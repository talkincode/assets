/**
 * OAuth-protected API surface: the MCP endpoint plus the upload-session
 * byte sink. The OAuthProvider validates the bearer token before this runs,
 * so `ctx` already carries the verified `props` (stored at authorize time)
 * and `auth` (token scopes, client, expiry).
 */

import { createMcpHandler } from 'agents/mcp/server';
import type { AuthInfo } from '@modelcontextprotocol/server';
import { insufficientScope, type OAuthResourceAuth } from '@cloudflare/workers-oauth-provider';
import { clientIp } from './abuse';
import { errorResponse } from './util';
import {
  createAssetsMcpServer,
  hasScope,
  mcpResourceUrl,
  SCOPE_WRITE,
  type McpIdentity,
} from './mcp';
import { completeUploadSession, type ServiceCtx } from './service';

interface TokenProps {
  email?: unknown;
  actor?: unknown;
}

export async function handleMcpApi(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const { props, auth } = ctx as unknown as { props?: TokenProps; auth?: OAuthResourceAuth };
  if (!auth || typeof props?.actor !== 'string' || !props.actor) {
    return errorResponse(401, 'unauthorized', 'valid OAuth access token required');
  }
  const identity: McpIdentity = {
    actor: props.actor,
    email: typeof props.email === 'string' ? props.email : null,
    scopes: Array.isArray(auth.scope) ? auth.scope : [],
    clientId: auth.clientId ?? null,
  };
  const url = new URL(request.url);

  if (url.pathname === '/mcp') {
    const handler = createMcpHandler(
      () => createAssetsMcpServer({ env, exec: ctx, identity, ip: clientIp(request) }),
      {
        route: '/mcp',
        authContext: { props: { actor: identity.actor, email: identity.email } },
      },
    );
    const authInfo: AuthInfo = {
      token: auth.token,
      clientId: auth.clientId ?? 'unknown-client',
      scopes: identity.scopes,
      ...(typeof auth.expiresAt === 'number' ? { expiresAt: auth.expiresAt } : {}),
      resource: new URL(mcpResourceUrl(env)),
      extra: { props: { actor: identity.actor, email: identity.email } },
    };
    return handler.fetch(request, { authInfo });
  }

  const uploadMatch = /^\/mcp\/uploads\/([A-Za-z0-9_-]{1,64})$/.exec(url.pathname);
  if (uploadMatch) {
    if (!hasScope(identity.scopes, SCOPE_WRITE)) return insufficientScope(auth, [SCOPE_WRITE]);
    const svc: ServiceCtx = { env, exec: ctx, actor: identity.actor, ip: clientIp(request) };
    return completeUploadSession(svc, request, uploadMatch[1]);
  }

  return errorResponse(404, 'not_found', 'no such route');
}
