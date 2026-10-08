import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createUploadKey, resetAccessCaches } from '../src/auth';
import { resetSettingsCache } from '../src/db';
import { TEST_EMAIL, signAccessJwt } from './access-fixtures';

/**
 * MCP (L0) seam: the worker as a remote MCP + OAuth server, driven over HTTP
 * exactly like Cloudflare's MCP Portal would drive it. The canonical public
 * host is used on purpose — OAuth token audience is bound to it.
 */
const BASE = 'https://assets.talkincode.net';
const MCP_URL = `${BASE}/mcp`;
const RESOURCE = `${BASE}/mcp`;

async function uploadKey(): Promise<string> {
  return (await createUploadKey(env, 'mcp-test', 'test-setup')).secret;
}

async function accessHeaders(): Promise<Record<string, string>> {
  return { 'cf-access-jwt-assertion': await signAccessJwt({ email: TEST_EMAIL }) };
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

/** Drive the full MCP OAuth code flow and return a bearer token. */
async function authorize(scopes: string[]): Promise<string> {
  const access = await accessHeaders();
  const redirectUri = 'http://localhost:9999/callback';

  const registered = await SELF.fetch(`${BASE}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'mcp-test-client',
      redirect_uris: [redirectUri],
    }),
  });
  expect(registered.status).toBe(201);
  const { client_id: clientId, client_secret: clientSecret } =
    (await registered.json()) as { client_id: string; client_secret?: string };  const basic = clientSecret
    ? `Basic ${btoa(`${clientId}:${clientSecret}`)}`
    : undefined;

  const { verifier, challenge } = await pkce();
  const authorizeUrl =
    `${BASE}/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${encodeURIComponent(scopes.join(' '))}` +
    `&resource=${encodeURIComponent(RESOURCE)}` +
    `&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256` +
    `&state=test-state`;
  const consentPage = await SELF.fetch(authorizeUrl, { headers: access });
  expect(consentPage.status).toBe(200);
  const html = await consentPage.text();
  expect(html).toContain('Allow');
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1];
  expect(handle).toBeTruthy();
  const cookies = consentPage.headers.getSetCookie();
  expect(cookies.length).toBeGreaterThan(0);

  const form = new URLSearchParams();
  form.set('handle', handle!);
  form.set('decision', 'approve');
  for (const scope of scopes) form.append('scope', scope);
  // Manual redirects: the 302 points at the test-only loopback callback.
  // Send only the name=value pairs back, not the Set-Cookie attributes.
  const cookiePairs = cookies.map((cookie) => cookie.split(';')[0]);
  const approved = await SELF.fetch(`${BASE}/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: { ...access, 'content-type': 'application/x-www-form-urlencoded', cookie: cookiePairs.join('; ') },
    body: form.toString(),
  });
  expect(approved.status).toBe(302);
  const location = approved.headers.get('location')!;
  expect(location.startsWith(redirectUri)).toBe(true);
  const code = new URL(location).searchParams.get('code');
  expect(code).toBeTruthy();

  // client_secret_basic: the client_id travels in the Basic header only;
  // repeating it in the body counts as a second auth method.
  const tokenBody = new URLSearchParams({
    grant_type: 'authorization_code',
    code: code!,
    redirect_uri: redirectUri,
    ...(basic ? {} : { client_id: clientId }),
    code_verifier: verifier,
    resource: RESOURCE,
  });
  const token = await SELF.fetch(`${BASE}/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(basic ? { authorization: basic } : {}),
    },
    body: tokenBody.toString(),
  });
  expect(token.status).toBe(200);
  const { access_token: accessToken } = (await token.json()) as { access_token: string };
  expect(accessToken).toBeTruthy();
  return accessToken;
}

function mcpHeaders(token: string, version?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${token}`,
  };
  if (version) headers['mcp-protocol-version'] = version;
  return headers;
}

async function mcpCall(token: string, version: string | undefined, id: number, method: string, params: unknown) {
  const response = await SELF.fetch(MCP_URL, {
    method: 'POST',
    headers: mcpHeaders(token, version),
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  expect(response.status).toBe(200);
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('text/event-stream')) {
    const dataLines = (await response.text())
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice('data: '.length));
    expect(dataLines.length).toBeGreaterThan(0);
    return JSON.parse(dataLines[dataLines.length - 1]) as {
      result?: any;
      error?: { code: number; message: string };
    };
  }
  return (await response.json()) as { result?: any; error?: { code: number; message: string } };
}

async function uploadFixture(key: string, body: string, filename: string): Promise<{ asset_hash: string; hash: string }> {
  const created = await SELF.fetch(`${BASE}/api/upload`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'x-filename': filename,
      'content-type': 'text/markdown; charset=utf-8',
      'content-length': String(new TextEncoder().encode(body).length),
    },
    body,
  });
  expect(created.status).toBe(201);
  return (await created.json()) as { asset_hash: string; hash: string };
}

beforeEach(async () => {
  resetAccessCaches();
  resetSettingsCache();
});

describe('mcp tool calls over oauth', () => {
  it('authorizes, initializes, and searches assets', async () => {
    const key = await uploadKey();
    const fixture = await uploadFixture(key, '# hello mcp\n', 'hello.md');
    const token = await authorize(['assets:read', 'assets:write']);

    const initialized = await mcpCall(token, undefined, 1, 'initialize', {
      protocolVersion: '2026-07-28',
      capabilities: {},
      clientInfo: { name: 'mcp-test', version: '0.1.0' },
    });
    expect(initialized.error).toBeUndefined();
    expect(initialized.result.serverInfo.name).toBe('talkincode-assets');
    const version = initialized.result.protocolVersion as string;
    expect(version).toBeTruthy();

    const listed = await mcpCall(token, version, 2, 'tools/list', {});
    const names = (listed.result.tools as { name: string }[]).map((tool) => tool.name);
    for (const expected of ['search_assets', 'get_asset', 'create_temp_link', 'create_upload_session']) {
      expect(names).toContain(expected);
    }

    const found = await mcpCall(token, version, 3, 'tools/call', {
      name: 'search_assets',
      arguments: { q: 'hello' },
    });
    expect(found.error).toBeUndefined();
    const payload = JSON.parse(found.result.content[0].text);
    expect(payload.total).toBeGreaterThanOrEqual(1);
    expect(payload.assets.some((asset: { hash: string }) => asset.hash === fixture.asset_hash)).toBe(true);
  });

  it('refuses write tools on a read-only grant', async () => {
    const key = await uploadKey();
    const fixture = await uploadFixture(key, '# scoped\n', 'scoped.md');
    const token = await authorize(['assets:read']);

    const initialized = await mcpCall(token, undefined, 1, 'initialize', {
      protocolVersion: '2026-07-28',
      capabilities: {},
      clientInfo: { name: 'mcp-test', version: '0.1.0' },
    });
    const version = initialized.result.protocolVersion as string;

    const denied = await mcpCall(token, version, 2, 'tools/call', {
      name: 'create_temp_link',
      arguments: { asset_hash: fixture.asset_hash },
    });
    expect(denied.error).toBeUndefined();
    expect(denied.result.isError).toBe(true);
    expect(denied.result.content[0].text).toContain('insufficient_scope');
  });
});

describe('mcp write and admin tools', () => {
  it('caps temp links at 4h and audits with the oauth identity', async () => {
    const key = await uploadKey();
    const fixture = await uploadFixture(key, '# temp\n', 'temp.md');
    const token = await authorize(['assets:read', 'assets:write', 'assets:admin']);
    const init = await mcpCall(token, undefined, 1, 'initialize', {
      protocolVersion: '2026-07-28',
      capabilities: {},
      clientInfo: { name: 'mcp-test', version: '0.1.0' },
    });
    const version = init.result.protocolVersion as string;

    const tooLong = await mcpCall(token, version, 2, 'tools/call', {
      name: 'create_temp_link',
      arguments: { asset_hash: fixture.asset_hash, expires_in: '5h' },
    });
    expect(tooLong.result.isError).toBe(true);
    expect(tooLong.result.content[0].text).toContain('temp_link_ttl');

    const created = await mcpCall(token, version, 3, 'tools/call', {
      name: 'create_temp_link',
      arguments: { asset_hash: fixture.asset_hash, expires_in: '30m', label: 'mcp-test' },
    });
    expect(created.result.isError).toBeUndefined();
    const link = JSON.parse(created.result.content[0].text).link;
    expect(link.url).toContain(`/${link.hash}/temp.md`);

    const row = await env.DB.prepare("SELECT actor, action FROM audit_log WHERE target = ? AND action = 'link:temp'")
      .bind(link.hash)
      .first<{ actor: string; action: string }>();
    expect(row?.actor).toBe(TEST_EMAIL);
  });

  it('completes an upload session with a single PUT', async () => {
    const token = await authorize(['assets:read', 'assets:write']);
    const init = await mcpCall(token, undefined, 1, 'initialize', {
      protocolVersion: '2026-07-28',
      capabilities: {},
      clientInfo: { name: 'mcp-test', version: '0.1.0' },
    });
    const version = init.result.protocolVersion as string;

    const session = await mcpCall(token, version, 2, 'tools/call', {
      name: 'create_upload_session',
      arguments: { filename: 'session.txt', content_type: 'text/plain', size: 11, tags: 'mcp' },
    });
    expect(session.result.isError).toBeUndefined();
    const { session_id: sessionId, upload_url: uploadUrl } = JSON.parse(session.result.content[0].text);
    expect(uploadUrl.startsWith(`${BASE}/uploads/${sessionId}?key=`)).toBe(true);

    const body = 'hello bytes';
    const put = await SELF.fetch(uploadUrl, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-length': String(body.length) },
      body,
    });
    expect(put.status).toBe(201);
    const stored = (await put.json()) as { asset_hash: string; hash: string; url: string };
    expect(stored.url).toContain(`/${stored.hash}/session.txt`);

    const replay = await SELF.fetch(uploadUrl, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-length': String(body.length) },
      body,
    });
    expect(replay.status).toBe(404);

    const found = await mcpCall(token, version, 3, 'tools/call', {
      name: 'search_assets',
      arguments: { tag: 'mcp' },
    });
    const payload = JSON.parse(found.result.content[0].text);
    expect(payload.assets.some((asset: { hash: string }) => asset.hash === stored.asset_hash)).toBe(true);
  });

  it('completes a session through the signed URL without any token', async () => {
    const token = await authorize(['assets:read', 'assets:write']);
    const init = await mcpCall(token, undefined, 1, 'initialize', {
      protocolVersion: '2026-07-28',
      capabilities: {},
      clientInfo: { name: 'mcp-test', version: '0.1.0' },
    });
    const version = init.result.protocolVersion as string;

    const session = await mcpCall(token, version, 2, 'tools/call', {
      name: 'create_upload_session',
      arguments: { filename: 'delegated.bin', size: 4 },
    });
    const { upload_url: uploadUrl } = JSON.parse(session.result.content[0].text);

    // A different execution context holding only the URL (no OAuth header).
    const put = await SELF.fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'content-length': '4' },
      body: 'data',
    });
    expect(put.status).toBe(201);
    const stored = (await put.json()) as { asset_hash: string; filename: string };
    expect(stored.filename).toBe('delegated.bin');

    // Single use: the same URL is dead afterwards.
    const replay = await SELF.fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'content-length': '4' },
      body: 'data',
    });
    expect(replay.status).toBe(404);

    const wrongKey = await SELF.fetch(uploadUrl.replace(/key=[^&]+/, 'key=nope'), {
      method: 'PUT',
      headers: { 'content-length': '4' },
      body: 'data',
    });
    expect(wrongKey.status).toBe(404);

    const noKey = await SELF.fetch(uploadUrl.split('?')[0], {
      method: 'PUT',
      headers: { 'content-length': '4' },
      body: 'data',
    });
    expect(noKey.status).toBe(404);
  });

  it('uploads small files directly through the tool', async () => {
    const token = await authorize(['assets:read', 'assets:write']);
    const init = await mcpCall(token, undefined, 1, 'initialize', {
      protocolVersion: '2026-07-28',
      capabilities: {},
      clientInfo: { name: 'mcp-test', version: '0.1.0' },
    });
    const version = init.result.protocolVersion as string;

    const bytes = new TextEncoder().encode('direct-bytes');
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const uploaded = await mcpCall(token, version, 2, 'tools/call', {
      name: 'upload_file',
      arguments: { filename: 'direct.txt', content: btoa(binary), tags: 'direct' },
    });
    expect(uploaded.result.isError).toBeUndefined();
    const body = JSON.parse(uploaded.result.content[0].text);
    expect(body.filename).toBe('direct.txt');
    expect(body.url).toContain(`/${body.hash}/direct.txt`);

    const served = await SELF.fetch(`${BASE}/${body.hash}/direct.txt`);
    expect(served.status).toBe(200);
    expect(await served.text()).toBe('direct-bytes');

    const bad = await mcpCall(token, version, 3, 'tools/call', {
      name: 'upload_file',
      arguments: { filename: 'bad.txt', content: '!!!not-base64!!!' },
    });
    expect(bad.result.isError).toBe(true);
    expect(bad.result.content[0].text).toContain('invalid_content');
  });

  it('deletes, restores, and revokes with the admin scope', async () => {
    const key = await uploadKey();
    const fixture = await uploadFixture(key, '# admin\n', 'admin.md');
    const token = await authorize(['assets:read', 'assets:write', 'assets:admin']);
    const init = await mcpCall(token, undefined, 1, 'initialize', {
      protocolVersion: '2026-07-28',
      capabilities: {},
      clientInfo: { name: 'mcp-test', version: '0.1.0' },
    });
    const version = init.result.protocolVersion as string;

    const temp = await mcpCall(token, version, 2, 'tools/call', {
      name: 'create_temp_link',
      arguments: { asset_hash: fixture.asset_hash },
    });
    const linkHash = JSON.parse(temp.result.content[0].text).link.hash as string;

    const revoked = await mcpCall(token, version, 3, 'tools/call', {
      name: 'revoke_link',
      arguments: { link_hash: linkHash },
    });
    expect(JSON.parse(revoked.result.content[0].text).revoked).toBe(linkHash);

    const deleted = await mcpCall(token, version, 4, 'tools/call', {
      name: 'delete_asset',
      arguments: { asset_hash: fixture.asset_hash },
    });
    expect(JSON.parse(deleted.result.content[0].text).deleted).toBe(fixture.asset_hash);

    const restored = await mcpCall(token, version, 5, 'tools/call', {
      name: 'restore_asset',
      arguments: { asset_hash: fixture.asset_hash },
    });
    expect(JSON.parse(restored.result.content[0].text).asset.status).toBe('expired');
  });
});

describe('mcp management coverage', () => {
  it('updates metadata, writes text, and mints a standard link (admin only)', async () => {
    const key = await uploadKey();
    const fixture = await uploadFixture(key, '# manage\n', 'manage.md');
    const writeToken = await authorize(['assets:read', 'assets:write']);
    const adminToken = await authorize(['assets:read', 'assets:write', 'assets:admin']);
    const init = await mcpCall(adminToken, undefined, 1, 'initialize', {
      protocolVersion: '2026-07-28',
      capabilities: {},
      clientInfo: { name: 'mcp-test', version: '0.1.0' },
    });
    const version = init.result.protocolVersion as string;

    // Standard (potentially long-lived) links need the admin scope.
    const writeDenied = await mcpCall(writeToken, version, 2, 'tools/call', {
      name: 'create_link',
      arguments: { asset_hash: fixture.asset_hash, expires_in: '7d' },
    });
    expect(writeDenied.result.isError).toBe(true);
    expect(writeDenied.result.content[0].text).toContain('insufficient_scope');

    const updated = await mcpCall(adminToken, version, 3, 'tools/call', {
      name: 'update_asset',
      arguments: { asset_hash: fixture.asset_hash, note: 'managed', tags: ['a', 'b'] },
    });
    expect(JSON.parse(updated.result.content[0].text).asset.note).toBe('managed');

    const written = await mcpCall(adminToken, version, 4, 'tools/call', {
      name: 'write_text_content',
      arguments: { asset_hash: fixture.asset_hash, content: '# managed!\n' },
    });
    expect(writeDenied.result.isError).toBe(true);
    expect(JSON.parse(written.result.content[0].text).asset.size).toBeGreaterThan(0);

    const readBack = await mcpCall(adminToken, version, 5, 'tools/call', {
      name: 'read_text_content',
      arguments: { asset_hash: fixture.asset_hash },
    });
    expect(JSON.parse(readBack.result.content[0].text).text).toBe('# managed!\n');

    const linked = await mcpCall(adminToken, version, 6, 'tools/call', {
      name: 'create_link',
      arguments: { asset_hash: fixture.asset_hash, expires_in: '7d', label: 'docs' },
    });
    expect(JSON.parse(linked.result.content[0].text).link.label).toBe('docs');
  });

  it('creates projects and mints never-expiring links (admin)', async () => {
    const key = await uploadKey();
    const fixture = await uploadFixture(key, '# housed\n', 'housed.md');
    const writeToken = await authorize(['assets:read', 'assets:write']);
    const adminToken = await authorize(['assets:read', 'assets:write', 'assets:admin']);
    const init = await mcpCall(adminToken, undefined, 1, 'initialize', {
      protocolVersion: '2026-07-28',
      capabilities: {},
      clientInfo: { name: 'mcp-test', version: '0.1.0' },
    });
    const version = init.result.protocolVersion as string;

    const project = await mcpCall(writeToken, version, 2, 'tools/call', {
      name: 'create_project',
      arguments: { slug: 'mcp-estate', name: 'MCP Estate' },
    });
    expect(project.result.isError).toBeUndefined();
    expect(JSON.parse(project.result.content[0].text).project.slug).toBe('mcp-estate');

    const housed = await mcpCall(writeToken, version, 3, 'tools/call', {
      name: 'update_asset',
      arguments: { asset_hash: fixture.asset_hash, project: 'mcp-estate' },
    });
    expect(JSON.parse(housed.result.content[0].text).asset.project.slug).toBe('mcp-estate');

    const eternal = await mcpCall(adminToken, version, 4, 'tools/call', {
      name: 'create_link',
      arguments: { asset_hash: fixture.asset_hash, never: true, label: 'evergreen' },
    });
    const link = JSON.parse(eternal.result.content[0].text).link;
    expect(link.expires_at).toBeNull();
    expect(link.status).toBe('live');
  });

  it('purges immediately with purge=true and sweeps dead sessions', async () => {
    const key = await uploadKey();
    const fixture = await uploadFixture(key, '# purge\n', 'purge.md');
    const token = await authorize(['assets:read', 'assets:write', 'assets:admin']);
    const init = await mcpCall(token, undefined, 1, 'initialize', {
      protocolVersion: '2026-07-28',
      capabilities: {},
      clientInfo: { name: 'mcp-test', version: '0.1.0' },
    });
    const version = init.result.protocolVersion as string;

    const purged = await mcpCall(token, version, 2, 'tools/call', {
      name: 'delete_asset',
      arguments: { asset_hash: fixture.asset_hash, purge: true },
    });
    expect(JSON.parse(purged.result.content[0].text)).toMatchObject({
      deleted: fixture.asset_hash,
      hard: true,
    });
    const gone = await env.DB.prepare('SELECT hash FROM assets WHERE hash = ?')
      .bind(fixture.asset_hash)
      .first<{ hash: string }>();
    expect(gone).toBeNull();

    const { sweep } = await import('../src/cron');
    const session = await mcpCall(token, version, 3, 'tools/call', {
      name: 'create_upload_session',
      arguments: { filename: 'stale.bin', expires_in: '30m' },
    });
    const sessionId = JSON.parse(session.result.content[0].text).session_id as string;
    await env.DB.prepare('UPDATE upload_sessions SET expires_at = ? WHERE id = ?')
      .bind(Date.now() - 1000, sessionId)
      .run();
    const result = await sweep(env, {} as ExecutionContext);
    expect(result.sessionsCleared).toBeGreaterThanOrEqual(1);
    const cleared = await env.DB.prepare('SELECT id FROM upload_sessions WHERE id = ?')
      .bind(sessionId)
      .first<{ id: string }>();
    expect(cleared).toBeNull();
  });

  it('rejects bad tokens and out-of-scope session uploads', async () => {
    const token = await authorize(['assets:read']);
    const init = await mcpCall(token, undefined, 1, 'initialize', {
      protocolVersion: '2026-07-28',
      capabilities: {},
      clientInfo: { name: 'mcp-test', version: '0.1.0' },
    });
    const version = init.result.protocolVersion as string;
    const session = await mcpCall(token, version, 2, 'tools/call', {
      name: 'create_upload_session',
      arguments: { filename: 'x.bin' },
    });
    // Read-only grant cannot even open a session: the tool gate fires first.
    expect(session.result.isError).toBe(true);
    expect(session.result.content[0].text).toContain('insufficient_scope');

    const forged = await SELF.fetch(`${BASE}/mcp/uploads/aaaaaaaaaaaaaaaaaaaaaa`, {
      method: 'PUT',
      headers: { authorization: 'Bearer not-a-token', 'content-length': '1' },
      body: 'x',
    });
    expect(forged.status).toBe(401);
  });
});

describe('mcp resources and prompts', () => {
  it('lists and reads metadata/text resources and prompts', async () => {
    const key = await uploadKey();
    const fixture = await uploadFixture(key, '# resource\n', 'resource.md');
    const token = await authorize(['assets:read']);
    const init = await mcpCall(token, undefined, 1, 'initialize', {
      protocolVersion: '2026-07-28',
      capabilities: {},
      clientInfo: { name: 'mcp-test', version: '0.1.0' },
    });
    const version = init.result.protocolVersion as string;

    const resources = await mcpCall(token, version, 2, 'resources/list', {});
    expect(resources.error).toBeUndefined();
    const uris = (resources.result.resources as { uri: string }[]).map((resource) => resource.uri);
    expect(uris).toContain(`asset://meta/${fixture.asset_hash}`);

    const meta = await mcpCall(token, version, 3, 'resources/read', {
      uri: `asset://meta/${fixture.asset_hash}`,
    });
    expect(JSON.parse(meta.result.contents[0].text).filename).toBe('resource.md');

    const text = await mcpCall(token, version, 4, 'resources/read', {
      uri: `asset://text/${fixture.asset_hash}`,
    });
    expect(text.result.contents[0].text).toContain('# resource');

    const prompts = await mcpCall(token, version, 5, 'prompts/list', {});
    const names = (prompts.result.prompts as { name: string }[]).map((prompt) => prompt.name);
    expect(names).toEqual(expect.arrayContaining(['share_asset', 'asset_digest']));

    const prompt = await mcpCall(token, version, 6, 'prompts/get', {
      name: 'asset_digest',
      arguments: { asset_hash: fixture.asset_hash },
    });
    expect(prompt.result.messages[0].content.text).toContain(fixture.asset_hash);
  });
});

describe('mcp oauth browser login', () => {
  it('accepts the dashboard session cookie at /authorize', async () => {
    const assertion = await signAccessJwt({ email: TEST_EMAIL });
    const page = await SELF.fetch(`${BASE}/authorize?response_type=code&client_id=x`, {
      headers: { cookie: `CF_Authorization=${assertion}; other=1` },
    });
    // Unknown client -> local 400 page, which still proves the login passed.
    expect(page.status).toBe(400);
    expect(await page.text()).not.toContain('access_required');
  });

  it('pins the oauth resource to the public base url', async () => {
    const { MCP_RESOURCE } = await import('../src/mcp');
    expect(MCP_RESOURCE).toBe(`${env.PUBLIC_BASE_URL.replace(/\/+$/, '')}/mcp`);
  });
});

describe('mcp oauth discovery', () => {
  it('publishes protected-resource metadata for /mcp', async () => {
    const response = await SELF.fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { resource: string; authorization_servers: string[] };
    expect(body.resource).toBe(RESOURCE);
    expect(body.authorization_servers.length).toBeGreaterThan(0);
  });

  it('challenges unauthenticated MCP requests instead of redirecting to login', async () => {
    const response = await SELF.fetch(MCP_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('Bearer');
  });
});
