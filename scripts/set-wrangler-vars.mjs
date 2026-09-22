#!/usr/bin/env node
/**
 * Update `[vars]` entries in wrangler.toml without disturbing the comments that
 * explain them.
 *
 *   node scripts/set-wrangler-vars.mjs ACCESS_AUD=abc ACCESS_TEAM_DOMAIN=team.cloudflareaccess.com
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const configPath = fileURLToPath(new URL('../wrangler.toml', import.meta.url));
const pairs = process.argv.slice(2).map((argument) => {
  const index = argument.indexOf('=');
  if (index <= 0) {
    process.stderr.write(`error: expected KEY=VALUE, got "${argument}"\n`);
    process.exit(1);
  }
  return [argument.slice(0, index), argument.slice(index + 1)];
});

if (pairs.length === 0) {
  process.stderr.write('usage: node scripts/set-wrangler-vars.mjs KEY=VALUE [KEY=VALUE ...]\n');
  process.exit(1);
}

let contents = readFileSync(configPath, 'utf8');
for (const [key, value] of pairs) {
  const pattern = new RegExp(`^(${key}\\s*=\\s*).*$`, 'm');
  if (!pattern.test(contents)) {
    process.stderr.write(`error: ${key} is not declared in wrangler.toml\n`);
    process.exit(1);
  }
  contents = contents.replace(pattern, `$1${JSON.stringify(value)}`);
  process.stdout.write(`set ${key}\n`);
}
writeFileSync(configPath, contents);
