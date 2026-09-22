# Notes for agents working in this repository

`talkincode-assets` is a Cloudflare Worker (TypeScript, no runtime dependencies) that
stores immutable assets and serves them through expiring share links, plus a dashboard
behind Cloudflare Access.

## Model

- **Asset** (`assets.hash`): immutable identity; bytes kept until manual delete.
- **Link** (`links.hash`): public locator in `/<hash>/<filename>`; own `expires_at`.
- **Project** (`projects.slug`): optional folder for assets; filter with `?project=` / CLI `--project`.
- Upload creates asset + first link. Public GET resolves **link** hash only.
- Agent temporary links: `POST /admin/api/assets/:hash/temp-link` — hard max **4 hours**.

## Commands

```bash
npm run types      # regenerate worker-configuration.d.ts from wrangler.toml (needed for tsc)
npm run typecheck  # tsc --noEmit
npm test           # vitest inside workerd: real D1/R2/DO bindings, not mocks
npm run deploy     # wrangler deploy (assets.talkincode.net)
```

## Layout

- `src/index.ts` — routing entry; `sweep()` runs hourly (trash only; not link expiry).
- `src/assets.ts` — public read via links → assets.
- `src/links.ts` — hash allocation, TTL helpers, temp-link 4h cap.
- `src/upload.ts` — streams to R2; writes asset + first link.
- `src/admin.ts` — `/admin/api/*` behind Access (links, temp-link, content editor).
- `src/auth.ts` — upload keys + Access JWT (fail-closed).
- `src/abuse*.ts` — brute-force blocking on failed lookups.
- `public/admin/` — dashboard (plain HTML/CSS/JS).
- `cli/assets.mjs` — agent-friendly CLI (`temp`, `find`, `put --json`).

## Useful facts

- Uploads need `ASSETS_KEY`; admin commands need `CF_ACCESS_CLIENT_ID`/`SECRET`.
  Env file: `~/.config/talkincode-assets/env`.
- Agent share pattern:
  `./cli/assets.mjs --env-file ~/.config/talkincode-assets/env temp <asset|query> --expire 1h -q`
- `put --json` returns `asset_hash`, `hash` (link), and `url`.
- Keep `schema.sql` as the readable source of truth for the data model.
