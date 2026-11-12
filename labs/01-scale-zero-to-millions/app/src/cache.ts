import { Redis } from "ioredis";
import { client, registry } from "../../../../shared/ts/http.ts";

// CACHE_MODE=none   -> every read goes to Postgres
// CACHE_MODE=aside  -> cache-aside: GET redis, on miss read DB and SET with TTL
export const mode = process.env.CACHE_MODE ?? "none";
const ttl = Number(process.env.CACHE_TTL_S ?? 30);
// SINGLEFLIGHT=1 coalesces concurrent misses for the same key inside one process.
// Without it, a hot key expiring triggers N identical DB queries (thundering herd).
const singleflight = process.env.CACHE_SINGLEFLIGHT === "1";

export const redis = mode === "none" ? null : new Redis(process.env.REDIS_URL ?? "redis://redis:6379", {
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
});

const hits = new client.Counter({ name: "cache_hits_total", help: "cache hits", registers: [registry] });
const misses = new client.Counter({ name: "cache_misses_total", help: "cache misses", registers: [registry] });
const errors = new client.Counter({ name: "cache_errors_total", help: "cache errors (fallback to DB)", registers: [registry] });

const inflight = new Map<string, Promise<unknown>>();

export async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  if (!redis) return load();
  try {
    const raw = await redis.get(key);
    if (raw !== null) {
      hits.inc();
      return JSON.parse(raw) as T;
    }
  } catch {
    // Cache down must not mean site down: degrade to DB (and watch DB load jump).
    errors.inc();
    return load();
  }
  misses.inc();

  if (singleflight) {
    const pending = inflight.get(key);
    if (pending) return pending as Promise<T>;
  }
  const p = (async () => {
    const value = await load();
    if (value !== null && value !== undefined) {
      redis.set(key, JSON.stringify(value), "EX", ttl).catch(() => errors.inc());
    }
    return value;
  })();
  if (singleflight) {
    inflight.set(key, p);
    p.finally(() => inflight.delete(key));
  }
  return p;
}

export async function invalidate(key: string) {
  if (!redis) return;
  // Delete (not update) on write: avoids racing writers leaving stale value in cache.
  await redis.del(key).catch(() => errors.inc());
}
