#!/usr/bin/env node
/**
 * CLI for talkincode-assets — designed for agents and scripts.
 *
 * Zero dependencies. Configuration from the environment:
 *
 *   ASSETS_BASE_URL            https://assets.talkincode.net (default)
 *   ASSETS_KEY                 upload key, required by `put`
 *   CF_ACCESS_CLIENT_ID        Access service token id (admin commands)
 *   CF_ACCESS_CLIENT_SECRET    Access service token secret
 *
 * Agent tip: prefer `--json` or `-q` (quiet = just the URL / hash).
 * Temporary share links are hard-capped at 4 hours on the server.
 */

import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import process from 'node:process';

/** Must match server TEMP_LINK_MAX_SECONDS. */
const TEMP_LINK_MAX_SECONDS = 4 * 60 * 60;

const HELP = `talkincode-assets CLI (agent-friendly)

Upload
  assets put <file|-> [--expire 7d|never] [--name FILE] [--hash LINK_HASH] [--note TEXT] [--tags a,b] [--project SLUG]
      → prints share URL (first link). --json includes asset_hash + link hash.

Find & share (agents)
  assets ls [--status live|expired|deleted|all] [--kind KIND] [--tag TAG] [--project SLUG|none] [--q TEXT] [--limit N]
  assets show <asset_hash>
  assets find <query> [--project SLUG|none] [--limit N]
      → prints asset_hash + note + filename (search live assets)
  assets note <asset_hash> <text|->   # set / update note (stdin with -)
  assets note <asset_hash> --clear    # clear note
  assets temp <asset_hash|query> [--project SLUG] [--expire 30m|1h|4h] [--label TEXT]
      → mint a temporary share link (HARD MAX 4h; default 1h). -q prints only the URL.
  assets link <asset_hash> [--expire 7d|never] [--label TEXT] [--hash HASH]
      → mint a normal share link (dashboard-style TTL; no 4h cap)
  assets links <asset_hash>
  assets revoke <link_hash>

Projects
  assets projects
  assets project-create <slug> [--name TEXT] [--note TEXT]
  assets project-show <slug|id>
  assets project-rm <slug|id>
  assets project-set <asset_hash> <slug|none>

Lifecycle
  assets rm <asset_hash> [--hard]
  assets restore <asset_hash>
  assets url <link_hash> [filename]

Keys / abuse
  assets keys | key-create <name> | key-revoke <id>
  assets blocked | unblock <source>
  assets whoami | health | help

Global: --json  --quiet/-q  --base-url URL  --env-file PATH

Env: ASSETS_BASE_URL, ASSETS_KEY, CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET
`;

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.replace(/^['"]|['"]$/g, '');
  }
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const [key, inline] = token.slice(2).split('=');
      if (inline !== undefined) {
        flags[key] = inline;
      } else if (['json', 'quiet', 'hard', 'help', 'verbose', 'clear'].includes(key)) {
        flags[key] = true;
      } else {
        flags[key] = argv[i + 1];
        i += 1;
      }
    } else if (token === '-q') {
      flags.quiet = true;
    } else if (token === '-h') {
      flags.help = true;
    } else {
      positional.push(token);
    }
  }
  return { flags, positional };
}

const { flags, positional } = parseArgs(process.argv.slice(2));
const command = positional.shift() ?? 'help';

if (command === 'help' || flags.help) {
  process.stdout.write(HELP);
  process.exit(0);
}

loadEnvFile(flags['env-file'] ? resolve(flags['env-file']) : resolve(process.cwd(), '.env'));

const baseUrl = (flags['base-url'] ?? process.env.ASSETS_BASE_URL ?? 'https://assets.talkincode.net').replace(/\/+$/, '');
const uploadKey = process.env.ASSETS_KEY;
const accessId = process.env.CF_ACCESS_CLIENT_ID;
const accessSecret = process.env.CF_ACCESS_CLIENT_SECRET;

function fail(message, hint) {
  process.stderr.write(`error: ${message}\n`);
  if (hint) process.stderr.write(`hint: ${hint}\n`);
  process.exit(1);
}

function authHeaders(forUpload) {
  const headers = {};
  if (forUpload) {
    if (!uploadKey) fail('ASSETS_KEY is not set', 'create an upload key in the dashboard and export ASSETS_KEY');
    headers.authorization = `Bearer ${uploadKey}`;
  } else if (accessId && accessSecret) {
    headers['cf-access-client-id'] = accessId;
    headers['cf-access-client-secret'] = accessSecret;
  }
  return headers;
}

async function request(path, { method = 'GET', body, headers = {}, forUpload = false, raw = false } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...authHeaders(forUpload), ...headers },
    body,
    duplex: body && typeof body.pipe === 'function' ? 'half' : undefined,
  });
  const text = await response.text();
  if (response.status === 403 || response.status === 401) {
    let payload = null;
    try { payload = JSON.parse(text); } catch { /* not json */ }
    if (payload?.error === 'blocked') fail('this network is blocked by the abuse guard', 'wait for the block to expire, or unblock it in the dashboard');
    if (!accessId && path.startsWith('/admin')) {
      fail('dashboard API refused the request', 'set CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET (Access service token) for admin commands');
    }
  }
  if (!response.ok) {
    let payload = null;
    try { payload = JSON.parse(text); } catch { /* not json */ }
    fail(`${method} ${path} -> ${response.status} ${payload?.error ?? ''} ${payload?.message ?? text.slice(0, 300)}`.trim());
  }
  if (raw) return text;
  try { return text ? JSON.parse(text) : null; } catch { return text; }
}

function output(data, human, quietText) {
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    return;
  }
  if (flags.quiet) {
    process.stdout.write(`${quietText ?? human ?? ''}\n`);
    return;
  }
  process.stdout.write(`${human ?? JSON.stringify(data, null, 2)}\n`);
}

function humanSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes ?? 0;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
  return `${value < 10 && index > 0 ? value.toFixed(1) : Math.round(value)} ${units[index]}`;
}

function humanExpiry(expiresAt) {
  if (expiresAt === undefined) return '—';
  if (expiresAt === null) return 'never';
  const delta = expiresAt - Date.now();
  if (delta <= 0) return 'expired';
  const days = Math.floor(delta / 86400000);
  if (days >= 1) return `in ${days}d`;
  const hours = Math.floor(delta / 3600000);
  if (hours >= 1) return `in ${hours}h`;
  return `in ${Math.max(1, Math.floor(delta / 60000))}m`;
}

/** Parse 30m / 1h / 4h into seconds; returns null for never. */
function parseDurationSeconds(raw) {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim().toLowerCase();
  if (text === 'never' || text === '0') return null;
  if (/^\d+$/.test(text)) return Number(text);
  const match = /^(\d+)([smhdw])$/.exec(text);
  if (!match) fail(`invalid duration "${raw}"`, 'use 30m, 1h, 4h, 7d, or never');
  const n = Number(match[1]);
  const unit = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[match[2]];
  return n * unit;
}

function assertTempExpiry(expiresIn) {
  const seconds = parseDurationSeconds(expiresIn ?? '1h');
  if (seconds === null) {
    fail('temporary links cannot be permanent', `use --expire 30m|1h|4h (max ${TEMP_LINK_MAX_SECONDS / 3600}h)`);
  }
  if (seconds <= 0 || seconds > TEMP_LINK_MAX_SECONDS) {
    fail(
      `temporary link expiry must be ≤ ${TEMP_LINK_MAX_SECONDS / 3600}h`,
      'example: assets temp <hash> --expire 1h -q',
    );
  }
  return expiresIn ?? '1h';
}

async function put() {
  const source = positional[0];
  if (!source) fail('usage: assets put <file|->');
  const params = new URLSearchParams();
  if (flags.expire) params.set('expires_in', String(flags.expire));
  if (flags.hash) params.set('hash', String(flags.hash));
  if (flags.note) params.set('note', String(flags.note));
  if (flags.tags) params.set('tags', String(flags.tags));
  if (flags.project) params.set('project', String(flags.project));

  let body;
  let filename = flags.name;
  const headers = {};

  if (source === '-') {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    body = Buffer.concat(chunks);
    if (!filename) fail('reading from stdin needs --name <filename>');
  } else {
    const path = resolve(source);
    if (!existsSync(path)) fail(`no such file: ${source}`);
    const stats = statSync(path);
    if (stats.isDirectory()) fail(`${source} is a directory`);
    body = createReadStream(path);
    headers['content-length'] = String(stats.size);
    if (!filename) filename = basename(path);
  }
  if (filename) params.set('filename', String(filename));
  headers['content-type'] = 'application/octet-stream';

  const result = await request(`/api/upload?${params}`, { method: 'POST', body, headers, forUpload: true });
  const human = [
    `url:         ${result.url}`,
    `link_hash:   ${result.hash}`,
    `asset_hash:  ${result.asset_hash}`,
    `note:        ${result.note ?? ''}`,
    `size:        ${humanSize(result.size)}`,
    `link_expires:${humanExpiry(result.expires_at)}`,
  ].join('\n');
  output(result, human, result.url);
}

function formatNote(note) {
  if (!note) return '-';
  return String(note).replace(/[\t\r\n]+/g, ' ').trim() || '-';
}

async function ls() {
  const params = new URLSearchParams();
  params.set('status', String(flags.status ?? 'live'));
  params.set('limit', String(flags.limit ?? 50));
  if (flags.q) params.set('q', String(flags.q));
  if (flags.kind) params.set('kind', String(flags.kind));
  if (flags.tag) params.set('tag', String(flags.tag));
  if (flags.project) params.set('project', String(flags.project));
  const data = await request(`/admin/api/assets?${params}`, {});
  const lines = data.assets
    .map((asset) => {
      const project = asset.project?.slug ? `proj=${asset.project.slug}` : 'proj=-';
      return `${asset.hash}\t${formatNote(asset.note)}\t${asset.filename}\t${humanSize(asset.size)}\t${project}\tlinks=${asset.live_links ?? 0}`;
    })
    .join('\n');
  output(data, `total ${data.total}\n${lines}`);
}

async function find() {
  const q = positional[0] ?? flags.q;
  if (!q) fail('usage: assets find <query> [--project SLUG]', 'searches live assets by filename / hash / note / tags');
  const params = new URLSearchParams({
    status: 'live',
    q: String(q),
    limit: String(flags.limit ?? 20),
  });
  if (flags.project) params.set('project', String(flags.project));
  const data = await request(`/admin/api/assets?${params}`, {});
  if (!flags.json && !flags.quiet && data.assets.length === 0) {
    fail(`no live assets matched "${q}"`);
  }
  const lines = data.assets
    .map((asset) => `${asset.hash}\t${formatNote(asset.note)}\t${asset.filename}\t${humanSize(asset.size)}\tlinks=${asset.live_links ?? 0}`)
    .join('\n');
  output(data, lines, data.assets[0]?.hash ?? '');
}

async function show() {
  const hash = positional[0];
  if (!hash) fail('usage: assets show <asset_hash>');
  const data = await request(`/admin/api/assets/${encodeURIComponent(hash)}`, {});
  const asset = data.asset;
  const linkLines = (data.links ?? [])
    .map((link) => `  ${link.hash}  ${link.status.padEnd(8)} ${humanExpiry(link.expires_at).padEnd(10)} ${link.url}`)
    .join('\n');
  const human = [
    `asset_hash: ${asset.hash}`,
    `filename:   ${asset.filename}`,
    `type:       ${asset.content_type}`,
    `size:       ${humanSize(asset.size)}`,
    `status:     ${asset.status} (live_links=${asset.live_links ?? 0})`,
    `project:    ${asset.project ? `${asset.project.name} (${asset.project.slug})` : '—'}`,
    `created:    ${new Date(asset.created_at).toISOString()}`,
    `downloads:  ${asset.downloads}`,
    `tags:       ${(asset.tags ?? []).join(', ')}`,
    `note:       ${asset.note ?? ''}`,
    'links:',
    linkLines || '  (none)',
  ].join('\n');
  output(data, human, asset.hash);
}

async function resolveAssetHash(spec) {
  if (!spec) fail('asset hash or search query required');
  // Prefer exact asset hash hit.
  try {
    const data = await request(`/admin/api/assets/${encodeURIComponent(spec)}`, {});
    if (data?.asset?.hash) return data.asset.hash;
  } catch {
    // fall through to search
  }
  const params = new URLSearchParams({ status: 'live', q: String(spec), limit: '5' });
  if (flags.project) params.set('project', String(flags.project));
  const listed = await request(`/admin/api/assets?${params}`, {});
  if (!listed.assets?.length) fail(`no asset matched "${spec}"`);
  if (listed.assets.length > 1 && !flags.json) {
    process.stderr.write(`note: ${listed.assets.length} matches; using first ${listed.assets[0].hash} (${listed.assets[0].filename})\n`);
  }
  return listed.assets[0].hash;
}

async function projectsList() {
  const data = await request('/admin/api/projects', {});
  const lines = [
    `unassigned  ${data.unassigned ?? 0}`,
    ...(data.projects ?? []).map((row) =>
      `${row.slug.padEnd(20)} ${String(row.asset_count ?? 0).padStart(4)}  ${row.name}${row.archived_at ? ' (archived)' : ''}`,
    ),
  ].join('\n');
  output(data, lines || 'no projects');
}

async function projectCreate() {
  const slug = positional[0];
  if (!slug) fail('usage: assets project-create <slug> [--name TEXT] [--note TEXT]');
  const body = { slug };
  if (flags.name) body.name = String(flags.name);
  if (flags.note) body.note = String(flags.note);
  const data = await request('/admin/api/projects', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
  output(data, `created ${data.project.slug} (${data.project.name}) id=${data.project.id}`, data.project.slug);
}

async function projectShow() {
  const id = positional[0];
  if (!id) fail('usage: assets project-show <slug|id>');
  const data = await request(`/admin/api/projects/${encodeURIComponent(id)}`, {});
  const p = data.project;
  output(data, `slug: ${p.slug}\nname: ${p.name}\nid: ${p.id}\nassets: ${p.asset_count}\nnote: ${p.note ?? ''}`, p.slug);
}

async function projectRemove() {
  const id = positional[0];
  if (!id) fail('usage: assets project-rm <slug|id>');
  const data = await request(`/admin/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
  output(data, `deleted ${data.slug} (assets unassigned)`, data.slug);
}

async function noteSet() {
  const hash = positional[0];
  if (!hash) fail('usage: assets note <asset_hash> <text|-> | assets note <asset_hash> --clear');
  let note;
  if (flags.clear) {
    note = '';
  } else {
    const raw = positional[1];
    if (raw === undefined) fail('usage: assets note <asset_hash> <text|-> | assets note <asset_hash> --clear');
    if (raw === '-') {
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      note = Buffer.concat(chunks).toString('utf8').trim();
    } else {
      note = String(raw);
    }
  }
  const data = await request(`/admin/api/assets/${encodeURIComponent(hash)}`, {
    method: 'PATCH',
    body: JSON.stringify({ note }),
    headers: { 'content-type': 'application/json' },
  });
  const saved = data.asset?.note ?? '';
  output(data, `asset_hash: ${hash}\nnote:       ${saved || '(cleared)'}`, hash);
}

async function projectSet() {
  const hash = positional[0];
  const project = positional[1] ?? flags.project;
  if (!hash || project === undefined) fail('usage: assets project-set <asset_hash> <slug|none>');
  const data = await request(`/admin/api/assets/${encodeURIComponent(hash)}`, {
    method: 'PATCH',
    body: JSON.stringify({ project }),
    headers: { 'content-type': 'application/json' },
  });
  const label = data.asset?.project?.slug ?? 'none';
  output(data, `asset ${hash} → project ${label}`, label);
}

/** Agent entry: find asset + mint ≤4h temporary link. */
async function temp() {
  const spec = positional[0];
  if (!spec) fail('usage: assets temp <asset_hash|query> [--expire 1h] [--label TEXT]', `max expiry ${TEMP_LINK_MAX_SECONDS / 3600}h`);
  const expiresIn = assertTempExpiry(flags.expire);
  const assetHash = await resolveAssetHash(spec);
  const body = { expires_in: expiresIn };
  if (flags.label) body.label = String(flags.label);
  const data = await request(`/admin/api/assets/${encodeURIComponent(assetHash)}/temp-link`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
  const link = data.link;
  const human = [
    `url:         ${link.url}`,
    `link_hash:   ${link.hash}`,
    `asset_hash:  ${link.asset_hash}`,
    `expires:     ${humanExpiry(link.expires_at)}`,
    `max_seconds: ${data.max_seconds}`,
  ].join('\n');
  output({ ...data, asset_hash: assetHash }, human, link.url);
}

async function linkCreate() {
  const hash = positional[0];
  if (!hash) fail('usage: assets link <asset_hash> [--expire 7d|never] [--label TEXT] [--hash HASH]');
  const body = {};
  if (flags.expire === 'never') body.never = true;
  else if (flags.expire) body.expires_in = String(flags.expire);
  if (flags.label) body.label = String(flags.label);
  if (flags.hash) body.hash = String(flags.hash);
  const data = await request(`/admin/api/assets/${encodeURIComponent(hash)}/links`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
  output(data, `url: ${data.link.url}\nhash: ${data.link.hash}\nexpires: ${humanExpiry(data.link.expires_at)}`, data.link.url);
}

async function linksList() {
  const hash = positional[0];
  if (!hash) fail('usage: assets links <asset_hash>');
  const data = await request(`/admin/api/assets/${encodeURIComponent(hash)}/links`, {});
  const lines = (data.links ?? [])
    .map((link) => `${link.hash}  ${link.status.padEnd(8)} ${humanExpiry(link.expires_at).padEnd(10)} ${link.url}`)
    .join('\n');
  output(data, lines || 'no links');
}

async function revoke() {
  const hash = positional[0];
  if (!hash) fail('usage: assets revoke <link_hash>');
  const data = await request(`/admin/api/links/${encodeURIComponent(hash)}`, { method: 'DELETE' });
  output(data, `revoked ${data.revoked}`);
}

async function remove() {
  const hash = positional[0];
  if (!hash) fail('usage: assets rm <asset_hash> [--hard]');
  const suffix = flags.hard ? '?purge=1' : '';
  const data = await request(`/admin/api/assets/${encodeURIComponent(hash)}${suffix}`, { method: 'DELETE' });
  output(data, `deleted ${data.deleted}${data.hard ? ' (purged)' : ' (recoverable until the trash sweep)'}`);
}

async function restore() {
  const hash = positional[0];
  if (!hash) fail('usage: assets restore <asset_hash>');
  const data = await request(`/admin/api/assets/${encodeURIComponent(hash)}/restore`, {
    method: 'POST',
    body: '{}',
    headers: { 'content-type': 'application/json' },
  });
  output(data, `restored ${data.asset.hash} (create a new link to share again)`, data.asset.hash);
}

async function url() {
  const hash = positional[0];
  if (!hash) fail('usage: assets url <link_hash> [filename]');
  const name = positional[1];
  const built = `${baseUrl}/${hash}${name ? `/${encodeURIComponent(name)}` : ''}`;
  output({ url: built }, built);
}

async function keys() {
  const data = await request('/admin/api/keys', {});
  const lines = data.keys
    .map((key) => `${key.prefix}…  ${key.revoked_at ? 'revoked' : 'active '}  used ${key.use_count}x  ${key.last_used_at ? `last ${new Date(key.last_used_at).toISOString()}` : 'never used'}  ${key.name}  (${key.id})`)
    .join('\n');
  output(data, lines || 'no keys');
}

async function keyCreate() {
  const name = positional[0];
  if (!name) fail('usage: assets key-create <name>');
  const data = await request('/admin/api/keys', {
    method: 'POST',
    body: JSON.stringify({ name }),
    headers: { 'content-type': 'application/json' },
  });
  // Human mode masks the secret; --json / -q expose it for agents/scripts.
  const masked = `${String(data.secret).slice(0, 10)}${'•'.repeat(18)}`;
  const human = [
    `id:     ${data.id}`,
    `prefix: ${data.prefix}…`,
    `secret: ${masked}`,
    '',
    'secret is masked here. Use --json (or -q) to print the full secret once.',
  ].join('\n');
  output(data, human, data.secret);
}

async function keyRevoke() {
  const id = positional[0];
  if (!id) fail('usage: assets key-revoke <id>');
  const data = await request(`/admin/api/keys/${encodeURIComponent(id)}`, { method: 'DELETE' });
  output(data, `revoked ${data.revoked}`);
}

async function blocked() {
  const data = await request('/admin/api/abuse', {});
  const lines = data.blocked
    .map((row) => `${row.source.padEnd(22)} ${row.active ? 'blocked' : 'expired'}  strikes ${row.strikes}  until ${new Date(row.blocked_until).toISOString()}  ${row.detail ?? ''}`)
    .join('\n');
  output(data, lines || 'nothing blocked');
}

async function unblock() {
  const source = positional[0];
  if (!source) fail('usage: assets unblock <source>');
  const data = await request(`/admin/api/abuse/${encodeURIComponent(source)}`, { method: 'DELETE' });
  output(data, `unblocked ${data.unblocked}`);
}

async function whoami() {
  const data = await request('/admin/api/me', {});
  output(data, `${data.email ?? data.service_token ?? data.actor}\nbase url: ${data.public_base_url}\ntemp link max: ${data.temp_link_max_seconds}s`);
}

async function health() {
  const data = await request('/health', {});
  output(data, `${data.status} @ ${data.service}`);
}

const commands = {
  put,
  upload: put,
  ls,
  list: ls,
  find,
  search: find,
  show,
  get: show,
  note: noteSet,
  'set-note': noteSet,
  temp,
  'temp-link': temp,
  'temp-url': temp,
  link: linkCreate,
  links: linksList,
  revoke,
  rm: remove,
  delete: remove,
  restore,
  url,
  projects: projectsList,
  project: projectsList,
  'project-create': projectCreate,
  'project-show': projectShow,
  'project-rm': projectRemove,
  'project-delete': projectRemove,
  'project-set': projectSet,
  keys,
  'key-create': keyCreate,
  'key-revoke': keyRevoke,
  blocked,
  unblock,
  whoami,
  health,
};

const handler = commands[command];
if (!handler) fail(`unknown command "${command}"`, 'run `assets help`');
await handler();
