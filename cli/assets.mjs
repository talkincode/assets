#!/usr/bin/env node
/**
 * CLI for talkincode-assets.
 *
 * Zero dependencies so an agent can run it with a bare `node` (or directly via
 * `./cli/assets.mjs`). Configuration comes from the environment:
 *
 *   ASSETS_BASE_URL            https://assets.talkincode.net (default)
 *   ASSETS_KEY                 upload key, required by `put`
 *   CF_ACCESS_CLIENT_ID        Access service token id, required by admin commands
 *   CF_ACCESS_CLIENT_SECRET    Access service token secret
 *
 * A `./.env` file in the working directory is loaded when present; real
 * environment variables always win.
 */

import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import process from 'node:process';

const HELP = `talkincode-assets CLI

  assets put <file|-> [--expire 7d|never] [--name FILE] [--hash HASH] [--note TEXT] [--tags a,b]
  assets ls [--status live|expired|deleted|all] [--kind KIND] [--tag TAG] [--q TEXT] [--limit N]
  assets show <hash>
  assets rm <hash> [--hard]
  assets restore <hash> [--expire 7d]
  assets expire <hash> <7d|never>
  assets rotate <hash> [--hash NEW]
  assets url <hash> [filename]
  assets keys | key-create <name> | key-revoke <id>
  assets blocked | unblock <source>
  assets whoami | health | help

Global flags: --json  --quiet/-q  --base-url URL  --env-file PATH

Environment: ASSETS_BASE_URL, ASSETS_KEY, CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET
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
      } else if (['json', 'quiet', 'hard', 'help', 'verbose'].includes(key)) {
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

/**
 * `--json` is for machines that want everything, `--quiet` for scripts that
 * only want the one value (a URL, an id), and the default is a readable summary.
 */
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

function humanExpiry(asset) {
  if (!asset.expires_at) return 'never';
  const delta = asset.expires_at - Date.now();
  if (delta <= 0) return 'expired';
  const days = Math.floor(delta / 86400000);
  if (days >= 1) return `in ${days}d`;
  const hours = Math.floor(delta / 3600000);
  if (hours >= 1) return `in ${hours}h`;
  return `in ${Math.max(1, Math.floor(delta / 60000))}m`;
}

async function put() {
  const source = positional[0];
  if (!source) fail('usage: assets put <file|->');
  const params = new URLSearchParams();
  if (flags.expire) params.set('expires_in', String(flags.expire));
  if (flags.hash) params.set('hash', String(flags.hash));
  if (flags.note) params.set('note', String(flags.note));
  if (flags.tags) params.set('tags', String(flags.tags));

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
  // Filename stays in the query string. HTTP headers are ISO-8859-1, so a
  // non-ASCII name in X-Filename fails in both the browser and undici.
  headers['content-type'] = 'application/octet-stream';

  const result = await request(`/api/upload?${params}`, { method: 'POST', body, headers, forUpload: true });
  const human = `url: ${result.url}\nhash: ${result.hash}\nsize: ${humanSize(result.size)}\nexpires: ${humanExpiry(result)}`;
  output(result, human, result.url);
}

async function ls() {
  const params = new URLSearchParams();
  params.set('status', String(flags.status ?? 'live'));
  params.set('limit', String(flags.limit ?? 50));
  if (flags.q) params.set('q', String(flags.q));
  if (flags.kind) params.set('kind', String(flags.kind));
  if (flags.tag) params.set('tag', String(flags.tag));
  const data = await request(`/admin/api/assets?${params}`, {});
  const lines = data.assets
    .map((asset) => `${asset.hash}  ${String(asset.status).padEnd(8)} ${humanSize(asset.size).padStart(9)}  ${humanExpiry(asset).padEnd(12)} ${asset.filename}`)
    .join('\n');
  output(data, `total ${data.total}\n${lines}`);
}

async function show() {
  const hash = positional[0];
  if (!hash) fail('usage: assets show <hash>');
  const data = await request(`/admin/api/assets/${encodeURIComponent(hash)}`, {});
  const asset = data.asset;
  const human = [
    `hash:      ${asset.hash}`,
    `url:       ${asset.url}`,
    `filename:  ${asset.filename}`,
    `type:      ${asset.content_type}`,
    `size:      ${humanSize(asset.size)}`,
    `status:    ${asset.status}`,
    `created:   ${new Date(asset.created_at).toISOString()}`,
    `expires:   ${asset.expires_at ? new Date(asset.expires_at).toISOString() : 'never'}`,
    `downloads: ${asset.downloads}`,
    `tags:      ${(asset.tags ?? []).join(', ')}`,
    `note:      ${asset.note ?? ''}`,
  ].join('\n');
  output(data, human, asset.url);
}

async function remove() {
  const hash = positional[0];
  if (!hash) fail('usage: assets rm <hash> [--hard]');
  const suffix = flags.hard ? '?purge=1' : '';
  const data = await request(`/admin/api/assets/${encodeURIComponent(hash)}${suffix}`, { method: 'DELETE' });
  output(data, `deleted ${data.deleted}${data.hard ? ' (purged)' : ' (recoverable until the trash sweep)'}`);
}

async function restore() {
  const hash = positional[0];
  if (!hash) fail('usage: assets restore <hash> [--expire 7d]');
  const body = flags.expire ? JSON.stringify({ expires_in: String(flags.expire) }) : '{}';
  const data = await request(`/admin/api/assets/${encodeURIComponent(hash)}/restore`, {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/json' },
  });
  output(data, `restored ${data.asset.hash} -> ${data.asset.url}`, data.asset.url);
}

async function expire() {
  const [hash, value] = positional;
  if (!hash || !value) fail('usage: assets expire <hash> <7d|never>');
  const body = value === 'never' ? { never: true } : { expires_in: value };
  const data = await request(`/admin/api/assets/${encodeURIComponent(hash)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
  output(data, `expires: ${humanExpiry(data.asset)}`);
}

async function rotate() {
  const hash = positional[0];
  if (!hash) fail('usage: assets rotate <hash> [--hash NEW]');
  const body = flags.hash ? JSON.stringify({ hash: String(flags.hash) }) : '{}';
  const data = await request(`/admin/api/assets/${encodeURIComponent(hash)}/rotate`, {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/json' },
  });
  output(data, `old: ${data.previous_url}\nnew: ${data.asset.url}`, data.asset.url);
}

async function url() {
  const hash = positional[0];
  if (!hash) fail('usage: assets url <hash> [filename]');
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
  output(data, `id: ${data.id}\nsecret: ${data.secret}\n\nstore the secret now; it is not recoverable.`);
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
  output(data, `${data.email ?? data.service_token ?? data.actor}\nbase url: ${data.public_base_url}`);
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
  show,
  get: show,
  rm: remove,
  delete: remove,
  restore,
  expire,
  ttl: expire,
  rotate,
  url,
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
