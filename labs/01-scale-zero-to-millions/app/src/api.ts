// Backend API: documents of a collaborative editor.
// Each route stresses a different resource on purpose:
//   GET  /docs/:id          -> DB read (or cache)         : network + DB IO/CPU
//   PUT  /docs/:id          -> DB write + cache invalidate : WAL/fsync, row locks
//   GET  /users/:id/docs    -> index range scan           : DB CPU, payload size
//   GET  /docs/:id/render   -> CPU-bound work in Node     : event loop blocking
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { client, createApp, HttpError, registry } from "../../../../shared/ts/http.ts";
import { pool, readPool, replicaPool, shutdownPools } from "./db.ts";
import { cached, invalidate, redis } from "./cache.ts";

const app = createApp();
const RENDER_ITER = Number(process.env.RENDER_ITER ?? 200);

type Doc = { id: number; owner_id: number; title: string; body: string; version: number; updated_at: string };

// Read-your-writes on an async replica. The client proves what it already wrote
// (like a session token) and the server picks a strategy:
//   RYW=none     ignore it: the reader may see an older version (stale read)
//   RYW=primary  any request flagged `x-ryw` goes to the primary (sticky after write)
//   RYW=version  read replica; if row.version < x-min-version, re-read on primary
//                (per entity; an editor already knows the doc version it holds)
//   RYW=lsn      wait until replica replayed x-min-lsn (WAL position of the write),
//                up to RYW_WAIT_MS, then fall back to primary (per database, any query)
const RYW = process.env.RYW ?? "none";
const RYW_WAIT_MS = Number(process.env.RYW_WAIT_MS ?? 50);
const reads = new client.Counter({
  name: "db_reads_total",
  help: "Document reads by pool and reason",
  labelNames: ["pool", "reason"],
  registers: [registry],
});

const SELECT_DOC = "SELECT id, owner_id, title, body, version, updated_at FROM documents WHERE id = $1";
const queryDoc = (p: typeof pool, id: number) => p.query<Doc>(SELECT_DOC, [id]).then((r) => r.rows[0] ?? null);
const onPrimary = (id: number, reason: string) => (reads.inc({ pool: "primary", reason }), queryDoc(pool, id));

async function replicaCaughtUp(lsn: string) {
  const deadline = Date.now() + RYW_WAIT_MS;
  for (;;) {
    const r = await replicaPool!.query("SELECT pg_last_wal_replay_lsn() >= $1::pg_lsn AS ok", [lsn]);
    if (r.rows[0].ok) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((res) => setTimeout(res, 1));
  }
}

async function loadDoc(id: number, req?: IncomingMessage): Promise<Doc | null> {
  const p = readPool();
  if (p === pool) return onPrimary(id, "normal");
  const h = req?.headers ?? {};
  if (RYW === "primary" && h["x-ryw"]) return onPrimary(id, "ryw");
  try {
    if (RYW === "lsn" && typeof h["x-min-lsn"] === "string" && !(await replicaCaughtUp(h["x-min-lsn"]))) {
      return onPrimary(id, "lsn_timeout");
    }
    const doc = await queryDoc(p, id);
    reads.inc({ pool: "replica", reason: "normal" });
    if (RYW === "version" && doc && doc.version < Number(h["x-min-version"] ?? 0)) return onPrimary(id, "stale");
    return doc;
  } catch {
    // Replica down or too slow: reads degrade to primary instead of failing.
    return onPrimary(id, "replica_error");
  }
}

app.get("/docs/:id", async ({ params, req }) => {
  const id = Number(params.id);
  const doc = await cached(`doc:${id}`, () => loadDoc(id, req));
  if (!doc) throw new HttpError(404, "doc not found");
  return doc;
});

app.put("/docs/:id", async ({ params, body }) => {
  const id = Number(params.id);
  const input = (await body()) ?? {};
  if (typeof input.body !== "string") throw new HttpError(400, "body required");
  const r = await pool.query<Doc>(
    `UPDATE documents SET body = $2, version = version + 1, updated_at = now()
     WHERE id = $1 RETURNING id, version, updated_at`,
    [id, input.body],
  );
  if (r.rowCount === 0) throw new HttpError(404, "doc not found");
  await invalidate(`doc:${id}`);
  // WAL position after commit: a replica that replayed past it has this write.
  // Costs one extra round trip, so only when the lsn strategy is on.
  if (RYW !== "lsn") return r.rows[0];
  const l = await pool.query("SELECT pg_current_wal_insert_lsn()::text AS lsn");
  return { ...r.rows[0], lsn: l.rows[0].lsn };
});

app.get("/users/:id/docs", async ({ params, query }) => {
  const limit = Math.min(Number(query.get("limit") ?? 20), 100);
  const userId = Number(params.id);
  // List view does not need body: selecting fewer columns = less IO and less network.
  return cached(`user-docs:${userId}:${limit}`, () =>
    readPool()
      .query(
        `SELECT id, title, version, updated_at FROM documents
         WHERE owner_id = $1 ORDER BY updated_at DESC LIMIT $2`,
        [userId, limit],
      )
      .then((r) => r.rows),
  );
});

// Simulates server-side render / diff / export: pure CPU on the event loop.
// While this runs, every other request on this replica waits (watch event loop lag).
app.get("/docs/:id/render", async ({ params, req }) => {
  const id = Number(params.id);
  const doc = await cached(`doc:${id}`, () => loadDoc(id, req));
  if (!doc) throw new HttpError(404, "doc not found");
  let h = doc.body;
  for (let i = 0; i < RENDER_ITER; i++) h = createHash("sha256").update(h).digest("hex") + doc.body;
  return { id, hash: h.slice(0, 64), words: doc.body.split(/\s+/).length };
});

app.listen(Number(process.env.PORT ?? 3000), async () => {
  await shutdownPools();
  redis?.disconnect();
});
