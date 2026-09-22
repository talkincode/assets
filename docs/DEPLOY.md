# 部署

目标：`assets.talkincode.net` 上的 Worker + D1 + R2 + Durable Object，`/admin` 由
Cloudflare Access 保护，只允许 `jamiesun.net@gmail.com`。

## 0. 前置

- Cloudflare 账号 `83b40c9065a6f4631f4ab6cda824a21a`（`jamiesun.net@gmail.com`）
- 域名 `talkincode.net` 在该账号下（本仓库使用 Custom Domain，DNS 记录随部署自动创建）
- 本机 `npm install` 已完成，`npx wrangler whoami` 能列出该账号

## 1. 创建资源

```bash
npx wrangler r2 bucket create talkincode-assets
npx wrangler d1 create talkincode-assets
```

把输出的 `database_id` 填进 `wrangler.toml` 的 `[[d1_databases]]`。然后应用 schema：

```bash
npm run db:init          # 远程
npm run db:init:local    # 本地开发库（wrangler dev 用）
```

已有库加标签列（只需跑一次）：

```bash
npm run db:migrate:tags
npm run db:migrate:tags:local
```

## 2. 首次部署

```bash
npm run types            # 生成 worker-configuration.d.ts（Env 类型）
npx wrangler deploy
curl -sS https://assets.talkincode.net/health
```

此时 `/admin` 会返回 503 `access_not_configured`——这是刻意的 fail-closed：
Access 没配好之前，管理 API 不会放行任何请求。

## 3. 造第一把上传密钥

dashboard 需要 Access，上传只需要密钥。所以先离线造一把：

```bash
node scripts/bootstrap-key.mjs --name bootstrap
export ASSETS_KEY=ak_...
./cli/assets.mjs put ./README.md --expire 7d
```

脚本直接把 `api_keys` 行写进 D1（只存 SHA-256）。之后建议在 dashboard 里管理密钥。

## 4. 配置 Cloudflare Access（dashboard 的 SSO）

### 方式 A：脚本（推荐）

需要一个 API Token，权限：

- Account → **Access: Apps and Policies → Edit**
- Account → **Access: Service Tokens → Edit**（仅在需要给 CLI 造 service token 时）

```bash
CLOUDFLARE_API_TOKEN=... ./scripts/setup-access.sh --service-token cli
npx wrangler deploy
```

脚本会：

1. 读取 Zero Trust 组织，拿到团队域 `<team>.cloudflareaccess.com`；
2. 创建（或复用）名为 `Talkincode Assets` 的 self-hosted 应用，
   domain `assets.talkincode.net`、path `admin`、session 24h；
3. 创建 allow 策略 `allow-owner`：`include = email jamiesun.net@gmail.com`；
4. 把 `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` 写回 `wrangler.toml`；
5. 可选：创建 Access Service Token，打印 `client_id` / `client_secret`（只显示一次）供 CLI 使用。

### 脚本踩过的三个坑（手工配置时同样要注意）

1. **`zone_name` 必填**：不带 `zone_name` 建应用会报 `12130 domain does not belong to zone`。
2. **path 要写进 domain**：`path` 字段会被这个 API 版本丢弃，导致应用盖住整个域名，
   连公开下载都会被 302 到登录页。必须让 destination 变成 `assets.talkincode.net/admin`。
3. **service token 的策略 decision 是 `non_identity`**，不是 `allow`：service token 不携带
   用户身份，`allow` 策略永远匹配不上，结果是每个请求都 302 回登录页。

另外：本账号的 Zero Trust 组织域是 `toughstruct.cloudflareaccess.com`（历史命名），
登录页会显示这个域名，属于正常现象。

### 方式 B：控制台手工配置

Zero Trust → Access → Applications → Add an application → Self-hosted：

| 字段 | 值 |
| --- | --- |
| Application name | `Talkincode Assets` |
| Public hostname / path | `assets.talkincode.net/admin`（**path 必须拼在域名字段里**） |
| Session duration | 24h |
| Cookie | `HttpOnly` 打开，`SameSite` = `Lax` |
| Policy name | `allow-owner`，Action = Allow |
| Policy rule | Include → Emails → `jamiesun.net@gmail.com` |

建好后复制应用页顶部的 **Application Audience (AUD) Tag**，和团队域一起写入配置：

```bash
node scripts/set-wrangler-vars.mjs ACCESS_TEAM_DOMAIN=<team>.cloudflareaccess.com ACCESS_AUD=<aud>
npx wrangler deploy
```

### 登录方式

Access 应用默认支持 **One-time PIN**（邮件验证码），只允许名单里的邮箱，开箱可用。
想换成 Google SSO：Zero Trust → Settings → Authentication → Login methods 添加 Google
（需要自建 Google OAuth 客户端），然后在应用的 Authentication 里选中它。

> Worker 侧会独立校验 `Cf-Access-Jwt-Assertion` 的 RS256 签名、`aud`、有效期与邮箱名单，
> 命中不了就 401/403。即使有人绕过边缘，也拿不到管理数据。

## 5. CLI 的管理命令

CLI 的管理命令走 `/admin/api`，因此需要 Access 认可的身份。推荐用 Service Token：

```bash
export ASSETS_BASE_URL=https://assets.talkincode.net
export CF_ACCESS_CLIENT_ID=...
export CF_ACCESS_CLIENT_SECRET=...
./cli/assets.mjs ls
```

也可以把这些写进工作目录的 `.env`（CLI 会自动读取，环境变量优先）。

## 6. 可选：秒级清除缓存

默认删除/过期最多 60 秒后才在全网生效（`CACHE_TTL_SECONDS`）。要让删除立即生效：

1. 新建 API Token：Zone → Cache Purge → Purge，作用域 `talkincode.net`；
2. `npx wrangler secret put CF_PURGE_TOKEN` 写入该 token。

`CF_ZONE_ID` 已在 `wrangler.toml` 中配置。

## 6.5 CI 部署用的 token（已配好）

`talkincode-assets-deploy` 是用账号里那把 key 新建的**账号级** token，只授了
Workers Scripts / Routes、Workers Tail、D1、R2、Account Settings 读写和 zone Workers
Routes 读写，不含 Access、不含 DNS。已写入 GitHub Secrets（`CLOUDFLARE_API_TOKEN`、
`CLOUDFLARE_ACCOUNT_ID`），`deploy.yml` 推 main 或手动触发即可。

两个只有踩过才知道的点：

- **zone 权限组必须挂在 account 资源下**：`POST /accounts/{id}/tokens` 不认
  `com.cloudflare.api.zone.*` 这种资源类型，zone 级的 Workers Routes 组要放在
  `com.cloudflare.api.account.{id}` 的策略里。
- 因此该 token 的策略是**一条** account 资源策略，里面同时含账号级和 zone 级权限组。

## 7. 环境变量速查

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PUBLIC_BASE_URL` | `https://assets.talkincode.net` | 返回给调用方的外链前缀 |
| `DEFAULT_TTL_DAYS` | `7` | 未指定过期时间时的默认值；`0` = 永不过期 |
| `MAX_UPLOAD_BYTES` | `104857600` | 单文件上限（100 MiB） |
| `CACHE_TTL_SECONDS` | `60` | 边缘/浏览器缓存上限，也是删除传播上限 |
| `CORS_ORIGIN` | `*` | 公开下载响应的 `Access-Control-Allow-Origin` |
| `ACCESS_TEAM_DOMAIN` | 空 | Access 团队域；空 = 管理接口 503 |
| `ACCESS_AUD` | 空 | Access 应用 AUD；空 = 管理接口 503 |
| `ACCESS_ALLOWED_EMAILS` | `jamiesun.net@gmail.com` | 允许登录 dashboard 的邮箱，逗号分隔 |
| `ACCESS_ALLOW_SERVICE_TOKENS` | `true` | 是否接受 Access service token（CLI） |
| `ABUSE_MISS_THRESHOLD` | `15` | 一个窗口内猜错多少次触发封禁 |
| `ABUSE_WINDOW_SECONDS` | `600` | 统计窗口 |
| `ABUSE_BAN_SCHEDULE` | `300,3600,86400,604800` | 逐次加倍的封禁时长（秒） |
| `ABUSE_STRIKE_DECAY_HOURS` | `24` | 多久没有新违规就清空累计违规次数 |
| `TRASH_RETENTION_DAYS` | `7` | 手动删除后字节保留天数 |
| `CF_ZONE_ID` | `talkincode.net` | 精确清除缓存用 |
| `CF_PURGE_TOKEN` | 未设置 | Secret；设置后删除立即全网生效 |

`default_ttl_days` / `max_upload_bytes` / `trash_retention_days` 三个值可以在 dashboard
「设置」里在线调整（存 D1，优先于上面的兜底值）。

## 8. CI 部署（可选）

`.github/workflows/deploy.yml` 在 push 到 `main` 时执行 `wrangler deploy`。
在仓库 secrets 里配置 `CLOUDFLARE_API_TOKEN`（Workers Scripts:Edit、D1:Edit、R2:Edit）
和 `CLOUDFLARE_ACCOUNT_ID`。

## 9. 回滚与排障

```bash
npx wrangler deployments list
npx wrangler rollback [version-id]
npx wrangler tail                                   # 实时日志
npx wrangler d1 execute talkincode-assets --remote -y --command "SELECT hash, size, expires_at FROM assets ORDER BY created_at DESC LIMIT 10"
```

- `/admin` 302 到 `…cloudflareaccess.com/cdn-cgi/access/login/…`：正常，说明 Access 在拦。
- `/admin` 503 `access_not_configured`：`ACCESS_AUD` / `ACCESS_TEAM_DOMAIN` 没写进
  `wrangler.toml`，或改完没重新部署（**换过 Access 应用必须重新 deploy**，AUD 会变）。
- `/admin` 401 `access_required`：请求过了边缘但没带 JWT——多半是绕过了 Access。
- service token 请求也 302：多半是策略 decision 写成了 `allow`，应为 `non_identity`。
- 上传 413：超过 `max_upload_bytes`。
- 上传 411：请求没有 `Content-Length`（chunked）。补上长度再传。
