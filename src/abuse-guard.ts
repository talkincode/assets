/**
 * One durable object per client network (IPv4 /24, IPv6 /64).
 *
 * A source gets a fixed budget of hash misses inside a sliding window. When the
 * budget is spent the source is blocked, and every further strike multiplies the
 * ban length, so a script that keeps guessing is locked out for longer each
 * time. Only failures reach this object, which keeps the hot path (a real
 * download) free of a durable-object round trip.
 */

import { DurableObject } from 'cloudflare:workers';
import { recordBlockedSource } from './db';

const STORAGE_KEY = 'state';
const STRIKE_DECAY_MS = 7 * 24 * 60 * 60 * 1000;

export interface GuardState {
  source: string;
  misses: number;
  windowStart: number;
  strikes: number;
  blockedUntil: number;
  lastStrikeAt: number;
  firstSeen: number;
  lastSeen: number;
}

export interface GuardResult {
  blocked: boolean;
  blockedUntil: number;
  strikes: number;
  misses: number;
  justBlocked: boolean;
}

export class AbuseGuard extends DurableObject<Env> {
  private cache: GuardState | null = null;

  private settings() {
    const threshold = Math.max(1, Number.parseInt(this.env.ABUSE_MISS_THRESHOLD, 10) || 15);
    const windowMs = Math.max(10, Number.parseInt(this.env.ABUSE_WINDOW_SECONDS, 10) || 600) * 1000;
    const schedule = this.env.ABUSE_BAN_SCHEDULE.split(',')
      .map((value) => Number.parseInt(value.trim(), 10))
      .filter((value) => Number.isFinite(value) && value > 0);
    return {
      threshold,
      windowMs,
      schedule: schedule.length > 0 ? schedule : [300, 3600, 86400, 604800],
    };
  }

  private async load(): Promise<GuardState> {
    if (this.cache) return this.cache;
    const stored = await this.ctx.storage.get<GuardState>(STORAGE_KEY);
    const now = Date.now();
    this.cache = stored ?? {
      source: '',
      misses: 0,
      windowStart: now,
      strikes: 0,
      blockedUntil: 0,
      lastStrikeAt: 0,
      firstSeen: now,
      lastSeen: now,
    };
    return this.cache;
  }

  async check(source: string): Promise<GuardResult> {
    const state = await this.load();
    const now = Date.now();
    // Fresh object: adopt the name so the dashboard can show it.
    if (state.source === '') state.source = source;
    return {
      blocked: state.blockedUntil > now,
      blockedUntil: state.blockedUntil,
      strikes: state.strikes,
      misses: state.misses,
      justBlocked: false,
    };
  }

  async recordMiss(source: string, detail: string): Promise<GuardResult> {
    const { threshold, windowMs, schedule } = this.settings();
    const state = await this.load();
    const now = Date.now();
    state.source = source;
    if (state.firstSeen === 0) state.firstSeen = now;
    state.lastSeen = now;

    if (now - state.windowStart > windowMs) {
      state.windowStart = now;
      state.misses = 0;
    }
    state.misses += 1;

    let justBlocked = false;
    if (state.misses >= threshold) {
      if (now - state.lastStrikeAt > STRIKE_DECAY_MS) state.strikes = 0;
      state.strikes += 1;
      state.lastStrikeAt = now;
      const banSeconds = schedule[Math.min(state.strikes - 1, schedule.length - 1)];
      state.blockedUntil = now + banSeconds * 1000;
      state.misses = 0;
      state.windowStart = now;
      justBlocked = true;
      await this.mirror(state, detail);
    }

    await this.ctx.storage.put(STORAGE_KEY, state);
    return {
      blocked: state.blockedUntil > now,
      blockedUntil: state.blockedUntil,
      strikes: state.strikes,
      misses: state.misses,
      justBlocked,
    };
  }

  async reset(): Promise<void> {
    this.cache = null;
    await this.ctx.storage.delete(STORAGE_KEY);
  }

  /** Persist the block so the dashboard can list and lift it. */
  private mirror(state: GuardState, detail: string): Promise<void> {
    return recordBlockedSource(this.env, {
      source: state.source,
      strikes: state.strikes,
      misses: state.misses,
      blocked_until: state.blockedUntil,
      first_seen: state.firstSeen,
      last_seen: state.lastSeen,
      detail,
    });
  }
}
