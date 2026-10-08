/**
 * Shared service layer: the single home for asset/link business rules.
 *
 * Both the dashboard (`admin.ts`) and the MCP server (`mcp.ts`) call into
 * here, so TTL caps, soft-delete semantics, audit rows, and list shapes
 * cannot drift apart. Transport concerns (REST JSON shapes, MCP schemas)
 * stay with the callers; identity arrives as an explicit actor string.
 *
 * Scope checks live with the callers (MCP guards, dashboard allowlist),
 * not here: every function assumes an already-authorized caller.
 */

import {
  HttpError,
  clampInt,
  decodeTags,
  digestEquals,
  errorResponse,
  guessContentType,
  isEditableTextAsset,
  isMarkdownAsset,
  jsonResponse,
  normalizeProjectSlug,
  normalizeTags,
  nowMs,
  randomHash,
  requireString,
  sanitizeFilename,
  serializeTags,
} from './util';
import {
  all,
  audit,
  first,
  getNumberSetting,
  getProject,
  getProjectBySlug,
  projectRef,
  projectsByIds,
  run,
  type AssetRow,
  type LinkRow,
  type ProjectRow,
} from './db';
import { linkStatsForAssets, summarizeAssetWithLinks } from './assets';
import {
  insertLink,
  linkSummary,
  linkUrl,
  parseExpiryHint,
  resolveLinkExpiry,
  resolveTempLinkExpiry,
  TEMP_LINK_MAX_SECONDS,
} from './links';
import { assetCacheUrls, purgeUrls } from './cache';
import { clientIp, isBlocked, registerMiss } from './abuse';

/** Who is acting, without any transport wrapper. */
export interface ServiceCtx {
  env: Env;
  exec: ExecutionContext;
  actor: string;
  ip: string | null;
}

/** Editor/MCP text-size cap (2 MiB). */
export const TEXT_EDIT_LIMIT = 2 * 1024 * 1024;

export async function loadAssetOr404(env: Env, hash: string): Promise<AssetRow> {
  const asset = await first<AssetRow>(env, 'SELECT * FROM assets WHERE hash = ?', hash);
  if (!asset) throw new HttpError(404, 'not_found', `no asset with hash ${hash}`);
  return asset;
}

export async function loadLinkOr404(env: Env, hash: string): Promise<LinkRow> {
  const link = await first<LinkRow>(env, 'SELECT * FROM links WHERE hash = ?', hash);
  if (!link) throw new HttpError(404, 'not_found', `no link with hash ${hash}`);
  return link;
}

export async function summarizeOne(env: Env, asset: AssetRow, now = nowMs()) {
  const stats = await linkStatsForAssets(env, [asset.hash], now);
  const project = asset.project_id
    ? projectRef(await getProject(env, asset.project_id))
    : null;
  return summarizeAssetWithLinks(env, asset, stats.get(asset.hash)!, now, project);
}

export async function purgeLink(env: Env, exec: ExecutionContext, linkHash: string, filename: string): Promise<void> {
  await purgeUrls(env, exec, assetCacheUrls(env, linkHash, filename));
}

export async function purgeAssetLinks(env: Env, exec: ExecutionContext, assetHash: string, filename: string): Promise<void> {
  const links = await all<{ hash: string }>(env, 'SELECT hash FROM links WHERE asset_hash = ?', assetHash);
  const urls = links.flatMap((row) => assetCacheUrls(env, row.hash, filename));
  if (urls.length > 0) await purgeUrls(env, exec, urls);
}

/**
 * Resolve project assignment from body fields `project` / `project_id` / `project_slug`.
 * `null` / `""` / `"none"` / `"unassigned"` clears the assignment.
 */
export async function resolveProjectAssignment(
  env: Env,
  body: Record<string, unknown>,
): Promise<{ touched: boolean; projectId: string | null }> {
  if (!('project' in body) && !('project_id' in body) && !('project_slug' in body)) {
    return { touched: false, projectId: null };
  }
  const raw =
    'project' in body ? body.project
    : 'project_slug' in body ? body.project_slug
    : body.project_id;
  if (raw === null || raw === '' || raw === 'none' || raw === 'unassigned') {
    return { touched: true, projectId: null };
  }
  const text = String(raw).trim();
  if (text === '') return { touched: true, projectId: null };
  const byId = await getProject(env, text);
  if (byId) return { touched: true, projectId: byId.id };
  const slug = normalizeProjectSlug(text);
  const bySlug = await getProjectBySlug(env, slug);
  if (!bySlug) throw new HttpError(404, 'project_not_found', `no project "${slug}"`);
  return { touched: true, projectId: bySlug.id };
}

/** List/upload filter: slug or id; `none`/`unassigned`/`-` → unassigned (NULL). */
export async function resolveProjectFilter(env: Env, raw: string): Promise<string | null | undefined> {
  const text = raw.trim();
  if (!text) return undefined;
  if (text === 'none' || text === 'unassigned' || text === '-') return null;
  const byId = await getProject(env, text);
  if (byId) return byId.id;
  const slug = normalizeProjectSlug(text);
  const bySlug = await getProjectBySlug(env, slug);
  if (!bySlug) throw new HttpError(404, 'project_not_found', `no project "${slug}"`);
  return bySlug.id;
}

export function summarizeProject(row: ProjectRow, count = 0) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    note: row.note,
    created_at: row.created_at,
    archived_at: row.archived_at,
    asset_count: count,
  };
}

const KIND_FILTERS: Record<string, string> = {
  image: "content_type LIKE 'image/%'",
  audio: "content_type LIKE 'audio/%'",
  video: "content_type LIKE 'video/%'",
  text: "content_type LIKE 'text/%'",
};

export interface SearchArgs {
  q?: string;
  tag?: string;
  project?: string;
  status?: string;
  kind?: string;
  /** Raw caller input; clampInt normalizes (strings from query, numbers from MCP). */
  limit?: unknown;
  offset?: unknown;
}

/** Asset search: the same filter semantics for dashboard list and MCP. */
export async function searchAssets(env: Env, args: SearchArgs, now = nowMs()) {
  const q = args.q?.trim() ?? '';
  const status = args.status ?? 'live';
  const kind = args.kind ?? '';
  const tag = args.tag?.trim() ?? '';
  const projectRaw = args.project?.trim() ?? '';
  const limit = clampInt(args.limit, 1, 200, 50);
  const offset = clampInt(args.offset, 0, 1_000_000, 0);

  const liveLinkSql = `EXISTS (
    SELECT 1 FROM links
    WHERE links.asset_hash = assets.hash
      AND links.revoked_at IS NULL
      AND (links.expires_at IS NULL OR links.expires_at > ?)
  )`;

  const where: string[] = [];
  const binds: unknown[] = [];
  switch (status) {
    case 'live':
      where.push(`deleted_at IS NULL AND ${liveLinkSql}`);
      binds.push(now);
      break;
    case 'expired':
      where.push(`deleted_at IS NULL AND NOT ${liveLinkSql}`);
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
    where.push(
      "NOT (content_type LIKE 'image/%' OR content_type LIKE 'audio/%' OR content_type LIKE 'video/%' OR content_type LIKE 'text/%')",
    );
  }
  if (tag) {
    where.push(
      `EXISTS (SELECT 1 FROM json_each(COALESCE(NULLIF(tags, ''), '[]')) WHERE value = ?)`,
    );
    binds.push(tag);
  }
  if (projectRaw) {
    const projectId = await resolveProjectFilter(env, projectRaw);
    if (projectId === null) {
      where.push('project_id IS NULL');
    } else if (projectId !== undefined) {
      where.push('project_id = ?');
      binds.push(projectId);
    }
  }
  if (q) {
    where.push('(hash LIKE ? OR filename LIKE ? OR note LIKE ? OR tags LIKE ?)');
    binds.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
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
  const stats = await linkStatsForAssets(env, rows.map((row) => row.hash), now);
  const projectMap = await projectsByIds(
    env,
    rows.map((row) => row.project_id).filter((id): id is string => Boolean(id)),
  );
  return {
    total: total?.n ?? 0,
    limit,
    offset,
    assets: rows.map((row) =>
      summarizeAssetWithLinks(
        env,
        row,
        stats.get(row.hash)!,
        now,
        projectRef(row.project_id ? projectMap.get(row.project_id) : null),
      ),
    ),
  };
}

export async function listLinks(env: Env, assetHash: string, now = nowMs()) {
  const asset = await loadAssetOr404(env, assetHash);
  const links = await all<LinkRow>(
    env,
    'SELECT * FROM links WHERE asset_hash = ? ORDER BY created_at DESC',
    asset.hash,
  );
  return {
    asset_hash: asset.hash,
    links: links.map((link) => linkSummary(env, link, asset.filename, now)),
  };
}

export async function getAssetDetail(env: Env, assetHash: string, now = nowMs()) {
  const asset = await loadAssetOr404(env, assetHash);
  const { links } = await listLinks(env, asset.hash, now);
  const summary = await summarizeOne(env, asset, now);
  return {
    asset: {
      ...summary,
      editable_text: isEditableTextAsset(asset.content_type, asset.filename),
      markdown: isMarkdownAsset(asset.content_type, asset.filename),
    },
    links,
  };
}

export async function listProjects(env: Env, includeArchived: boolean, now = nowMs()) {
  const rows = await all<ProjectRow & { asset_count: number }>(
    env,
    `SELECT projects.*,
            (SELECT COUNT(*) FROM assets
             WHERE assets.project_id = projects.id
               AND assets.deleted_at IS NULL
               AND EXISTS (
                 SELECT 1 FROM links
                 WHERE links.asset_hash = assets.hash
                   AND links.revoked_at IS NULL
                   AND (links.expires_at IS NULL OR links.expires_at > ?)
               )) AS asset_count
     FROM projects
     ${includeArchived ? '' : 'WHERE projects.archived_at IS NULL'}
     ORDER BY projects.name COLLATE NOCASE ASC`,
    now,
  );
  const unassigned = await first<{ n: number }>(
    env,
    `SELECT COUNT(*) AS n FROM assets
     WHERE project_id IS NULL
       AND deleted_at IS NULL
       AND EXISTS (
         SELECT 1 FROM links
         WHERE links.asset_hash = assets.hash
           AND links.revoked_at IS NULL
           AND (links.expires_at IS NULL OR links.expires_at > ?)
       )`,
    now,
  );
  return {
    projects: rows.map((row) => summarizeProject(row, row.asset_count ?? 0)),
    unassigned: unassigned?.n ?? 0,
  };
}

export interface CreateProjectArgs {
  slug?: string;
  name?: string;
  note?: string;
}

/** Same validation as POST /admin/api/projects. */
export async function createProject(ctx: ServiceCtx, args: CreateProjectArgs, now = nowMs()) {
  const { env } = ctx;
  const slugSource = args.slug ?? args.name;
  if (slugSource === undefined || slugSource === null || String(slugSource).trim() === '') {
    throw new HttpError(400, 'invalid_project_slug', 'pass slug (ASCII) and optional name');
  }
  const slug = normalizeProjectSlug(slugSource);
  const nameRaw = args.name === undefined || args.name === null ? slug : String(args.name).trim();
  if (nameRaw === '') throw new HttpError(400, 'invalid_name', 'name is required');
  if (nameRaw.length > 80) {
    throw new HttpError(400, 'invalid_name', 'name must be at most 80 characters');
  }
  const note = args.note === undefined || args.note === null ? null : String(args.note).slice(0, 500);
  if (await getProjectBySlug(env, slug)) {
    throw new HttpError(409, 'slug_taken', `project slug "${slug}" already exists`);
  }
  const id = randomHash(22);
  try {
    await run(
      env,
      'INSERT INTO projects (id, slug, name, note, created_at) VALUES (?, ?, ?, ?, ?)',
      id,
      slug,
      nameRaw,
      note,
      now,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/unique constraint failed/i.test(message)) {
      throw new HttpError(409, 'slug_taken', `project slug "${slug}" already exists`);
    }
    throw error;
  }
  await audit(env, {
    actor: ctx.actor,
    action: 'project:create',
    target: id,
    ip: ctx.ip,
    detail: `${slug} (${nameRaw})`,
  });
  return { project: summarizeProject((await getProject(env, id))!) };
}

export async function listTags(env: Env, now = nowMs()) {
  const rows = await all<{ tag: string; count: number }>(
    env,
    `SELECT je.value AS tag, COUNT(*) AS count
     FROM assets
     JOIN json_each(COALESCE(NULLIF(assets.tags, ''), '[]')) AS je
     WHERE assets.deleted_at IS NULL
       AND EXISTS (
         SELECT 1 FROM links
         WHERE links.asset_hash = assets.hash
           AND links.revoked_at IS NULL
           AND (links.expires_at IS NULL OR links.expires_at > ?)
       )
     GROUP BY je.value
     ORDER BY count DESC, je.value COLLATE NOCASE ASC`,
    now,
  );
  return { tags: rows };
}

export interface CreateLinkArgs {
  asset_hash: string;
  expires_in?: string;
  expires_at?: string;
  never?: boolean;
  ttl?: string;
  label?: string;
  hash?: string;
}

export async function createLink(ctx: ServiceCtx, args: CreateLinkArgs, now = nowMs()) {
  const { env } = ctx;
  const asset = await loadAssetOr404(env, args.asset_hash);
  if (asset.deleted_at !== null || asset.purged_at !== null) {
    throw new HttpError(409, 'not_live', 'restore the asset before creating links');
  }
  const hint = parseExpiryHint({
    expires_in: args.expires_in,
    expires_at: args.expires_at,
    never: args.never,
    ttl: args.ttl,
  });
  const expiresAt = await resolveLinkExpiry(env, hint, now);
  const requested = args.hash === undefined || args.hash === null || args.hash === '' ? null : String(args.hash);
  const link = await insertLink(env, {
    assetHash: asset.hash,
    expiresAt,
    label: args.label === undefined || args.label === null ? null : String(args.label),
    createdBy: ctx.actor,
    requestedHash: requested,
    now,
  });
  await audit(env, {
    actor: ctx.actor,
    action: 'link:create',
    target: link.hash,
    ip: ctx.ip,
    detail: `asset ${asset.hash}; expires ${expiresAt ?? 'never'}`,
  });
  return { link: linkSummary(env, link, asset.filename, now) };
}

export interface CreateTempLinkArgs {
  asset_hash: string;
  expires_in?: string;
  label?: string;
}

/** Agent temporary link: always expires, hard-capped at TEMP_LINK_MAX_SECONDS (4h). */
export async function createTempLink(ctx: ServiceCtx, args: CreateTempLinkArgs, now = nowMs()) {
  const { env } = ctx;
  const asset = await loadAssetOr404(env, args.asset_hash);
  if (asset.deleted_at !== null || asset.purged_at !== null) {
    throw new HttpError(409, 'not_live', 'restore the asset before creating links');
  }
  const expiresAt = resolveTempLinkExpiry(args.expires_in, now);
  const link = await insertLink(env, {
    assetHash: asset.hash,
    expiresAt,
    label: args.label === undefined || args.label === null || args.label === ''
      ? 'temp'
      : String(args.label).slice(0, 80),
    createdBy: ctx.actor,
    now,
  });
  await audit(env, {
    actor: ctx.actor,
    action: 'link:temp',
    target: link.hash,
    ip: ctx.ip,
    detail: `asset ${asset.hash}; expires_at ${expiresAt}`,
  });
  return {
    link: linkSummary(env, link, asset.filename, now),
    max_seconds: TEMP_LINK_MAX_SECONDS,
  };
}

export interface UpdateAssetArgs {
  asset_hash: string;
  filename?: string;
  note?: string | null;
  tags?: string | string[];
  /** Passed straight to resolveProjectAssignment; absent = untouched. */
  projectInput?: Record<string, unknown>;
}

/** Same field rules for dashboard PATCH and MCP update_asset. */
export async function updateAsset(ctx: ServiceCtx, args: UpdateAssetArgs) {
  const { env } = ctx;
  const asset = await loadAssetOr404(env, args.asset_hash);
  const updates: string[] = [];
  const binds: unknown[] = [];
  if (args.filename !== undefined) {
    updates.push('filename = ?');
    binds.push(sanitizeFilename(requireString(args.filename, 'filename'), asset.filename));
  }
  if (args.note !== undefined) {
    updates.push('note = ?');
    binds.push(args.note === null ? null : String(args.note).slice(0, 500));
  }
  if (args.tags !== undefined) {
    updates.push('tags = ?');
    binds.push(serializeTags(normalizeTags(args.tags)));
  }
  const projectAssign = await resolveProjectAssignment(env, args.projectInput ?? {});
  if (projectAssign.touched) {
    updates.push('project_id = ?');
    binds.push(projectAssign.projectId);
  }
  if (updates.length === 0) {
    throw new HttpError(400, 'nothing_to_update', 'pass filename, note, tags or project');
  }
  await run(env, `UPDATE assets SET ${updates.join(', ')} WHERE hash = ?`, ...binds, asset.hash);
  await purgeAssetLinks(env, ctx.exec, asset.hash, asset.filename);
  await audit(env, {
    actor: ctx.actor,
    action: 'update',
    target: asset.hash,
    ip: ctx.ip,
    detail: JSON.stringify({
      filename: args.filename,
      note: args.note,
      tags: args.tags,
      project: args.projectInput,
    }).slice(0, 400),
  });
  return { asset: await summarizeOne(env, await loadAssetOr404(env, asset.hash)) };
}

export async function deleteAsset(ctx: ServiceCtx, assetHash: string, purge: boolean, now = nowMs()) {
  const { env } = ctx;
  const asset = await loadAssetOr404(env, assetHash);
  if (purge) {
    await env.BUCKET.delete(asset.object_key);
    await run(env, 'DELETE FROM links WHERE asset_hash = ?', asset.hash);
    await run(env, 'DELETE FROM assets WHERE hash = ?', asset.hash);
  } else {
    const retentionDays = await getNumberSetting(env, 'trash_retention_days', Number(env.TRASH_RETENTION_DAYS) || 7);
    await run(
      env,
      'UPDATE assets SET deleted_at = ?, delete_reason = ? WHERE hash = ?',
      now,
      'manual',
      asset.hash,
    );
    // Revoke every live link so existing URLs stop immediately.
    await run(
      env,
      'UPDATE links SET revoked_at = ? WHERE asset_hash = ? AND revoked_at IS NULL',
      now,
      asset.hash,
    );
    if (retentionDays <= 0) {
      await env.BUCKET.delete(asset.object_key);
      await run(env, 'UPDATE assets SET purged_at = ? WHERE hash = ?', now, asset.hash);
    }
  }
  await purgeAssetLinks(env, ctx.exec, asset.hash, asset.filename);
  await audit(env, {
    actor: ctx.actor,
    action: purge ? 'delete:hard' : 'delete',
    target: asset.hash,
    ip: ctx.ip,
    detail: asset.filename,
  });
  return { deleted: asset.hash, hard: purge };
}

export async function restoreAsset(ctx: ServiceCtx, assetHash: string) {
  const { env } = ctx;
  const asset = await loadAssetOr404(env, assetHash);
  if (asset.purged_at !== null) {
    throw new HttpError(409, 'purged', 'the bytes for this asset are gone; the row is metadata only');
  }
  await run(env, 'UPDATE assets SET deleted_at = NULL, delete_reason = NULL WHERE hash = ?', asset.hash);
  await purgeAssetLinks(env, ctx.exec, asset.hash, asset.filename);
  await audit(env, { actor: ctx.actor, action: 'restore', target: asset.hash, ip: ctx.ip });
  return { asset: await summarizeOne(env, await loadAssetOr404(env, asset.hash)) };
}

export async function revokeLink(ctx: ServiceCtx, linkHash: string, now = nowMs()) {
  const { env } = ctx;
  const link = await loadLinkOr404(env, linkHash);
  const asset = await loadAssetOr404(env, link.asset_hash);
  if (link.revoked_at === null) {
    await run(env, 'UPDATE links SET revoked_at = ? WHERE hash = ?', now, link.hash);
    await purgeLink(env, ctx.exec, link.hash, asset.filename);
    await audit(env, {
      actor: ctx.actor,
      action: 'link:revoke',
      target: link.hash,
      ip: ctx.ip,
      detail: `asset ${asset.hash}`,
    });
  }
  const updated = await loadLinkOr404(env, link.hash);
  return { revoked: link.hash, link: linkSummary(env, updated, asset.filename) };
}

export async function readTextContent(env: Env, assetHash: string) {
  const asset = await loadAssetOr404(env, assetHash);
  if (!isEditableTextAsset(asset.content_type, asset.filename)) {
    throw new HttpError(415, 'not_editable', 'only markdown/plain text can be read as text');
  }
  if (asset.deleted_at !== null || asset.purged_at !== null) {
    throw new HttpError(409, 'not_live', 'restore the asset before reading its content');
  }
  if (asset.size > TEXT_EDIT_LIMIT) {
    throw new HttpError(413, 'too_large', 'text reads are limited to 2 MiB; use a share link');
  }
  const object = await env.BUCKET.get(asset.object_key);
  if (!object) throw new HttpError(404, 'not_found', 'object bytes are missing');
  return {
    asset_hash: asset.hash,
    filename: asset.filename,
    content_type: asset.content_type,
    size: asset.size,
    text: await object.text(),
  };
}

export interface WriteTextArgs {
  asset_hash: string;
  /** Raw replacement bytes; callers encode text themselves so binary is never transcoded. */
  content: Uint8Array;
  content_type?: string;
}

export async function writeTextContent(ctx: ServiceCtx, args: WriteTextArgs) {
  const { env } = ctx;
  const asset = await loadAssetOr404(env, args.asset_hash);
  if (!isEditableTextAsset(asset.content_type, asset.filename)) {
    throw new HttpError(415, 'not_editable', 'only markdown/plain text can be saved from the editor');
  }
  if (asset.deleted_at !== null || asset.purged_at !== null) {
    throw new HttpError(409, 'not_live', 'restore the asset before editing its content');
  }
  const bytes = args.content;
  if (bytes.byteLength === 0) throw new HttpError(400, 'empty_body', 'refusing to store an empty object');
  const maxBytes = Math.min(
    TEXT_EDIT_LIMIT,
    await getNumberSetting(env, 'max_upload_bytes', Number(env.MAX_UPLOAD_BYTES) || 104_857_600),
  );
  if (bytes.byteLength > maxBytes) {
    throw new HttpError(413, 'too_large', `editor saves are limited to ${maxBytes} bytes`);
  }
  const contentType = args.content_type?.trim() ||
    guessContentType(
      asset.filename,
      isMarkdownAsset(asset.content_type, asset.filename)
        ? 'text/markdown; charset=utf-8'
        : 'text/plain; charset=utf-8',
    );
  if (!isEditableTextAsset(contentType, asset.filename)) {
    throw new HttpError(415, 'not_editable', 'content-type is not an editable text type');
  }
  const object = await env.BUCKET.put(asset.object_key, bytes, {
    httpMetadata: { contentType },
    customMetadata: { hash: asset.hash, filename: asset.filename },
  });
  const size = object?.size ?? bytes.byteLength;
  const etag = object?.etag ?? null;
  await run(
    env,
    'UPDATE assets SET content_type = ?, size = ?, etag = ? WHERE hash = ?',
    contentType,
    size,
    etag,
    asset.hash,
  );
  await purgeAssetLinks(env, ctx.exec, asset.hash, asset.filename);
  await audit(env, {
    actor: ctx.actor,
    action: 'content:update',
    target: asset.hash,
    ip: ctx.ip,
    detail: `${asset.filename} (${size} bytes)`,
  });
  return { asset: await summarizeOne(env, await loadAssetOr404(env, asset.hash)) };
}

// ---------------------------------------------------------------------------
// Upload sessions: metadata first (MCP tool), bytes later (PUT with the same
// OAuth token). Large files never pass through MCP JSON.
// ---------------------------------------------------------------------------

/** Cap for single-call base64 uploads: MCP JSON is not a bulk transport. */
export const DIRECT_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

/** Bytes already in R2, waiting for their asset + first-link rows. */
export interface StoredUpload {
  objectKey: string;
  assetHash: string;
  linkHash: string;
  filename: string;
  contentType: string;
  size: number;
  etag: string | null;
  note: string | null;
  tagsJson: string | null;
  projectId: string | null;
  linkExpiresAt: number | null;
  uploaderIp: string | null;
  uploaderAgent: string | null;
  /** Where the bytes came from, for the audit line. */
  via: string;
  /** Extra bookkeeping after the rows land (e.g. mark a session completed). */
  afterInsert?: (env: Env, now: number) => Promise<void>;
}

/**
 * Insert the asset + first-link rows for R2 bytes, audit, and describe the
 * result. Shared by session completion and direct uploads so both paths
 * mint identical records. Cleans up R2 + rows when the insert fails.
 */
export async function recordStoredUpload(ctx: ServiceCtx, stored: StoredUpload, now = nowMs()) {
  const { env } = ctx;
  try {
    const project = stored.projectId ? projectRef(await getProject(env, stored.projectId)) : null;
    await run(
      env,
      `INSERT INTO assets (hash, object_key, filename, content_type, size, etag, note, tags, project_id, key_id,
                             uploader_ip, uploader_agent, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      stored.assetHash,
      stored.objectKey,
      stored.filename,
      stored.contentType,
      stored.size,
      stored.etag,
      stored.note,
      stored.tagsJson,
      stored.projectId,
      stored.uploaderIp,
      stored.uploaderAgent,
      now,
    );
    const link = await insertLink(env, {
      assetHash: stored.assetHash,
      expiresAt: stored.linkExpiresAt,
      createdBy: ctx.actor,
      requestedHash: stored.linkHash,
      now,
    });
    await stored.afterInsert?.(env, now);
    await audit(env, {
      actor: ctx.actor,
      action: 'upload',
      target: stored.assetHash,
      ip: ctx.ip,
      detail: `${stored.filename} (${stored.size} bytes) link=${link.hash} ${stored.via}`,
    });
    return {
      hash: link.hash,
      asset_hash: stored.assetHash,
      link_hash: link.hash,
      filename: stored.filename,
      size: stored.size,
      content_type: stored.contentType,
      tags: decodeTags(stored.tagsJson),
      project,
      note: stored.note,
      created_at: now,
      expires_at: stored.linkExpiresAt,
      url: linkUrl(env, link.hash, stored.filename),
    };
  } catch (error) {
    await env.BUCKET.delete(stored.objectKey).catch(() => undefined);
    await run(env, 'DELETE FROM assets WHERE hash = ?', stored.assetHash).catch(() => undefined);
    await run(env, 'DELETE FROM links WHERE hash = ?', stored.linkHash).catch(() => undefined);
    throw error;
  }
}

export interface UploadSessionRow {
  id: string;
  upload_key: string | null;
  filename: string;
  content_type: string;
  size_expected: number | null;
  note: string | null;
  tags: string | null;
  project_id: string | null;
  link_expires_at: number | null;
  created_by: string;
  created_at: number;
  expires_at: number;
  completed_at: number | null;
  asset_hash: string | null;
}

export interface CreateSessionArgs {
  filename: string;
  content_type?: string;
  size?: number;
  note?: string;
  tags?: string | string[];
  project?: string;
  expires_in?: string;
}

export async function createUploadSession(ctx: ServiceCtx, args: CreateSessionArgs, now = nowMs()) {
  const { env } = ctx;
  const rawName = String(args.filename ?? '').trim();
  if (!rawName) throw new HttpError(400, 'invalid_filename', 'filename is required');
  const filename = sanitizeFilename(rawName);
  const contentType = guessContentType(filename, args.content_type ?? null);
  const maxBytes = await getNumberSetting(env, 'max_upload_bytes', Number(env.MAX_UPLOAD_BYTES) || 104_857_600);
  let sizeExpected: number | null = null;
  if (args.size !== undefined && args.size !== null) {
    if (!Number.isInteger(args.size) || args.size <= 0 || args.size > maxBytes) {
      throw new HttpError(400, 'invalid_size', `size must be between 1 and ${maxBytes} bytes`);
    }
    sizeExpected = args.size;
  }
  // Unknown projects already throw project_not_found inside the resolver.
  const projectAssign = await resolveProjectAssignment(
    env,
    args.project === undefined ? {} : { project: args.project },
  );
  // Sessions are short-lived reservations: same 1h default / 4h cap as temp links.
  const expiresAt = resolveTempLinkExpiry(args.expires_in, now);
  const linkExpiresAt = await resolveLinkExpiry(env, undefined, now);
  const id = randomHash();
  // 32 base58 chars (~190 bits): the signed-URL secret. Single use, dies
  // with the session; possession of the tool response is the authorization.
  const uploadKey = randomHash(32);
  const tags = args.tags === undefined ? [] : normalizeTags(args.tags);
  await run(
    env,
    `INSERT INTO upload_sessions
       (id, upload_key, filename, content_type, size_expected, note, tags, project_id,
        link_expires_at, created_by, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    uploadKey,
    filename,
    contentType,
    sizeExpected,
    args.note === undefined ? null : String(args.note).slice(0, 500),
    serializeTags(tags),
    projectAssign.projectId,
    linkExpiresAt,
    ctx.actor,
    now,
    expiresAt,
  );
  await audit(env, {
    actor: ctx.actor,
    action: 'upload:session',
    target: id,
    ip: ctx.ip,
    detail: `${filename} (${contentType})`,
  });
  const base = env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  return {
    session_id: id,
    // Signed URL: the key is a secret — whoever holds the tool response
    // can PUT once, no OAuth header needed (creator and uploader differ).
    upload_url: `${base}/uploads/${id}?key=${uploadKey}`,
    upload_method: 'PUT',
    filename,
    content_type: contentType,
    size_expected: sizeExpected,
    max_bytes: maxBytes,
    expires_at: expiresAt,
  };
}

export interface DirectUploadArgs {
  filename: string;
  /** Standard base64 (not url-safe); decoded size must fit the direct cap. */
  content: string;
  content_type?: string;
  note?: string;
  tags?: string | string[];
  project?: string;
}

/**
 * One-call upload for small files (≤10 MiB): base64 in, asset + first link
 * out. Anything bigger belongs in an upload session — MCP JSON is not a
 * bulk transport, and large tool payloads time out through portals.
 */
export async function uploadFileDirect(ctx: ServiceCtx, args: DirectUploadArgs, now = nowMs()) {
  const { env } = ctx;
  const rawName = String(args.filename ?? '').trim();
  if (!rawName) throw new HttpError(400, 'invalid_filename', 'filename is required');
  const filename = sanitizeFilename(rawName);
  const contentType = guessContentType(filename, args.content_type ?? null);
  const raw = String(args.content ?? '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(raw) || raw.length % 4 !== 0) {
    throw new HttpError(400, 'invalid_content', 'content must be standard base64');
  }
  let bytes: Uint8Array;
  try {
    const binary = atob(raw);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  } catch {
    throw new HttpError(400, 'invalid_content', 'content must be standard base64');
  }
  if (bytes.byteLength === 0) throw new HttpError(400, 'empty_body', 'refusing to store an empty object');
  const cap = Math.min(
    DIRECT_UPLOAD_MAX_BYTES,
    await getNumberSetting(env, 'max_upload_bytes', Number(env.MAX_UPLOAD_BYTES) || 104_857_600),
  );
  if (bytes.byteLength > cap) {
    throw new HttpError(
      413,
      'direct_upload_too_large',
      `direct uploads are limited to ${cap} bytes; use create_upload_session for bigger files`,
    );
  }
  const projectAssign = await resolveProjectAssignment(
    env,
    args.project === undefined ? {} : { project: args.project },
  );
  const linkExpiresAt = await resolveLinkExpiry(env, undefined, now);
  const assetHash = randomHash();
  const linkHash = randomHash();
  const objectKey = `objects/${randomHash(26)}`;
  const object = await env.BUCKET.put(objectKey, bytes, {
    httpMetadata: { contentType },
    customMetadata: { hash: assetHash, filename },
  }).catch((error) => {
    console.error('direct upload failed', error);
    throw new HttpError(400, 'upload_failed', 'upload failed');
  });
  return recordStoredUpload(
    ctx,
    {
      objectKey,
      assetHash,
      linkHash,
      filename,
      contentType,
      size: object?.size ?? bytes.byteLength,
      etag: object?.etag ?? null,
      note: args.note === undefined ? null : String(args.note).slice(0, 500),
      tagsJson: serializeTags(args.tags === undefined ? [] : normalizeTags(args.tags)),
      projectId: projectAssign.projectId,
      linkExpiresAt,
      uploaderIp: ctx.ip,
      uploaderAgent: 'mcp:upload_file',
      via: 'via mcp upload_file',
    },
    now,
  );
}

/**
 * Signed-URL completion: `PUT /uploads/:id?key=<secret>` with no OAuth
 * header. The secret is minted with the session, single-use, and expires
 * with it — possession of the `create_upload_session` response authorizes
 * exactly one PUT. Guessing counts as abuse, like guessing link hashes.
 */
export async function completeUploadSessionByKey(
  env: Env,
  exec: ExecutionContext,
  request: Request,
  url: URL,
  sessionId: string,
): Promise<Response> {
  if (request.method !== 'PUT') {
    return errorResponse(405, 'method_not_allowed', 'complete an upload session with PUT');
  }
  const blocked = await isBlocked(env, request);
  if (blocked.blocked) {
    return errorResponse(403, 'blocked', 'this network has been blocked after repeated failed attempts');
  }
  const fail = async (): Promise<Response> => {
    await registerMiss(env, request, 'bad upload session key');
    return errorResponse(404, 'not_found', 'no such upload session');
  };
  const session = await first<UploadSessionRow>(env, 'SELECT * FROM upload_sessions WHERE id = ?', sessionId);
  if (!session) return fail();
  const presented = url.searchParams.get('key');
  if (!session.upload_key || !presented || !(await digestEquals(session.upload_key, presented))) {
    return fail();
  }
  const svc: ServiceCtx = { env, exec, actor: session.created_by, ip: clientIp(request) };
  return completeUploadSession(svc, request, sessionId);
}

/**
 * Complete a session by streaming the PUT body straight into R2 — the same
 * no-buffering contract as POST /api/upload (Content-Length required).
 */
export async function completeUploadSession(
  ctx: ServiceCtx,
  request: Request,
  sessionId: string,
  now = nowMs(),
): Promise<Response> {
  const { env } = ctx;
  if (request.method !== 'PUT') {
    return errorResponse(405, 'method_not_allowed', 'complete an upload session with PUT');
  }
  const session = await first<UploadSessionRow>(env, 'SELECT * FROM upload_sessions WHERE id = ?', sessionId);
  if (!session || session.completed_at !== null) {
    return errorResponse(404, 'not_found', 'no such upload session');
  }
  if (session.expires_at <= now) {
    return errorResponse(410, 'expired', 'this upload session has expired; create a new one');
  }
  if (!request.body) return errorResponse(400, 'empty_body', 'request has no body');
  const declaredHeader = request.headers.get('content-length');
  if (declaredHeader === null) {
    return errorResponse(411, 'length_required', 'Content-Length is required');
  }
  const declared = Number(declaredHeader);
  const maxBytes = await getNumberSetting(env, 'max_upload_bytes', Number(env.MAX_UPLOAD_BYTES) || 104_857_600);
  if (!Number.isFinite(declared) || declared <= 0) {
    return errorResponse(400, 'invalid_length', 'Content-Length is not a positive number');
  }
  if (declared > maxBytes) {
    return errorResponse(413, 'too_large', `upload exceeds the ${maxBytes} byte limit`);
  }
  if (session.size_expected !== null && declared !== session.size_expected) {
    return errorResponse(400, 'size_mismatch', `session expects ${session.size_expected} bytes`);
  }

  const assetHash = randomHash();
  const linkHash = randomHash();
  const objectKey = `objects/${randomHash(26)}`;
  const fixed = new FixedLengthStream(declared);
  request.body.pipeTo(fixed.writable).catch(() => undefined);
  let stored = false;
  let size = declared;
  let etag: string | null = null;
  try {
    const object = await env.BUCKET.put(objectKey, fixed.readable, {
      httpMetadata: { contentType: session.content_type },
      customMetadata: { hash: assetHash, filename: session.filename },
    });
    stored = true;
    if (object?.size !== undefined) size = object.size;
    etag = object?.etag ?? null;
  } catch (error) {
    if (stored) await env.BUCKET.delete(objectKey).catch(() => undefined);
    console.error('upload session failed', error);
    return errorResponse(400, 'upload_failed', 'upload failed');
  }
  if (size === 0) {
    await env.BUCKET.delete(objectKey);
    return errorResponse(400, 'empty_body', 'refusing to store an empty object');
  }

  try {
    const body = await recordStoredUpload(
      { ...ctx, ip: clientIp(request) },
      {
        objectKey,
        assetHash,
        linkHash,
        filename: session.filename,
        contentType: session.content_type,
        size,
        etag,
        note: session.note,
        tagsJson: session.tags,
        projectId: session.project_id,
        linkExpiresAt: session.link_expires_at,
        uploaderIp: clientIp(request),
        uploaderAgent: request.headers.get('user-agent'),
        via: 'via upload session',
        afterInsert: async (db, at) => {
          await run(
            db,
            'UPDATE upload_sessions SET completed_at = ?, asset_hash = ? WHERE id = ?',
            at,
            assetHash,
            session.id,
          );
        },
      },
      now,
    );
    return jsonResponse(body, { status: 201 });
  } catch (error) {
    if (error instanceof HttpError) {
      return errorResponse(error.status, error.code, error.message);
    }
    throw error;
  }
}
