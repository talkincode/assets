# API

所有时间戳都是 Unix 毫秒。错误响应统一为 `{ "error": "<code>", "message": "<英文说明>" }`。

## 公开接口

### `GET|HEAD /<hash>/<filename?>`

返回文件。`filename` 只影响 `Content-Disposition`（下载名），不参与定位；省略时会用
上传时的原始文件名。

- 支持 `Range`（206 + `Content-Range`）、`If-None-Match`（304）、`ETag`、`HEAD`。
- `?dl=1` 强制 `attachment`（默认图片/音视频/纯文本等可预览类型是 `inline`）。
  HTML、XHTML、SVG、XML、JavaScript 一律 `attachment`，`?inline=1` 不能改回 inline。
- 每条资产响应都带 `X-Content-Type-Options: nosniff` 和 `Content-Security-Policy: sandbox`。
- 响应头带 `Access-Control-Allow-Origin: *`，可直接在网页里引用图片、音视频。
- 状态码：`200` / `206` / `304` / `404`（不存在、已删除）/ `410`（已过期）/
  `403`（来源被封禁，带 `Retry-After`；已存在的文件同样拒绝）。

### `POST /api/upload`

| 位置 | 名称 | 说明 |
| --- | --- | --- |
| Header | `Authorization: Bearer <上传密钥>` | 也可用 `X-Assets-Key`。密钥不接受放在 URL 里 |
| Header | `Content-Type` | 决定存储的 MIME；缺省时按扩展名推断 |
| Header | `Content-Length` | 必填。没有长度的 chunked 请求直接 `411` |
| Header/Query | `X-Filename` / `?filename=` / `Content-Disposition` | 下载名 |
| Query | `expires_in`（或 `ttl`） | `30m` / `12h` / `7d` / `2w` / 秒数 / `never` |
| Query | `expires_at` | 绝对时间（ISO 或 epoch） |
| Query | `hash` | 自定义 hash：16–64 位 `[A-Za-z0-9_-]` |
| Query | `note` | 备注，dashboard 可见 |

```bash
curl -X POST "https://assets.talkincode.net/api/upload?expires_in=7d&filename=demo.mp4" \
  -H "Authorization: Bearer $ASSETS_KEY" \
  -H "Content-Type: video/mp4" \
  --data-binary @demo.mp4
```

```json
{
  "hash": "9fK2mQ7dLpR1sVx8YzA3bC",
  "filename": "demo.mp4",
  "size": 1048576,
  "content_type": "video/mp4",
  "created_at": 1789000000000,
  "expires_at": 1789604800000,
  "url": "https://assets.talkincode.net/9fK2mQ7dLpR1sVx8YzA3bC/demo.mp4"
}
```

状态码：`201`、`400`（空 body、非法 hash、畸形文件名）、`401`（密钥无效）、
`403`（来源被封禁）、`409`（hash 已被占用，含并发冲突）、`411`（缺少 `Content-Length`）、
`413`（超过大小上限）、`429`（上传过于频繁）。

### `GET /health`

`{ "status": "ok", "service": "talkincode-assets", "time": 1789000000000 }`

## 管理接口（`/admin/api/*`，需 Cloudflare Access）

浏览器通过 Access 会话自动带上 `Cf-Access-Jwt-Assertion`；脚本/CI 用 Service Token
（`CF-Access-Client-Id` + `CF-Access-Client-Secret`）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/me` | 当前身份与外链前缀 |
| GET | `/stats` | 总量、占用、按类型分布、封禁数、密钥数 |
| GET | `/assets` | 列表：`status=live\|expired\|deleted\|all`、`kind`、`q`、`limit`、`offset` |
| POST | `/assets` | 上传（dashboard 登录态，无需上传密钥） |
| GET | `/assets/:hash` | 详情 + 该资产的操作记录 |
| PATCH | `/assets/:hash` | `{expires_in}` / `{expires_at}` / `{never:true}` / `{filename}` / `{note}` |
| POST | `/assets/:hash/rotate` | 换 hash：`{hash?}`，留空则随机；返回新链接与旧链接 |
| DELETE | `/assets/:hash` | 软删除（字节进回收站）；`?purge=1` 彻底删除 |
| POST | `/assets/:hash/restore` | 恢复，可同时改期 `{expires_in}` |
| GET/POST | `/keys` | 列出 / 创建上传密钥 |
| DELETE | `/keys/:id` | 吊销密钥 |
| GET | `/abuse` | 封禁来源：每行带 `active` 标记（是否仍在封禁中）与累计猜错次数 |
| DELETE | `/abuse/:source` | 解封（source 需 URL 编码，如 `203.0.113.0%2F24`） |
| GET | `/audit` | 操作记录 |
| GET/PATCH | `/settings` | 运行时策略（`default_ttl_days`、`max_upload_bytes`、`trash_retention_days`） |

```bash
curl -sS https://assets.talkincode.net/admin/api/stats \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET"
```

## 定时任务

每小时（`17 * * * *`）执行一次清理：

1. 过期资产：写入删除标记并立即删除 R2 字节；
2. 回收站资产：超过 `trash_retention_days` 后删除字节、记录 `purged_at`；
3. 清理 7 天前的封禁记录、180 天前的审计记录。
