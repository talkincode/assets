# API

所有时间戳都是 Unix 毫秒。错误响应统一为 `{ "error": "<code>", "message": "<英文说明>" }`。

## 模型：资产 vs 分享链接

- **资产**（`assets.hash`）：不可变身份，字节一直保留，仅人工删除。**不是**公开外链。
- **分享链接**（`links.hash`）：公开定位器；`/<hash>/<filename>` 只解析链接 hash。
  每条链接自有 `expires_at` / 吊销，互不影响。
- 上传会创建资产 + **第一条链接**；响应里的 `hash` / `url` 指这条链接，另有 `asset_hash`。

## 公开接口

### `GET|HEAD /<hash>/<filename?>`

`hash` 是 **链接** 定位器。`filename` 只影响 `Content-Disposition`。

- 支持 `Range`（206）、`If-None-Match`（304）、`ETag`、`HEAD`。
- `?dl=1` 强制 `attachment`；HTML/SVG/XML/JS 一律 `attachment`。
- `X-Content-Type-Options: nosniff`、`Content-Security-Policy: sandbox`、CORS `*`。
- 状态码：`200` / `206` / `304` / `404`（无此链接、已吊销、资产已删）/
  `410`（链接过期）/ `403`（来源被封禁）。

### `POST /api/upload`

| 位置 | 名称 | 说明 |
| --- | --- | --- |
| Header | `Authorization: Bearer <上传密钥>` | 也可用 `X-Assets-Key` |
| Header | `Content-Type` | 存储 MIME；缺省按扩展名推断 |
| Header | `Content-Length` | 必填 |
| Header/Query | `X-Filename` / `?filename=` | 下载名 |
| Query | `expires_in` / `ttl` / `expires_at` / `never` | **首条链接** 的过期（资产本身不过期） |
| Query | `hash` | 自定义 **链接** hash（16–64 位 `[A-Za-z0-9_-]`） |
| Query | `note` / `tags` | 备注与标签（挂在资产上） |
| Query | `project` / `project_id` / Header `X-Project` | 归属项目（slug 或 id） |

```json
{
  "hash": "<link_hash>",
  "asset_hash": "<asset_hash>",
  "link_hash": "<link_hash>",
  "filename": "demo.mp4",
  "size": 1048576,
  "content_type": "video/mp4",
  "tags": ["demo"],
  "project": { "id": "…", "slug": "coollearn", "name": "Cool Learn" },
  "note": "季度报告终稿",
  "created_at": 1789000000000,
  "expires_at": 1789604800000,
  "url": "https://assets.talkincode.net/<link_hash>/demo.mp4"
}
```

### `GET /health`

`{ "status": "ok", "service": "talkincode-assets", "time": … }`

## 管理接口（`/admin/api/*`，需 Cloudflare Access）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/me` | 身份；含 `temp_link_max_seconds`（14400） |
| GET | `/stats` | 总量；`live`/`expired` 按「是否还有有效链接」聚合 |
| GET | `/assets` | 列表：`status=live\|expired\|deleted\|all`、`kind`、`tag`、`project`（slug/id/`none`）、`q` |
| POST | `/assets/batch` | `{hashes, tags?, tags_mode?, project?, create_links?, expires_in?/never?, label?}` |
| GET | `/assets/:assetHash` | 详情 + `links[]` + 审计；含 `editable_text` / `markdown` / `project` |
| GET/POST | `/assets/:assetHash/links` | 列出 / 新建普通分享链接 |
| POST | `/assets/:assetHash/temp-link` | **临时链**：`{expires_in?}`，默认 1h，**硬上限 4h** |
| PATCH | `/links/:linkHash` | 改链接过期 / label |
| DELETE | `/links/:linkHash` | 吊销链接（不删资产） |
| GET/PUT | `/assets/:assetHash/content` | 文本/Markdown 原文读写（≤2 MiB） |
| PATCH | `/assets/:assetHash` | `{filename}` / `{note}` / `{tags}` / `{project}`（slug/id/`none`） |
| DELETE | `/assets/:assetHash` | 软删（吊销全部链接）；`?purge=1` 彻底删除 |
| POST | `/assets/:assetHash/restore` | 恢复资产（需重新建链才能外发） |
| GET | `/tags` | 有效资产上的标签计数 |
| GET/POST | `/projects` | 项目列表 / 创建 `{slug, name?, note?}` |
| GET/PATCH/DELETE | `/projects/:idOrSlug` | 详情 / 改名改 slug / 删除（资产改未归类） |
| GET/POST | `/keys` · `DELETE /keys/:id` | 上传密钥 |
| GET | `/abuse` · `DELETE /abuse/:source` | 封禁来源 |
| GET | `/audit` | 操作记录 |
| GET/PATCH | `/settings` | `default_ttl_days`（新建链接默认）、`max_upload_bytes`、`trash_retention_days` |

```bash
# Agent：为已有资产开一条 ≤4h 的临时链
curl -sS -X POST "https://assets.talkincode.net/admin/api/assets/$ASSET_HASH/temp-link" \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"expires_in":"1h","label":"agent"}'
```

## MCP（`/mcp`，需 MCP OAuth）

远程 MCP 服务器（Streamable HTTP，无状态），给 Cloudflare MCP Portal 这类
MCP 客户端用。OAuth 发现按标准来：未授权调 `/mcp` 返回 401 + `WWW-Authenticate`，
元数据在 `/.well-known/oauth-protected-resource/mcp`，授权页 `/authorize`、
token `/token`、客户端注册 `/register`。

授权页只认 dashboard 成员：带 `Cf-Access-Jwt-Assertion` 头，或先登录过 `/admin/`
（浏览器会自动带 `CF_Authorization` cookie）。签发的是本服务的 OAuth token，
不是 Access token；`aud` 绑定 `https://assets.talkincode.net/mcp`。

Scope：`assets:read`（搜索/读取）、`assets:write`（建链/改元数据/传文件）、
`assets:admin`（删除/恢复/吊销）。高 scope 兼容低 scope。权限不足的工具调用
返回 `insufficient_scope`，不暴露数据。

| 工具 | scope | 说明 |
| --- | --- | --- |
| `search_assets` | read | 按 `q`/`tag`/`project`/`status`/`kind` 搜索，与 dashboard 列表同规则 |
| `get_asset` | read | 元数据 + `links[]`（过期/吊销/下载 URL） |
| `list_projects` / `list_tags` | read | 文件夹与标签 |
| `read_text_content` | read | Markdown/纯文本原文（≤2 MiB） |
| `create_temp_link` | write | **临时链**：默认 1h，**硬上限 4h**，与 dashboard/CLI 同规则 |
| `create_link` | admin | 普通分享链（默认 TTL 策略；`never:true` 建无过期链接） |
| `create_project` | write | 新建项目文件夹（`slug`/`name` 二选一） |
| `update_asset` | write | 改 `filename`/`note`/`tags`/`project` |
| `write_text_content` | write | 覆盖文本资产字节（≤2 MiB） |
| `create_upload_session` | write | 预定上传：返回 `upload_url`，单次 PUT 字节（需 `Content-Length`） |
| `delete_asset` | admin | 软删（吊销全部链接，字节保留 7 天）；`purge=true` 立即彻底删除 |
| `restore_asset` | admin | 恢复软删资产（链接保持吊销，需重建） |
| `revoke_link` | admin | 吊销一条分享链 |

资源（均为 read）：`asset://meta/<hash>`（JSON 元数据）、`asset://text/<hash>`
（文本原文）。提示词：`share_asset`（write，开临时链分享）、`asset_digest`
（read，摘要资产）。所有写操作记审计，actor 为 OAuth 身份邮箱。

大文件不要走 MCP JSON：`create_upload_session` 返回**一次性签名 URL**
（`.../uploads/:id?key=...`），谁拿到谁 PUT，不需要 OAuth 头——建 session
和传字节的可以是两个执行体：

```bash
curl -sS -X PUT "$UPLOAD_URL" \
  -H "Content-Length: $(wc -c < demo.mp4)" \
  --data-binary @demo.mp4
```

key 单次有效、随 session 过期（默认 1h 窗口，最长 4h），猜错计入滥用封禁；
过期未用的每小时清理。同一执行体手里有 token 时，也可以用 OAuth 头 PUT
到 `/mcp/uploads/:id`，效果相同。

## 定时任务

每小时：清理回收站过期字节、过期封禁记录、旧审计、过期未用的上传 session、
过期的 OAuth token/授权。**不会**因链接过期删除 R2。
