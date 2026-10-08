---
name: assets
description: >-
  通过 `assets` CLI 操作 talkincode-assets（assets.talkincode.net）：上传不可变资产、按项目检索、
  写备注、开临时分享链接（硬上限 4 小时）。用户要分享文件、上传素材、找已有资产、发短期 URL、
  或提到 assets.talkincode / talkincode-assets / temp-link 时使用。Agent 优先 `--json` 或 `-q`。
---

# talkincode-assets（`assets`）

私有资产服务：字节按 **asset hash** 永久保存；对外只发带过期时间的 **link hash** URL。
Agent 默认只发 **临时链**（服务端硬上限 **4 小时**）。

命令已在 PATH：`assets`。配置默认读 `~/.config/talkincode-assets/env`（含 `ASSETS_KEY`、
`CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`）。也可用 `--env-file PATH`。

## 模型（别搞反）

| 概念 | 含义 |
| --- | --- |
| Asset | 不可变身份；`asset_hash`；删要显式 `rm` |
| Link | 公开定位符 `/<link_hash>/<filename>`；自有 `expires_at` |
| Project | 可选文件夹；`--project SLUG` / `?project=` |

上传 = 建 asset + 首条 link。公开 GET 只认 **link** hash。

## Agent 推荐流程

```bash
# 1) 上传（--json 含 asset_hash、hash=link、url）
assets put ./doc.pdf --expire 7d --project coollearn --json

# 2) 检索（输出 asset_hash + note + 文件名）
assets find "季度报告" --project coollearn --json
assets ls --project coollearn --status live --json
assets note "$ASSET_HASH" "agent: 已核对"

# 3) 临时分享（默认 1h，最大 4h）；-q 只打 URL
URL=$(assets temp "$ASSET_HASH" --expire 1h -q)
# 或按关键词 + 项目缩小范围
URL=$(assets temp "季度报告" --project coollearn --expire 1h -q)
```

超过 4h：`assets temp … --expire 5h` 会被 CLI 与服务端拒绝。长期分享用 `assets link`（无 4h 帽）。

## 命令速查

| 命令 | 用途 |
| --- | --- |
| `put <file>` | 上传；`--expire` 管首链；`--project` / `--note` / `--tags` |
| `find` / `ls` / `show` | 检索 / 列表 / 详情 |
| `note <asset_hash> <text>` | 写备注（`--clear` 清空；`-` 读 stdin） |
| `temp <asset\|query>` | **临时链 ≤4h**（agent 主入口） |
| `link` / `links` / `revoke` | 普通链 / 列出 / 吊销 |
| `projects` / `project-create` / `project-set` | 项目 CRUD 与归属 |
| `rm` / `restore` | 删 / 恢复资产 |
| `url <link_hash>` | 拼公开 URL |

全局：`--json`、`-q` / `--quiet`、`--base-url`、`--env-file`。

## 规则

1. 对外分享优先 `temp`，不要把长期 dashboard 链接当 agent 默认出口。
2. 解析 `--json` 时用 `asset_hash` 做后续操作；`url` / `-q` 给人类点开。
3. 有项目上下文时始终加 `--project`，避免 `temp`/`find` 命中同名文件。
4. 不要把 `ASSETS_KEY` 或 Access Secret 写进回复、日志或提交。
5. `health` / `whoami` 可做连通性自检。
