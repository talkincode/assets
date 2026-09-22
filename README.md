# talkincode-assets

基于 Cloudflare 的私有资产服务：上传图片 / 音频 / 视频 / 任意文件，拿到一个 hash 外链，
在私有 dashboard 里预览、改期、换 hash、删除。

- **外链**：`https://assets.talkincode.net/<hash>/<filename>` —— 定位只靠 `hash`，
  `filename` 只是下载名，可以随便改。
- **过期**：默认 7 天，可按上传指定（`1h` / `7d` / `never`…），到期后链接立即失效并释放存储。
- **dashboard**：`https://assets.talkincode.net/admin/`，走 Cloudflare Access（SSO），
  当前只允许 `jamiesun.net@gmail.com`。
- **上传密钥**：dashboard 里配置，可多个、可吊销，只在创建时显示一次。
- **CLI**：`cli/assets.mjs`，零依赖，纯环境变量配置，方便 agent 调用。
- **暴力破解防护**：连续猜 hash / 猜密钥的来源会被自动封禁，且逐次加倍。

## 架构

```mermaid
flowchart TD
  browser["浏览器 / agent"] -->|"GET /hash/filename"| edge
  dash["dashboard<br/>/admin"] -->|"Cloudflare Access<br/>SSO"| edge
  edge["Worker: talkincode-assets"] --> d1[("D1<br/>元数据 / 密钥 / 审计")]
  edge --> r2[("R2<br/>文件字节")]
  edge --> guard["Durable Object<br/>AbuseGuard 按来源记账"]
  cron["Cron 每小时"] --> edge
```

| 组件 | 作用 |
| --- | --- |
| Worker `talkincode-assets` | 全部路由：公开下载、上传 API、dashboard API、定时清理 |
| D1 `talkincode-assets` | `assets` / `api_keys` / `audit_log` / `blocked_sources` / `settings` |
| R2 `talkincode-assets` | 对象存储，key 为 `objects/<随机串>`，与 hash 解耦（换 hash 不用搬字节） |
| Durable Object `AbuseGuard` | 每个来源网络（IPv4 /24、IPv6 /64）一份猜错计数与封禁状态 |
| Cloudflare Access | `/admin` 的 SSO 鉴权；Worker 会再次校验 JWT 签名与 `aud`（fail-closed） |

## 路由一览

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET/HEAD | `/<hash>/<filename?>` | 无（hash 即凭证） | 下载/预览，支持 Range、ETag、CORS |
| POST/PUT | `/api/upload` | 上传密钥 | 返回 `hash` 与外链 |
| GET | `/health` | 无 | 存活探测 |
| ANY | `/admin/api/*` | Cloudflare Access | dashboard 与管理 API |
| GET | `/admin/` | Cloudflare Access | dashboard 静态页面 |

## 快速开始

```bash
npm install
npm run types                 # 由 wrangler.toml 生成 Env 类型
npm test                      # workerd 内跑真实 D1/R2/DO 的集成测试

# 1) 建资源（首次）
npx wrangler r2 bucket create talkincode-assets
npx wrangler d1 create talkincode-assets         # 把 database_id 填进 wrangler.toml
npm run db:init                                  # 应用 schema.sql

# 2) 部署
npx wrangler deploy

# 3) 先造一把上传密钥（Access 还没配好时也能用）
node scripts/bootstrap-key.mjs --name laptop

# 4) 配好 dashboard 的 SSO
CLOUDFLARE_API_TOKEN=... ./scripts/setup-access.sh --service-token cli
npx wrangler deploy
```

完整步骤（含 Access 控制台手工配置、自定义域名、CI）见 [docs/DEPLOY.md](docs/DEPLOY.md)。

## 用法

### CLI

```bash
export ASSETS_KEY=ak_...            # 上传密钥
./cli/assets.mjs put ./demo.mp4 --expire 7d
# url: https://assets.talkincode.net/9fK.../demo.mp4

export CF_ACCESS_CLIENT_ID=...      # Access service token（管理命令用）
export CF_ACCESS_CLIENT_SECRET=...
./cli/assets.mjs ls --status live --json
./cli/assets.mjs rotate 9fK... --hash NewHashValue123456
./cli/assets.mjs expire 9fK... 30d
./cli/assets.mjs rm 9fK...
```

全部命令见 [docs/CLI.md](docs/CLI.md)，接口细节见 [docs/API.md](docs/API.md)。

### 上传密钥

在 dashboard 的「上传密钥」页创建，或 `node scripts/bootstrap-key.mjs --name ci`。
服务端只存 SHA-256；吊销后立即失效。

### 本地开发

```bash
npm run db:init:local
npm run dev        # http://localhost:8787
npm test           # vitest + workerd（真实绑定，不是 mock）
```

## 设计取舍

- **hash 就是唯一凭证**：22 位 base58（约 128 bit 熵），无法穷举，删除/换 hash 即撤销。
  自定义 hash 最短 16 位，且不能是 `admin`、`api` 等保留路径。
- **删除是软删除**：字节保留 7 天（`trash_retention_days`）可恢复；过期则立即释放。
- **缓存与删除的传播**：内容按 URL 不可变，边缘缓存 `max-age=min(剩余有效期, CACHE_TTL_SECONDS)`，
  默认 60 秒。也就是说删除/过期最多滞后 60 秒全网生效；配置 `CF_PURGE_TOKEN` 后
  删除会走 Cloudflare 精确 URL 清除，立即生效。
- **只有失败请求才记账**：正常下载不触发任何封禁逻辑，热门资源路径上没有额外开销。

## 安全模型

见 [docs/SECURITY.md](docs/SECURITY.md)：hash 熵、密钥存储与轮换、Access 二次校验、
两层暴力破解阻断、响应头与文件名注入防护、已知限制。

## 目录

```
src/            Worker 源码（路由 / 上传 / 公开下载 / 管理 API / 反滥用 / 定时清理）
public/admin/   dashboard（原生 HTML+CSS+JS，无构建步骤）
cli/            agent 友好的 CLI
scripts/        部署与 Access 配置脚本
test/           workerd 内的集成测试
docs/           DEPLOY / API / CLI / SECURITY
```

## License

MIT
