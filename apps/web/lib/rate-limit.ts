import "server-only";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { serverEnv } from "@/lib/env";

type Limiter = { limit: (key: string) => Promise<{ success: boolean }> };

const limiters = new Map<string, Limiter>();

/**
 * Sliding-window rate limiter backed by Upstash Redis. When Redis isn't
 * configured (local dev), it allows everything.
 */
export function rateLimiter(name: string, requests: number, window: `${number} ${"s" | "m" | "h"}`): Limiter {
  const existing = limiters.get(name);
  if (existing) return existing;

  const env = serverEnv();
  const limiter: Limiter =
    env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN
      ? new Ratelimit({
          redis: new Redis({ url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN }),
          limiter: Ratelimit.slidingWindow(requests, window),
          prefix: `rl:${name}`,
        })
      : { limit: async () => ({ success: true }) };

  limiters.set(name, limiter);
  return limiter;
}

export function clientIp(headers: Headers): string {
  return headers.get("x-forwarded-for")?.split(",")[0]?.trim() || headers.get("x-real-ip") || "unknown";
}
