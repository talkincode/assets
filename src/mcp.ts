/**
 * MCP (L0) service layer + server factory.
 *
 * Business rules live with the dashboard (admin.ts): same TTL caps, same
 * audit rows, same soft-delete semantics. This module only translates them
 * into MCP tools / resources / prompts. Every mutation writes an audit entry
 * with the OAuth identity as actor.
 */

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  createLink,
  createProject,
  createTempLink,
  createUploadSession,
  deleteAsset,
  getAssetDetail,
  listProjects,
  listTags,
  readTextContent,
  restoreAsset,
  revokeLink,
  searchAssets,
  updateAsset,
  writeTextContent,
  type CreateLinkArgs,
  type CreateProjectArgs,
  type CreateSessionArgs,
  type CreateTempLinkArgs,
  type SearchArgs,
  type ServiceCtx,
} from './service';
import { HttpError, isEditableTextAsset } from './util';

export const MCP_ROUTE = '/mcp';
export const MCP_SERVER_NAME = 'talkincode-assets';
export const MCP_SERVER_VERSION = '0.1.0';

/** Canonical protected-resource URL. Must match PUBLIC_BASE_URL + /mcp. */
export const MCP_RESOURCE = 'https://assets.talkincode.net/mcp';
export const MCP_ISSUER = 'https://assets.talkincode.net';

export const SCOPE_READ = 'assets:read';
export const SCOPE_WRITE = 'assets:write';
export const SCOPE_ADMIN = 'assets:admin';
export const SCOPES_SUPPORTED = [SCOPE_READ, SCOPE_WRITE, SCOPE_ADMIN, 'offline_access'];
/**
 * Advertised as the minimum grant so MCP clients request all three up front.
 * Step-up after a 403 works in theory, but mainstream clients (ChatGPT,
 * Portal) never step up — a read-only first grant would strand write tools
 * with no path to recovery. Single-owner service: the consent page is the
 * authorization boundary, not the scope floor.
 */
export const SCOPES_REQUIRED = [SCOPE_READ, SCOPE_WRITE, SCOPE_ADMIN];

export interface McpIdentity {
  actor: string;
  email: string | null;
  scopes: string[];
  clientId: string | null;
}

/** Broader scopes imply narrower ones; rank decides: admin > write > read. */
const SCOPE_RANK = [SCOPE_READ, SCOPE_WRITE, SCOPE_ADMIN];
export function hasScope(granted: string[], needed: string): boolean {
  const needRank = SCOPE_RANK.indexOf(needed);
  if (needRank === -1) return false;
  return granted.some((scope) => SCOPE_RANK.indexOf(scope) >= needRank);
}

export function mcpResourceUrl(env: Env): string {
  return `${env.PUBLIC_BASE_URL.replace(/\/+$/, '')}/mcp`;
}

/**
 * Scope gate for every MCP operation. The installed MCP SDK (v2.0.0) has no
 * protocol-level scope challenges, so each tool/resource/prompt checks the
 * OAuth token scopes explicitly through this helper. Broader scopes imply
 * narrower ones (admin > write > read); without the needed scope the caller
 * gets a machine-readable insufficient_scope error telling it to re-authorize.
 */
/** Throwing variant for resource/prompt callbacks, which cannot return tool errors. */
export function needScope(identity: McpIdentity, needed: string): void {
  if (!hasScope(identity.scopes, needed)) {
    throw new HttpError(403, 'insufficient_scope', `this operation needs the "${needed}" scope`);
  }
}

export function scopeDenied(identity: McpIdentity, needed: string) {
  if (hasScope(identity.scopes, needed)) return null;
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          error: 'insufficient_scope',
          message: `this operation needs the "${needed}" scope; re-authorize with: ${needed}`,
          required_scopes: [needed],
        }),
      },
    ],
    isError: true as const,
  };
}


// ---------------------------------------------------------------------------
// Server factory: one McpServer per request, closed over that request's
// OAuth identity. Stateless transport carries no session; durable state
// lives in D1/R2 behind the identity.
// ---------------------------------------------------------------------------

export interface McpRequestDeps {
  env: Env;
  exec: ExecutionContext;
  identity: McpIdentity;
  ip: string | null;
}

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

function fail(error: unknown) {
  const body = error instanceof HttpError
    ? { error: error.code, message: error.message }
    : { error: 'internal_error', message: 'request failed' };
  if (!(error instanceof HttpError)) console.error('mcp tool failed', error);
  return { content: [{ type: 'text' as const, text: JSON.stringify(body) }], isError: true as const };
}

/**
 * One wrapper for every tool: scope gate, then service call, then errors as
 * tool results (never thrown — a throw would surface as an opaque -32603).
 */
function guarded<A>(identity: McpIdentity, scope: string, fn: (args: A) => Promise<unknown>) {
  return async (args: A) => {
    const denied = scopeDenied(identity, scope);
    if (denied) return denied;
    try {
      return ok(await fn(args));
    } catch (error) {
      return fail(error);
    }
  };
}

const hashArg = z.string().min(16).max(64).describe('Asset hash (assets.hash), not a share-link hash');
const tagsArg = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .describe('Tags: comma/space separated string or array');

export function createAssetsMcpServer(deps: McpRequestDeps): McpServer {
  const { env, exec, identity, ip } = deps;
  const svc: ServiceCtx = { env, exec, actor: identity.actor, ip };
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    {
      instructions:
        'Talkincode Assets: immutable files addressed by asset hash, shared through expiring link URLs. ' +
        'Use search_assets to find files, get_asset for metadata and share links, create_temp_link (max 4h) to share. ' +
        'Large uploads: create_upload_session first, then PUT the bytes to upload_url.',
    },
  );

  server.registerTool(
    'search_assets',
    {
      description: 'Search assets by filename/note/tag text, tag, project, status, or media kind',
      inputSchema: z.object({
        q: z.string().optional().describe('Free-text match on hash, filename, note, tags'),
        tag: z.string().optional(),
        project: z.string().optional().describe('Project slug or id; "none" for unassigned'),
        status: z.enum(['live', 'expired', 'deleted', 'all']).optional().describe('Default live'),
        kind: z.enum(['image', 'audio', 'video', 'text', 'other']).optional(),
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    guarded<SearchArgs>(identity, SCOPE_READ, (args) => searchAssets(env, args)),
  );

  server.registerTool(
    'get_asset',
    {
      description: 'Asset metadata plus its share links (expiry, revoke state, download URLs)',
      inputSchema: z.object({ asset_hash: hashArg }),
      annotations: { readOnlyHint: true },
    },
    guarded<{ asset_hash: string }>(identity, SCOPE_READ, (args) => getAssetDetail(env, args.asset_hash)),
  );

  server.registerTool(
    'list_projects',
    {
      description: 'List asset folders (projects) with live-asset counts',
      inputSchema: z.object({
        include_archived: z.boolean().optional().describe('Default false'),
      }),
      annotations: { readOnlyHint: true },
    },
    guarded<{ include_archived?: boolean }>(identity, SCOPE_READ, (args) =>
      listProjects(env, args.include_archived ?? false)),
  );

  server.registerTool(
    'list_tags',
    {
      description: 'Tags in use on live assets, with counts',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    guarded<Record<string, never>>(identity, SCOPE_READ, () => listTags(env)),
  );

  server.registerTool(
    'read_text_content',
    {
      description: 'Read the text of a markdown/plain-text asset (2 MiB cap; larger files need a share link)',
      inputSchema: z.object({ asset_hash: hashArg }),
      annotations: { readOnlyHint: true },
    },
    guarded<{ asset_hash: string }>(identity, SCOPE_READ, (args) => readTextContent(env, args.asset_hash)),
  );

  server.registerTool(
    'create_temp_link',
    {
      description: 'Create a temporary share link for an asset. Always expires, hard max 4 hours, default 1 hour',
      inputSchema: z.object({
        asset_hash: hashArg,
        expires_in: z.string().optional().describe('e.g. "30m", "1h", "4h". Default 1h, max 4h'),
        label: z.string().max(80).optional().describe('Channel note, e.g. "wechat"'),
      }),
      annotations: { idempotentHint: false, openWorldHint: true },
    },
    guarded<CreateTempLinkArgs>(identity, SCOPE_WRITE, (args) => createTempLink(svc, args)),
  );

  server.registerTool(
    'create_link',
    {
      description:
        'Create a regular share link with its own expiry (default policy when omitted). ' +
        'Needs the admin scope because links may be long-lived or never expire; use create_temp_link for short shares.',
      inputSchema: z.object({
        asset_hash: hashArg,
        expires_in: z.string().optional().describe('TTL like "7d"; ignored when expires_at/never is set'),
        expires_at: z.string().optional().describe('Absolute timestamp'),
        never: z.boolean().optional().describe('Link never expires'),
        label: z.string().max(80).optional(),
        hash: z.string().min(16).max(64).optional().describe('Custom link hash locator'),
      }),
      annotations: { idempotentHint: false, openWorldHint: true },
    },
    guarded<CreateLinkArgs>(identity, SCOPE_ADMIN, (args) => createLink(svc, args)),
  );

  server.registerTool(
    'update_asset',
    {
      description: 'Edit asset filename, note, tags, or project assignment',
      inputSchema: z.object({
        asset_hash: hashArg,
        filename: z.string().optional(),
        note: z.string().max(500).nullable().optional().describe('Null clears the note'),
        tags: tagsArg,
        project: z.string().nullable().optional().describe('Slug/id to assign; "none" clears'),
      }),
      annotations: { idempotentHint: true },
    },
    guarded<{ asset_hash: string; filename?: string; note?: string | null; tags?: string | string[]; project?: string | null }>(identity, SCOPE_WRITE, (args) =>
      updateAsset(svc, {
        asset_hash: args.asset_hash,
        filename: args.filename,
        note: args.note,
        tags: args.tags,
        projectInput: args.project === undefined ? undefined : { project: args.project },
      })),
  );

  server.registerTool(
    'write_text_content',
    {
      description: 'Replace the bytes of a markdown/plain-text asset (2 MiB cap). Overwrites file content.',
      inputSchema: z.object({
        asset_hash: hashArg,
        content: z.string().describe('Full replacement text'),
        content_type: z.string().optional().describe('Defaults to text/plain or text/markdown by filename'),
      }),
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    guarded<{ asset_hash: string; content: string; content_type?: string }>(identity, SCOPE_WRITE, (args) =>
      writeTextContent(svc, {
        asset_hash: args.asset_hash,
        content: new TextEncoder().encode(args.content),
        content_type: args.content_type,
      })),
  );

  server.registerTool(
    'create_upload_session',
    {
      description:
        'Reserve an upload: returns a signed upload_url for a single PUT of the raw bytes ' +
        '(Content-Length required, no Authorization header needed — the URL carries a single-use key). ' +
        'Hand the URL to whatever uploads the bytes; creator and uploader may differ. ' +
        'Prefer this over text tools for any file; required for binary/media.',
      inputSchema: z.object({
        filename: z.string().describe('Download filename, e.g. "demo.mp4"'),
        content_type: z.string().optional().describe('Inferred from filename when omitted'),
        size: z.number().int().positive().optional().describe('Exact byte size when known'),
        note: z.string().max(500).optional(),
        tags: tagsArg,
        project: z.string().optional(),
        expires_in: z.string().optional().describe('Session window, default 1h, max 4h'),
      }),
      annotations: { openWorldHint: true },
    },
    guarded<CreateSessionArgs>(identity, SCOPE_WRITE, (args) => createUploadSession(svc, args)),
  );

  server.registerTool(
    'create_project',
    {
      description: 'Create an asset folder (project) for grouping uploads',
      inputSchema: z.object({
        slug: z.string().optional().describe('ASCII locator, e.g. "demo-kit". Derived from name when omitted'),
        name: z.string().max(80).optional().describe('Display name. Required when slug is omitted'),
        note: z.string().max(500).optional(),
      }),
      annotations: { idempotentHint: false },
    },
    guarded<CreateProjectArgs>(identity, SCOPE_WRITE, (args) => createProject(svc, args)),
  );

  server.registerTool(
    'delete_asset',
    {
      description: 'Soft-delete an asset (revokes all its links; bytes kept 7 days for restore) or purge immediately',
      inputSchema: z.object({
        asset_hash: hashArg,
        purge: z.boolean().optional().describe('True = delete bytes and rows now. Irreversible.'),
      }),
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    guarded<{ asset_hash: string; purge?: boolean }>(identity, SCOPE_ADMIN, (args) =>
      deleteAsset(svc, args.asset_hash, args.purge ?? false)),
  );

  server.registerTool(
    'restore_asset',
    {
      description: 'Restore a soft-deleted asset (links stay revoked; create a new link to share again)',
      inputSchema: z.object({ asset_hash: hashArg }),
      annotations: { idempotentHint: true },
    },
    guarded<{ asset_hash: string }>(identity, SCOPE_ADMIN, (args) => restoreAsset(svc, args.asset_hash)),
  );

  server.registerTool(
    'revoke_link',
    {
      description: 'Revoke one share link now (the asset itself is untouched)',
      inputSchema: z.object({
        link_hash: z.string().min(16).max(64).describe('Share-link hash, not the asset hash'),
      }),
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    guarded<{ link_hash: string }>(identity, SCOPE_ADMIN, (args) => revokeLink(svc, args.link_hash)),
  );

  // -- resources -------------------------------------------------------------

  const listLive = async (limit: number) => {
    const page = await searchAssets(env, { status: 'live', limit, offset: 0 });
    return { page };
  };

  const metaTemplate = new ResourceTemplate('asset://meta/{hash}', {
    list: async () => {
      if (!hasScope(identity.scopes, SCOPE_READ)) return { resources: [] };
      const { page } = await listLive(50);
      return {
        resources: page.assets.map((asset) => ({
          uri: `asset://meta/${asset.hash}`,
          name: asset.filename,
          mimeType: 'application/json',
        })),
      };
    },
  });
  server.registerResource(
    'asset-metadata',
    metaTemplate,
    {
      title: 'Asset metadata',
      description: 'JSON metadata for one asset (status, size, tags, project, note)',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      needScope(identity, SCOPE_READ);
      const hash = String(variables.hash ?? '');
      const detail = await getAssetDetail(env, hash);
      return {
        contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(detail.asset) }],
      };
    },
  );

  const textTemplate = new ResourceTemplate('asset://text/{hash}', {
    list: async () => {
      if (!hasScope(identity.scopes, SCOPE_READ)) return { resources: [] };
      const { page } = await listLive(50);
      return {
        resources: page.assets
          .filter((asset) => isEditableTextAsset(asset.content_type, asset.filename))
          .map((asset) => ({
            uri: `asset://text/${asset.hash}`,
            name: asset.filename,
            mimeType: 'text/plain',
          })),
      };
    },
  });
  server.registerResource(
    'asset-text',
    textTemplate,
    {
      title: 'Asset text',
      description: 'Raw text of a markdown/plain-text asset (2 MiB cap)',
      mimeType: 'text/plain',
    },
    async (uri, variables) => {
      needScope(identity, SCOPE_READ);
      const hash = String(variables.hash ?? '');
      const read = await readTextContent(env, hash);
      return {
        contents: [{ uri: uri.href, mimeType: read.content_type, text: read.text }],
      };
    },
  );

  // -- prompts ---------------------------------------------------------------

  server.registerPrompt(
    'share_asset',
    {
      title: 'Share an asset',
      description: 'Create a temporary share link and present it with expiry',
      argsSchema: z.object({
        asset_hash: z.string().describe('Asset to share'),
        expires_in: z.string().optional().describe('Link TTL, e.g. "1h". Max 4h'),
        label: z.string().optional().describe('Channel note'),
      }),
    },
    (args) => {
      needScope(identity, SCOPE_WRITE);
      return {
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text:
              `Create a temporary share link for asset ${args.asset_hash}` +
              `${args.expires_in ? ` that lasts ${args.expires_in}` : ''}` +
              `${args.label ? ` for the "${args.label}" channel` : ''} ` +
              `using the create_temp_link tool, then reply with the URL, the expiry time, and the filename.`,
          },
        },
      ],
      };
    },
  );

  server.registerPrompt(
    'asset_digest',
    {
      title: 'Summarize an asset',
      description: 'Fetch asset metadata and summarize it for sharing',
      argsSchema: z.object({
        asset_hash: z.string().describe('Asset to summarize'),
      }),
    },
    (args) => {
      needScope(identity, SCOPE_READ);
      return {
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text:
              `Look up asset ${args.asset_hash} with get_asset and summarize it in one short paragraph: ` +
              `filename, media type and size, tags, project, note, and whether it currently has a live share link.`,
          },
        },
      ],
      };
    },
  );

  return server;
}
