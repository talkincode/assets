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
  parseDuration,
  parseTimestamp,
  randomHash,
  sanitizeFilename,
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
    const plain = /filename="?([^";]+)"?/i.exec(disposition);
    const raw = extended ? decodeURIComponent(extended[1]) : plain ? plain[1] : null;
    if (raw) return sanitizeFilename(raw);
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
 *  - a chunked body has to be buffered, and is refused past a small ceiling so
 *    a worker isolate cannot be pushed into an out-of-memory kill.
 *
 * A `Content-Length` that understates the real body makes the stream error out
 * rather than storing a truncated object.
 */
const CHUNKED_BUFFER_LIMIT = 25 * 1024 * 1024;

async function r2Body(request: Request, maxBytes: number): Promise<{ body: ReadableStream; expectedSize: number }> {
  const declaredHeader = request.headers.get('content-length');
  const stream = request.body;
  if (!stream) throw new HttpError(400, 'empty_body', 'request has no body');

  if (declaredHeader !== null) {
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

  const limit = Math.min(maxBytes, CHUNKED_BUFFER_LIMIT);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new HttpError(
        total > maxBytes ? 413 : 411,
        total > maxBytes ? 'too_large' : 'length_required',
        total > maxBytes
          ? `upload exceeds the ${maxBytes} byte limit`
          : `chunked uploads are limited to ${limit} bytes; send Content-Length for larger files`,
      );
    }
    chunks.push(value);
  }
  if (total === 0) throw new HttpError(400, 'empty_body', 'refusing to store an empty object');
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body: new Response(merged).body!, expectedSize: total };
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
  const note = url.searchParams.get('note') ?? request.headers.get('x-note');
  const objectKey = `objects/${randomHash(26)}`;

  let size = 0;
  let etag: string | null = null;
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
    etag = object?.etag ?? null;
    if (object?.size !== undefined) size = object.size;
  } catch (error) {
    if (error instanceof HttpError) return errorResponse(error.status, error.code, error.message);
    return errorResponse(400, 'upload_failed', error instanceof Error ? error.message : 'upload failed');
  }

  if (size === 0) {
    await env.BUCKET.delete(objectKey);
    return errorResponse(400, 'empty_body', 'refusing to store an empty object');
  }

  await run(
    env,
    `INSERT INTO assets (hash, object_key, filename, content_type, size, etag, note, key_id,
                         uploader_ip, uploader_agent, created_at, expires_at, downloads)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    hash,
    objectKey,
    filename,
    contentType,
    size,
    etag,
    note,
    actor.keyId,
    clientIp(request),
    request.headers.get('user-agent'),
    now,
    expiresAt,
  );

  await audit(env, {
    actor: actor.actor,
    action: 'upload',
    target: hash,
    ip: clientIp(request),
    detail: `${filename} (${size} bytes)`,
  });

  return jsonResponse(
    {
      hash,
      filename,
      size,
      content_type: contentType,
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
