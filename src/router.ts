/**
 * Minimal path router. Patterns are literal segments plus `:name` captures;
 * nothing here needs regular expressions or route priorities, so there is no
 * ordering surprise when a new route is added.
 */

import type { Identity } from './auth';
import { errorResponse } from './util';

export interface Ctx {
  request: Request;
  env: Env;
  /** ExecutionContext of the incoming request (waitUntil / passThroughOnException). */
  exec: ExecutionContext;
  url: URL;
  params: Record<string, string>;
  /** Set once for admin requests, so handlers never re-verify the assertion. */
  identity?: Identity;
}

export type Handler = (ctx: Ctx) => Promise<Response> | Response;

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
}

function split(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '');
}

export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): this {
    this.routes.push({ method: method.toUpperCase(), segments: split(pattern), handler });
    return this;
  }

  get(pattern: string, handler: Handler): this {
    return this.add('GET', pattern, handler);
  }

  post(pattern: string, handler: Handler): this {
    return this.add('POST', pattern, handler);
  }

  patch(pattern: string, handler: Handler): this {
    return this.add('PATCH', pattern, handler);
  }

  put(pattern: string, handler: Handler): this {
    return this.add('PUT', pattern, handler);
  }

  delete(pattern: string, handler: Handler): this {
    return this.add('DELETE', pattern, handler);
  }

  /** `null` means "no route matched", which lets the caller fall through. */
  async handle(ctx: Ctx, prefix = ''): Promise<Response | null> {
    const path = split(ctx.url.pathname);
    const prefixSegments = split(prefix);
    if (prefixSegments.length > 0) {
      if (!prefixSegments.every((segment, index) => path[index] === segment)) return null;
    }
    const rest = path.slice(prefixSegments.length);
    for (const route of this.routes) {
      if (route.method !== ctx.request.method.toUpperCase()) continue;
      if (route.segments.length !== rest.length) continue;
      const params: Record<string, string> = {};
      let matched = true;
      for (let i = 0; i < route.segments.length; i += 1) {
        const pattern = route.segments[i];
        if (pattern.startsWith(':')) {
          try {
            params[pattern.slice(1)] = decodeURIComponent(rest[i]);
          } catch {
            return errorResponse(400, 'invalid_request', 'malformed path encoding');
          }
        } else if (pattern !== rest[i]) {
          matched = false;
          break;
        }
      }
      if (!matched) continue;
      return route.handler({ ...ctx, params: { ...ctx.params, ...params } });
    }
    return null;
  }
}
