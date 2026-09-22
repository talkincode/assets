/**
 * D1 access layer: one place that knows the asset/link row shapes and the
 * settings lookup, so route handlers never hand-write SQL for common reads.
 */

import { assetKind, decodeTags, type AssetKind } from './util';

export interface ProjectRow {
  id: string;
  slug: string;
  name: string;
  note: string | null;
  created_at: number;
  archived_at: number | null;
}

export interface ProjectRef {
  id: string;
  slug: string;
  name: string;
}

export interface AssetRow {
  hash: string;
  object_key: string;
  filename: string;
  content_type: string;
  size: number;
  etag: string | null;
  note: string | null;
  tags: string | null;
  project_id: string | null;
  key_id: string | null;
  uploader_ip: string | null;
  uploader_agent: string | null;
  created_at: number;
  deleted_at: number | null;
  delete_reason: string | null;
  purged_at: number | null;
}

export interface LinkRow {
  hash: string;
  asset_hash: string;
  expires_at: number | null;
  label: string | null;
  created_at: number;
  created_by: string | null;
  revoked_at: number | null;
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

export async function getLink(env: Env, hash: string): Promise<LinkRow | null> {
  return first<LinkRow>(env, 'SELECT * FROM links WHERE hash = ?', hash);
}

export async function getProject(env: Env, id: string): Promise<ProjectRow | null> {
  return first<ProjectRow>(env, 'SELECT * FROM projects WHERE id = ?', id);
}

export async function getProjectBySlug(env: Env, slug: string): Promise<ProjectRow | null> {
  return first<ProjectRow>(env, 'SELECT * FROM projects WHERE slug = ?', slug);
}

export function projectRef(row: ProjectRow | null | undefined): ProjectRef | null {
  if (!row) return null;
  return { id: row.id, slug: row.slug, name: row.name };
}

/** Load project refs for a set of ids (skips missing / empty). */
export async function projectsByIds(env: Env, ids: string[]): Promise<Map<string, ProjectRow>> {
  const unique = [...new Set(ids.filter(Boolean))];
  const map = new Map<string, ProjectRow>();
  if (unique.length === 0) return map;
  const placeholders = unique.map(() => '?').join(',');
  const rows = await all<ProjectRow>(
    env,
    `SELECT * FROM projects WHERE id IN (${placeholders})`,
    ...unique,
  );
  for (const row of rows) map.set(row.id, row);
  return map;
}

export interface AssetView extends Omit<AssetRow, 'tags'> {
  tags: string[];
  kind: AssetKind;
  status: 'live' | 'expired' | 'deleted' | 'purged';
  live_links: number;
  downloads: number;
}

export function describeAsset(
  asset: AssetRow,
  now: number,
  extras: { live_links?: number; downloads?: number } = {},
): AssetView {
  const liveLinks = extras.live_links ?? 0;
  const status = asset.purged_at
    ? 'purged'
    : asset.deleted_at
      ? 'deleted'
      : liveLinks === 0
        ? 'expired'
        : 'live';
  return {
    ...asset,
    tags: decodeTags(asset.tags),
    kind: assetKind(asset.content_type),
    status,
    live_links: liveLinks,
    downloads: extras.downloads ?? 0,
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
