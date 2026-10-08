/**
 * Dashboard API. Every route runs behind a verified Cloudflare Access identity
 * (see `requireAccessIdentity`) and writes an audit entry for anything that
 * changes state.
 *
 * Assets are immutable identities. Public URLs are share links with their own
 * expiry; most mutations here manage those links rather than the asset row.
 */

import {
  HttpError,
  assetKind,
  clampInt,
  decodeTags,
  errorResponse,
  isEditableTextAsset,
  isMarkdownAsset,
  jsonResponse,
  normalizeProjectSlug,
  normalizeTags,
  nowMs,
  parseDuration,
  parseTimestamp,
  randomHash,
  requireString,
  serializeTags,
  toErrorResponse,
} from './util';
import { Router, type Ctx } from './router';
import {
  all,
  audit,
  first,
  getProject,
  getProjectBySlug,
  projectRef,
  projectsByIds,
  run,
  setSetting,
  type AssetRow,
  type LinkRow,
  type ProjectRow,
} from './db';
import { createUploadKey, accessConfigured, requireAccessIdentity } from './auth';
import { handleUpload, uploadPolicy } from './upload';
import { clientIp, guardReset } from './abuse';
import {
  insertLink,
  linkSummary,
  parseExpiryHint,
  resolveLinkExpiry,
  TEMP_LINK_MAX_SECONDS,
} from './links';
import {
  createLink,
  createProject,
  createTempLink,
  deleteAsset,
  getAssetDetail,
  listLinks,
  listProjects,
  listTags,
  loadAssetOr404,
  loadLinkOr404,
  purgeLink,
  purgeAssetLinks,
  resolveProjectAssignment,
  restoreAsset,
  revokeLink,
  searchAssets,
  summarizeOne,
  summarizeProject,
  updateAsset,
  writeTextContent,
  type ServiceCtx,
} from './service';

const MAX_PROJECT_NAME_LENGTH = 80;

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

function serviceCtx(ctx: Ctx): ServiceCtx {
  return { env: ctx.env, exec: ctx.exec, actor: ctx.identity!.actor, ip: clientIp(ctx.request) };
}




async function findProject(env: Env, idOrSlug: string): Promise<ProjectRow | null> {
  const byId = await getProject(env, idOrSlug);
  if (byId) return byId;
  try {
    return await getProjectBySlug(env, normalizeProjectSlug(idOrSlug));
  } catch {
    return null;
  }
}

const router = new Router();

router.get('/me', (ctx) => {
  const identity = ctx.identity!;
  const access = identity.kind === 'access' ? identity : null;
  const base = ctx.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  // Application-domain logout clears the CF_Authorization cookie fastest;
  // team-domain logout also works (see Cloudflare Access session docs).
  const logoutUrl = `${base}/cdn-cgi/access/logout`;
  return jsonResponse({
    actor: identity.actor,
    email: access?.email ?? null,
    service_token: access?.serviceToken ?? null,
    public_base_url: ctx.env.PUBLIC_BASE_URL,
    logout_url: logoutUrl,
    temp_link_max_seconds: TEMP_LINK_MAX_SECONDS,
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
  }>(
    env,
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN deleted_at IS NULL
              AND EXISTS (
                SELECT 1 FROM links
                WHERE links.asset_hash = assets.hash
                  AND links.revoked_at IS NULL
                  AND (links.expires_at IS NULL OR links.expires_at > ?1)
              ) THEN 1 ELSE 0 END) AS live,
            SUM(CASE WHEN deleted_at IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM links
                WHERE links.asset_hash = assets.hash
                  AND links.revoked_at IS NULL
                  AND (links.expires_at IS NULL OR links.expires_at > ?1)
              ) THEN 1 ELSE 0 END) AS expired,
            SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS deleted,
            SUM(size) AS bytes,
            SUM(CASE WHEN deleted_at IS NULL THEN size ELSE 0 END) AS live_bytes
     FROM assets`,
    now,
  );
  const downloads = await first<{ n: number }>(env, 'SELECT COALESCE(SUM(downloads), 0) AS n FROM links');
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
      downloads: downloads?.n ?? 0,
      kinds,
    },
    blocked_sources: blocked?.n ?? 0,
    upload_keys: keys?.n ?? 0,
    policy: await uploadPolicy(env),
    temp_link_max_seconds: TEMP_LINK_MAX_SECONDS,
    now,
  });
});

router.get('/assets', async (ctx) => {
  const { env, url } = ctx;
  const tag = url.searchParams.get('tag')?.trim() ?? '';
  const projectRaw = url.searchParams.get('project')?.trim()
    ?? url.searchParams.get('project_id')?.trim()
    ?? '';
  const found = await searchAssets(env, {
    q: url.searchParams.get('q')?.trim() ?? '',
    status: url.searchParams.get('status') ?? 'live',
    kind: url.searchParams.get('kind') ?? '',
    tag,
    project: projectRaw,
    limit: url.searchParams.get('limit'),
    offset: url.searchParams.get('offset'),
  });
  return jsonResponse({
    ...found,
    tag: tag || null,
    project: projectRaw || null,
  });
});

/** Distinct tags with live-asset counts, for the dashboard tag nav. */
router.get('/tags', async (ctx) => jsonResponse(await listTags(ctx.env)));

router.get('/projects', async (ctx) => {
  const includeArchived = ctx.url.searchParams.get('archived') === '1';
  return jsonResponse(await listProjects(ctx.env, includeArchived));
});

router.post('/projects', async (ctx) => {
  const body = await readJson(ctx.request);
  const created = await createProject(serviceCtx(ctx), {
    slug: body.slug as string | undefined,
    name: body.name as string | undefined,
    note: body.note as string | undefined,
  });
  return jsonResponse(created, { status: 201 });
});

router.get('/projects/:id', async (ctx) => {
  const project = await findProject(ctx.env, ctx.params.id);
  if (!project) throw new HttpError(404, 'not_found', `no project "${ctx.params.id}"`);
  const now = nowMs();
  const count = await first<{ n: number }>(
    ctx.env,
    `SELECT COUNT(*) AS n FROM assets
     WHERE project_id = ? AND deleted_at IS NULL
       AND EXISTS (
         SELECT 1 FROM links
         WHERE links.asset_hash = assets.hash
           AND links.revoked_at IS NULL
           AND (links.expires_at IS NULL OR links.expires_at > ?)
       )`,
    project.id,
    now,
  );
  return jsonResponse({ project: summarizeProject(project, count?.n ?? 0) });
});

router.patch('/projects/:id', async (ctx) => {
  const project = await findProject(ctx.env, ctx.params.id);
  if (!project) throw new HttpError(404, 'not_found', `no project "${ctx.params.id}"`);
  const body = await readJson(ctx.request);
  const updates: string[] = [];
  const binds: unknown[] = [];

  if ('slug' in body) {
    const slug = normalizeProjectSlug(body.slug);
    if (slug !== project.slug) {
      const clash = await getProjectBySlug(ctx.env, slug);
      if (clash && clash.id !== project.id) {
        throw new HttpError(409, 'slug_taken', `project slug "${slug}" already exists`);
      }
      updates.push('slug = ?');
      binds.push(slug);
    }
  }
  if ('name' in body) {
    const name = String(body.name ?? '').trim();
    if (name === '') throw new HttpError(400, 'invalid_name', 'name is required');
    if (name.length > MAX_PROJECT_NAME_LENGTH) {
      throw new HttpError(400, 'invalid_name', `name must be at most ${MAX_PROJECT_NAME_LENGTH} characters`);
    }
    updates.push('name = ?');
    binds.push(name);
  }
  if ('note' in body) {
    updates.push('note = ?');
    binds.push(body.note === null ? null : String(body.note).slice(0, 500));
  }
  if ('archived' in body) {
    updates.push('archived_at = ?');
    binds.push(body.archived ? nowMs() : null);
  }
  if (updates.length === 0) {
    throw new HttpError(400, 'nothing_to_update', 'pass slug, name, note or archived');
  }
  await run(ctx.env, `UPDATE projects SET ${updates.join(', ')} WHERE id = ?`, ...binds, project.id);
  await audit(ctx.env, {
    actor: ctx.identity!.actor,
    action: 'project:update',
    target: project.id,
    ip: clientIp(ctx.request),
    detail: JSON.stringify(body).slice(0, 400),
  });
  const updated = await getProject(ctx.env, project.id);
  return jsonResponse({ project: summarizeProject(updated!) });
});

router.delete('/projects/:id', async (ctx) => {
  const project = await findProject(ctx.env, ctx.params.id);
  if (!project) throw new HttpError(404, 'not_found', `no project "${ctx.params.id}"`);
  // Unassign assets first so FK-ish references stay consistent.
  await run(ctx.env, 'UPDATE assets SET project_id = NULL WHERE project_id = ?', project.id);
  await run(ctx.env, 'DELETE FROM projects WHERE id = ?', project.id);
  await audit(ctx.env, {
    actor: ctx.identity!.actor,
    action: 'project:delete',
    target: project.id,
    ip: clientIp(ctx.request),
    detail: project.slug,
  });
  return jsonResponse({ deleted: project.id, slug: project.slug });
});

router.post('/assets', (ctx) => {
  const identity = ctx.identity!;
  return handleUpload(ctx, { actor: identity.actor, keyId: null });
});

const MAX_BATCH = 50;

/**
 * Batch update tags / project, or mint share links for many assets at once.
 * Registered before `/assets/:hash` so `batch` is never treated as a hash.
 */
router.post('/assets/batch', async (ctx) => {
  const { env } = ctx;
  const body = await readJson(ctx.request);
  const hashesRaw = body.hashes;
  if (!Array.isArray(hashesRaw) || hashesRaw.length === 0) {
    throw new HttpError(400, 'invalid_request', 'hashes must be a non-empty array');
  }
  if (hashesRaw.length > MAX_BATCH) {
    throw new HttpError(400, 'too_many', `at most ${MAX_BATCH} hashes per batch`);
  }
  const hashes = [...new Set(hashesRaw.map((value) => String(value)))];
  const createLinks = body.create_links === true;
  const hasTags = 'tags' in body;
  const projectAssign = await resolveProjectAssignment(env, body);
  if (!createLinks && !hasTags && !projectAssign.touched) {
    throw new HttpError(400, 'nothing_to_update', 'pass tags, project and/or create_links');
  }

  const tagsMode = String(body.tags_mode ?? 'replace');
  if (hasTags && !['replace', 'add', 'remove'].includes(tagsMode)) {
    throw new HttpError(400, 'invalid_tags_mode', 'tags_mode must be replace|add|remove');
  }
  const incomingTags = hasTags ? normalizeTags(body.tags) : [];

  let linkExpiresAt: number | null | undefined;
  if (createLinks) {
    const hint = parseExpiryHint(body);
    linkExpiresAt = await resolveLinkExpiry(env, hint);
  }

  const results: {
    hash: string;
    url: string | null;
    tags: string[];
    project: ReturnType<typeof projectRef>;
    link?: ReturnType<typeof linkSummary>;
  }[] = [];
  const missing: string[] = [];
  const now = nowMs();

  for (const hash of hashes) {
    const asset = await first<AssetRow>(env, 'SELECT * FROM assets WHERE hash = ?', hash);
    if (!asset) {
      missing.push(hash);
      continue;
    }
    if (asset.deleted_at !== null || asset.purged_at !== null) {
      missing.push(hash);
      continue;
    }

    let currentTags = decodeTags(asset.tags);
    if (hasTags) {
      if (tagsMode === 'replace') currentTags = incomingTags;
      else if (tagsMode === 'add') currentTags = normalizeTags([...currentTags, ...incomingTags]);
      else currentTags = currentTags.filter((tag) => !incomingTags.includes(tag));
      await run(env, 'UPDATE assets SET tags = ? WHERE hash = ?', serializeTags(currentTags), asset.hash);
    }
    if (projectAssign.touched) {
      await run(env, 'UPDATE assets SET project_id = ? WHERE hash = ?', projectAssign.projectId, asset.hash);
    }

    let createdLink: LinkRow | undefined;
    if (createLinks) {
      createdLink = await insertLink(env, {
        assetHash: asset.hash,
        expiresAt: linkExpiresAt === undefined ? null : linkExpiresAt,
        label: body.label === undefined || body.label === null ? null : String(body.label).slice(0, 80),
        createdBy: ctx.identity!.actor,
        now,
      });
    }

    await audit(env, {
      actor: ctx.identity!.actor,
      action: createLinks ? 'batch:link' : 'batch:update',
      target: asset.hash,
      ip: clientIp(ctx.request),
      detail: JSON.stringify({
        tags: hasTags ? currentTags : undefined,
        tags_mode: hasTags ? tagsMode : undefined,
        project_id: projectAssign.touched ? projectAssign.projectId : undefined,
        link: createdLink?.hash,
      }).slice(0, 400),
    });

    const summary = await summarizeOne(env, await loadAssetOr404(env, asset.hash), now);
    results.push({
      hash: summary.hash,
      url: createdLink ? linkSummary(env, createdLink, asset.filename, now).url : summary.url,
      tags: summary.tags,
      project: summary.project,
      link: createdLink ? linkSummary(env, createdLink, asset.filename, now) : undefined,
    });
  }

  return jsonResponse({
    updated: results.length,
    missing,
    results,
  });
});

router.get('/assets/:hash', async (ctx) => {
  const detail = await getAssetDetail(ctx.env, ctx.params.hash);
  const trail = await all<{ at: number; actor: string; action: string; detail: string | null }>(
    ctx.env,
    'SELECT at, actor, action, detail FROM audit_log WHERE target = ? OR target IN (SELECT hash FROM links WHERE asset_hash = ?) ORDER BY at DESC LIMIT 40',
    ctx.params.hash,
    ctx.params.hash,
  );
  return jsonResponse({ ...detail, audit: trail });
});

router.get('/assets/:hash/links', async (ctx) =>
  jsonResponse(await listLinks(ctx.env, ctx.params.hash)));

router.post('/assets/:hash/links', async (ctx) => {
  const body = await readJson(ctx.request);
  const created = await createLink(serviceCtx(ctx), {
    asset_hash: ctx.params.hash,
    expires_in: body.expires_in as string | undefined,
    expires_at: body.expires_at as string | undefined,
    never: body.never as boolean | undefined,
    ttl: body.ttl as string | undefined,
    label: body.label as string | undefined,
    hash: body.hash as string | undefined,
  });
  return jsonResponse(created, { status: 201 });
});

/**
 * Agent/CLI temporary share link. Hard-capped at TEMP_LINK_MAX_SECONDS (4h).
 * Body: `{ expires_in?: "30m"|"1h"|"4h", label? }` — default 1h.
 */
router.post('/assets/:hash/temp-link', async (ctx) => {
  const body = await readJson(ctx.request);
  const created = await createTempLink(serviceCtx(ctx), {
    asset_hash: ctx.params.hash,
    expires_in: body.expires_in as string | undefined,
    label: body.label as string | undefined,
  });
  return jsonResponse(created, { status: 201 });
});

router.patch('/links/:hash', async (ctx) => {
  const { env } = ctx;
  const link = await loadLinkOr404(env, ctx.params.hash);
  const asset = await loadAssetOr404(env, link.asset_hash);
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
  if ('label' in body) {
    updates.push('label = ?');
    binds.push(body.label === null ? null : String(body.label).slice(0, 80));
  }
  if (updates.length === 0) {
    throw new HttpError(400, 'nothing_to_update', 'pass expires_in, expires_at, never, or label');
  }

  await run(env, `UPDATE links SET ${updates.join(', ')} WHERE hash = ?`, ...binds, link.hash);
  await purgeLink(env, ctx.exec, link.hash, asset.filename);
  await audit(env, {
    actor: ctx.identity!.actor,
    action: 'link:update',
    target: link.hash,
    ip: clientIp(ctx.request),
    detail: JSON.stringify(body).slice(0, 400),
  });
  const updated = await loadLinkOr404(env, link.hash);
  return jsonResponse({ link: linkSummary(env, updated, asset.filename) });
});

router.delete('/links/:hash', async (ctx) =>
  jsonResponse(await revokeLink(serviceCtx(ctx), ctx.params.hash)));

router.get('/assets/:hash/content', async (ctx) => {
  const asset = await loadAssetOr404(ctx.env, ctx.params.hash);
  if (!isEditableTextAsset(asset.content_type, asset.filename)) {
    throw new HttpError(415, 'not_editable', 'only markdown/plain text can be opened in the editor');
  }
  if (asset.purged_at !== null) throw new HttpError(410, 'purged', 'bytes have been removed');
  const object = await ctx.env.BUCKET.get(asset.object_key);
  if (!object) throw new HttpError(404, 'not_found', 'object bytes are missing');
  const headers = new Headers({
    'content-type': asset.content_type || 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'x-assets-hash': asset.hash,
    'x-assets-filename': encodeURIComponent(asset.filename),
  });
  return new Response(object.body, { status: 200, headers });
});

router.put('/assets/:hash/content', async (ctx) => {
  if (!ctx.request.body) throw new HttpError(400, 'empty_body', 'request has no body');
  const bytes = new Uint8Array(await ctx.request.arrayBuffer());
  const updated = await writeTextContent(serviceCtx(ctx), {
    asset_hash: ctx.params.hash,
    content: bytes,
    content_type: ctx.request.headers.get('content-type')?.trim() || undefined,
  });
  return jsonResponse({
    asset: {
      ...updated.asset,
      editable_text: true,
      markdown: isMarkdownAsset(updated.asset.content_type, updated.asset.filename),
    },
  });
});

router.patch('/assets/:hash', async (ctx) => {
  const body = await readJson(ctx.request);
  const updated = await updateAsset(serviceCtx(ctx), {
    asset_hash: ctx.params.hash,
    filename: body.filename as string | undefined,
    note: (body.note as string | null | undefined),
    tags: body.tags as string | string[] | undefined,
    projectInput: body,
  });
  return jsonResponse(updated);
});

router.delete('/assets/:hash', async (ctx) => {
  const hard = ctx.url.searchParams.get('purge') === '1' || ctx.url.searchParams.get('hard') === '1';
  return jsonResponse(await deleteAsset(serviceCtx(ctx), ctx.params.hash, hard));
});

router.post('/assets/:hash/restore', async (ctx) =>
  jsonResponse(await restoreAsset(serviceCtx(ctx), ctx.params.hash)));

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
      access_configured: accessConfigured(ctx.env),
      temp_link_max_seconds: TEMP_LINK_MAX_SECONDS,
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

router.get('/policy', async (ctx) => jsonResponse({
  ...(await uploadPolicy(ctx.env)),
  temp_link_max_seconds: TEMP_LINK_MAX_SECONDS,
}));

/**
 * Browsers send `Sec-Fetch-Site` and `Origin` on non-GET fetches. A cross-site
 * call is refused even if the Access cookie were attached. Service tokens and
 * the CLI omit both headers and stay allowed.
 */
function assertAdminWriteOrigin(request: Request, url: URL): void {
  if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') return;
  if (request.headers.get('sec-fetch-site') === 'cross-site') {
    throw new HttpError(403, 'cross_site', 'cross-site admin requests are refused');
  }
  const origin = request.headers.get('origin');
  if (!origin) return;
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    throw new HttpError(403, 'cross_site', 'invalid Origin');
  }
  if (originUrl.host !== url.host) {
    throw new HttpError(403, 'cross_site', 'Origin does not match this service');
  }
}

export async function handleAdminRequest(ctx: Ctx): Promise<Response> {
  try {
    const identity = await requireAccessIdentity(ctx.env, ctx.request);
    assertAdminWriteOrigin(ctx.request, ctx.url);
    const response = await router.handle({ ...ctx, identity }, '/admin/api');
    if (response) return response;
    return errorResponse(404, 'not_found', 'unknown admin endpoint');
  } catch (error) {
    return toErrorResponse(error);
  }
}
