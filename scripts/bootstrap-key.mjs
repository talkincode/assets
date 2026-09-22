#!/usr/bin/env node
/**
 * Create the first upload key without the dashboard.
 *
 * The dashboard needs Cloudflare Access to be configured; uploads only need a
 * key. This script closes that ordering gap by writing the key row straight
 * into D1 through wrangler, so a fresh deployment is usable before Access is
 * in place. After the first key exists, create the rest from the dashboard.
 *
 *   node scripts/bootstrap-key.mjs --name ci            # remote D1
 *   node scripts/bootstrap-key.mjs --name dev --local   # local D1 (wrangler dev)
 */

import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const args = process.argv.slice(2);
const name = (() => {
  const index = args.findIndex((value) => value === '--name');
  return index >= 0 ? args[index + 1] : 'bootstrap';
})();
const local = args.includes('--local');
const database = 'talkincode-assets';

if (typeof name !== 'string' || !/^[A-Za-z0-9._ -]{1,64}$/.test(name)) {
  process.stderr.write('error: --name must be 1-64 characters of [A-Za-z0-9._ -]\n');
  process.exit(1);
}

const secret = `ak_${randomBytes(24).toString('hex')}`;
const keyHash = createHash('sha256').update(secret).digest('hex');
const id = randomUUID();
const now = Date.now();
const sql = `INSERT INTO api_keys (id, name, key_hash, prefix, created_at, created_by, use_count)
VALUES ('${id}', '${name}', '${keyHash}', '${secret.slice(0, 10)}', ${now}, 'bootstrap', 0);`;

const result = spawnSync(
  'npx',
  ['--no-install', 'wrangler', 'd1', 'execute', database, local ? '--local' : '--remote', '-y', `--command=${sql}`],
  { stdio: 'inherit', cwd: new URL('..', import.meta.url).pathname },
);

if (result.status !== 0) {
  process.stderr.write('error: wrangler d1 execute failed\n');
  process.exit(result.status ?? 1);
}

process.stdout.write(`\nkey id : ${id}\nkey    : ${secret}\n\n`);
process.stdout.write('Store the key now — only its SHA-256 is stored.\n');
process.stdout.write(`Try it:\n  export ASSETS_KEY=${secret}\n  ./cli/assets.mjs put ./README.md --expire 7d\n`);
