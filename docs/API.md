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

## 定时任务

每小时：清理回收站过期字节、过期封禁记录、旧审计。**不会**因链接过期删除 R2。
