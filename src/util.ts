/**
 * Small, dependency-free helpers shared by every route.
 *
 * Two things here carry real weight for the service's guarantees:
 *  - hashes are the only thing protecting a link, so they are generated with
 *    rejection sampling from a 58-character alphabet (128 bits at length 22);
 *  - filenames come from user input and end up in HTTP headers, so they are
 *    sanitised before they are ever echoed back.
 */

export const HASH_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export const DEFAULT_HASH_LENGTH = 22;
export const MIN_CUSTOM_HASH_LENGTH = 16;
export const MAX_HASH_LENGTH = 64;

/** Paths that must never be claimed by an asset hash. */
export const RESERVED_SEGMENTS = new Set([
  'admin',
  'api',
  'health',
  'favicon.ico',
  'favicon.svg',
  'robots.txt',
  'index.html',
  'assets',
  'static',
  '.well-known',
]);

const HASH_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${MIN_CUSTOM_HASH_LENGTH},${MAX_HASH_LENGTH}}$`);

/**
 * 128 bits of entropy by default. `byte % 58` alone would bias the first 24
 * characters, so bytes outside the largest whole multiple of the alphabet are
 * discarded instead.
 */
export function randomHash(length = DEFAULT_HASH_LENGTH): string {
  const out: string[] = [];
  const limit = 256 - (256 % HASH_ALPHABET.length);
  while (out.length < length) {
    const bytes = new Uint8Array(length - out.length);
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= limit) continue;
      out.push(HASH_ALPHABET[byte % HASH_ALPHABET.length]);
      if (out.length === length) break;
    }
  }
  return out.join('');
}

/**
 * Reserved service paths (`/admin`, `/health`, …) are all shorter than
 * MIN_CUSTOM_HASH_LENGTH, so the length rule already keeps them out of the hash
 * space; the asset route additionally checks RESERVED_SEGMENTS before touching
 * the database.
 */
export function hashProblem(hash: string): string | null {
  if (!HASH_PATTERN.test(hash)) {
    return `hash must be ${MIN_CUSTOM_HASH_LENGTH}-${MAX_HASH_LENGTH} characters of [A-Za-z0-9_-]`;
  }
  return null;
}

export function isValidHash(hash: string): boolean {
  return hashProblem(hash) === null;
}

/** Raised by handlers for anything that should answer 4xx with a code. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function jsonResponse(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse({ error: code, message }, { status });
}

export function toErrorResponse(error: unknown): Response {
  if (error instanceof HttpError) return errorResponse(error.status, error.code, error.message);
  // Unexpected failures are logged with their detail and reported without it,
  // so an internal message never becomes public API surface.
  console.error('unhandled error', error);
  return errorResponse(500, 'internal_error', 'unexpected error; check the worker logs');
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, 'invalid_request', `${field} is required`);
  }
  return value.trim();
}

export function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  const value = typeof raw === 'string' ? Number.parseInt(raw, 10) : typeof raw === 'number' ? raw : NaN;
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

const DURATION_UNITS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
  w: 604800,
};

/**
 * Accepts "90", "90s", "30m", "12h", "7d", "2w", "never" or "0".
 * Returns seconds, or `null` for "no expiry".
 */
export function parseDuration(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  const raw = String(input).trim().toLowerCase();
  if (raw === '' || raw === 'never' || raw === 'none' || raw === 'forever' || raw === '0') return null;
  const match = /^(\d+)\s*(s|m|h|d|w)?$/.exec(raw);
  if (!match) {
    throw new HttpError(400, 'invalid_duration', `cannot read duration "${input}" (try 7d, 12h, 3600, never)`);
  }
  return Number.parseInt(match[1], 10) * DURATION_UNITS[match[2] ?? 's'];
}

/** Accepts an ISO timestamp or epoch milliseconds/seconds. */
export function parseTimestamp(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  const raw = String(input).trim();
  if (raw === '' || raw.toLowerCase() === 'never') return null;
  if (/^\d+$/.test(raw)) {
    const value = Number.parseInt(raw, 10);
    // Anything that small is seconds, not milliseconds.
    return value < 100_000_000_000 ? value * 1000 : value;
  }
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    throw new HttpError(400, 'invalid_timestamp', `cannot read timestamp "${input}"`);
  }
  return parsed;
}

/**
 * Filenames are attacker-controlled and land in `Content-Disposition`, so
 * everything that could break the header or the response is dropped.
 */
export function sanitizeFilename(input: string | null | undefined, fallback = 'download'): string {
  if (!input) return fallback;
  const lastSegment = input.split(/[\\/]/).pop() ?? '';
  const cleaned = lastSegment
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f"\\]/g, '')
    .replace(/[<>|:*?]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  if (cleaned === '') return fallback;
  return cleaned.length > 200 ? cleaned.slice(0, 200) : cleaned;
}

export function contentDisposition(filename: string, mode: 'inline' | 'attachment'): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${mode}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

const EXTENSION_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  json: 'application/json',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  srt: 'application/x-subrip',
  vtt: 'text/vtt; charset=utf-8',
};

export function guessContentType(filename: string, provided?: string | null): string {
  const trimmed = provided?.split(';')[0].trim().toLowerCase();
  if (trimmed && trimmed !== 'application/octet-stream' && trimmed !== 'binary/octet-stream') {
    return provided!.trim();
  }
  const extension = filename.includes('.') ? filename.split('.').pop()!.toLowerCase() : '';
  return EXTENSION_TYPES[extension] ?? 'application/octet-stream';
}

export type AssetKind = 'image' | 'audio' | 'video' | 'text' | 'archive' | 'document' | 'other';

export function assetKind(contentType: string): AssetKind {
  const type = contentType.toLowerCase();
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('audio/')) return 'audio';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('text/')) return 'text';
  if (/zip|gzip|tar|7z|rar|compressed/.test(type)) return 'archive';
  if (/pdf|msword|officedocument|json|xml|csv/.test(type)) return 'document';
  return 'other';
}

export function isPreviewable(contentType: string): boolean {
  return assetKind(contentType) !== 'other' && assetKind(contentType) !== 'archive';
}

/** Markdown and plain text that the dashboard may open in the online editor. */
export function isEditableTextAsset(contentType: string, filename: string): boolean {
  const type = contentType.split(';')[0].trim().toLowerCase();
  const name = filename.toLowerCase();
  if (type.includes('html') || type.includes('javascript') || type.includes('svg+xml')) return false;
  if (type.includes('markdown') || type === 'text/x-markdown') return true;
  if (type === 'text/plain' || type.startsWith('text/plain')) return true;
  if (/\.(md|markdown|mdown|txt)$/.test(name)) return true;
  return false;
}

export function isMarkdownAsset(contentType: string, filename: string): boolean {
  const type = contentType.split(';')[0].trim().toLowerCase();
  const name = filename.toLowerCase();
  return type.includes('markdown') || type === 'text/x-markdown' || /\.(md|markdown|mdown)$/.test(name);
}

const ACTIVE_CONTENT_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'text/xml',
  'application/xml',
]);

/**
 * Types that a browser will execute when navigated to on this origin.
 * They must be downloaded, never rendered inline: an HTML page here can call
 * `/admin/api` with the Access cookie.
 */
export function isActiveContent(contentType: string): boolean {
  const type = contentType.split(';')[0].trim().toLowerCase();
  return ACTIVE_CONTENT_TYPES.has(type) || type.includes('javascript');
}

export const MAX_TAGS = 16;
export const MAX_TAG_LENGTH = 40;

export const MAX_PROJECT_SLUG_LENGTH = 40;
export const MAX_PROJECT_NAME_LENGTH = 80;

/**
 * Project slugs are CLI / filter locators: lowercase `[a-z0-9][a-z0-9_-]*`.
 * Accepts "Cool Learn" → "cool-learn". Empty input throws.
 */
export function normalizeProjectSlug(input: unknown): string {
  if (input === null || input === undefined) {
    throw new HttpError(400, 'invalid_project_slug', 'project slug is required');
  }
  const raw = String(input)
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (raw.length < 2) {
    throw new HttpError(400, 'invalid_project_slug', 'slug must be at least 2 characters');
  }
  if (raw.length > MAX_PROJECT_SLUG_LENGTH) {
    throw new HttpError(
      400,
      'invalid_project_slug',
      `slug must be at most ${MAX_PROJECT_SLUG_LENGTH} characters`,
    );
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(raw)) {
    throw new HttpError(400, 'invalid_project_slug', 'slug must start with a letter or digit');
  }
  return raw;
}

/**
 * Tags are for dashboard grouping, not security. Commas separate them on the
 * wire; each tag is trimmed, control characters are dropped, empties ignored,
 * and duplicates are removed while keeping the first occurrence.
 */
export function normalizeTags(input: unknown): string[] {
  const parts: string[] = [];
  if (input === null || input === undefined) return parts;
  if (Array.isArray(input)) {
    for (const value of input) {
      if (typeof value === 'string') parts.push(value);
      else if (value !== null && value !== undefined) parts.push(String(value));
    }
  } else if (typeof input === 'string') {
    parts.push(...input.split(/[,，]/));
  } else {
    throw new HttpError(400, 'invalid_tags', 'tags must be a string or an array of strings');
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of parts) {
    // eslint-disable-next-line no-control-regex
    const tag = raw.normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, '').trim();
    if (tag === '') continue;
    if (tag.length > MAX_TAG_LENGTH) {
      throw new HttpError(400, 'invalid_tags', `each tag must be at most ${MAX_TAG_LENGTH} characters`);
    }
    if (seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length > MAX_TAGS) {
      throw new HttpError(400, 'invalid_tags', `at most ${MAX_TAGS} tags per asset`);
    }
  }
  return out;
}

/** Persist as JSON text, or NULL when the asset has no tags. */
export function serializeTags(tags: string[]): string | null {
  return tags.length === 0 ? null : JSON.stringify(tags);
}

/** Read the JSON column back into an array; junk values become []. */
export function decodeTags(raw: string | null | undefined): string[] {
  if (raw === null || raw === undefined || raw.trim() === '') return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const value of parsed) {
      if (typeof value !== 'string') continue;
      // eslint-disable-next-line no-control-regex
      const tag = value.normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, '').trim();
      if (tag === '' || tag.length > MAX_TAG_LENGTH || seen.has(tag)) continue;
      seen.add(tag);
      out.push(tag);
      if (out.length >= MAX_TAGS) break;
    }
    return out;
  } catch {
    return [];
  }
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Compares two hex digests without leaking where they diverge. */
export async function digestEquals(a: string, b: string): Promise<boolean> {
  if (a.length !== b.length) return false;
  const encoder = new TextEncoder();
  return crypto.subtle.timingSafeEqual(encoder.encode(a), encoder.encode(b));
}

export function nowMs(): number {
  return Date.now();
}

export function isoOrNull(ms: number | null | undefined): string | null {
  return ms === null || ms === undefined ? null : new Date(ms).toISOString();
}
