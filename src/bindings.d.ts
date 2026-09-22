/**
 * Bindings that are not declared in `wrangler.toml`, so `wrangler types` cannot
 * know about them. Keep this list short and in sync with docs/DEPLOY.md.
 */
interface Env {
  /** `wrangler secret put CF_PURGE_TOKEN` — enables instant global cache purge. */
  CF_PURGE_TOKEN?: string;
}
