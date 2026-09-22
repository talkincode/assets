import { env, SELF, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createUploadKey, resetAccessCaches } from '../src/auth';
import { networkKey } from '../src/abuse';
import type { AbuseGuard } from '../src/abuse-guard';
import { resetSettingsCache } from '../src/db';
import { TEST_EMAIL, signAccessJwt } from './access-fixtures';

const BASE = 'https://assets.example.com';
/** Every test gets its own source network so abuse accounting cannot leak. */
const DEFAULT_IP = '198.18.0.10';

async function upload(
  body: string,
  options: { key?: string; query?: string; filename?: string; ip?: string; contentType?: string } = {},
) {
  const params = new URLSearchParams(options.query ?? '');
  return SELF.fetch(`${BASE}/api/upload?${params}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${options.key ?? ''}`,
      'x-filename': options.filename ?? 'report.txt',
      'content-type': options.contentType ?? 'text/plain',
      'content-length': String(new TextEncoder().encode(body).length),
      'cf-connecting-ip': options.ip ?? DEFAULT_IP,
    },
    body,
  });
}

/** Clear the abuse guard state for a source, as the dashboard would. */
async function clearGuard(ip: string): Promise<void> {
  const source = networkKey(ip);
  await runInDurableObject(env.ABUSE.getByName(source), async (object: AbuseGuard) => {
    await object.reset();
  });
  await env.DB.prepare('DELETE FROM blocked_sources WHERE source = ?').bind(source).run();
}

async function newKey(name = 'test'): Promise<string> {
  const created = await createUploadKey(env, name, 'test-setup');
  return created.secret;
}

let key: string;

beforeEach(async () => {
  key = await newKey();
  resetAccessCaches();
  resetSettingsCache();
  // Bindings keep their storage between tests in this file, so put the policy
  // and the abuse counters back to a known state.
  await env.DB.batch([
    env.DB.prepare("INSERT INTO settings (k, v) VALUES ('default_ttl_days', '7') ON CONFLICT(k) DO UPDATE SET v = '7'"),
    env.DB.prepare(
      "INSERT INTO settings (k, v) VALUES ('max_upload_bytes', '104857600') ON CONFLICT(k) DO UPDATE SET v = '104857600'",
    ),
    env.DB.prepare(
      "INSERT INTO settings (k, v) VALUES ('trash_retention_days', '7') ON CONFLICT(k) DO UPDATE SET v = '7'",
    ),
  ]);
  await clearGuard(DEFAULT_IP);
  await clearGuard('192.0.2.30');
  await clearGuard('203.0.113.9');
  await clearGuard('198.51.100.7');
  await clearGuard('198.18.0.50');
  // Requests without cf-connecting-ip land on the LOCAL_SOURCE bucket.
  await clearGuard('127.0.0.1');
  await clearGuard('local');
});

describe('upload and delivery', () => {
  it('stores bytes under a hash and serves them at any filename', async () => {
    const created = await upload('hello assets', { key });
    expect(created.status).toBe(201);
    const { hash, url, expires_at: expiresAt, asset_hash: assetHash } = (await created.json()) as {
      hash: string;
      url: string;
      expires_at: number | null;
      asset_hash: string;
    };
    expect(hash).toHaveLength(22);
    expect(assetHash).toHaveLength(22);
    expect(assetHash).not.toBe(hash);
    expect(url).toContain(`/${hash}/report.txt`);
    // Default link TTL is 7 days.
    expect(expiresAt! - Date.now()).toBeGreaterThan(6.9 * 86400000);

    const served = await SELF.fetch(`${BASE}/${hash}/anything-i-like.txt`);
    expect(served.status).toBe(200);
    expect(await served.text()).toBe('hello assets');
    expect(served.headers.get('content-disposition')).toContain('inline');
    expect(served.headers.get('content-disposition')).toContain('anything-i-like.txt');
    expect(served.headers.get('x-content-type-options')).toBe('nosniff');
    expect(served.headers.get('content-security-policy')).toBe('sandbox');
    expect(served.headers.get('cache-control')).toContain('max-age=');
    expect(served.headers.get('etag')).toBeTruthy();

    const decorated = await SELF.fetch(`${BASE}/${hash}/other-name.txt?utm=campaign&inline=1`);
    expect(decorated.status).toBe(200);
    expect(decorated.headers.get('content-disposition')).toContain('other-name.txt');
    expect(await decorated.text()).toBe('hello assets');
  });

  it('downloads HTML and SVG instead of rendering them, even with ?inline=1', async () => {
    const htmlBody = '<script>fetch("/admin/api/me")</script>';
    const html = await SELF.fetch(`${BASE}/api/upload`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'x-filename': 'evil.html',
        'content-type': 'text/html; charset=utf-8',
        'content-length': String(new TextEncoder().encode(htmlBody).length),
        'cf-connecting-ip': DEFAULT_IP,
      },
      body: htmlBody,
    });
    expect(html.status).toBe(201);
    const { hash } = (await html.json()) as { hash: string };
    const served = await SELF.fetch(`${BASE}/${hash}/evil.html?inline=1`);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(served.headers.get('x-content-type-options')).toBe('nosniff');
    expect(served.headers.get('content-security-policy')).toBe('sandbox');

    const svgBody = '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>';
    const svg = await SELF.fetch(`${BASE}/api/upload`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'x-filename': 'evil.svg',
        'content-type': 'image/svg+xml',
        'content-length': String(new TextEncoder().encode(svgBody).length),
        'cf-connecting-ip': DEFAULT_IP,
      },
      body: svgBody,
    });
    const svgHash = ((await svg.json()) as { hash: string }).hash;
    const svgServed = await SELF.fetch(`${BASE}/${svgHash}/evil.svg?inline=1`);
    expect(svgServed.headers.get('content-disposition')).toMatch(/^attachment;/);
  });

  it('rejects a key in the query string and a body without Content-Length', async () => {
    const viaQuery = await SELF.fetch(`${BASE}/api/upload?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: {
        'content-type': 'text/plain',
        'content-length': '1',
        'cf-connecting-ip': DEFAULT_IP,
      },
      body: 'x',
    });
    expect(viaQuery.status).toBe(401);

    const viaHeader = await SELF.fetch(`${BASE}/api/upload`, {
      method: 'POST',
      headers: {
        'x-assets-key': key,
        'content-type': 'text/plain',
        'content-length': '1',
        'x-filename': 'a.txt',
        'cf-connecting-ip': DEFAULT_IP,
      },
      body: 'x',
    });
    expect(viaHeader.status).toBe(201);

    const chunked = await SELF.fetch(`${BASE}/api/upload`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'text/plain',
        'cf-connecting-ip': DEFAULT_IP,
      },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('hi'));
          controller.close();
        },
      }),
    });
    expect(chunked.status).toBe(411);

    const badName = await SELF.fetch(`${BASE}/api/upload`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'text/plain',
        'content-length': '1',
        'content-disposition': "attachment; filename*=UTF-8''%E0%A4%A",
        'cf-connecting-ip': DEFAULT_IP,
      },
      body: 'x',
    });
    expect(badName.status).toBe(400);
    expect(((await badName.json()) as { error: string }).error).toBe('invalid_filename');
  });

  it('maps a concurrent custom-hash clash to 409', async () => {
    const query = 'hash=RaceHashValue123456';
    const [first, second] = await Promise.all([
      upload('one', { key, query }),
      upload('two', { key, query }),
    ]);
    expect([first.status, second.status].sort()).toEqual([201, 409]);
    const row = await env.DB.prepare('SELECT asset_hash FROM links WHERE hash = ?')
      .bind('RaceHashValue123456')
      .first<{ asset_hash: string }>();
    expect(row?.asset_hash).toBeTruthy();
    const asset = await env.DB.prepare('SELECT object_key FROM assets WHERE hash = ?')
      .bind(row!.asset_hash)
      .first<{ object_key: string }>();
    expect(await env.BUCKET.head(asset!.object_key)).not.toBeNull();
  });

  it('stores tags on upload, filters by tag, and lets admin edit them', async () => {
    const created = await upload('tagged body', { key, query: 'tags=课件,PDF&expires_in=7d' });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { hash: string; asset_hash: string; tags: string[] };
    expect(body.tags).toEqual(['课件', 'PDF']);

    const token = await signAccessJwt({ email: TEST_EMAIL });
    const auth = { 'cf-access-jwt-assertion': token, 'content-type': 'application/json' };

    const listed = await SELF.fetch(`${BASE}/admin/api/assets?tag=${encodeURIComponent('课件')}`, {
      headers: auth,
    });
    expect(listed.status).toBe(200);
    const listBody = (await listed.json()) as { assets: { hash: string; tags: string[] }[] };
    expect(listBody.assets.some((asset) => asset.hash === body.asset_hash)).toBe(true);

    const tags = await SELF.fetch(`${BASE}/admin/api/tags`, { headers: auth });
    expect(tags.status).toBe(200);
    const tagBody = (await tags.json()) as { tags: { tag: string; count: number }[] };
    expect(tagBody.tags.some((row) => row.tag === '课件' && row.count >= 1)).toBe(true);

    const patched = await SELF.fetch(`${BASE}/admin/api/assets/${body.asset_hash}`, {
      method: 'PATCH',
      headers: auth,
      body: JSON.stringify({ tags: '微课' }),
    });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { asset: { tags: string[] } }).asset.tags).toEqual(['微课']);

    const cleared = await SELF.fetch(`${BASE}/admin/api/assets/${body.asset_hash}`, {
      method: 'PATCH',
      headers: auth,
      body: JSON.stringify({ tags: '' }),
    });
    expect(((await cleared.json()) as { asset: { tags: string[] } }).asset.tags).toEqual([]);
  });

  it('creates projects, assigns on upload, and filters by project slug', async () => {
    const token = await signAccessJwt({ email: TEST_EMAIL });
    const auth = { 'cf-access-jwt-assertion': token, 'content-type': 'application/json' };

    const createdProject = await SELF.fetch(`${BASE}/admin/api/projects`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ slug: 'li-cui', name: '李翠' }),
    });
    expect(createdProject.status).toBe(201);
    const projectBody = (await createdProject.json()) as {
      project: { id: string; slug: string; name: string };
    };
    expect(projectBody.project.slug).toBe('li-cui');
    expect(projectBody.project.name).toBe('李翠');

    const uploaded = await upload('project-body', {
      key,
      query: 'project=li-cui&expires_in=7d',
      filename: 'li-cui.png',
    });
    expect(uploaded.status).toBe(201);
    const upBody = (await uploaded.json()) as {
      asset_hash: string;
      project: { slug: string; name: string } | null;
    };
    expect(upBody.project?.slug).toBe('li-cui');

    const listed = await SELF.fetch(`${BASE}/admin/api/assets?project=li-cui`, { headers: auth });
    expect(listed.status).toBe(200);
    const listBody = (await listed.json()) as {
      assets: { hash: string; project: { slug: string } | null }[];
    };
    expect(listBody.assets.some((row) => row.hash === upBody.asset_hash && row.project?.slug === 'li-cui')).toBe(true);

    const none = await SELF.fetch(`${BASE}/admin/api/assets?project=none&status=live`, { headers: auth });
    expect(none.status).toBe(200);
    const noneBody = (await none.json()) as { assets: { hash: string; project: unknown }[] };
    expect(noneBody.assets.every((row) => row.project === null)).toBe(true);

    const cleared = await SELF.fetch(`${BASE}/admin/api/assets/${upBody.asset_hash}`, {
      method: 'PATCH',
      headers: auth,
      body: JSON.stringify({ project: 'none' }),
    });
    expect(cleared.status).toBe(200);
    expect(((await cleared.json()) as { asset: { project: unknown } }).asset.project).toBeNull();
  });

  it('batch-updates tags and creates share links', async () => {
    const first = (await (await upload('batch-one', { key, query: 'tags=旧标签' })).json()) as {
      hash: string;
      asset_hash: string;
    };
    const second = (await (await upload('batch-two', { key })).json()) as { hash: string; asset_hash: string };
    const token = await signAccessJwt({ email: TEST_EMAIL });
    const auth = { 'cf-access-jwt-assertion': token, 'content-type': 'application/json' };

    const updated = await SELF.fetch(`${BASE}/admin/api/assets/batch`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        hashes: [first.asset_hash, second.asset_hash],
        tags: '批量,共享',
        tags_mode: 'replace',
      }),
    });
    expect(updated.status).toBe(200);
    const updatedBody = (await updated.json()) as {
      updated: number;
      results: { hash: string; tags: string[] }[];
    };
    expect(updatedBody.updated).toBe(2);
    expect(updatedBody.results.every((row) => row.tags.includes('批量'))).toBe(true);

    const linked = await SELF.fetch(`${BASE}/admin/api/assets/batch`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        hashes: [first.asset_hash, second.asset_hash],
        create_links: true,
        expires_in: '1d',
      }),
    });
    expect(linked.status).toBe(200);
    const linkedBody = (await linked.json()) as {
      results: { url: string; link: { hash: string } }[];
    };
    expect(linkedBody.results).toHaveLength(2);
    const probe = { 'cf-connecting-ip': '198.18.0.50' };
    for (const row of linkedBody.results) {
      expect(row.link.hash).toBeTruthy();
      expect((await SELF.fetch(`${BASE}/${row.link.hash}/x.txt`, { headers: probe })).status).toBe(200);
    }
  });

  it('answers range requests and HEAD without touching the body', async () => {
    const { hash } = (await (await upload('0123456789', { key })).json()) as { hash: string };
    const ranged = await SELF.fetch(`${BASE}/${hash}/r.txt`, { headers: { range: 'bytes=2-5' } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(await ranged.text()).toBe('2345');

    const head = await SELF.fetch(`${BASE}/${hash}/r.txt`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('10');
  });

  it('refuses uploads without a valid key', async () => {
    expect((await upload('nope')).status).toBe(401);
    expect((await upload('nope', { key: 'ak_wrong' })).status).toBe(401);
  });

  it('honours link expires_in and keeps asset bytes after the link expires', async () => {
    const created = await upload('short lived', { key, query: 'expires_in=1s' });
    const { hash, asset_hash: assetHash } = (await created.json()) as { hash: string; asset_hash: string };
    expect((await SELF.fetch(`${BASE}/${hash}/s.txt`)).status).toBe(200);

    await env.DB.prepare('UPDATE links SET expires_at = ? WHERE hash = ?').bind(Date.now() - 1000, hash).run();
    expect((await SELF.fetch(`${BASE}/${hash}/s.txt`)).status).toBe(410);

    // Asset bytes remain; a fresh link can still serve them.
    const token = await signAccessJwt({ email: TEST_EMAIL });
    const minted = await SELF.fetch(`${BASE}/admin/api/assets/${assetHash}/links`, {
      method: 'POST',
      headers: { 'cf-access-jwt-assertion': token, 'content-type': 'application/json' },
      body: JSON.stringify({ expires_in: '1d' }),
    });
    expect(minted.status).toBe(201);
    const newLink = ((await minted.json()) as { link: { hash: string } }).link.hash;
    expect((await SELF.fetch(`${BASE}/${newLink}/s.txt`)).status).toBe(200);
  });

  it('supports never-expiring links and custom link hashes', async () => {
    const created = await upload('forever', { key, query: 'expires_in=never&hash=CustomHashValue12345' });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { hash: string; asset_hash: string; expires_at: number | null };
    expect(body.hash).toBe('CustomHashValue12345');
    expect(body.asset_hash).not.toBe(body.hash);
    expect(body.expires_at).toBeNull();
    expect((await SELF.fetch(`${BASE}/CustomHashValue12345/f.txt`)).status).toBe(200);

    const clash = await upload('again', { key, query: 'hash=CustomHashValue12345' });
    expect(clash.status).toBe(409);
  });

  it('enforces the size cap and stores nothing when it is exceeded', async () => {
    await env.DB.prepare(
      `INSERT INTO settings (k, v) VALUES ('max_upload_bytes', '16')
       ON CONFLICT(k) DO UPDATE SET v = '16'`,
    ).run();
    resetSettingsCache();

    const before = await env.DB.prepare('SELECT COUNT(*) AS n FROM assets').first<{ n: number }>();
    const rejected = await upload('this body is definitely longer than sixteen bytes', { key });
    expect(rejected.status).toBe(413);

    const after = await env.DB.prepare('SELECT COUNT(*) AS n FROM assets').first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
  });
});

describe('admin API and Cloudflare Access', () => {
  it('refuses anonymous access to the dashboard API', async () => {
    const response = await SELF.fetch(`${BASE}/admin/api/stats`);
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: string }).error).toBe('access_required');
  });

  it('accepts an assertion signed by the Access team, for an allowed email', async () => {
    const token = await signAccessJwt({ email: TEST_EMAIL });
    const me = await SELF.fetch(`${BASE}/admin/api/me`, { headers: { 'cf-access-jwt-assertion': token } });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { email: string }).email).toBe(TEST_EMAIL);
  });

  it('rejects assertions for another audience or another email', async () => {
    const wrongAudience = await signAccessJwt({ email: TEST_EMAIL, aud: ['someone-else'] });
    const rejected = await SELF.fetch(`${BASE}/admin/api/me`, {
      headers: { 'cf-access-jwt-assertion': wrongAudience },
    });
    expect(rejected.status).toBe(401);

    resetAccessCaches();
    const wrongEmail = await signAccessJwt({ email: 'intruder@example.com' });
    const forbidden = await SELF.fetch(`${BASE}/admin/api/me`, {
      headers: { 'cf-access-jwt-assertion': wrongEmail },
    });
    expect(forbidden.status).toBe(403);
  });

  it('rejects a malformed assertion, a missing exp, and the wrong issuer', async () => {
    const malformed = await SELF.fetch(`${BASE}/admin/api/me`, {
      headers: { 'cf-access-jwt-assertion': 'not-a-jwt' },
    });
    expect(malformed.status).toBe(401);

    resetAccessCaches();
    const noExp = await signAccessJwt({ email: TEST_EMAIL, omitExp: true });
    const missingExp = await SELF.fetch(`${BASE}/admin/api/me`, {
      headers: { 'cf-access-jwt-assertion': noExp },
    });
    expect(missingExp.status).toBe(401);

    resetAccessCaches();
    const foreign = await signAccessJwt({ email: TEST_EMAIL, iss: 'https://evil.example' });
    const wrongIssuer = await SELF.fetch(`${BASE}/admin/api/me`, {
      headers: { 'cf-access-jwt-assertion': foreign },
    });
    expect(wrongIssuer.status).toBe(401);
  });

  it('rejects a tampered assertion', async () => {
    const token = await signAccessJwt({ email: TEST_EMAIL });
    const [header, payload] = token.split('.');
    const forged = `${header}.${payload}.${'A'.repeat(342)}`;
    const response = await SELF.fetch(`${BASE}/admin/api/me`, { headers: { 'cf-access-jwt-assertion': forged } });
    expect(response.status).toBe(401);
  });

  it('reads and saves markdown content from the dashboard editor', async () => {
    const token = await signAccessJwt({ email: TEST_EMAIL });
    const auth = { 'cf-access-jwt-assertion': token };
    const created = await upload('# Hello\n\nworld', {
      key,
      filename: 'note.md',
      contentType: 'text/markdown; charset=utf-8',
      query: 'expires_in=1d',
    });
    expect(created.status).toBe(201);
    const { hash: linkHash, asset_hash: assetHash } = (await created.json()) as {
      hash: string;
      asset_hash: string;
    };

    const detail = await SELF.fetch(`${BASE}/admin/api/assets/${assetHash}`, { headers: auth });
    const detailBody = (await detail.json()) as { asset: { editable_text: boolean; markdown: boolean } };
    expect(detailBody.asset.editable_text).toBe(true);
    expect(detailBody.asset.markdown).toBe(true);

    const got = await SELF.fetch(`${BASE}/admin/api/assets/${assetHash}/content`, { headers: auth });
    expect(got.status).toBe(200);
    expect(await got.text()).toBe('# Hello\n\nworld');

    const next = new TextEncoder().encode('# Updated\n\nbody');
    const saved = await SELF.fetch(`${BASE}/admin/api/assets/${assetHash}/content`, {
      method: 'PUT',
      headers: {
        ...auth,
        'content-type': 'text/markdown; charset=utf-8',
        'content-length': String(next.byteLength),
      },
      body: next,
    });
    expect(saved.status).toBe(200);
    const savedBody = (await saved.json()) as { asset: { size: number; markdown: boolean } };
    expect(savedBody.asset.markdown).toBe(true);
    expect(savedBody.asset.size).toBe(next.byteLength);
    expect(await (await SELF.fetch(`${BASE}/${linkHash}/note.md`)).text()).toBe('# Updated\n\nbody');

    const empty = await SELF.fetch(`${BASE}/admin/api/assets/${assetHash}/content`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'text/markdown; charset=utf-8', 'content-length': '0' },
      body: '',
    });
    expect(empty.status).toBe(400);

    const html = await upload('<b>x</b>', { key, filename: 'x.html', contentType: 'text/html' });
    const htmlAsset = ((await html.json()) as { asset_hash: string }).asset_hash;
    expect((await SELF.fetch(`${BASE}/admin/api/assets/${htmlAsset}/content`, { headers: auth })).status).toBe(415);
  });

  it('manages independent share links and asset lifecycle', async () => {
    const token = await signAccessJwt({ email: TEST_EMAIL });
    const auth = { 'cf-access-jwt-assertion': token, 'content-type': 'application/json' };
    const created = await upload('lifecycle body', { key, query: 'expires_in=1d' });
    const { hash: firstLink, asset_hash: assetHash } = (await created.json()) as {
      hash: string;
      asset_hash: string;
    };

    const listed = await SELF.fetch(`${BASE}/admin/api/assets?status=live`, { headers: auth });
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { total: number }).total).toBeGreaterThan(0);

    const second = await SELF.fetch(`${BASE}/admin/api/assets/${assetHash}/links`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ expires_in: '30d', label: 'channel-b' }),
    });
    expect(second.status).toBe(201);
    const secondLink = ((await second.json()) as { link: { hash: string; expires_at: number } }).link;
    expect(secondLink.expires_at).toBeGreaterThan(Date.now() + 29 * 86400000);
    expect((await SELF.fetch(`${BASE}/${firstLink}/x.txt`)).status).toBe(200);
    expect((await SELF.fetch(`${BASE}/${secondLink.hash}/x.txt`)).status).toBe(200);

    const revoked = await SELF.fetch(`${BASE}/admin/api/links/${firstLink}`, { method: 'DELETE', headers: auth });
    expect(revoked.status).toBe(200);
    expect((await SELF.fetch(`${BASE}/${firstLink}/x.txt`)).status).toBe(404);
    expect((await SELF.fetch(`${BASE}/${secondLink.hash}/x.txt`)).status).toBe(200);

    const tempOk = await SELF.fetch(`${BASE}/admin/api/assets/${assetHash}/temp-link`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ expires_in: '1h' }),
    });
    expect(tempOk.status).toBe(201);
    const tempDenied = await SELF.fetch(`${BASE}/admin/api/assets/${assetHash}/temp-link`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ expires_in: '5h' }),
    });
    expect(tempDenied.status).toBe(400);

    const deleted = await SELF.fetch(`${BASE}/admin/api/assets/${assetHash}`, { method: 'DELETE', headers: auth });
    expect(deleted.status).toBe(200);
    expect((await SELF.fetch(`${BASE}/${secondLink.hash}/x.txt`)).status).toBe(404);

    const restored = await SELF.fetch(`${BASE}/admin/api/assets/${assetHash}/restore`, {
      method: 'POST',
      headers: auth,
      body: '{}',
    });
    expect(restored.status).toBe(200);
    // Restored asset needs a new link to be publicly reachable again.
    const fresh = await SELF.fetch(`${BASE}/admin/api/assets/${assetHash}/links`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ expires_in: '7d' }),
    });
    const freshHash = ((await fresh.json()) as { link: { hash: string } }).link.hash;
    expect((await SELF.fetch(`${BASE}/${freshHash}/x.txt`)).status).toBe(200);

    const purged = await SELF.fetch(`${BASE}/admin/api/assets/${assetHash}?purge=1`, { method: 'DELETE', headers: auth });
    expect(purged.status).toBe(200);
    expect((await SELF.fetch(`${BASE}/${freshHash}/x.txt`)).status).toBe(404);
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM assets WHERE hash = ?').bind(assetHash).first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it('creates and revokes upload keys, and audits the action', async () => {
    const token = await signAccessJwt({ email: TEST_EMAIL });
    const auth = { 'cf-access-jwt-assertion': token, 'content-type': 'application/json' };

    const created = await SELF.fetch(`${BASE}/admin/api/keys`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ name: 'agent' }),
    });
    expect(created.status).toBe(201);
    const { secret, id } = (await created.json()) as { secret: string; id: string };

    const stored = await env.DB.prepare('SELECT key_hash FROM api_keys WHERE id = ?').bind(id).first<{ key_hash: string }>();
    expect(stored?.key_hash).not.toBe(secret);
    expect((await upload('with the new key', { key: secret })).status).toBe(201);

    const revoked = await SELF.fetch(`${BASE}/admin/api/keys/${id}`, { method: 'DELETE', headers: auth });
    expect(revoked.status).toBe(200);
    expect((await upload('after revocation', { key: secret })).status).toBe(401);

    const trail = await SELF.fetch(`${BASE}/admin/api/audit`, { headers: auth });
    const actions = ((await trail.json()) as { entries: { action: string }[] }).entries.map((entry) => entry.action);
    expect(actions).toContain('key:create');
    expect(actions).toContain('key:revoke');
  });

  it('only lets the dashboard edit the settings it declares editable', async () => {
    const token = await signAccessJwt({ email: TEST_EMAIL });
    const auth = { 'cf-access-jwt-assertion': token, 'content-type': 'application/json' };

    const ok = await SELF.fetch(`${BASE}/admin/api/settings`, {
      method: 'PATCH',
      headers: auth,
      body: JSON.stringify({ default_ttl_days: 3 }),
    });
    expect(ok.status).toBe(200);

    const rejected = await SELF.fetch(`${BASE}/admin/api/settings`, {
      method: 'PATCH',
      headers: auth,
      body: JSON.stringify({ access_allowed_emails: 'anyone@example.com' }),
    });
    expect(rejected.status).toBe(400);

    const crossSite = await SELF.fetch(`${BASE}/admin/api/settings`, {
      method: 'PATCH',
      headers: {
        ...auth,
        origin: 'https://evil.example',
        'sec-fetch-site': 'cross-site',
      },
      body: JSON.stringify({ default_ttl_days: 1 }),
    });
    expect(crossSite.status).toBe(403);

    const upload2 = await upload('uses the new default', { key });
    const body = (await upload2.json()) as { expires_at: number };
    expect(body.expires_at - Date.now()).toBeLessThan(4 * 86400000);
  });
});

describe('abuse protection', () => {
  it('answers unknown hashes with 404 and blocks a source that keeps guessing', async () => {
    const ip = { 'cf-connecting-ip': '203.0.113.9' };
    const misses = async () => (await SELF.fetch(`${BASE}/GUESSGUESSGUESS12345/x.txt`, { headers: ip })).status;

    // ABUSE_MISS_THRESHOLD is 3 in the test config.
    expect(await misses()).toBe(404);
    expect(await misses()).toBe(404);
    expect(await misses()).toBe(403);

    const mirrored = await env.DB.prepare('SELECT strikes, misses FROM blocked_sources WHERE source = ?')
      .bind('203.0.113.0/24')
      .first<{ strikes: number; misses: number }>();
    expect(mirrored?.strikes).toBe(1);

    // A different network is unaffected, and a real asset still loads.
    const other = { 'cf-connecting-ip': '198.51.100.7' };
    expect((await SELF.fetch(`${BASE}/GUESSGUESSGUESS12345/x.txt`, { headers: other })).status).toBe(404);

    const created = await upload('still fine', { key });
    const { hash } = (await created.json()) as { hash: string };
    expect((await SELF.fetch(`${BASE}/${hash}/ok.txt`)).status).toBe(200);
    const denied = await SELF.fetch(`${BASE}/${hash}/ok.txt`, { headers: ip });
    expect(denied.status).toBe(403);
    expect(denied.headers.get('retry-after')).toBeTruthy();

    // The dashboard shows the block as active, with the lifetime miss count.
    const token = await signAccessJwt({ email: TEST_EMAIL });
    const listed = await SELF.fetch(`${BASE}/admin/api/abuse`, { headers: { 'cf-access-jwt-assertion': token } });
    const abuse = (await listed.json()) as {
      active: number;
      blocked: { source: string; active: boolean; strikes: number; misses: number }[];
    };
    const row = abuse.blocked.find((entry) => entry.source === '203.0.113.0/24');
    expect(row?.active).toBe(true);
    expect(row?.strikes).toBe(1);
    expect(row?.misses).toBe(3);

    // The dashboard can lift the block again.
    const unblocked = await SELF.fetch(`${BASE}/admin/api/abuse/${encodeURIComponent('203.0.113.0/24')}`, {
      method: 'DELETE',
      headers: { 'cf-access-jwt-assertion': token },
    });
    expect(unblocked.status).toBe(200);
    expect(await misses()).toBe(404);
  });

  it('counts wrong upload keys the same way as wrong hashes', async () => {
    const attempt = async () => (await upload('x', { key: 'ak_nope', ip: '192.0.2.30' })).status;
    expect(await attempt()).toBe(401);
    expect(await attempt()).toBe(401);
    expect(await attempt()).toBe(403);
  });
});

describe('routing surface', () => {
  it('keeps internal paths quiet', async () => {
    expect((await SELF.fetch(`${BASE}/health`)).status).toBe(200);
    expect((await SELF.fetch(`${BASE}/favicon.ico`)).status).toBe(404);
    expect((await SELF.fetch(`${BASE}/`)).status).toBe(404);
    expect((await SELF.fetch(`${BASE}/a/b/c`)).status).toBe(404);
    expect((await SELF.fetch(`${BASE}/api/unknown`)).status).toBe(404);
  });

  it('rejects a malformed admin path instead of returning 500', async () => {
    const token = await signAccessJwt({ email: TEST_EMAIL });
    const response = await SELF.fetch(`${BASE}/admin/api/assets/%ZZ`, {
      headers: { 'cf-access-jwt-assertion': token },
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe('invalid_request');
  });

  it('answers CORS preflights for embedding', async () => {
    const response = await SELF.fetch(`${BASE}/anything/x.png`, { method: 'OPTIONS' });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
  });
});
