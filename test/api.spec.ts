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
  options: { key?: string; query?: string; filename?: string; ip?: string } = {},
) {
  const params = new URLSearchParams(options.query ?? '');
  return SELF.fetch(`${BASE}/api/upload?${params}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${options.key ?? ''}`,
      'x-filename': options.filename ?? 'report.txt',
      'content-type': 'text/plain',
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
    const { hash, url, expires_at: expiresAt } = (await created.json()) as {
      hash: string;
      url: string;
      expires_at: number | null;
    };
    expect(hash).toHaveLength(22);
    expect(url).toContain(`/${hash}/report.txt`);
    // Default TTL is 7 days.
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
    const row = await env.DB.prepare('SELECT object_key FROM assets WHERE hash = ?')
      .bind('RaceHashValue123456')
      .first<{ object_key: string }>();
    expect(row?.object_key).toBeTruthy();
    expect(await env.BUCKET.head(row!.object_key)).not.toBeNull();
  });

  it('stores tags on upload, filters by tag, and lets admin edit them', async () => {
    const created = await upload('tagged body', { key, query: 'tags=课件,PDF&expires_in=7d' });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { hash: string; tags: string[] };
    expect(body.tags).toEqual(['课件', 'PDF']);

    const token = await signAccessJwt({ email: TEST_EMAIL });
    const auth = { 'cf-access-jwt-assertion': token, 'content-type': 'application/json' };

    const listed = await SELF.fetch(`${BASE}/admin/api/assets?tag=${encodeURIComponent('课件')}`, {
      headers: auth,
    });
    expect(listed.status).toBe(200);
    const listBody = (await listed.json()) as { assets: { hash: string; tags: string[] }[] };
    expect(listBody.assets.some((asset) => asset.hash === body.hash)).toBe(true);

    const tags = await SELF.fetch(`${BASE}/admin/api/tags`, { headers: auth });
    expect(tags.status).toBe(200);
    const tagBody = (await tags.json()) as { tags: { tag: string; count: number }[] };
    expect(tagBody.tags.some((row) => row.tag === '课件' && row.count >= 1)).toBe(true);

    const patched = await SELF.fetch(`${BASE}/admin/api/assets/${body.hash}`, {
      method: 'PATCH',
      headers: auth,
      body: JSON.stringify({ tags: '微课' }),
    });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { asset: { tags: string[] } }).asset.tags).toEqual(['微课']);

    const cleared = await SELF.fetch(`${BASE}/admin/api/assets/${body.hash}`, {
      method: 'PATCH',
      headers: auth,
      body: JSON.stringify({ tags: '' }),
    });
    expect(((await cleared.json()) as { asset: { tags: string[] } }).asset.tags).toEqual([]);
  });

  it('batch-updates tags and expiry, and rotates hashes', async () => {
    const first = (await (await upload('batch-one', { key, query: 'tags=旧标签' })).json()) as { hash: string };
    const second = (await (await upload('batch-two', { key })).json()) as { hash: string };
    const token = await signAccessJwt({ email: TEST_EMAIL });
    const auth = { 'cf-access-jwt-assertion': token, 'content-type': 'application/json' };

    const updated = await SELF.fetch(`${BASE}/admin/api/assets/batch`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        hashes: [first.hash, second.hash],
        tags: '批量,共享',
        tags_mode: 'replace',
        expires_in: '1d',
      }),
    });
    expect(updated.status).toBe(200);
    const updatedBody = (await updated.json()) as {
      updated: number;
      results: { hash: string; tags: string[]; expires_at: number }[];
    };
    expect(updatedBody.updated).toBe(2);
    expect(updatedBody.results.every((row) => row.tags.includes('批量'))).toBe(true);

    const rotated = await SELF.fetch(`${BASE}/admin/api/assets/batch`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ hashes: [first.hash, second.hash], rotate: true }),
    });
    expect(rotated.status).toBe(200);
    const rotatedBody = (await rotated.json()) as {
      results: { hash: string; previous_hash: string }[];
    };
    expect(rotatedBody.results).toHaveLength(2);
    const probe = { 'cf-connecting-ip': '198.18.0.50' };
    for (const row of rotatedBody.results) {
      expect(row.hash).not.toBe(row.previous_hash);
      expect((await SELF.fetch(`${BASE}/${row.previous_hash}/x.txt`, { headers: probe })).status).toBe(404);
      expect((await SELF.fetch(`${BASE}/${row.hash}/x.txt`, { headers: probe })).status).toBe(200);
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

  it('honours expires_in, and reports 410 both before and after the sweep', async () => {
    const created = await upload('short lived', { key, query: 'expires_in=1s' });
    const { hash } = (await created.json()) as { hash: string };
    expect((await SELF.fetch(`${BASE}/${hash}/s.txt`)).status).toBe(200);

    await env.DB.prepare('UPDATE assets SET expires_at = ? WHERE hash = ?').bind(Date.now() - 1000, hash).run();
    expect((await SELF.fetch(`${BASE}/${hash}/s.txt`)).status).toBe(410);

    // The hourly sweep tombstones it and drops the bytes; the answer must not
    // change just because housekeeping ran.
    await env.DB.prepare('UPDATE assets SET deleted_at = ?, delete_reason = ?, purged_at = ? WHERE hash = ?')
      .bind(Date.now(), 'expired', Date.now(), hash)
      .run();
    expect((await SELF.fetch(`${BASE}/${hash}/s.txt`)).status).toBe(410);
  });

  it('supports never-expiring uploads and custom hashes', async () => {
    const created = await upload('forever', { key, query: 'expires_in=never&hash=CustomHashValue12345' });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { hash: string; expires_at: number | null };
    expect(body.hash).toBe('CustomHashValue12345');
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

  it('drives the lifecycle: list, update expiry, rotate, delete, restore, purge', async () => {
    const token = await signAccessJwt({ email: TEST_EMAIL });
    const auth = { 'cf-access-jwt-assertion': token, 'content-type': 'application/json' };
    const created = await upload('lifecycle body', { key, query: 'expires_in=1d' });
    const { hash } = (await created.json()) as { hash: string };

    const listed = await SELF.fetch(`${BASE}/admin/api/assets?status=live`, { headers: auth });
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { total: number }).total).toBeGreaterThan(0);

    const patched = await SELF.fetch(`${BASE}/admin/api/assets/${hash}`, {
      method: 'PATCH',
      headers: auth,
      body: JSON.stringify({ expires_in: '30d' }),
    });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { asset: { expires_at: number } }).asset.expires_at).toBeGreaterThan(
      Date.now() + 29 * 86400000,
    );

    const rotated = await SELF.fetch(`${BASE}/admin/api/assets/${hash}/rotate`, { method: 'POST', headers: auth, body: '{}' });
    const rotatedBody = (await rotated.json()) as { asset: { hash: string; url: string }; previous_hash: string };
    expect(rotatedBody.asset.hash).not.toBe(hash);
    expect((await SELF.fetch(`${BASE}/${hash}/x.txt`)).status).toBe(404);
    expect((await SELF.fetch(`${BASE}/${rotatedBody.asset.hash}/x.txt`)).status).toBe(200);

    const nextHash = rotatedBody.asset.hash;
    const deleted = await SELF.fetch(`${BASE}/admin/api/assets/${nextHash}`, { method: 'DELETE', headers: auth });
    expect(deleted.status).toBe(200);
    expect((await SELF.fetch(`${BASE}/${nextHash}/x.txt`)).status).toBe(404);

    const restored = await SELF.fetch(`${BASE}/admin/api/assets/${nextHash}/restore`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ expires_in: '7d' }),
    });
    expect(restored.status).toBe(200);
    expect((await SELF.fetch(`${BASE}/${nextHash}/x.txt`)).status).toBe(200);

    const purged = await SELF.fetch(`${BASE}/admin/api/assets/${nextHash}?purge=1`, { method: 'DELETE', headers: auth });
    expect(purged.status).toBe(200);
    expect((await SELF.fetch(`${BASE}/${nextHash}/x.txt`)).status).toBe(404);
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM assets WHERE hash = ?').bind(nextHash).first<{ n: number }>();
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
