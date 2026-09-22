/**
 * Upload path, shared by the public key-authenticated endpoint and the
 * dashboard. Both produce the same record; only the recorded actor differs.
 *
 * The body is streamed straight into R2 while a counter enforces the size cap,
 * so a large file never has to be buffered in the worker.
 */

import {
  HttpError,
  errorResponse,
  guessContentType,
  hashProblem,
  jsonResponse,
  normalizeTags,
  parseDuration,
  parseTimestamp,
  randomHash,
  sanitizeFilename,
  serializeTags,
} from './util';
import { audit, first, getNumberSetting, run } from './db';
import type { Ctx } from './router';
import { clientIp } from './abuse';

export interface UploadActor {
  /** For the audit log: an email, a service token name, or `key:<name>`. */
  actor: string;
  keyId: string | null;
}

function filenameFromRequest(request: Request, url: URL): string {
  const explicit = url.searchParams.get('filename') ?? request.headers.get('x-filename');
  if (explicit) return sanitizeFilename(explicit);
  const disposition = request.headers.get('content-disposition');
  if (disposition) {
    const extended = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
    if (extended) {
      try {
        return sanitizeFilename(decodeURIComponent(extended[1]));
      } catch {
        throw new HttpError(400, 'invalid_filename', 'Content-Disposition filename is not valid percent-encoding');
      }
    }
    const plain = /filename="?([^";]+)"?/i.exec(disposition);
    if (plain) return sanitizeFilename(plain[1]);
  }
  return 'download';
}

async function resolveExpiry(env: Env, request: Request, url: URL, now: number): Promise<number | null> {
  const headerTtl = request.headers.get('x-expires-in');
  const headerAt = request.headers.get('x-expires-at');
  const ttlRaw = url.searchParams.get('expires_in') ?? url.searchParams.get('ttl') ?? headerTtl;
  const atRaw = url.searchParams.get('expires_at') ?? headerAt;

  if (atRaw !== null && atRaw !== undefined) return parseTimestamp(atRaw);
  if (ttlRaw !== null && ttlRaw !== undefined) {
    const seconds = parseDuration(ttlRaw);
    return seconds === null ? null : now + seconds * 1000;
  }
  const defaultDays = await getNumberSetting(env, 'default_ttl_days', Number(env.DEFAULT_TTL_DAYS) || 7);
  if (defaultDays <= 0) return null;
  return now + defaultDays * 86_400_000;
}

/**
 * R2 will only accept a body whose length it knows up front, so:
 *  - a declared `Content-Length` is verified against the cap and streamed
 *    through a FixedLengthStream (no buffering, no truncation);
 *  - a body without `Content-Length` is refused (411) instead of buffered.
 *    Chunked uploads used to pin up to 25 MB per request in the isolate.
 *
 * A `Content-Length` that understates the real body makes the stream error out
 * rather than storing a truncated object.
 */
async function r2Body(request: Request, maxBytes: number): Promise<{ body: ReadableStream; expectedSize: number }> {
  const declaredHeader = request.headers.get('content-length');
  const stream = request.body;
  if (!stream) throw new HttpError(400, 'empty_body', 'request has no body');
  if (declaredHeader === null) {
    throw new HttpError(411, 'length_required', 'Content-Length is required');
  }

  const declared = Number(declaredHeader);
  if (!Number.isFinite(declared) || declared < 0) {
    throw new HttpError(400, 'invalid_length', 'Content-Length is not a number');
  }
  if (declared > maxBytes) {
    throw new HttpError(413, 'too_large', `upload exceeds the ${maxBytes} byte limit`);
  }
  if (declared === 0) throw new HttpError(400, 'empty_body', 'refusing to store an empty object');
  const fixed = new FixedLengthStream(declared);
  // Must not be awaited: the put below is what drives the readable half.
  stream.pipeTo(fixed.writable).catch(() => undefined);
  return { body: fixed.readable, expectedSize: declared };
}

function isUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : '';
  return /unique constraint failed/i.test(`${message}\n${cause}`);
}

export async function handleUpload(ctx: Ctx, actor: UploadActor): Promise<Response> {
  const { request, env, url } = ctx;
  if (request.method !== 'POST' && request.method !== 'PUT') {
    return errorResponse(405, 'method_not_allowed', 'upload with POST or PUT');
  }

  const limiter = env.UPLOAD_LIMITER;
  if (limiter) {
    const { success } = await limiter.limit({ key: actor.actor });
    if (!success) return errorResponse(429, 'rate_limited', 'too many uploads, slow down');
  }

  const maxBytes = await getNumberSetting(env, 'max_upload_bytes', Number(env.MAX_UPLOAD_BYTES) || 104_857_600);
  const declared = Number(request.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    return errorResponse(413, 'too_large', `upload exceeds the ${maxBytes} byte limit`);
  }
  if (!request.body) return errorResponse(400, 'empty_body', 'request has no body');

  const now = Date.now();
  const filename = filenameFromRequest(request, url);
  const contentType = guessContentType(filename, request.headers.get('content-type'));

  const requestedHash = url.searchParams.get('hash') ?? request.headers.get('x-hash');
  if (requestedHash !== null) {
    const problem = hashProblem(requestedHash);
    if (problem) throw new HttpError(400, 'invalid_hash', problem);
    const existing = await first<{ hash: string }>(env, 'SELECT hash FROM assets WHERE hash = ?', requestedHash);
    if (existing) throw new HttpError(409, 'hash_taken', 'that hash is already in use');
  }
  const hash = requestedHash ?? randomHash();

  const expiresAt = await resolveExpiry(env, request, url, now);
  const noteRaw = url.searchParams.get('note') ?? request.headers.get('x-note');
  // Same ceiling as the dashboard PATCH, so a header cannot store an unbounded note.
  const note = noteRaw === null ? null : noteRaw.slice(0, 500);
  // Tags stay in the query string (or a JSON-ish header of ASCII-safe commas).
  const tagsRaw = url.searchParams.get('tags') ?? request.headers.get('x-tags');
  const tags = tagsRaw === null ? [] : normalizeTags(tagsRaw);
  const tagsJson = serializeTags(tags);
  const objectKey = `objects/${randomHash(26)}`;

  let size = 0;
  let etag: string | null = null;
  let stored = false;
  try {
    const { body, expectedSize } = await r2Body(request, maxBytes);
    size = expectedSize;
    const object = await env.BUCKET.put(objectKey, body, {
      httpMetadata: { contentType },
      customMetadata: {
        hash,
        filename,
        expiresAt: expiresAt === null ? 'never' : new Date(expiresAt).toISOString(),
      },
    });
    stored = true;
    etag = object?.etag ?? null;
    if (object?.size !== undefined) size = object.size;
  } catch (error) {
    if (stored) await env.BUCKET.delete(objectKey).catch(() => undefined);
    if (error instanceof HttpError) return errorResponse(error.status, error.code, error.message);
    // The R2/stream message is an internal detail; the client only gets a fixed code.
    console.error('upload failed', error);
    return errorResponse(400, 'upload_failed', 'upload failed');
  }

  if (size === 0) {
    await env.BUCKET.delete(objectKey);
    return errorResponse(400, 'empty_body', 'refusing to store an empty object');
  }

  try {
    await run(
      env,
      `INSERT INTO assets (hash, object_key, filename, content_type, size, etag, note, tags, key_id,
                           uploader_ip, uploader_agent, created_at, expires_at, downloads)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      hash,
      objectKey,
      filename,
      contentType,
      size,
      etag,
      note,
      tagsJson,
      actor.keyId,
      clientIp(request),
      request.headers.get('user-agent'),
      now,
      expiresAt,
    );
  } catch (error) {
    // The row did not commit, so the object would otherwise be orphaned.
    await env.BUCKET.delete(objectKey).catch(() => undefined);
    if (isUniqueViolation(error)) {
      return errorResponse(409, 'hash_taken', 'that hash is already in use');
    }
    throw error;
  }

  try {
    await audit(env, {
      actor: actor.actor,
      action: 'upload',
      target: hash,
      ip: clientIp(request),
      detail: tags.length > 0 ? `${filename} (${size} bytes) [${tags.join(', ')}]` : `${filename} (${size} bytes)`,
    });
  } catch (error) {
    // The asset is already durable. Failing the request here would invite a
    // retry that creates a second object.
    console.error('upload audit failed', error);
  }

  return jsonResponse(
    {
      hash,
      filename,
      size,
      content_type: contentType,
      tags,
      created_at: now,
      expires_at: expiresAt,
      url: `${env.PUBLIC_BASE_URL}/${hash}/${encodeURIComponent(filename)}`,
    },
    { status: 201 },
  );
}

/** Used by the dashboard to show what policy a new upload will get. */
export async function uploadPolicy(env: Env) {
  return {
    default_ttl_days: await getNumberSetting(env, 'default_ttl_days', Number(env.DEFAULT_TTL_DAYS) || 7),
    max_upload_bytes: await getNumberSetting(env, 'max_upload_bytes', Number(env.MAX_UPLOAD_BYTES) || 104_857_600),
  };
}
