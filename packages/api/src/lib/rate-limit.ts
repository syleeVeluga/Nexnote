import type { Redis } from "ioredis";

export interface RateLimitConfig {
  key: string;
  limit: number;
  windowSec: number;
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetSec: number;
}

// Minimal surface we actually use — lets tests pass a fake without wiring all of ioredis.
export interface RateLimitRedis {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
}

/**
 * Fixed-window counter backed by Redis INCR + EXPIRE.
 *
 * Why fixed-window: ingestion is a coarse-grained 202-async endpoint; we don't
 * need token-bucket precision. A single INCR is cheap and atomic, and the
 * window boundary edge case (double burst across boundary) is acceptable here.
 * Fails open if Redis is unreachable — the BullMQ enqueue that follows would
 * fail anyway, producing a clearer 5xx than a spurious 429.
 */
export async function consumeRateLimit(
  redis: RateLimitRedis,
  cfg: RateLimitConfig,
): Promise<RateLimitResult> {
  const nowSec = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(nowSec / cfg.windowSec) * cfg.windowSec;
  const redisKey = `rl:${cfg.key}:${windowStart}`;

  try {
    const count = await redis.incr(redisKey);
    if (count === 1) {
      await redis.expire(redisKey, cfg.windowSec);
    }
    const remaining = Math.max(0, cfg.limit - count);
    const resetSec = Math.max(1, windowStart + cfg.windowSec - nowSec);
    return {
      allowed: count <= cfg.limit,
      limit: cfg.limit,
      remaining,
      resetSec,
    };
  } catch {
    return {
      allowed: true,
      limit: cfg.limit,
      remaining: cfg.limit,
      resetSec: cfg.windowSec,
    };
  }
}

export function parsePositiveInt(
  raw: string | undefined,
  fallback: number,
): number {
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
