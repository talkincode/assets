# Notes for agents working in this repository

`talkincode-assets` is a Cloudflare Worker (TypeScript, no runtime dependencies) that
serves hash-addressed assets plus a dashboard behind Cloudflare Access.

## Commands

```bash
npm run types      # regenerate worker-configuration.d.ts from wrangler.toml (needed for tsc)
npm run typecheck  # tsc --noEmit
npm test           # vitest inside workerd: real D1/R2/DO bindings, not mocks
npm run deploy     # wrangler deploy (assets.talkincode.net)
```

## Layout

- `src/index.ts` — routing entry; `sweep()` runs hourly via the cron trigger.
- `src/assets.ts` — public read path (`/<hash>/<filename>`): range, ETag, cache, expiry.
- `src/upload.ts` — the only write path for bytes; streams to R2 with a size guard.
- `src/admin.ts` — `/admin/api/*`, always behind a verified Access identity.
- `src/auth.ts` — upload keys (SHA-256 in D1) and Access JWT verification (fail-closed).
- `src/abuse*.ts` — two-layer brute-force blocking; only failures are counted.
- `public/admin/` — dashboard, plain HTML/CSS/JS, no build step.
- `cli/assets.mjs` — the CLI agents should use for uploads and admin actions.

## Useful facts

- Uploads need `ASSETS_KEY`; admin commands need `CF_ACCESS_CLIENT_ID`/`SECRET`.
  A ready-made env file lives at `~/.config/talkincode-assets/env` — run admin commands as
  `./cli/assets.mjs --env-file ~/.config/talkincode-assets/env <cmd>`.
- `./cli/assets.mjs put <file> --json` is the machine-readable path.
- Asset URLs are `PUBLIC_BASE_URL + "/" + hash + "/" + filename`; only the hash locates bytes.
- Tests override `ACCESS_TEAM_DOMAIN` / `ABUSE_MISS_THRESHOLD` in `vitest.config.ts`; the
  Access signing keys are served from `test/access-fixtures.ts` through a stubbed fetch.
- Keep `schema.sql` commented — it is the readable source of truth for the data model.
