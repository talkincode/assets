/**
 * talkincode-assets — request entry point.
 *
 *   GET  /<hash>/<filename?>   public asset delivery (hash is the locator)
 *   POST /api/upload           upload with an upload key
 *   ANY  /admin/api/*          dashboard API, behind a verified Access identity
 *   POST /mcp                  MCP server (Streamable HTTP), behind MCP OAuth
 *   PUT  /mcp/uploads/:id      upload-session bytes, same OAuth token
 *   PUT  /uploads/:id?key=..   upload-session bytes, single-use session key (no OAuth)
 *   GET|POST /authorize        MCP OAuth consent page (Access members only)
 *   GET  /health               liveness probe
 *
 * The dashboard itself is static and served by the Workers static-assets
 * binding; requests that match a file never reach this worker.
 *
 * OAuth protocol endpoints (/token, /register, /.well-known/…) are served by
 * the OAuthProvider itself; everything else falls through to the dashboard /
 * public routes below via defaultHandler.
 */

import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { handleAssetRequest } from './assets';
import { handleAdminRequest } from './admin';
import { handleUpload } from './upload';
import { authenticateUploadKey, touchUploadKey } from './auth';
import { clientIp, isBlocked, registerMiss, withinRequestBudget } from './abuse';
import { sweep } from './cron';
import { errorResponse, jsonResponse, toErrorResponse } from './util';
import type { Ctx } from './router';
import { handleAuthorizeGet, handleAuthorizePost } from './mcp-auth';
import { handleMcpApi } from './mcp-http';
import { completeUploadSessionByKey } from './service';
import { MCP_ISSUER, MCP_RESOURCE, SCOPES_REQUIRED, SCOPES_SUPPORTED } from './mcp';

export { AbuseGuard } from './abuse-guard';

const oauth = new OAuthProvider<Env>({
  apiRoute: '/mcp',
  apiHandler: {
    fetch: (request, env, ctx) => handleMcpApi(request, env, ctx),
  },
  defaultHandler: {
    fetch: (request, env, ctx) => {
      const url = new URL(request.url);
      if (url.pathname === '/authorize') {
        if (request.method === 'GET') return handleAuthorizeGet(env, request);
        if (request.method === 'POST') return handleAuthorizePost(env, request);
        return errorResponse(405, 'method_not_allowed', 'authorize with GET or POST');
      }
      return route({ request, env, exec: ctx, url, params: {} });
    },
  },
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register',
  scopesSupported: [...SCOPES_SUPPORTED],
  resourceMetadata: {
    resource: MCP_RESOURCE,
    authorization_servers: [MCP_ISSUER],
    resource_name: 'Talkincode Assets',
  },
  requiredScopes: [...SCOPES_REQUIRED],
  clientIdMetadataDocumentEnabled: true,
});

export default {
  async fetch(request: Request, env: Env, exec: ExecutionContext): Promise<Response> {
    try {
      return await oauth.fetch(request, env, exec);
    } catch (error) {
      return toErrorResponse(error);
    }
  },

  async scheduled(_event: ScheduledController, env: Env, exec: ExecutionContext): Promise<void> {
    const result = await sweep(env, exec);
    const oauthPurged = await oauth.purgeExpiredData(env).catch((error) => {
      console.error('oauth purge failed', error);
      return null;
    });
    const oauthSwept = (oauthPurged?.grantsPurged ?? 0) + (oauthPurged?.tokensPurged ?? 0);
    if (
      result.purged > 0 || result.blocksCleared > 0 || result.auditPruned > 0 ||
      result.sessionsCleared > 0 || oauthSwept > 0
    ) {
      console.log('assets sweep', JSON.stringify({ ...result, oauth: oauthPurged }));
    }
  },
} satisfies ExportedHandler<Env>;

/** Percent-decoding must never throw on hostile input. */
function decodeSegment(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

async function route(ctx: Ctx): Promise<Response> {
  const { request, env, url } = ctx;
  const path = url.pathname;

  if (path === '/health') {
    return jsonResponse({ status: 'ok', service: 'talkincode-assets', time: Date.now() });
  }

  if (path === '/api/upload') {
    const blocked = await isBlocked(env, request);
    if (blocked.blocked) {
      return errorResponse(403, 'blocked', 'this network has been blocked after repeated failed attempts');
    }
    const identity = await authenticateUploadKey(env, request);
    if (!identity) {
      // A wrong key is the same kind of abuse as guessing hashes.
      const verdict = await registerMiss(env, request, 'bad upload key');
      if (verdict.blocked) {
        return errorResponse(403, 'blocked', 'this network has been blocked after repeated failed attempts');
      }
      return errorResponse(401, 'unauthorized', 'missing or invalid upload key');
    }
    if (!(await withinRequestBudget(env, request))) {
      return errorResponse(429, 'rate_limited', 'too many requests');
    }
    touchUploadKey(env, ctx.exec, identity.key.id, clientIp(request));
    return handleUpload(ctx, { actor: identity.actor, keyId: identity.key.id });
  }

  if (path === '/admin/api' || path.startsWith('/admin/api/')) {
    return handleAdminRequest(ctx);
  }

  const segments = path.split('/').filter((segment) => segment !== '');

  // Signed-URL upload completion. Outside the OAuth apiRoute on purpose:
  // the uploader holds the single-use session key, not the creator's token.
  if (segments.length === 2 && segments[0] === 'uploads') {
    const sessionId = decodeSegment(segments[1]);
    if (sessionId === null) return errorResponse(404, 'not_found', 'not found');
    return completeUploadSessionByKey(env, ctx.exec, request, url, sessionId);
  }
  if (segments.length === 1 || segments.length === 2) {
    const hash = decodeSegment(segments[0]);
    const filename = segments.length === 2 ? decodeSegment(segments[1]) : null;
    if (hash === null || (segments.length === 2 && filename === null)) {
      return errorResponse(404, 'not_found', 'not found');
    }
    const params: Record<string, string> = { hash };
    if (filename !== null) params.filename = filename;
    return handleAssetRequest({ ...ctx, params });
  }

  return errorResponse(404, 'not_found', 'no such route');
}
