// Job queue on Redis Streams. Stream = append-only log; consumer group = several
// workers share it, each entry goes to one worker, and stays "pending" until XACK.
// A worker that dies keeps its pending entries; others take them with XAUTOCLAIM
// (at-least-once delivery: a job can run twice, so the job must be idempotent).
//
// Separate Redis from the cache on purpose: the cache runs `allkeys-lru`, which
// would evict queue entries under memory pressure (silent job loss). Queue Redis
// runs `noeviction` + AOF: when full, XADD fails loudly instead.
import { Redis } from "ioredis";

export const STREAM = "render-jobs";
export const GROUP = "workers";
export const queue = new Redis(process.env.QUEUE_URL ?? "redis://queue:6379", { maxRetriesPerRequest: 1 });

export async function ensureGroup() {
  await queue.xgroup("CREATE", STREAM, GROUP, "$", "MKSTREAM").catch((e) => {
    if (!String(e.message).includes("BUSYGROUP")) throw e;
  });
}

// Entries not yet delivered to any worker (`lag`) + delivered but not acked (`pending`).
export async function backlog() {
  const groups = (await queue.xinfo("GROUPS", STREAM).catch(() => [])) as unknown[][];
  for (const g of groups) {
    const f: Record<string, unknown> = {};
    for (let i = 0; i < g.length; i += 2) f[String(g[i])] = g[i + 1];
    if (f.name === GROUP) return { lag: Number(f.lag ?? 0), pending: Number(f.pending ?? 0) };
  }
  return { lag: 0, pending: 0 };
}
