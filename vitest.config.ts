import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

/**
 * Tests run inside workerd against the real bindings declared in wrangler.toml
 * (D1, R2, Durable Object, rate limits). The miniflare overrides below replace
 * the Access team domain with a fixture and shorten the abuse threshold so the
 * escalation ladder can be exercised in a few requests.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: {
        bindings: {
          ACCESS_TEAM_DOMAIN: 'test.cloudflareaccess.com',
          ACCESS_AUD: 'test-aud-tag',
          ACCESS_ALLOWED_EMAILS: 'jamiesun.net@gmail.com',
          ABUSE_MISS_THRESHOLD: '3',
          CACHE_TTL_SECONDS: '60',
        },
      },
    }),
  ],
  test: {
    setupFiles: ['./test/setup.ts'],
    // Nested checkouts (agent worktrees, vendored copies) must not be picked up:
    // two suites in one miniflare share D1 and would fight over settings.
    exclude: ['**/node_modules/**', '**/dist/**', '**/.delta/**'],
  },
});
