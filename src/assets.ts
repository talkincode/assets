/**
 * Public read path: GET|HEAD /<hash>/<filename?>
 *
 * The hash alone identifies the bytes; the filename is decoration that also
 * decides the download name, which is why an arbitrary name is accepted and
 * sanitised rather than validated against the stored one.
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
import { describeAsset, getAsset, run, type AssetRow } from './db';
import type { Ctx } from './router';
import { canonicalAssetUrl } from './cache';
import { isBlocked, registerMiss, withinRequestBudget } from './abuse';

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

function cacheSeconds(env: Env, asset: AssetRow, now: number): number {
  const configured = Math.max(0, Number.parseInt(env.CACHE_TTL_SECONDS, 10) || 60);
  if (asset.expires_at === null) return configured;
  const remaining = Math.max(0, Math.floor((asset.expires_at - now) / 1000));
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
  // is somebody guessing, and guessing is what the guard counts. In the first
  // hours after deployment this caught two scanners probing /.env.prod.
  const problem = hashProblem(hash);
  if (problem) {
    if (RESERVED_SEGMENTS.has(hash.toLowerCase())) return notFound();
    const verdict = await registerMiss(env, request, `malformed hash: ${hash.slice(0, 32)}`);
    if (verdict.blocked) return blockedResponse(verdict.retryAfter);
    return notFound();
  }

  const now = Date.now();
  const asset = await getAsset(env, hash);
  if (!asset) {
    const verdict = await registerMiss(env, request, 'unknown hash');
    if (verdict.blocked) return blockedResponse(verdict.retryAfter);
    return notFound();
  }
  // Expiry is answered before the sweep gets to it, and keeps answering 410
  // afterwards, so the status a client sees does not depend on when
  // housekeeping happened to run.
  if (asset.expires_at !== null && asset.expires_at <= now) {
    const headers = new Headers({
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    });
    applyDocumentGuards(headers);
    return new Response('this asset has expired\n', { status: 410, headers });
  }
  if (asset.purged_at !== null) return notFound();
  if (asset.deleted_at !== null) return notFound();

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
  headers.set('cache-control', `public, max-age=${cacheSeconds(env, asset, now)}`);

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
    const cached = await caches.default.match(cacheRequest(env, asset.hash));
    if (cached) {
      headers.set('content-length', String(asset.size));
      // Headers are rebuilt for this request. Only the bytes are cached, so a
      // junk query or a different filename cannot mint a new cache entry.
      return new Response(cached.body, { status: 200, headers });
    }
  }

  const object = await env.BUCKET.get(asset.object_key, range ? { range } : undefined);
  if (!object) {
    // Metadata without bytes: the sweeper is behind or the object was removed.
    return notFound({ 'x-assets-state': 'metadata-only' });
  }

  const body = 'body' in object ? object.body : null;
  headers.set('content-length', String(range ? range.length : asset.size));
  if (range) {
    headers.set('content-range', `bytes ${range.offset}-${range.offset + range.length - 1}/${asset.size}`);
  }

  const response = new Response(body, { status: range ? 206 : 200, headers });
  if (!range) {
    ctx.exec.waitUntil(countDownload(env, asset));
    ctx.exec.waitUntil(caches.default.put(cacheRequest(env, asset.hash), response.clone()));
  }
  return response;
}

function cacheRequest(env: Env, hash: string): Request {
  return new Request(canonicalAssetUrl(env.PUBLIC_BASE_URL, hash), { method: 'GET' });
}

function countDownload(env: Env, asset: AssetRow): Promise<unknown> {
  return run(
    env,
    'UPDATE assets SET downloads = downloads + 1, last_access_at = ? WHERE hash = ?',
    Date.now(),
    asset.hash,
  ).catch(() => undefined);
}

/** Shared by the admin list so the dashboard and the CLI agree on shape. */
export function assetSummary(env: Env, asset: AssetRow, now = Date.now()) {
  const view = describeAsset(asset, now);
  return {
    ...view,
    url: `${env.PUBLIC_BASE_URL}${view.url_path}`,
  };
}
