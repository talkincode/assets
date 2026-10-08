# Notes for agents working in this repository

`talkincode-assets` is a Cloudflare Worker (TypeScript) that stores immutable
assets and serves them through expiring share links, plus a dashboard behind
Cloudflare Access and a remote MCP server (Streamable HTTP + MCP OAuth) for
the Cloudflare MCP Portal.

## Model

- **Asset** (`assets.hash`): immutable identity; bytes kept until manual delete.
- **Link** (`links.hash`): public locator in `/<hash>/<filename>`; own `expires_at`.
- **Project** (`projects.slug`): optional folder for assets; filter with `?project=` / CLI `--project`.
- Upload creates asset + first link. Public GET resolves **link** hash only.
- Agent temporary links: `POST /admin/api/assets/:hash/temp-link` — hard max **4 hours**.
- MCP upload sessions (`upload_sessions`): single-use, complete with PUT within
  ≤4h (default 1h); swept hourly when expired unused.
- MCP OAuth scopes: `assets:read` < `assets:write` < `assets:admin` (broader
  implies narrower). Every MCP tool/resource/prompt checks scopes explicitly
  (`scopeDenied`/`needScope` in `src/mcp.ts`) — the installed MCP SDK has no
  protocol-level scope challenges, so never rely on one.

## Commands

```bash
npm run types      # regenerate worker-configuration.d.ts from wrangler.toml (needed for tsc)
npm run typecheck  # tsc --noEmit
npm test           # vitest inside workerd: real D1/R2/DO bindings, not mocks
npm run deploy     # wrangler deploy (assets.talkincode.net)
```

## Layout

- `src/index.ts` — OAuthProvider wiring (MCP at `/mcp`, authorize at
  `/authorize`); everything else falls through to `route()`; `sweep()` runs
  hourly (trash, expired sessions, OAuth purge; not link expiry).
- `src/assets.ts` — public read via links → assets.
- `src/links.ts` — hash allocation, TTL helpers, temp-link 4h cap.
- `src/upload.ts` — streams to R2; writes asset + first link.
- `src/admin.ts` — `/admin/api/*` behind Access (links, temp-link, content editor).
- `src/auth.ts` — upload keys + Access JWT (fail-closed).
- `src/service.ts` — shared asset/link rules used by dashboard and MCP.
- `src/mcp.ts` — MCP protocol layer: server factory (tools/resources/prompts)
  plus scope gates; business logic stays in `service.ts`.
- `src/mcp-auth.ts` — `/authorize` consent page (Access members only).
- `src/mcp-http.ts` — OAuth-protected dispatch: `/mcp` → MCP handler,
  `/mcp/uploads/:id` → session byte sink.
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
- `MCP_RESOURCE`/`MCP_ISSUER` in `src/mcp.ts` must equal
  `PUBLIC_BASE_URL` + `/mcp` (pinned by `test/mcp.spec.ts`).
