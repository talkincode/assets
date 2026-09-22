# CLI

`cli/assets.mjs`：零依赖、纯 Node（≥20），给人和 agent 用。

```bash
./cli/assets.mjs help
```

## 环境变量

| 变量 | 必需 | 说明 |
| --- | --- | --- |
| `ASSETS_BASE_URL` | 否 | 默认 `https://assets.talkincode.net` |
| `ASSETS_KEY` | `put` 需要 | 上传密钥（dashboard 创建，或 `scripts/bootstrap-key.mjs`） |
| `CF_ACCESS_CLIENT_ID` | 管理命令需要 | Access Service Token client id |
| `CF_ACCESS_CLIENT_SECRET` | 管理命令需要 | Access Service Token secret |

CLI 会自动读取工作目录下的 `.env`（已存在的环境变量优先），
也可以用 `--base-url`、`--env-file` 覆盖。部署时 `access:setup --service-token` 会把
Access service token 写到 `~/.config/talkincode-assets/env`（600），所以管理命令通常这样跑：

```bash
./cli/assets.mjs --env-file ~/.config/talkincode-assets/env ls
```

## 输出约定

- 默认：人类可读摘要
- `--json`：完整 JSON（agent 首选）
- `-q` / `--quiet`：只输出一个值（URL、id），方便 `$(...)` 捕获

## 命令

### 上传

```bash
./cli/assets.mjs put ./demo.mp4 --expire 7d --note "产品演示"
./cli/assets.mjs put ./report.pdf --expire never
./cli/assets.mjs put ./image.png --name hero-shot.png --expire 30d
cat ./log.txt | ./cli/assets.mjs put - --name run.log --expire 1d
URL=$(./cli/assets.mjs put ./a.png -q)
./cli/assets.mjs put ./a.png --expire 7d --json | jq -r .url
```

`--expire` 支持 `30m` / `12h` / `7d` / `2w` / 秒数 / `never`；省略则用服务端默认值。

### 查询与管理（需要 Access Service Token）

```bash
./cli/assets.mjs ls --status live --limit 20
./cli/assets.mjs ls --kind video --q demo --json
./cli/assets.mjs show 9fK2mQ7dLpR1sVx8YzA3bC
./cli/assets.mjs expire 9fK2mQ7dLpR1sVx8YzA3bC 30d
./cli/assets.mjs expire 9fK2mQ7dLpR1sVx8YzA3bC never
./cli/assets.mjs rotate 9fK2mQ7dLpR1sVx8YzA3bC          # 随机新 hash
./cli/assets.mjs rotate 9fK2mQ7dLpR1sVx8YzA3bC --hash NewHashValue1234567
./cli/assets.mjs rm 9fK2mQ7dLpR1sVx8YzA3bC              # 软删除，可恢复
./cli/assets.mjs rm 9fK2mQ7dLpR1sVx8YzA3bC --hard       # 彻底删除
./cli/assets.mjs restore 9fK2mQ7dLpR1sVx8YzA3bC --expire 7d
```

### 密钥

```bash
./cli/assets.mjs keys
./cli/assets.mjs key-create agent-ci        # 只显示一次 secret
./cli/assets.mjs key-revoke <key-id>
```

### 安全

```bash
./cli/assets.mjs blocked
./cli/assets.mjs unblock 203.0.113.0%2F24
```

### 其他

```bash
./cli/assets.mjs url 9fK2mQ7dLpR1sVx8YzA3bC demo.mp4   # 只拼外链，不请求服务端
./cli/assets.mjs whoami
./cli/assets.mjs health
```

## Agent 用法示例

```bash
# 上传产物并把外链交给下一步
URL=$(ASSETS_KEY=ak_... ./cli/assets.mjs put ./out/video.mp4 --expire 3d -q)
echo "$URL" >> artifacts.txt

# 收集一批文件的 hash，便于后续统一改期或删除
for f in ./out/*.png; do
  ./cli/assets.mjs put "$f" --expire 30d --json | jq -r '[.hash, .filename, .url] | @tsv'
done
```

退出码：`0` 成功，`1` 失败（原因写 stderr）。被封禁时提示里会说明是反滥用机制。

## 安装为全局命令（可选）

```bash
npm link          # 之后可直接用 `assets put ...`
```
