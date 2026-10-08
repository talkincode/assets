/**
 * MCP OAuth `/authorize` page.
 *
 * The MCP Portal (or any MCP client) opens this URL in a browser after
 * OAuth discovery. The user proves dashboard membership first — via the
 * Access assertion header, or the Access session cookie from a prior
 * `/admin/` login — then approves the client's scopes. Tokens the client
 * gets afterwards are this service's own OAuth tokens, not Access tokens.
 */

import {
  AuthorizationError,
  CimdFetchError,
  type ConsentDescription,
  type OAuthHelpers,
} from '@cloudflare/workers-oauth-provider';
import { HttpError, toErrorResponse } from './util';
import { requireAccessIdentity, type AccessIdentity } from './auth';

function oauthHelpers(env: Env): OAuthHelpers {
  const helpers = (env as unknown as { OAUTH_PROVIDER?: OAuthHelpers }).OAUTH_PROVIDER;
  if (!helpers) throw new HttpError(500, 'internal_error', 'oauth provider is not mounted');
  return helpers;
}

/**
 * Dashboard membership for the authorize step. The Access edge app only
 * fronts `/admin`, so this endpoint is reached directly: accept the
 * assertion header when present, otherwise the Access session cookie the
 * browser already holds from logging in to the dashboard.
 */
export async function requireMcpLogin(env: Env, request: Request): Promise<AccessIdentity> {
  if (request.headers.get('cf-access-jwt-assertion')) {
    return requireAccessIdentity(env, request);
  }
  const cookie = request.headers.get('cookie') ?? '';
  const match = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(cookie);
  if (match) {
    let value = match[1].trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      // Fall through to the login hint below.
    }
    if (value) {
      const headers = new Headers(request.headers);
      headers.set('cf-access-jwt-assertion', value);
      return requireAccessIdentity(env, new Request(request.url, { headers }));
    }
  }
  throw new HttpError(401, 'access_required', 'log in to the dashboard (/admin/) first, then retry authorization');
}

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

function consentPage(details: ConsentDescription, handle: string): string {
  const name = escapeHtml(details.clientName);
  const origin = details.clientDomain
    ? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
    : 'This app registered itself; its name is not verified.';
  const scopes = details.scope
    .map(
      (scope) =>
        `<label><input type="checkbox" name="scope" value="${escapeHtml(scope)}" checked> ${escapeHtml(scope)}</label>`,
    )
    .join('<br>');
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize ${name} — Talkincode Assets</title>
<h1>Allow ${name} to access your assets?</h1>
<p>${origin} Access will be sent to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
${details.redirectIsLoopback ? '<p><strong>This sends access to an app on your computer.</strong> Continue only if you just started signing in from it.</p>' : ''}
<form method="post">
  <input type="hidden" name="handle" value="${escapeHtml(handle)}">
  ${scopes}
  <p><button name="decision" value="approve">Allow</button> <button name="decision" value="deny">Deny</button></p>
</form>`;
}

function oauthErrorResponse(error: unknown): Response {
  if (error instanceof AuthorizationError && error.redirectTo) {
    return Response.redirect(error.redirectTo, 302);
  }
  if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
    const message = error instanceof AuthorizationError ? error.description : 'This app could not be verified.';
    return new Response(message, { status: 400, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
  return toErrorResponse(error);
}

export async function handleAuthorizeGet(env: Env, request: Request): Promise<Response> {
  await requireMcpLogin(env, request);
  const oauth = oauthHelpers(env);
  let authRequest;
  try {
    authRequest = await oauth.parseAuthRequest(request);
  } catch (error) {
    return oauthErrorResponse(error);
  }
  const details = await oauth.describeConsent(authRequest);
  const consent = await oauth.beginConsent(authRequest);
  consent.headers.set('content-type', 'text/html; charset=utf-8');
  return new Response(consentPage(details, consent.handle), { headers: consent.headers });
}

export async function handleAuthorizePost(env: Env, request: Request): Promise<Response> {
  const identity = await requireMcpLogin(env, request);
  const oauth = oauthHelpers(env);
  const form = await request.formData();
  const handle = String(form.get('handle') ?? '');
  try {
    if (form.get('decision') !== 'approve') {
      const denied = await oauth.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const approved = await oauth.approveConsent(request, handle, {
      scope: form.getAll('scope').map(String),
    });
    const subject = identity.email ?? identity.actor;
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: subject,
      metadata: {},
      scope: approved.request.scope,
      props: { email: identity.email, actor: identity.actor },
    });
    approved.headers.set('Location', redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (error) {
    return oauthErrorResponse(error);
  }
}
