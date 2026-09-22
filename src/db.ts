/**
 * D1 access layer: one place that knows the asset row shape and the settings
 * lookup, so route handlers never hand-write SQL for common reads.
 */

import { assetKind, type AssetKind } from './util';

export interface AssetRow {
  hash: string;
  object_key: string;
  filename: string;
  content_type: string;
  size: number;
  etag: string | null;
  note: string | null;
  key_id: string | null;
  uploader_ip: string | null;
  uploader_agent: string | null;
  created_at: number;
  expires_at: number | null;
  deleted_at: number | null;
  delete_reason: string | null;
  purged_at: number | null;
  downloads: number;
  last_access_at: number | null;
}

export interface ApiKeyRow {
  id: string;
  name: string;
  key_hash: string;
  prefix: string;
  created_at: number;
  created_by: string | null;
  last_used_at: number | null;
  last_used_ip: string | null;
  use_count: number;
  revoked_at: number | null;
}

export async function first<T>(env: Env, sql: string, ...params: unknown[]): Promise<T | null> {
  const row = await env.DB.prepare(sql)
    .bind(...params)
    .first<T>();
  return row ?? null;
}

export async function all<T>(env: Env, sql: string, ...params: unknown[]): Promise<T[]> {
  const result = await env.DB.prepare(sql)
    .bind(...params)
    .all<T>();
  return result.results ?? [];
}

export async function run(env: Env, sql: string, ...params: unknown[]): Promise<D1Result<unknown>> {
  return env.DB.prepare(sql)
    .bind(...params)
    .run();
}

export async function getAsset(env: Env, hash: string): Promise<AssetRow | null> {
  return first<AssetRow>(env, 'SELECT * FROM assets WHERE hash = ?', hash);
}

export interface AssetView extends AssetRow {
  kind: AssetKind;
  status: 'live' | 'expired' | 'deleted' | 'purged';
  url_path: string;
}

export function describeAsset(asset: AssetRow, now: number): AssetView {
  const status = asset.purged_at
    ? 'purged'
    : asset.deleted_at
      ? 'deleted'
      : asset.expires_at !== null && asset.expires_at <= now
        ? 'expired'
        : 'live';
  return {
    ...asset,
    kind: assetKind(asset.content_type),
    status,
    url_path: `/${asset.hash}/${encodeURIComponent(asset.filename)}`,
  };
}

const SETTINGS_CACHE_MS = 5_000;
const settingsCache = new Map<string, { value: string; at: number }>();

export async function getSetting(env: Env, key: string, fallback: string): Promise<string> {
  const cached = settingsCache.get(key);
  if (cached && Date.now() - cached.at < SETTINGS_CACHE_MS) return cached.value;
  const row = await first<{ v: string }>(env, 'SELECT v FROM settings WHERE k = ?', key);
  const value = row?.v ?? fallback;
  settingsCache.set(key, { value, at: Date.now() });
  return value;
}

export async function setSetting(env: Env, key: string, value: string): Promise<void> {
  await run(env, 'INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', key, value);
  settingsCache.delete(key);
}

/** Test hook: the settings cache is per-isolate, so tests need a way to drop it. */
export function resetSettingsCache(): void {
  settingsCache.clear();
}

export async function getNumberSetting(env: Env, key: string, fallback: number): Promise<number> {
  const raw = await getSetting(env, key, String(fallback));
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

export interface AuditEntry {
  actor: string;
  action: string;
  target?: string | null;
  ip?: string | null;
  detail?: string | null;
}

export async function audit(env: Env, entry: AuditEntry): Promise<void> {
  await run(
    env,
    'INSERT INTO audit_log (at, actor, action, target, ip, detail) VALUES (?, ?, ?, ?, ?, ?)',
    Date.now(),
    entry.actor,
    entry.action,
    entry.target ?? null,
    entry.ip ?? null,
    entry.detail ?? null,
  );
}

export interface BlockedSourceRow {
  source: string;
  strikes: number;
  misses: number;
  blocked_until: number;
  first_seen: number;
  last_seen: number;
  detail: string | null;
}

/**
 * The blocking decision lives in the AbuseGuard durable object; this table is
 * the dashboard-visible mirror of it.
 */
export async function recordBlockedSource(env: Env, row: BlockedSourceRow): Promise<void> {
  await run(
    env,
    `INSERT INTO blocked_sources (source, strikes, misses, blocked_until, first_seen, last_seen, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source) DO UPDATE SET
       strikes = excluded.strikes,
       misses = excluded.misses,
       blocked_until = excluded.blocked_until,
       last_seen = excluded.last_seen,
       detail = excluded.detail`,
    row.source,
    row.strikes,
    row.misses,
    row.blocked_until,
    row.first_seen,
    row.last_seen,
    row.detail,
  );
}

export async function clearBlockedSource(env: Env, source: string): Promise<void> {
  await run(env, 'DELETE FROM blocked_sources WHERE source = ?', source);
}
