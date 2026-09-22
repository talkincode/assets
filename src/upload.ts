/**
 * Upload path, shared by the public key-authenticated endpoint and the
 * dashboard. Both produce the same record; only the recorded actor differs.
 *
 * Creates an immutable asset plus the first share link (TTL from expires_in /
 * never / default_ttl_days). The public URL is always the link hash.
 */

import {
  HttpError,
  errorResponse,
  guessContentType,
  jsonResponse,
  normalizeProjectSlug,
  normalizeTags,
  parseTimestamp,
  randomHash,
  sanitizeFilename,
  serializeTags,
} from './util';
import { audit, getNumberSetting, getProject, getProjectBySlug, projectRef, run } from './db';
import type { Ctx } from './router';
import { clientIp } from './abuse';
import {
  allocateHash,
  insertLink,
  linkUrl,
  parseExpiryHint,
  resolveLinkExpiry,
} from './links';

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

async function resolveUploadLinkExpiry(env: Env, request: Request, url: URL, now: number): Promise<number | null> {
  const headerTtl = request.headers.get('x-expires-in');
  const headerAt = request.headers.get('x-expires-at');
  const hint = parseExpiryHint({
    expires_in: url.searchParams.get('expires_in') ?? url.searchParams.get('ttl') ?? headerTtl,
    expires_at: url.searchParams.get('expires_at') ?? headerAt,
    never: (url.searchParams.get('expires_in') ?? url.searchParams.get('ttl') ?? headerTtl) === 'never'
      ? true
      : undefined,
  });
  // parseExpiryHint treats missing as undefined; explicit "never" via parseDuration returns null.
  if (hint === undefined) {
    // Also honor bare expires_at=never via parseTimestamp path above; if only
    // expires_at header says never, parseTimestamp handles it.
    const atRaw = url.searchParams.get('expires_at') ?? headerAt;
    if (atRaw !== null && atRaw !== undefined) {
      return parseTimestamp(atRaw);
    }
  }
  return resolveLinkExpiry(env, hint, now);
}

/**
 * R2 will only accept a body whose length it knows up front, so:
 *  - a declared `Content-Length` is verified against the cap and streamed
 *    through a FixedLengthStream (no buffering, no truncation);
 *  - a body without `Content-Length` is refused (411) instead of buffered.
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

  // Optional `hash` becomes the first share-link locator (public URL), not the
  // immutable asset identity.
  const requestedLinkHash = url.searchParams.get('hash') ?? request.headers.get('x-hash');
  const linkHash = await allocateHash(env, requestedLinkHash);
  const assetHash = await allocateHash(env, null);

  const expiresAt = await resolveUploadLinkExpiry(env, request, url, now);
  const noteRaw = url.searchParams.get('note') ?? request.headers.get('x-note');
  const note = noteRaw === null ? null : noteRaw.slice(0, 500);
  const tagsRaw = url.searchParams.get('tags') ?? request.headers.get('x-tags');
  const tags = tagsRaw === null ? [] : normalizeTags(tagsRaw);
  const tagsJson = serializeTags(tags);
  const projectRaw = url.searchParams.get('project')
    ?? url.searchParams.get('project_id')
    ?? request.headers.get('x-project');
  let projectId: string | null = null;
  let project = null as ReturnType<typeof projectRef>;
  if (projectRaw !== null && projectRaw.trim() !== '') {
    const text = projectRaw.trim();
    const byId = await getProject(env, text);
    if (byId) {
      projectId = byId.id;
      project = projectRef(byId);
    } else {
      const slug = normalizeProjectSlug(text);
      const bySlug = await getProjectBySlug(env, slug);
      if (!bySlug) throw new HttpError(404, 'project_not_found', `no project "${slug}"`);
      projectId = bySlug.id;
      project = projectRef(bySlug);
    }
  }
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
        hash: assetHash,
        filename,
      },
    });
    stored = true;
    etag = object?.etag ?? null;
    if (object?.size !== undefined) size = object.size;
  } catch (error) {
    if (stored) await env.BUCKET.delete(objectKey).catch(() => undefined);
    if (error instanceof HttpError) return errorResponse(error.status, error.code, error.message);
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
      `INSERT INTO assets (hash, object_key, filename, content_type, size, etag, note, tags, project_id, key_id,
                           uploader_ip, uploader_agent, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      assetHash,
      objectKey,
      filename,
      contentType,
      size,
      etag,
      note,
      tagsJson,
      projectId,
      actor.keyId,
      clientIp(request),
      request.headers.get('user-agent'),
      now,
    );
    await insertLink(env, {
      assetHash,
      expiresAt,
      createdBy: actor.actor,
      requestedHash: linkHash,
      now,
    });
  } catch (error) {
    await env.BUCKET.delete(objectKey).catch(() => undefined);
    await run(env, 'DELETE FROM assets WHERE hash = ?', assetHash).catch(() => undefined);
    await run(env, 'DELETE FROM links WHERE hash = ?', linkHash).catch(() => undefined);
    if (isUniqueViolation(error)) {
      return errorResponse(409, 'hash_taken', 'that hash is already in use');
    }
    throw error;
  }

  try {
    await audit(env, {
      actor: actor.actor,
      action: 'upload',
      target: assetHash,
      ip: clientIp(request),
      detail: [
        `${filename} (${size} bytes) link=${linkHash}`,
        tags.length > 0 ? `[${tags.join(', ')}]` : '',
        project ? `project=${project.slug}` : '',
      ].filter(Boolean).join(' '),
    });
  } catch (error) {
    console.error('upload audit failed', error);
  }

  return jsonResponse(
    {
      hash: linkHash,
      asset_hash: assetHash,
      link_hash: linkHash,
      filename,
      size,
      content_type: contentType,
      tags,
      project,
      note,
      created_at: now,
      expires_at: expiresAt,
      url: linkUrl(env, linkHash, filename),
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
