/**
 * Cache invalidation for a hash-addressed service.
 *
 * Content is immutable per URL, so edges are free to keep it — but delete and
 * rotate must win. Two mechanisms, cheapest first:
 *
 *  1. `caches.default` purge in the colo that handled the mutation (always on);
 *  2. an exact-URL purge through the Cloudflare API when CF_PURGE_TOKEN is set,
 *     which makes deletes instant everywhere.
 *
 * Without (2) a stale copy can survive at most CACHE_TTL_SECONDS.
 */

/** The only cache key for an asset. Filename and query are not part of it. */
export function canonicalAssetUrl(base: string, hash: string): string {
  return `${base}/${hash}`;
}

/** Legacy key from before cache keys were collapsed to the hash. */
export function publicCacheKey(base: string, hash: string, filename: string, download: boolean): string {
  const url = new URL(`${base}/${hash}/${encodeURIComponent(filename)}`);
  if (download) url.searchParams.set('dl', '1');
  return url.toString();
}

export async function purgeUrls(env: Env, ctx: ExecutionContext, urls: string[]): Promise<void> {
  const unique = [...new Set(urls)];
  for (const url of unique) {
    await caches.default.delete(new Request(url, { method: 'GET' }));
  }
  if (!env.CF_PURGE_TOKEN || !env.CF_ZONE_ID) return;
  // The purge API takes at most 30 URLs per call.
  for (let i = 0; i < unique.length; i += 30) {
    const chunk = unique.slice(i, i + 30);
    ctx.waitUntil(purgeViaApi(env, chunk));
  }
}

async function purgeViaApi(env: Env, urls: string[]): Promise<void> {
  try {
    const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/purge_cache`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.CF_PURGE_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ files: urls }),
    });
    if (!response.ok) console.warn('purge_cache failed', response.status, await response.text());
  } catch (error) {
    console.warn('purge_cache error', error);
  }
}

/**
 * The live cache entry, plus the filename/`dl`/`inline` URLs written before
 * keys were normalized. Those leftovers expire within CACHE_TTL_SECONDS, but
 * a delete should still drop them immediately.
 */
export function assetCacheUrls(env: Env, hash: string, filename: string): string[] {
  const legacy = publicCacheKey(env.PUBLIC_BASE_URL, hash, filename, false);
  const inline = new URL(legacy);
  inline.searchParams.set('inline', '1');
  return [
    canonicalAssetUrl(env.PUBLIC_BASE_URL, hash),
    legacy,
    publicCacheKey(env.PUBLIC_BASE_URL, hash, filename, true),
    inline.toString(),
  ];
}
