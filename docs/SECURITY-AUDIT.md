# 安全审计报告

> 审计对象：本仓库当前工作区代码（含两处未提交的小改动），基于 commit `29ffb9d`。
> 审计方式：逐文件代码走查 + `npm run check`（tsc + workerd 内 27 个集成测试全绿）+ 针对性 grep 佐证。
> 结论先行：**整体设计扎实，无 SQL 注入、无鉴权绕过、无 dashboard DOM XSS；但存在 1 个高危
> （同源存储型 XSS 可升级为管理面接管）和 2 个中危问题，建议尽快修复。**

## 严重程度总览

| 级别 | 编号 | 问题 |
| --- | --- | --- |
| 高 | H-1 | 上传内容可在 `assets.talkincode.net` 同源执行脚本（HTML/SVG），可借 Access 会话接管 `/admin/api` |
| 中 | M-1 | 读路径的封禁不拦截请求：被封来源仍可探测与下载，命中/未命中信号不变 |
| 中 | M-2 | 恶意/异常输入未收敛为 4xx：多处 500，且 `upload_failed` 回显内部错误文案 |
| 低 | L-1 | 上传密钥可经 URL 查询参数 `?key=` 传递 |
| 低 | L-2 | 缓存清除只覆盖规范化 URL 变体；任意 query 造成缓存碎片与下载计数刷量 |
| 低 | L-3 | `bootstrap-key.mjs` 以字符串拼接方式生成 SQL（靠剥单引号防注入，脆弱） |
| 低 | L-4 | 自定义 hash 并发冲突 → 500；put 成功后 D1 写失败 → R2 孤儿对象 |
| 低 | L-5 | Worker 管理接口无 CSRF/Origin 校验，完全依赖 Access cookie 属性 |
| 低 | L-6 | 无 `Content-Length` 上传缓冲 25 MB，合法密钥可并发打内存 |
| 信息 | I-* | 见文末 |

---

## H-1（高危）同源存储型 XSS：任意文件上传 → 管理面接管

**位置**

- `src/util.ts:206` `guessContentType`：客户端 `Content-Type` 除 octet-stream 外**原样信任**并入库
- `src/util.ts:228` `isPreviewable('text/html') === true` → 下载方式为 `inline`
- `src/assets.ts:130`：响应原样回吐存储的 `content-type` / `content-disposition`，**全源码无 `X-Content-Type-Options`、无 CSP**（grep `nosniff|content-security-policy` 在 `src/` 零命中）
- 同源前提：dashboard（`/admin`）与公开资产同在 `assets.talkincode.net`；Access 应用只盖 `path=admin`（`scripts/setup-access.sh:98`）

**利用链**

1. 任意持有上传密钥者（CI / agent，密钥本设计为可多把、可分发）上传：
   `curl -X POST /api/upload -H 'Authorization: Bearer ak_…' -H 'Content-Type: text/html' --data-binary @evil.html`
   （或管理员在 dashboard 上传一个 .html——浏览器 `file.type` 就是 `text/html`）。
2. 返回外链 `https://assets.talkincode.net/<hash>/evil.html`，打开即在**服务自己的源**上执行 JS。
3. 若打开者持有活跃 Access 会话（即管理员），恶意页可 `fetch('/admin/api/*', {credentials:'include'})`：
   同源请求自动携带 `CF_Authorization` cookie → Access 边缘验票后注入 `cf-access-jwt-assertion` →
   Worker 二次校验通过 → **攻击者拿到完整管理 API**（创建/吊销密钥、删除、换 hash、改设置）。
4. 即使没有会话，也可在品牌域上做钓鱼页、挂马、垃圾内容托管（`CORS_ORIGIN=*` 还允许被任意站点引用）。

**修复（按优先级）**

1. **立即（无 UX 代价）**：所有资产响应加 `X-Content-Type-Options: nosniff` 与
   `Content-Security-Policy: sandbox`（导航到文档/SVG 时禁止脚本执行；不影响 `<img>/<video>` 等内嵌预览）。
2. **纵深防御**：对主动内容类型（`text/html`、`application/xhtml+xml`、`image/svg+xml`、`text/xml`、
   `application/xml`、`*javascript*`）强制 `Content-Disposition: attachment`，且 `?inline=1` 不得绕过。
3. **长期（真正的隔离）**：用户内容迁到独立源（如 `files.talkincode.net`），与 dashboard 彻底分源。
   代价是域名与 Access 应用配置调整，建议排期执行；1+2 落地后风险已可控。

---

## M-1（中危）读路径的封禁形同虚设

**位置**：`src/assets.ts:86` `handleAssetRequest` 从不调用 `isBlocked`；
该检查只存在于上传路径（`src/index.ts:61`，grep `isBlocked|guardCheck` 仅 `abuse.ts`/`index.ts` 命中）。

**行为**

- 被封来源请求**不存在**的 hash：先做 D1 查询（`src/assets.ts:113`），再记账，返回 403；
- 被封来源请求**存在**的 hash：正常 200 下载，封禁状态完全不参与判定；
- 于是 200 vs 403 依旧是“命中/未命中”判定信号，探测以 `READ_LIMITER` 1200 次/分钟持续进行；
- `MISS_LIMITER`（40/分钟）也省不下 D1 查询——查询发生在记账之前。

**影响**：`docs/SECURITY.md:53` 写的是“所有失败路径与上传接口”，字面没错，
但 `README.md:13` 宣称的“连续猜 hash 会被自动封禁”和 SECURITY.md 自述目标
（挡住探测、刷量）在读路径上均不成立。128 bit 熵下穷举仍不可行，故实际危害是
**资源滥用防护失效 + 文档承诺不符**，而非可猜性。

**修复**：`handleAssetRequest` 在 `hashProblem` 之前先 `isBlocked(env, request)`，命中即 403 + `Retry-After`。
权衡：同 /24 的 NAT 用户会被连带——但封禁模型本来就是 /24 粒度，此权衡已在设计内；修完需同步改文档。

---

## M-2（中危）异常输入未收敛为 4xx + 内部信息回显

| 位置 | 问题 | 现状 | 应为 |
| --- | --- | --- | --- |
| `src/upload.ts:175` | `upload_failed` 把 `error.message`（R2/流内部文案）回给客户端 | 400 + 内部细节 | 固定文案 |
| `src/upload.ts:37` | `Content-Disposition` 中畸形 `%` 序列使 `decodeURIComponent` 抛错 | 500 | 400 |
| `src/router.ts:72` | 管理路由参数 `decodeURIComponent` 未捕获 | 500 | 400/404 |
| `src/auth.ts:96` | 畸形 JWT 的 `atob`/`JSON.parse` 抛错被 `toErrorResponse` 兜成 500 | 500 | 401 |
| `src/auth.ts:184` | `exp` **缺失时不拒绝**；`iss` 从未校验 | 潜在放过无期限断言 | 缺 `exp` 即 401；校验 `iss === https://<team-domain>` |

全部 fail-closed，不构成放行，但把攻击者的 4xx 探测变成 500/日志噪声，且 `upload_failed` 泄内部细节。
`aud` + RS256 签名已挡住主要风险，故 `exp/iss` 为低危补强。

---

## 低危

**L-1 密钥走 URL 查询参数** — `src/auth.ts:36` 接受 `?key=`，`docs/API.md:22` 还在宣传。
URL 会进 Cloudflare 日志与任何下游 access log。建议只保留 `Authorization` / `X-Assets-Key` 头。

**L-2 缓存清除覆盖不全 + 缓存键碎片化** — 读路径接受任意 filename 装饰与任意 query，
缓存键取完整 `request.url`（`src/assets.ts:152`）；而清除只覆盖
“存储文件名 ± dl”两个变体（`src/cache.ts:50`）。后果：

- “配置 `CF_PURGE_TOKEN` 后全网立即生效”只对规范化 URL 成立，其它变体靠 `CACHE_TTL_SECONDS=60` 兜底（上界明确，故仅低危）；
- 任意 query 可制造缓存条目碎片，并让下载计数（`src/assets.ts:157`，缓存命中也 +1）任意膨胀。

建议：缓存键归一化（只保留 `dl`/`inline` 两个语义开关），purge 按归一化键执行；下载计数仅在真实回源时累加（或接受现状）。

**L-3 SQL 拼接** — `scripts/bootstrap-key.mjs:35` 用 `name.replace(/'/g, '')` 后拼进 SQL。
当前无法逃逸字符串字面量（无单引号即无法闭合），但这是“靠删字符防注入”，
建议改白名单 `^[A-Za-z0-9._ -]{1,64}$` 直接拒绝。

**L-4 竞态与孤儿对象** — `src/upload.ts:149` 对自定义 hash 是 check-then-insert：
并发同 hash 时 D1 主键冲突 → 500（应 409）；put 成功后 INSERT/audit 失败（`src/upload.ts:183`）
会留下 R2 孤儿字节。建议 catch 后回滚删除对象、并把 23505 映射为 409。

**L-5 管理接口无 CSRF 纵深防御** — Worker 只认 `cf-access-jwt-assertion`，
CSRF 防线完全依赖 Access cookie 属性（`HttpOnly` + `SameSite=Lax`，仅
`scripts/setup-access.sh:104` 保证；DEPLOY.md 的手工配置表未提这两个字段）。
建议对 `/admin/api` 的非 GET 方法加 `Sec-Fetch-Site`/`Origin` 校验（纵深防御，一行成本）。

**L-6 chunked 上传内存面** — `src/upload.ts:69` 无 `Content-Length` 时缓冲 25 MB，
`UPLOAD_LIMITER`（120/分钟，检查在缓冲前）下合法密钥仍可并发压内存。低危可用性，
可加并发上限或对超阈值请求直接 411。

---

## 信息级

- **I-1** 封禁与审计唯一信任根是 `cf-connecting-ip`（`src/abuse.ts:18`）。当前 `workers_dev = false`
  + custom domain，该头经 Cloudflare 边缘写入、不可伪造；将来若加旁路入口需重新评估。
- **I-2** 静态 dashboard 文件（`/admin/index.html`、`app.js`）只受边缘 Access 保护，Worker 不拦；
  Access 应用被删时静态页会 200（API 仍 fail-closed 401/503）。文件本身无敏感数据。
- **I-3** 上传路径 `note` 不限长（`src/upload.ts:155`；admin PATCH 限 500 字符，`src/admin.ts:233`），
  头/URL 长度天然有界，仅一致性问题。
- **I-4** 文档漂移：`docs/API.md:92` 说封禁记录保留 30 天，代码是 7 天（`src/cron.ts:70`），
  SECURITY.md 与代码一致。
- **I-5** 测试 RSA 私钥入库（`test/access-fixtures.ts:12`）：仅在 vitest 桩 fetch 下生效，
  生产 JWKS 来自真实团队域，可接受。
- **I-6** Access Service Token 默认 1 年有效（docs 已列为已知限制），注意放 CI secret 并轮换。
- **I-7** 审计日志保留 180 天后由 cron 清理（`src/cron.ts:74`），到期不可追查。

---

## 验证为“做得好”的部分（抽查证据）

- **Access 二次校验**：未配置即 503 fail-closed；`alg` 钉死 RS256（防 alg=none / HS256 混淆，
  `src/auth.ts:149`）；`kid`→JWKS、`aud`、`exp/nbf`（30s 容差）、轮换重试、
  邮箱白名单、service token 可一键关闭。
- **SQL**：全部走 `?` 绑定；动态片段只有白名单常量（`KIND_FILTERS`、固定 `updates` 列表），无注入点。
- **hash**：128 bit 拒绝采样（`src/util.ts:37`）；自定义 hash ≥16 位；
  保留路径有“长度下限 + `RESERVED_SEGMENTS`”双保险。
- **文件名/响应头注入**：控制字符、引号、反斜杠剥离 + RFC 5987 输出（`src/util.ts:156`），
  `Content-Disposition` 注入被挡住；`decodeSegment` 对非法百分号编码 fail-safe。
- **上传**：先鉴权后读 body；`FixedLengthStream` 防截断/防超额；chunked 上限；按 actor 限流；空对象拒绝。
- **密钥**：只存 SHA-256；`crypto.subtle.timingSafeEqual` 比较（已在 workerd 运行时与类型层验证存在，
  非文档虚构）；明文仅创建时展示一次。
- **dashboard DOM XSS**：16 处 `innerHTML` 插值逐一核对，全部经 `esc()`（`&<>"'` 全转义），
  未发现可利用点；`toast`/`textContent` 路径天然安全。
- **暴力破解分层**：边缘三档限流 + DO 状态化升级封禁 + IPv4 /24、IPv6 /64 聚合防换 IP（上传侧有效，见 M-1）。
- **缓存与删除**：`max-age=min(剩余有效期, CACHE_TTL_SECONDS)`，删除传播上界明确（60s）。
- **工程面**：零运行时依赖；CI 跑 typecheck + workerd 集成测试；`.dev.vars` 被忽略；
  仓库 grep 无密钥/token 泄漏；`setup-access.sh` 设置 `HttpOnly` + `SameSite=Lax`。

---

## 修复优先级建议

1. **P0**：H-1 的第 1、2 步（`nosniff` + CSP `sandbox` + 主动内容类型强制附件），
   改动集中在 `src/assets.ts` 响应头构造处，一次部署生效。
2. **P1**：M-1（读路径先查 `isBlocked`）、M-2（异常收敛 4xx、去掉 `upload_failed` 回显、补 `exp/iss`）。
3. **P2**：L-1 ~ L-6 与文档同步（README/SECURITY 的封禁承诺、API.md 的 30 天漂移）。
4. **排期**：用户内容独立源（H-1 第 3 步），彻底消除同源升级面。
