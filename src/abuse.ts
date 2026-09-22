/**
 * Client side of the brute-force protection.
 *
 * Layer 1 — `[[ratelimits]]` bindings give every source a request budget per
 *           minute. The miss budget is by far the tightest one.
 * Layer 2 — the AbuseGuard durable object remembers repeat offenders across
 *           deployments and blocks them for escalating periods.
 *
 * Only failed lookups are recorded. A visitor downloading a real asset never
 * pays for either layer.
 */

import type { GuardResult } from './abuse-guard';
import { clearBlockedSource } from './db';

export const LOCAL_SOURCE = 'local';

export function clientIp(request: Request): string {
  return request.headers.get('cf-connecting-ip') ?? LOCAL_SOURCE;
}

/** Bucket a source into a network so a single /24 cannot rotate through hosts. */
export function networkKey(ip: string): string {
  if (ip === LOCAL_SOURCE) return LOCAL_SOURCE;
  if (ip.includes(':')) {
    const groups = ip.split(':').filter((group) => group !== '');
    const head = groups.slice(0, 4).map((group) => group.padStart(4, '0'));
    while (head.length < 4) head.push('0000');
    return `${head.join(':')}::/64`;
  }
  const octets = ip.split('.');
  if (octets.length !== 4) return ip;
  return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
}

function guard(env: Env, source: string) {
  return env.ABUSE.getByName(source);
}

export async function guardCheck(env: Env, source: string): Promise<GuardResult> {
  return guard(env, source).check(source);
}

export async function guardMiss(env: Env, source: string, detail: string): Promise<GuardResult> {
  return guard(env, source).recordMiss(source, detail);
}

export async function guardReset(env: Env, source: string): Promise<void> {
  await guard(env, source).reset();
  await clearBlockedSource(env, source);
}

export interface MissVerdict {
  blocked: boolean;
  retryAfter: number;
}

/**
 * Decide what to do with a failed lookup: rate-limit it first (cheap), then let
 * the durable object decide whether the source has earned a ban.
 */
export async function registerMiss(env: Env, request: Request, detail: string): Promise<MissVerdict> {
  const source = networkKey(clientIp(request));
  const limiter = env.MISS_LIMITER;
  if (limiter) {
    const { success } = await limiter.limit({ key: `${source}:miss` });
    if (!success) {
      const result = await guardMiss(env, source, `rate limit: ${detail}`);
      return { blocked: true, retryAfter: Math.max(1, Math.ceil((result.blockedUntil - Date.now()) / 1000)) };
    }
  }
  const result = await guardMiss(env, source, detail);
  if (!result.blocked) return { blocked: false, retryAfter: 0 };
  return { blocked: true, retryAfter: Math.max(1, Math.ceil((result.blockedUntil - Date.now()) / 1000)) };
}

export async function isBlocked(env: Env, request: Request): Promise<MissVerdict> {
  const source = networkKey(clientIp(request));
  const result = await guardCheck(env, source);
  if (!result.blocked) return { blocked: false, retryAfter: 0 };
  return { blocked: true, retryAfter: Math.max(1, Math.ceil((result.blockedUntil - Date.now()) / 1000)) };
}

/** Layer 1 only: a coarse budget for the whole request surface. */
export async function withinRequestBudget(env: Env, request: Request): Promise<boolean> {
  const limiter = env.READ_LIMITER;
  if (!limiter) return true;
  const { success } = await limiter.limit({ key: networkKey(clientIp(request)) });
  return success;
}
