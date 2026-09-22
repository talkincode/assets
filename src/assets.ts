/**
 * Public read path: GET|HEAD /<hash>/<filename?>
 *
 * The path hash is a share-link locator. Filename only affects Content-Disposition.
 */

import {
  contentDisposition,
  errorResponse,
  guessContentType,
  hashProblem,
  isActiveContent,
  isPreviewable,
  RESERVED_SEGMENTS,
  sanitizeFilename,
} from './util';
import {
  all,
  describeAsset,
  getLink,
  projectRef,
  projectsByIds,
  run,
  type AssetRow,
  type LinkRow,
  type ProjectRef,
} from './db';
import type { Ctx } from './router';
import { canonicalAssetUrl } from './cache';
import { isBlocked, registerMiss, withinRequestBudget } from './abuse';
import { isLinkLive, linkUrl } from './links';

const RANGE_PATTERN = /^bytes=(\d*)-(\d*)$/;

/** Stop a stored file from being sniffed or executed as a same-origin document. */
function applyDocumentGuards(headers: Headers): void {
  headers.set('x-content-type-options', 'nosniff');
  headers.set('content-security-policy', 'sandbox');
}

function notFound(headers: HeadersInit = {}): Response {
  const merged = new Headers(headers);
  merged.set('cache-control', 'no-store');
  applyDocumentGuards(merged);
  return new Response('not found\n', { status: 404, headers: merged });
}

function gone(message: string): Response {
  const headers = new Headers({
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  });
  applyDocumentGuards(headers);
  return new Response(`${message}\n`, { status: 410, headers });
}

function blockedResponse(retryAfter: number): Response {
  const headers = new Headers({
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'retry-after': String(retryAfter),
  });
  applyDocumentGuards(headers);
  return new Response('too many failed lookups from this network\n', {
    status: 403,
    headers,
  });
}

function corsHeaders(env: Env): Headers {
  const headers = new Headers();
  headers.set('access-control-allow-origin', env.CORS_ORIGIN || '*');
  headers.set('access-control-allow-methods', 'GET, HEAD, OPTIONS');
  headers.set('access-control-allow-headers', 'range, if-none-match, if-modified-since');
  headers.set('access-control-expose-headers', 'content-length, content-range, etag, content-disposition');
  return headers;
}

export function parseRange(header: string | null, size: number): { offset: number; length: number } | null {
  if (!header) return null;
  const match = RANGE_PATTERN.exec(header.trim());
  if (!match) return null;
  const [, startRaw, endRaw] = match;
  if (startRaw === '' && endRaw === '') return null;
  if (startRaw === '') {
    const suffix = Number.parseInt(endRaw, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    const length = Math.min(suffix, size);
    return { offset: Math.max(0, size - length), length };
  }
  const offset = Number.parseInt(startRaw, 10);
  if (!Number.isFinite(offset) || offset >= size) return null;
  const end = endRaw === '' ? size - 1 : Math.min(Number.parseInt(endRaw, 10), size - 1);
  if (!Number.isFinite(end) || end < offset) return null;
  return { offset, length: end - offset + 1 };
}

function etagFor(asset: AssetRow): string {
  return asset.etag ? `"${asset.etag}"` : `"${asset.hash}-${asset.size}"`;
}

function downloadMode(url: URL, contentType: string): 'inline' | 'attachment' {
  // `?inline=1` must not turn HTML/SVG/XML/JS back into a same-origin document.
  if (isActiveContent(contentType)) return 'attachment';
  if (url.searchParams.get('dl') === '1' || url.searchParams.has('download')) return 'attachment';
  if (url.searchParams.get('inline') === '1') return 'inline';
  return isPreviewable(contentType) ? 'inline' : 'attachment';
}

function cacheSeconds(env: Env, link: LinkRow, now: number): number {
  const configured = Math.max(0, Number.parseInt(env.CACHE_TTL_SECONDS, 10) || 60);
  if (link.expires_at === null) return configured;
  const remaining = Math.max(0, Math.floor((link.expires_at - now) / 1000));
  return Math.min(configured, remaining);
}

export async function handleAssetRequest(ctx: Ctx): Promise<Response> {
  const { request, env, url } = ctx;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(env) });
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return errorResponse(405, 'method_not_allowed', 'assets are read-only on this path');
  }

  // A banned network is refused before any hash lookup, including hits.
  // Otherwise 200 vs 403 still tells a scanner which hashes exist.
  const blocked = await isBlocked(env, request);
  if (blocked.blocked) return blockedResponse(blocked.retryAfter);

  if (!(await withinRequestBudget(env, request))) {
    return blockedResponse(60);
  }

  const hash = ctx.params.hash;

  // Reserved service paths (favicon, robots, admin…) answer quietly: a browser
  // asking for one is not an attack. Everything else that is not a valid hash
  // is somebody guessing, and guessing is what the guard counts.
  const problem = hashProblem(hash);
  if (problem) {
    if (RESERVED_SEGMENTS.has(hash.toLowerCase())) return notFound();
    const verdict = await registerMiss(env, request, `malformed hash: ${hash.slice(0, 32)}`);
    if (verdict.blocked) return blockedResponse(verdict.retryAfter);
    return notFound();
  }

  const now = Date.now();
  const link = await getLink(env, hash);
  if (!link) {
    const verdict = await registerMiss(env, request, 'unknown hash');
    if (verdict.blocked) return blockedResponse(verdict.retryAfter);
    return notFound();
  }
  if (link.revoked_at !== null) return notFound();
  if (link.expires_at !== null && link.expires_at <= now) {
    return gone('this link has expired');
  }

  const asset = await env.DB.prepare('SELECT * FROM assets WHERE hash = ?')
    .bind(link.asset_hash)
    .first<AssetRow>();
  if (!asset || asset.purged_at !== null || asset.deleted_at !== null) {
    return notFound();
  }

  const requested = sanitizeFilename(ctx.params.filename ?? asset.filename, asset.filename);
  const filename = requested || asset.filename;
  const contentType = guessContentType(filename, asset.content_type);
  const mode = downloadMode(url, contentType);
  const headers = corsHeaders(env);
  applyDocumentGuards(headers);
  headers.set('content-type', contentType);
  headers.set('content-disposition', contentDisposition(filename, mode));
  headers.set('etag', etagFor(asset));
  headers.set('accept-ranges', 'bytes');
  headers.set('cache-control', `public, max-age=${cacheSeconds(env, link, now)}`);

  const inm = request.headers.get('if-none-match');
  if (inm && inm.split(',').some((value) => value.trim() === etagFor(asset))) {
    return new Response(null, { status: 304, headers });
  }

  const range = parseRange(request.headers.get('range'), asset.size);
  if (request.method === 'HEAD') {
    headers.set('content-length', String(range ? range.length : asset.size));
    if (range) headers.set('content-range', `bytes ${range.offset}-${range.offset + range.length - 1}/${asset.size}`);
    return new Response(null, { status: range ? 206 : 200, headers });
  }

  if (!range) {
    const cached = await caches.default.match(cacheRequest(env, link.hash));
    if (cached) {
      headers.set('content-length', String(asset.size));
      return new Response(cached.body, { status: 200, headers });
    }
  }

  const object = await env.BUCKET.get(asset.object_key, range ? { range } : undefined);
  if (!object) {
    return notFound({ 'x-assets-state': 'metadata-only' });
  }

  const body = 'body' in object ? object.body : null;
  headers.set('content-length', String(range ? range.length : asset.size));
  if (range) {
    headers.set('content-range', `bytes ${range.offset}-${range.offset + range.length - 1}/${asset.size}`);
  }

  const response = new Response(body, { status: range ? 206 : 200, headers });
  if (!range) {
    ctx.exec.waitUntil(countDownload(env, link.hash));
    ctx.exec.waitUntil(caches.default.put(cacheRequest(env, link.hash), response.clone()));
  }
  return response;
}

function cacheRequest(env: Env, hash: string): Request {
  return new Request(canonicalAssetUrl(env.PUBLIC_BASE_URL, hash), { method: 'GET' });
}

function countDownload(env: Env, linkHash: string): Promise<unknown> {
  return run(
    env,
    'UPDATE links SET downloads = downloads + 1, last_access_at = ? WHERE hash = ?',
    Date.now(),
    linkHash,
  ).catch(() => undefined);
}

/** Shared by the admin list so the dashboard and the CLI agree on shape. */
export function assetSummary(
  env: Env,
  asset: AssetRow,
  now = Date.now(),
  extras: {
    live_links?: number;
    downloads?: number;
    url?: string | null;
    primary_link_hash?: string | null;
    project?: ProjectRef | null;
  } = {},
) {
  const view = describeAsset(asset, now, {
    live_links: extras.live_links,
    downloads: extras.downloads,
  });
  return {
    ...view,
    url: extras.url ?? null,
    primary_link_hash: extras.primary_link_hash ?? null,
    project: extras.project ?? null,
  };
}

/** Attach project refs to summarized assets that already carry project_id. */
export async function withProjects<T extends { project_id: string | null }>(
  env: Env,
  rows: T[],
): Promise<(T & { project: ProjectRef | null })[]> {
  const map = await projectsByIds(
    env,
    rows.map((row) => row.project_id).filter((id): id is string => Boolean(id)),
  );
  return rows.map((row) => ({
    ...row,
    project: projectRef(row.project_id ? map.get(row.project_id) : null),
  }));
}

/** Load live-link aggregates for a set of asset hashes. */
export async function linkStatsForAssets(
  env: Env,
  hashes: string[],
  now = Date.now(),
): Promise<Map<string, { live_links: number; downloads: number; primary_hash: string | null }>> {
  const map = new Map<string, { live_links: number; downloads: number; primary_hash: string | null }>();
  for (const hash of hashes) {
    map.set(hash, { live_links: 0, downloads: 0, primary_hash: null });
  }
  if (hashes.length === 0) return map;

  const placeholders = hashes.map(() => '?').join(',');
  const rows = await all<{
    asset_hash: string;
    hash: string;
    expires_at: number | null;
    revoked_at: number | null;
    downloads: number;
    created_at: number;
  }>(
    env,
    `SELECT asset_hash, hash, expires_at, revoked_at, downloads, created_at
     FROM links WHERE asset_hash IN (${placeholders})
     ORDER BY created_at DESC`,
    ...hashes,
  );
  for (const row of rows) {
    const entry = map.get(row.asset_hash)!;
    entry.downloads += row.downloads;
    const live = isLinkLive(row as LinkRow, now);
    if (live) {
      entry.live_links += 1;
      if (!entry.primary_hash) entry.primary_hash = row.hash;
    }
  }
  return map;
}

export function summarizeAssetWithLinks(
  env: Env,
  asset: AssetRow,
  stats: { live_links: number; downloads: number; primary_hash: string | null },
  now = Date.now(),
  project: ProjectRef | null = null,
) {
  const url = stats.primary_hash ? linkUrl(env, stats.primary_hash, asset.filename) : null;
  return assetSummary(env, asset, now, {
    live_links: stats.live_links,
    downloads: stats.downloads,
    url,
    primary_link_hash: stats.primary_hash,
    project,
  });
}

// Re-export so call sites that only need the type keep working.
export type { LinkRow };
