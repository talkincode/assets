/**
 * Dashboard API. Every route runs behind a verified Cloudflare Access identity
 * (see `requireAccessIdentity`) and writes an audit entry for anything that
 * changes state.
 */

import {
  HttpError,
  assetKind,
  clampInt,
  errorResponse,
  hashProblem,
  jsonResponse,
  nowMs,
  parseDuration,
  parseTimestamp,
  randomHash,
  requireString,
  sanitizeFilename,
  toErrorResponse,
} from './util';
import { Router, type Ctx } from './router';
import { all, audit, first, getNumberSetting, run, setSetting, type AssetRow } from './db';
import { createUploadKey } from './auth';
import { handleUpload, uploadPolicy } from './upload';
import { assetCacheUrls, purgeUrls } from './cache';
import { requireAccessIdentity } from './auth';
import { clientIp, guardReset } from './abuse';
import { assetSummary } from './assets';

const MAX_PAGE_SIZE = 200;

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.trim() === '') return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'invalid_json', 'request body must be a JSON object');
  }
}

const KIND_FILTERS: Record<string, string> = {
  image: "content_type LIKE 'image/%'",
  audio: "content_type LIKE 'audio/%'",
  video: "content_type LIKE 'video/%'",
  text: "content_type LIKE 'text/%'",
};

async function loadAssetOr404(env: Env, hash: string): Promise<AssetRow> {
  const asset = await first<AssetRow>(env, 'SELECT * FROM assets WHERE hash = ?', hash);
  if (!asset) throw new HttpError(404, 'not_found', `no asset with hash ${hash}`);
  return asset;
}

/** Purge every cached variant of an asset at its current and previous hash. */
async function purgeAsset(env: Env, exec: ExecutionContext, hash: string, filename: string): Promise<void> {
  await purgeUrls(env, exec, assetCacheUrls(env, hash, filename));
}

const router = new Router();

router.get('/me', (ctx) => {
  const identity = ctx.identity!;
  const access = identity.kind === 'access' ? identity : null;
  return jsonResponse({
    actor: identity.actor,
    email: access?.email ?? null,
    service_token: access?.serviceToken ?? null,
    public_base_url: ctx.env.PUBLIC_BASE_URL,
  });
});

router.get('/stats', async (ctx) => {
  const { env } = ctx;
  const now = nowMs();
  const totals = await first<{
    total: number;
    live: number;
    expired: number;
    deleted: number;
    bytes: number;
    live_bytes: number;
    downloads: number;
  }>(
    env,
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN deleted_at IS NULL AND (expires_at IS NULL OR expires_at > ?1) THEN 1 ELSE 0 END) AS live,
            SUM(CASE WHEN deleted_at IS NULL AND expires_at IS NOT NULL AND expires_at <= ?1 THEN 1 ELSE 0 END) AS expired,
            SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS deleted,
            SUM(size) AS bytes,
            SUM(CASE WHEN deleted_at IS NULL AND (expires_at IS NULL OR expires_at > ?1) THEN size ELSE 0 END) AS live_bytes,
            SUM(downloads) AS downloads
     FROM assets`,
    now,
  );
  const byType = await all<{ content_type: string; n: number; bytes: number }>(
    env,
    `SELECT content_type, COUNT(*) AS n, SUM(size) AS bytes
     FROM assets WHERE deleted_at IS NULL GROUP BY content_type`,
  );
  const kinds: Record<string, { count: number; bytes: number }> = {};
  for (const row of byType) {
    const kind = assetKind(row.content_type);
    kinds[kind] = kinds[kind] ?? { count: 0, bytes: 0 };
    kinds[kind].count += row.n;
    kinds[kind].bytes += row.bytes ?? 0;
  }
  const blocked = await first<{ n: number }>(
    env,
    'SELECT COUNT(*) AS n FROM blocked_sources WHERE blocked_until > ?',
    now,
  );
  const keys = await first<{ n: number }>(
    env,
    'SELECT COUNT(*) AS n FROM api_keys WHERE revoked_at IS NULL',
  );
  return jsonResponse({
    assets: {
      total: totals?.total ?? 0,
      live: totals?.live ?? 0,
      expired: totals?.expired ?? 0,
      deleted: totals?.deleted ?? 0,
      bytes: totals?.bytes ?? 0,
      live_bytes: totals?.live_bytes ?? 0,
      downloads: totals?.downloads ?? 0,
      kinds,
    },
    blocked_sources: blocked?.n ?? 0,
    upload_keys: keys?.n ?? 0,
    policy: await uploadPolicy(env),
    now,
  });
});

router.get('/assets', async (ctx) => {
  const { env, url } = ctx;
  const q = url.searchParams.get('q')?.trim() ?? '';
  const status = url.searchParams.get('status') ?? 'live';
  const kind = url.searchParams.get('kind') ?? '';
  const limit = clampInt(url.searchParams.get('limit'), 1, MAX_PAGE_SIZE, 50);
  const offset = clampInt(url.searchParams.get('offset'), 0, 1_000_000, 0);
  const now = nowMs();

  const where: string[] = [];
  const binds: unknown[] = [];
  switch (status) {
    case 'live':
      where.push('deleted_at IS NULL AND (expires_at IS NULL OR expires_at > ?)');
      binds.push(now);
      break;
    case 'expired':
      where.push('deleted_at IS NULL AND expires_at IS NOT NULL AND expires_at <= ?');
      binds.push(now);
      break;
    case 'deleted':
      where.push('deleted_at IS NOT NULL');
      break;
    case 'all':
      break;
    default:
      throw new HttpError(400, 'invalid_status', 'status must be live|expired|deleted|all');
  }
  if (kind && KIND_FILTERS[kind]) {
    where.push(KIND_FILTERS[kind]);
  } else if (kind === 'other') {
    where.push("NOT (content_type LIKE 'image/%' OR content_type LIKE 'audio/%' OR content_type LIKE 'video/%' OR content_type LIKE 'text/%')");
  }
  if (q) {
    where.push('(hash LIKE ? OR filename LIKE ? OR note LIKE ?)');
    binds.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const total = await first<{ n: number }>(env, `SELECT COUNT(*) AS n FROM assets ${whereSql}`, ...binds);
  const rows = await all<AssetRow>(
    env,
    `SELECT * FROM assets ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    ...binds,
    limit,
    offset,
  );
  return jsonResponse({
    total: total?.n ?? 0,
    limit,
    offset,
    assets: rows.map((row) => assetSummary(env, row, now)),
  });
});

router.post('/assets', (ctx) => {
  const identity = ctx.identity!;
  return handleUpload(ctx, { actor: identity.actor, keyId: null });
});

router.get('/assets/:hash', async (ctx) => {
  const asset = await loadAssetOr404(ctx.env, ctx.params.hash);
  const trail = await all<{ at: number; actor: string; action: string; detail: string | null }>(
    ctx.env,
    'SELECT at, actor, action, detail FROM audit_log WHERE target = ? ORDER BY at DESC LIMIT 25',
    ctx.params.hash,
  );
  return jsonResponse({ asset: assetSummary(ctx.env, asset), audit: trail });
});

router.patch('/assets/:hash', async (ctx) => {
  const { env } = ctx;
  const hash = ctx.params.hash;
  const asset = await loadAssetOr404(env, hash);
  const body = await readJson(ctx.request);
  const updates: string[] = [];
  const binds: unknown[] = [];

  if ('expires_in' in body) {
    const seconds = parseDuration(body.expires_in as string);
    updates.push('expires_at = ?');
    binds.push(seconds === null ? null : nowMs() + seconds * 1000);
  } else if ('expires_at' in body) {
    updates.push('expires_at = ?');
    binds.push(parseTimestamp(body.expires_at as string));
  } else if (body.never === true) {
    updates.push('expires_at = NULL');
  }
  if ('filename' in body) {
    updates.push('filename = ?');
    binds.push(sanitizeFilename(requireString(body.filename, 'filename'), asset.filename));
  }
  if ('note' in body) {
    updates.push('note = ?');
    binds.push(body.note === null ? null : String(body.note).slice(0, 500));
  }
  if (updates.length === 0) {
    throw new HttpError(400, 'nothing_to_update', 'pass expires_in, expires_at, never, filename or note');
  }

  await run(env, `UPDATE assets SET ${updates.join(', ')} WHERE hash = ?`, ...binds, hash);
  await purgeAsset(env, ctx.exec, hash, asset.filename);
  await audit(env, {
    actor: ctx.identity!.actor,
    action: 'update',
    target: hash,
    ip: clientIp(ctx.request),
    detail: JSON.stringify(body).slice(0, 400),
  });
  const updated = await loadAssetOr404(env, hash);
  return jsonResponse({ asset: assetSummary(env, updated) });
});

router.post('/assets/:hash/rotate', async (ctx) => {
  const { env } = ctx;
  const asset = await loadAssetOr404(env, ctx.params.hash);
  const body = await readJson(ctx.request);
  const requested = body.hash === undefined || body.hash === null ? null : String(body.hash);
  if (requested !== null) {
    const problem = hashProblem(requested);
    if (problem) throw new HttpError(400, 'invalid_hash', problem);
    const clash = await first<{ hash: string }>(env, 'SELECT hash FROM assets WHERE hash = ?', requested);
    if (clash) throw new HttpError(409, 'hash_taken', 'that hash is already in use');
  }
  const next = requested ?? randomHash();
  await run(env, 'UPDATE assets SET hash = ? WHERE hash = ?', next, asset.hash);
  // The old link must stop working immediately; the new one starts cold.
  await purgeAsset(env, ctx.exec, asset.hash, asset.filename);
  await audit(env, {
    actor: ctx.identity!.actor,
    action: 'rotate',
    target: next,
    ip: clientIp(ctx.request),
    detail: `previous hash ${asset.hash}`,
  });
  const updated = await loadAssetOr404(env, next);
  return jsonResponse({
    asset: assetSummary(env, updated),
    previous_hash: asset.hash,
    previous_url: `${env.PUBLIC_BASE_URL}/${asset.hash}/${encodeURIComponent(asset.filename)}`,
  });
});

router.delete('/assets/:hash', async (ctx) => {
  const { env, url } = ctx;
  const asset = await loadAssetOr404(env, ctx.params.hash);
  const hard = url.searchParams.get('purge') === '1' || url.searchParams.get('hard') === '1';

  if (hard) {
    await env.BUCKET.delete(asset.object_key);
    await run(env, 'DELETE FROM assets WHERE hash = ?', asset.hash);
  } else {
    const retentionDays = await getNumberSetting(env, 'trash_retention_days', Number(env.TRASH_RETENTION_DAYS) || 7);
    await run(
      env,
      'UPDATE assets SET deleted_at = ?, delete_reason = ? WHERE hash = ?',
      nowMs(),
      'manual',
      asset.hash,
    );
    if (retentionDays <= 0) {
      await env.BUCKET.delete(asset.object_key);
      await run(env, 'UPDATE assets SET purged_at = ? WHERE hash = ?', nowMs(), asset.hash);
    }
  }

  await purgeAsset(env, ctx.exec, asset.hash, asset.filename);
  await audit(env, {
    actor: ctx.identity!.actor,
    action: hard ? 'delete:hard' : 'delete',
    target: asset.hash,
    ip: clientIp(ctx.request),
    detail: asset.filename,
  });
  return jsonResponse({ deleted: asset.hash, hard });
});

router.post('/assets/:hash/restore', async (ctx) => {
  const { env } = ctx;
  const asset = await loadAssetOr404(env, ctx.params.hash);
  if (asset.purged_at !== null) {
    throw new HttpError(409, 'purged', 'the bytes for this asset are gone; the row is metadata only');
  }
  const body = await readJson(ctx.request);
  if ('expires_in' in body) {
    const seconds = parseDuration(body.expires_in as string);
    await run(
      env,
      'UPDATE assets SET deleted_at = NULL, delete_reason = NULL, expires_at = ? WHERE hash = ?',
      seconds === null ? null : nowMs() + seconds * 1000,
      asset.hash,
    );
  } else {
    await run(env, 'UPDATE assets SET deleted_at = NULL, delete_reason = NULL WHERE hash = ?', asset.hash);
  }
  await purgeAsset(env, ctx.exec, asset.hash, asset.filename);
  await audit(env, { actor: ctx.identity!.actor, action: 'restore', target: asset.hash, ip: clientIp(ctx.request) });
  const updated = await loadAssetOr404(env, asset.hash);
  return jsonResponse({ asset: assetSummary(env, updated) });
});

router.get('/keys', async (ctx) => {
  const keys = await all<Record<string, unknown>>(
    ctx.env,
    `SELECT id, name, prefix, created_at, created_by, last_used_at, last_used_ip, use_count, revoked_at
     FROM api_keys ORDER BY created_at DESC`,
  );
  return jsonResponse({ keys });
});

router.post('/keys', async (ctx) => {
  const body = await readJson(ctx.request);
  const name = requireString(body.name, 'name').slice(0, 80);
  const created = await createUploadKey(ctx.env, name, ctx.identity!.actor);
  await audit(ctx.env, {
    actor: ctx.identity!.actor,
    action: 'key:create',
    target: created.id,
    ip: clientIp(ctx.request),
    detail: name,
  });
  return jsonResponse({ ...created, warning: 'copy this secret now; it is not stored anywhere' }, { status: 201 });
});

router.delete('/keys/:id', async (ctx) => {
  const { env } = ctx;
  const existing = await first<{ id: string; revoked_at: number | null }>(
    env,
    'SELECT id, revoked_at FROM api_keys WHERE id = ?',
    ctx.params.id,
  );
  if (!existing) throw new HttpError(404, 'not_found', 'no such key');
  if (existing.revoked_at === null) {
    await run(env, 'UPDATE api_keys SET revoked_at = ? WHERE id = ?', nowMs(), ctx.params.id);
    await audit(env, {
      actor: ctx.identity!.actor,
      action: 'key:revoke',
      target: ctx.params.id,
      ip: clientIp(ctx.request),
    });
  }
  return jsonResponse({ revoked: ctx.params.id });
});

router.get('/abuse', async (ctx) => {
  const now = nowMs();
  const rows = await all<{
    source: string;
    strikes: number;
    misses: number;
    blocked_until: number;
    first_seen: number;
    last_seen: number;
    detail: string | null;
  }>(
    ctx.env,
    `SELECT source, strikes, misses, blocked_until, first_seen, last_seen, detail
     FROM blocked_sources ORDER BY (blocked_until > ?1) DESC, last_seen DESC LIMIT 200`,
    now,
  );
  // History is kept for context, but the dashboard needs to know which rows are
  // still in force.
  const blocked = rows.map((row) => ({ ...row, active: row.blocked_until > now }));
  return jsonResponse({
    blocked,
    active: blocked.filter((row) => row.active).length,
    threshold: ctx.env.ABUSE_MISS_THRESHOLD,
    ban_schedule: ctx.env.ABUSE_BAN_SCHEDULE,
    strike_decay_hours: ctx.env.ABUSE_STRIKE_DECAY_HOURS,
  });
});

router.delete('/abuse/:source', async (ctx) => {
  await guardReset(ctx.env, ctx.params.source);
  await audit(ctx.env, {
    actor: ctx.identity!.actor,
    action: 'abuse:unblock',
    target: ctx.params.source,
    ip: clientIp(ctx.request),
  });
  return jsonResponse({ unblocked: ctx.params.source });
});

router.get('/audit', async (ctx) => {
  const limit = clampInt(ctx.url.searchParams.get('limit'), 1, 200, 50);
  const entries = await all<Record<string, unknown>>(
    ctx.env,
    'SELECT id, at, actor, action, target, ip, detail FROM audit_log ORDER BY at DESC LIMIT ?',
    limit,
  );
  return jsonResponse({ entries });
});

router.get('/settings', async (ctx) => {
  const rows = await all<{ k: string; v: string }>(ctx.env, 'SELECT k, v FROM settings ORDER BY k');
  return jsonResponse({
    settings: Object.fromEntries(rows.map((row) => [row.k, row.v])),
    read_only: {
      default_ttl_days: ctx.env.DEFAULT_TTL_DAYS,
      max_upload_bytes: ctx.env.MAX_UPLOAD_BYTES,
      cache_ttl_seconds: ctx.env.CACHE_TTL_SECONDS,
      trash_retention_days: ctx.env.TRASH_RETENTION_DAYS,
      abuse_miss_threshold: ctx.env.ABUSE_MISS_THRESHOLD,
      access_allowed_emails: ctx.env.ACCESS_ALLOWED_EMAILS,
      access_configured: ctx.env.ACCESS_AUD !== '' && ctx.env.ACCESS_TEAM_DOMAIN !== '',
    },
  });
});

const EDITABLE_SETTINGS = new Set(['default_ttl_days', 'max_upload_bytes', 'trash_retention_days']);

router.patch('/settings', async (ctx) => {
  const body = await readJson(ctx.request);
  const applied: Record<string, string> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!EDITABLE_SETTINGS.has(key)) throw new HttpError(400, 'unknown_setting', `${key} is not editable`);
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0) {
      throw new HttpError(400, 'invalid_setting', `${key} must be a non-negative number`);
    }
    await setSetting(ctx.env, key, String(Math.trunc(numeric)));
    applied[key] = String(Math.trunc(numeric));
  }
  if (Object.keys(applied).length === 0) throw new HttpError(400, 'nothing_to_update', 'no settings provided');
  await audit(ctx.env, {
    actor: ctx.identity!.actor,
    action: 'settings:update',
    ip: clientIp(ctx.request),
    detail: JSON.stringify(applied),
  });
  return jsonResponse({ settings: applied });
});

router.get('/policy', async (ctx) => jsonResponse(await uploadPolicy(ctx.env)));

export async function handleAdminRequest(ctx: Ctx): Promise<Response> {
  try {
    const identity = await requireAccessIdentity(ctx.env, ctx.request);
    const response = await router.handle({ ...ctx, identity }, '/admin/api');
    if (response) return response;
    return errorResponse(404, 'not_found', 'unknown admin endpoint');
  } catch (error) {
    return toErrorResponse(error);
  }
}
