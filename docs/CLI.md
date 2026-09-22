# CLI

`cli/assets.mjs`：零依赖、纯 Node（≥20），面向人和 **agent**。

```bash
./cli/assets.mjs help
```

## 环境变量

| 变量 | 必需 | 说明 |
| --- | --- | --- |
| `ASSETS_BASE_URL` | 否 | 默认 `https://assets.talkincode.net` |
| `ASSETS_KEY` | `put` 需要 | 上传密钥 |
| `CF_ACCESS_CLIENT_ID` / `SECRET` | 管理命令需要 | Access Service Token |

```bash
./cli/assets.mjs --env-file ~/.config/talkincode-assets/env ls
```

## 输出约定

- 默认：人类可读
- `--json`：完整 JSON（agent 首选）
- `-q` / `--quiet`：只输出一个值（通常是 URL 或 asset hash）

## Agent 工作流（推荐）

资产不过期；对外只发 **临时分享链接**（服务端硬上限 **4 小时**）。

```bash
# 1) 上传（返回首链 URL；--json 含 asset_hash）
./cli/assets.mjs put ./doc.pdf --expire 7d --json

# 2) 检索已有资产（可按项目定向；输出 hash + 备注）
./cli/assets.mjs find "季度报告" --project coollearn --json
./cli/assets.mjs ls --project coollearn --status live --json
./cli/assets.mjs note "$ASSET_HASH" "agent: 已核对页码"
./cli/assets.mjs projects --json

# 3) 开临时链（默认 1h，最大 4h）；-q 只打 URL
URL=$(./cli/assets.mjs --env-file ~/.config/talkincode-assets/env \
  temp <asset_hash|文件名关键词> --project coollearn --expire 1h -q)

# 超过 4h 会被 CLI 与服务端同时拒绝
./cli/assets.mjs temp "$ASSET_HASH" --expire 5h   # error
```

## 命令摘要

| 命令 | 作用 |
| --- | --- |
| `put <file>` | 上传：建资产 + 首链；`--expire` 管首链 TTL；`--project SLUG` 归属 |
| `find <query>` / `ls` | 检索资产；输出 `asset_hash`、备注、文件名；支持 `--project` |
| `note <asset_hash> <text>` | 写入 / 更新备注（`--clear` 清空；`-` 从 stdin） |
| `projects` / `project-create` / `project-set` | 项目列表、创建、改归属 |
| `show <asset_hash>` | 资产详情 + 全部链接 |
| `temp <asset\|query>` | **临时链** ≤4h（agent 主入口）；可加 `--project` 缩小检索 |
| `link <asset_hash>` | 普通分享链（可 `7d` / `never`） |
| `links <asset_hash>` | 列出链接 |
| `revoke <link_hash>` | 吊销单条链接 |
| `rm` / `restore` | 删 / 恢复 **资产** |
| `url <link_hash>` | 拼公开 URL |

```bash
./cli/assets.mjs put ./a.png --expire 7d -q
./cli/assets.mjs link "$ASSET_HASH" --expire 30d --label wechat -q
./cli/assets.mjs links "$ASSET_HASH" --json
./cli/assets.mjs revoke "$LINK_HASH"
./cli/assets.mjs rm "$ASSET_HASH"
```
