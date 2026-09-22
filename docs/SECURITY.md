# 安全模型

## 链接即凭证

外链地址形如 `https://assets.talkincode.net/<hash>/<filename>`，其中

- `hash` 是 22 位 base58 随机串（`crypto.getRandomValues` + 拒绝采样，约 128 bit 熵），
  由服务端生成，命中概率可以忽略；
- `filename` 只影响下载名，不参与定位，可任意；路径穿越、控制字符、引号在写响应头前被清理；
- `admin`、`api`、`health`、`favicon.ico` 等保留路径永远不可能成为 hash。

自定义 hash（`?hash=` / `--hash`）要求 16–64 位 `[A-Za-z0-9_-]`，其余一律 400：
弱 hash 会把“不可猜”降级成“可猜”，所以下限卡在 16 位（约 96 bit）。

删除、换 hash、改过期都会让旧链接立刻失效（受缓存传播上限约束，见下）。

## 上传密钥

- 密钥形如 `ak_<48 位 hex>`，服务端只存 **SHA-256**，明文仅在创建响应里出现一次；
- 校验时用 `crypto.subtle.timingSafeEqual` 比较摘要，避免时序侧信道；
- 可创建多把，按用途命名（`laptop`、`ci`、`agent-x`）；吊销立即生效，并记录
  `last_used_at` / `last_used_ip` / `use_count` 方便排查；
- 第一把密钥可以离线生成（`scripts/bootstrap-key.mjs`），不依赖 dashboard 是否已配好 SSO。

## Dashboard 鉴权（Cloudflare Access）

- Access 应用只覆盖 `assets.talkincode.net/admin`（含 `/admin/api/*`），策略为
  `allow` + 邮箱白名单 `jamiesun.net@gmail.com`，会话 24 小时；
- Worker **不信任**边缘结果，每个管理请求都会：
  1. 取 `Cf-Access-Jwt-Assertion`，用团队域发布（并缓存 10 分钟）的 JWKS 按 `kid` 验签（RS256）；
  2. 校验 `aud` 必须等于本应用的 AUD；
  3. 校验 `exp` / `nbf`（30 秒容差）；
  4. 校验身份：邮箱必须在 `ACCESS_ALLOWED_EMAILS` 里，或（可选）Access Service Token 的
     `common_name`（`ACCESS_ALLOW_SERVICE_TOKENS=true`）。
- `ACCESS_AUD` / `ACCESS_TEAM_DOMAIN` 为空时管理接口直接 503：宁可不可用，不可出错放行。
- 因此把 `/admin` 暴露到别的域名（例如 workers.dev）也不会泄露数据，只会得到 401。

## 暴力破解阻断

两条独立防线，只有**失败**请求会被记账：

1. **边缘限流**（`wrangler.toml` 的 `[[ratelimits]]`）
   - `READ_LIMITER`：每来源网络 1200 次/分钟
   - `MISS_LIMITER`：猜错 40 次/分钟
   - `UPLOAD_LIMITER`：每密钥 120 次/分钟

2. **状态化封禁**（`AbuseGuard` Durable Object，每个来源网络一份）
   - 来源按 IPv4 `/24`、IPv6 `/64` 聚合，换 IP 无法绕过；
   - 统计窗口（默认 600 秒）内累计猜错 15 次 → 封禁；
   - 封禁时长按 `ABUSE_BAN_SCHEDULE` 逐次加倍：5 分钟 → 1 小时 → 1 天 → 7 天；
   - 命中次数触发上限后计数归零，但 strike 保留 7 天（可调 `STRIKE_DECAY` 常量），
     也就是说“惯犯”的起罚点越来越重；
   - 被封禁的来源在所有失败路径与上传接口上直接 403 + `Retry-After`；
   - dashboard「安全防护」页可查看与解封（会同时清掉 D1 镜像与 DO 状态）。

猜错的对象包括：格式非法的 hash、不存在的 hash、错误的上传密钥。正常下载不触发任何记账。

> 由于 hash 有 128 bit 熵，穷举本身不可行；这套机制的目的是挡住资源滥用（探测、
> 刷量、密钥爆破）并留下可观察的痕迹，而不是“防止猜中”。

## 响应头与内容

| 头 | 处理 |
| --- | --- |
| `Content-Disposition` | 文件名过滤控制字符/引号/路径分隔符，按 RFC 5987 输出 `filename*=UTF-8''…` |
| `Content-Type` | 上传声明优先，其次按扩展名推断；未知类型为 `application/octet-stream` |
| `Cache-Control` | `public, max-age=min(剩余有效期, CACHE_TTL_SECONDS)`，不给已删除内容二次缓存的机会 |
| `Access-Control-Allow-Origin` | 默认 `*`（公开内容，可嵌入）；需要收紧就改 `CORS_ORIGIN` |
| `X-Assets-State: metadata-only` | 元数据在但字节已被清理时的 404 提示 |

服务不设置 `Set-Cookie`，不做 HTML 渲染，dashboard 是静态文件且带 `noindex`。

## 缓存与删除的传播

内容按 URL 不可变，所以边缘缓存是安全的，但删除必须赢：

- 默认 `CACHE_TTL_SECONDS=60`：删除/过期后，其他机房最多再服务 60 秒旧副本；
- 变更时先在处理请求的机房用 `caches.default.delete` 清除；
- 配置 `CF_PURGE_TOKEN` 后会调用 Cloudflare 精确 URL 清除接口，全网立即生效。

## 数据与生命周期

- 字节在 R2（key 与 hash 解耦，换 hash 不需要搬数据）；
- 元数据、密钥摘要、审计记录在 D1；`audit_log` 记录谁在什么时候删了/改了哪个 hash；
- 过期资产每小时由 cron 释放字节并写 `purged_at`；手动删除的资产保留
  `TRASH_RETENTION_DAYS`（默认 7 天）以便误删恢复。

## 已知限制

- 单文件上限受 Workers 请求体限制（当前默认 100 MiB）；chunked 上传（无
  `Content-Length`）为了给 R2 提供已知长度需要缓冲，上限 25 MB，超出返回 411；
- `Content-Length` 与实际 body 不符时以流错误结束，不会落库；
- Access Service Token 一旦签发就长期有效（默认 1 年），请放 CI secret 里并定期轮换；
- 反滥用状态保存在 DO 内，`ABUSE_*` 改动需重新部署生效；
- 若把 `/admin` 以外的新管理路径加到 Worker，记得同步 Access 应用的 path 与
  `handleAdminRequest` 的调用点。
