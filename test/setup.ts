import { env } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import { TEST_TEAM_DOMAIN, jwks } from './access-fixtures';

/**
 * D1's `exec()` wants one statement at a time and trips over `--` comments, so
 * schema.sql is stripped and split here. Keeping the file itself commented is
 * worth it: it is the schema people actually read.
 */
function statementsOf(sql: string): string[] {
  const stripped: string[] = [];
  let inString = false;
  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    if (char === "'" && sql[i - 1] !== '\\') inString = !inString;
    if (!inString && char === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i += 1;
      stripped.push(' ');
      continue;
    }
    stripped.push(char);
  }
  return stripped
    .join('')
    .split(';')
    .map((statement) => statement.replace(/\s+/g, ' ').trim())
    .filter((statement) => statement !== '');
}

for (const statement of statementsOf(schema)) {
  await env.DB.exec(statement);
}

/**
 * The worker fetches Access signing keys over the network; here they are served
 * from a fixture key pair. Tests run in the same isolate as the worker, so
 * stubbing global fetch is enough — `SELF.fetch` is a service binding and is
 * unaffected.
 */
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url === `https://${TEST_TEAM_DOMAIN}/cdn-cgi/access/certs`) {
    return new Response(JSON.stringify(jwks()), { headers: { 'content-type': 'application/json' } });
  }
  return realFetch(input as RequestInfo, init);
}) as typeof fetch;
