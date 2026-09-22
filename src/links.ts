/**
 * Share-link helpers: allocate hashes that stay unique across both assets and
 * links, resolve TTL for a new link, and present link rows to admin clients.
 */

import { HttpError, hashProblem, parseDuration, parseTimestamp, randomHash } from './util';
import { first, getNumberSetting, run, type LinkRow } from './db';

/** Hard ceiling for agent/CLI temporary share links (4 hours). */
export const TEMP_LINK_MAX_SECONDS = 4 * 60 * 60;

export async function hashTaken(env: Env, hash: string): Promise<boolean> {
  const asset = await first<{ hash: string }>(env, 'SELECT hash FROM assets WHERE hash = ?', hash);
  if (asset) return true;
  const link = await first<{ hash: string }>(env, 'SELECT hash FROM links WHERE hash = ?', hash);
  return Boolean(link);
}

/** Allocate a free random hash, or validate a requested one is unused. */
export async function allocateHash(env: Env, requested: string | null): Promise<string> {
  if (requested !== null) {
    const problem = hashProblem(requested);
    if (problem) throw new HttpError(400, 'invalid_hash', problem);
    if (await hashTaken(env, requested)) {
      throw new HttpError(409, 'hash_taken', 'that hash is already in use');
    }
    return requested;
  }
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = randomHash();
    if (!(await hashTaken(env, candidate))) return candidate;
  }
  throw new HttpError(500, 'internal_error', 'failed to allocate a free hash; retry');
}

/**
 * Resolve link expiry from query/headers/body fields.
 * Returns `undefined` when the caller did not supply any expiry hint (so the
 * default TTL policy can be applied by the caller).
 */
export function parseExpiryHint(input: {
  expires_in?: unknown;
  expires_at?: unknown;
  never?: unknown;
  ttl?: unknown;
}): number | null | undefined {
  if (input.never === true) return null;
  if (input.expires_at !== undefined && input.expires_at !== null) {
    return parseTimestamp(String(input.expires_at));
  }
  const ttl = input.expires_in ?? input.ttl;
  if (ttl !== undefined && ttl !== null) {
    const seconds = parseDuration(String(ttl));
    return seconds === null ? null : Date.now() + seconds * 1000;
  }
  return undefined;
}

export async function defaultLinkExpiry(env: Env, now = Date.now()): Promise<number | null> {
  const defaultDays = await getNumberSetting(env, 'default_ttl_days', Number(env.DEFAULT_TTL_DAYS) || 7);
  if (defaultDays <= 0) return null;
  return now + defaultDays * 86_400_000;
}

export async function resolveLinkExpiry(
  env: Env,
  hint: number | null | undefined,
  now = Date.now(),
): Promise<number | null> {
  if (hint !== undefined) return hint;
  return defaultLinkExpiry(env, now);
}

/**
 * Temporary (agent/CLI) links must expire, and within TEMP_LINK_MAX_SECONDS.
 * Returns the absolute expires_at timestamp.
 */
export function resolveTempLinkExpiry(
  expiresIn: unknown,
  now = Date.now(),
  defaultSeconds = 60 * 60,
): number {
  let seconds = defaultSeconds;
  if (expiresIn !== undefined && expiresIn !== null && String(expiresIn) !== '') {
    if (String(expiresIn) === 'never') {
      throw new HttpError(400, 'temp_link_ttl', `temporary links must expire within ${TEMP_LINK_MAX_SECONDS / 3600}h`);
    }
    const parsed = parseDuration(String(expiresIn));
    if (parsed === null) {
      throw new HttpError(400, 'temp_link_ttl', `temporary links must expire within ${TEMP_LINK_MAX_SECONDS / 3600}h`);
    }
    seconds = parsed;
  }
  if (seconds <= 0 || seconds > TEMP_LINK_MAX_SECONDS) {
    throw new HttpError(
      400,
      'temp_link_ttl',
      `temporary link expiry must be between 1s and ${TEMP_LINK_MAX_SECONDS / 3600}h`,
    );
  }
  return now + seconds * 1000;
}

export function isLinkLive(link: LinkRow, now = Date.now()): boolean {
  if (link.revoked_at !== null) return false;
  if (link.expires_at !== null && link.expires_at <= now) return false;
  return true;
}

export function linkStatus(link: LinkRow, now = Date.now()): 'live' | 'expired' | 'revoked' {
  if (link.revoked_at !== null) return 'revoked';
  if (link.expires_at !== null && link.expires_at <= now) return 'expired';
  return 'live';
}

export function linkUrl(env: Env, linkHash: string, filename: string): string {
  return `${env.PUBLIC_BASE_URL}/${linkHash}/${encodeURIComponent(filename)}`;
}

export function linkSummary(env: Env, link: LinkRow, filename: string, now = Date.now()) {
  return {
    hash: link.hash,
    asset_hash: link.asset_hash,
    expires_at: link.expires_at,
    label: link.label,
    created_at: link.created_at,
    created_by: link.created_by,
    revoked_at: link.revoked_at,
    downloads: link.downloads,
    last_access_at: link.last_access_at,
    status: linkStatus(link, now),
    url: linkUrl(env, link.hash, filename),
  };
}

export interface CreateLinkInput {
  assetHash: string;
  expiresAt: number | null;
  label?: string | null;
  createdBy: string;
  requestedHash?: string | null;
  now?: number;
}

export async function insertLink(env: Env, input: CreateLinkInput): Promise<LinkRow> {
  const now = input.now ?? Date.now();
  const hash = await allocateHash(env, input.requestedHash ?? null);
  const label = input.label === undefined || input.label === null || input.label === ''
    ? null
    : String(input.label).slice(0, 80);
  await run(
    env,
    `INSERT INTO links (hash, asset_hash, expires_at, label, created_at, created_by, downloads)
     VALUES (?, ?, ?, ?, ?, ?, 0)`,
    hash,
    input.assetHash,
    input.expiresAt,
    label,
    now,
    input.createdBy,
  );
  const row = await first<LinkRow>(env, 'SELECT * FROM links WHERE hash = ?', hash);
  if (!row) throw new HttpError(500, 'internal_error', 'link insert did not persist');
  return row;
}
