/**
 * talkincode-assets — request entry point.
 *
 *   GET  /<hash>/<filename?>   public asset delivery (hash is the locator)
 *   POST /api/upload           upload with an upload key
 *   ANY  /admin/api/*          dashboard API, behind a verified Access identity
 *   GET  /health               liveness probe
 *
 * The dashboard itself is static and served by the Workers static-assets
 * binding; requests that match a file never reach this worker.
 */

import { handleAssetRequest } from './assets';
import { handleAdminRequest } from './admin';
import { handleUpload } from './upload';
import { authenticateUploadKey, touchUploadKey } from './auth';
import { clientIp, isBlocked, registerMiss, withinRequestBudget } from './abuse';
import { sweep } from './cron';
import { errorResponse, jsonResponse, toErrorResponse } from './util';
import type { Ctx } from './router';

export { AbuseGuard } from './abuse-guard';

export default {
  async fetch(request: Request, env: Env, exec: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const ctx: Ctx = { request, env, exec, url, params: {} };
    try {
      return await route(ctx);
    } catch (error) {
      return toErrorResponse(error);
    }
  },

  async scheduled(_event: ScheduledController, env: Env, exec: ExecutionContext): Promise<void> {
    const result = await sweep(env, exec);
    if (result.expired > 0 || result.purged > 0) {
      console.log('assets sweep', JSON.stringify(result));
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
