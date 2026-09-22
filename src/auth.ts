/**
 * Two independent authentication paths:
 *
 *  - uploads use long-lived "upload keys" whose SHA-256 lives in D1 (the
 *    cleartext is only ever shown once, at creation time);
 *  - the dashboard uses Cloudflare Access. Access already stops unauthorised
 *    browsers at the edge, but the worker re-verifies the signed assertion on
 *    every request so the API is still safe if a route is ever published
 *    without an Access application in front of it.
 */

import { HttpError, digestEquals, sha256Hex } from './util';
import { first, run, type ApiKeyRow } from './db';

export interface ApiKeyIdentity {
  kind: 'key';
  key: ApiKeyRow;
  actor: string;
}

export interface AccessIdentity {
  kind: 'access';
  actor: string;
  email: string | null;
  serviceToken: string | null;
}

export type Identity = ApiKeyIdentity | AccessIdentity;

export function extractPresentedKey(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (header) {
    const [scheme, ...rest] = header.split(' ');
    if (scheme.toLowerCase() === 'bearer' && rest.length > 0) return rest.join(' ').trim();
  }
  // Query strings land in access logs. The key is header-only.
  const dedicated = request.headers.get('x-assets-key');
  if (!dedicated) return null;
  const trimmed = dedicated.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Returns the identity, or `null` when the presented key is wrong *and* the
 * caller should be counted as a failed attempt.
 */
export async function authenticateUploadKey(env: Env, request: Request): Promise<ApiKeyIdentity | null> {
  const presented = extractPresentedKey(request);
  if (!presented) return null;
  const keyHash = await sha256Hex(presented);
  const row = await first<ApiKeyRow>(env, 'SELECT * FROM api_keys WHERE key_hash = ?', keyHash);
  if (!row) return null;
  if (!(await digestEquals(row.key_hash, keyHash))) return null;
  if (row.revoked_at !== null) {
    throw new HttpError(401, 'key_revoked', 'this upload key has been revoked');
  }
  return { kind: 'key', key: row, actor: `key:${row.name}` };
}

/** Best-effort usage bookkeeping; never allowed to fail a request. */
export function touchUploadKey(env: Env, ctx: ExecutionContext, keyId: string, ip: string | null): void {
  ctx.waitUntil(
    run(
      env,
      'UPDATE api_keys SET last_used_at = ?, last_used_ip = ?, use_count = use_count + 1 WHERE id = ?',
      Date.now(),
      ip,
      keyId,
    ).catch(() => undefined),
  );
}

// ---------------------------------------------------------------------------
// Cloudflare Access assertion verification
// ---------------------------------------------------------------------------

interface Jwk {
  kid: string;
  kty: string;
  n?: string;
  e?: string;
}

interface JwksResponse {
  keys?: Jwk[];
}

const JWKS_TTL_MS = 10 * 60 * 1000;
let memoryJwks: { keys: Jwk[]; fetchedAt: number } | null = null;

/** Test hook. */
export function resetAccessCaches(): void {
  memoryJwks = null;
}

function base64UrlToBytes(value: string): Uint8Array {
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(401, 'invalid_assertion', 'malformed Access assertion');
  }
}

function decodeJson<T>(segment: string): T {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment))) as T;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(401, 'invalid_assertion', 'malformed Access assertion');
  }
}

async function loadJwks(env: Env, force = false): Promise<Jwk[]> {
  const fresh = memoryJwks && Date.now() - memoryJwks.fetchedAt < JWKS_TTL_MS;
  if (fresh && !force) return memoryJwks!.keys;
  const url = `https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`;
  const response = await fetch(url, { cf: { cacheTtl: 300 } });
  if (!response.ok) throw new HttpError(503, 'access_unavailable', `cannot load Access keys (${response.status})`);
  const body = (await response.json()) as JwksResponse;
  const keys = body.keys ?? [];
  if (keys.length === 0) throw new HttpError(503, 'access_unavailable', 'Access returned no signing keys');
  memoryJwks = { keys, fetchedAt: Date.now() };
  return keys;
}

function allowedEmails(env: Env): string[] {
  return env.ACCESS_ALLOWED_EMAILS.split(',')
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value !== '');
}

export function accessConfigured(env: Env): boolean {
  return env.ACCESS_TEAM_DOMAIN.trim() !== '' && env.ACCESS_AUD.trim() !== '';
}

interface AccessClaims {
  aud?: string | string[];
  iss?: string;
  email?: string;
  common_name?: string;
  exp?: number;
  nbf?: number;
  iat?: number;
}

export async function verifyAccessJwt(env: Env, token: string, now = Date.now()): Promise<AccessClaims> {
  if (!accessConfigured(env)) {
    throw new HttpError(503, 'access_not_configured', 'Cloudflare Access is not wired up yet; see docs/DEPLOY.md');
  }
  const parts = token.split('.');
  if (parts.length !== 3) throw new HttpError(401, 'invalid_assertion', 'malformed Access assertion');
  const [headerSegment, payloadSegment, signatureSegment] = parts;
  const header = decodeJson<{ alg?: string; kid?: string }>(headerSegment);
  if (header.alg !== 'RS256' || !header.kid) {
    throw new HttpError(401, 'invalid_assertion', 'unsupported Access assertion header');
  }

  const verifyWith = async (keys: Jwk[]): Promise<boolean> => {
    const jwk = keys.find((candidate) => candidate.kid === header.kid);
    if (!jwk) return false;
    const key = await crypto.subtle.importKey(
      'jwk',
      { ...jwk, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    try {
      return await crypto.subtle.verify(
        'RSASSA-PKCS1-v1_5',
        key,
        base64UrlToBytes(signatureSegment),
        new TextEncoder().encode(`${headerSegment}.${payloadSegment}`),
      );
    } catch (error) {
      if (error instanceof HttpError) throw error;
      return false;
    }
  };

  let keys = await loadJwks(env);
  if (!(await verifyWith(keys))) {
    // The signing key may simply have rotated; retry once against fresh keys.
    keys = await loadJwks(env, true);
    if (!(await verifyWith(keys))) throw new HttpError(401, 'invalid_assertion', 'bad Access assertion signature');
  }

  const claims = decodeJson<AccessClaims>(payloadSegment);
  const audiences = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
  if (!audiences.includes(env.ACCESS_AUD)) {
    throw new HttpError(401, 'invalid_assertion', 'Access assertion was issued for another application');
  }
  const expectedIssuer = `https://${env.ACCESS_TEAM_DOMAIN.trim()}`;
  if (claims.iss !== expectedIssuer) {
    throw new HttpError(401, 'invalid_assertion', 'Access assertion was issued by another team');
  }
  const seconds = now / 1000;
  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) {
    throw new HttpError(401, 'invalid_assertion', 'Access assertion is missing exp');
  }
  if (claims.exp + 30 < seconds) {
    throw new HttpError(401, 'assertion_expired', 'Access session expired, reload the page');
  }
  if (typeof claims.nbf === 'number' && claims.nbf - 30 > seconds) {
    throw new HttpError(401, 'invalid_assertion', 'Access assertion is not valid yet');
  }
  return claims;
}

export async function requireAccessIdentity(env: Env, request: Request): Promise<AccessIdentity> {
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token) {
    throw new HttpError(401, 'access_required', 'sign in through Cloudflare Access to use the dashboard');
  }
  const claims = await verifyAccessJwt(env, token);

  if (claims.email) {
    const email = claims.email.toLowerCase();
    const allowlist = allowedEmails(env);
    if (allowlist.length > 0 && !allowlist.includes(email)) {
      throw new HttpError(403, 'not_allowed', `${claims.email} is not on the dashboard allowlist`);
    }
    return { kind: 'access', actor: email, email, serviceToken: null };
  }

  if (claims.common_name) {
    if (env.ACCESS_ALLOW_SERVICE_TOKENS !== 'true') {
      throw new HttpError(403, 'service_tokens_disabled', 'Access service tokens are disabled for this service');
    }
    return {
      kind: 'access',
      actor: `token:${claims.common_name}`,
      email: null,
      serviceToken: claims.common_name,
    };
  }

  throw new HttpError(403, 'not_allowed', 'Access assertion carries no identity');
}

// ---------------------------------------------------------------------------
// Upload keys
// ---------------------------------------------------------------------------

const KEY_PREFIX = 'ak_';

export async function createUploadKey(
  env: Env,
  name: string,
  actor: string,
): Promise<{ id: string; secret: string; prefix: string }> {
  const secret = `${KEY_PREFIX}${[...crypto.getRandomValues(new Uint8Array(24))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')}`;
  const id = crypto.randomUUID();
  await run(
    env,
    `INSERT INTO api_keys (id, name, key_hash, prefix, created_at, created_by, use_count)
     VALUES (?, ?, ?, ?, ?, ?, 0)`,
    id,
    name,
    await sha256Hex(secret),
    secret.slice(0, 10),
    Date.now(),
    actor,
  );
  return { id, secret, prefix: secret.slice(0, 10) };
}
