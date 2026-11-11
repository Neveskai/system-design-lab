// Backend API: documents of a collaborative editor.
// Each route stresses a different resource on purpose:
//   GET  /docs/:id          -> DB read (or cache)         : network + DB IO/CPU
//   PUT  /docs/:id          -> DB write + cache invalidate : WAL/fsync, row locks
//   GET  /users/:id/docs    -> index range scan           : DB CPU, payload size
//   GET  /docs/:id/render   -> CPU-bound work in Node     : event loop blocking
//   GET  /attachments/:key  -> bytes from object storage  : network bandwidth
//   POST /docs/:id/render-jobs -> enqueue, worker renders : queue depth, end-to-end latency
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { client, createApp, HttpError, registry } from "../../../../shared/ts/http.ts";
import { pool, readPool, replicaPool, shutdownPools } from "./db.ts";
import { cached, invalidate, redis } from "./cache.ts";
import { getObject, presign } from "./s3.ts";
import { backlog, ensureGroup, queue, STREAM } from "./queue.ts";
import { render } from "./render.ts";

const app = createApp();
const RENDER_ITER = Number(process.env.RENDER_ITER ?? 200);
// > 0 => render response says `Cache-Control: public, max-age=N` and the CDN may keep it.
const RENDER_MAX_AGE = Number(process.env.RENDER_MAX_AGE ?? 0);
const ATTACH_MODE = process.env.ATTACH_MODE ?? "proxy";

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
app.get("/docs/:id/render", async ({ params, req, res }) => {
  const id = Number(params.id);
  const doc = await cached(`doc:${id}`, () => loadDoc(id, req));
  if (!doc) throw new HttpError(404, "doc not found");
  const h = render(doc.body, RENDER_ITER);
  if (RENDER_MAX_AGE > 0) res.setHeader("cache-control", `public, max-age=${RENDER_MAX_AGE}`);
  return { id, hash: h, version: doc.version, words: doc.body.split(/\s+/).length };
});

// Attachments (images, files pasted into a doc).
//   proxy    API reads the object and streams it: every byte crosses the API twice
//            (S3 -> API -> client). Simple auth, but the API pays network + CPU per byte.
//   redirect API checks access, then answers 302 to a presigned URL. The client
//            downloads from S3 directly; the API only signs (a few microseconds of HMAC).
app.get("/attachments/:key", async ({ params, res }) => {
  if (ATTACH_MODE === "redirect") {
    res.writeHead(302, { location: await presign(params.key), "content-length": 0 });
    return res.end();
  }
  const obj = await getObject(params.key).catch((e) => {
    throw new HttpError(e.$metadata?.httpStatusCode === 404 ? 404 : 502, e.name);
  });
  res.writeHead(200, {
    "content-type": obj.ContentType ?? "application/octet-stream",
    "content-length": obj.ContentLength ?? 0,
    etag: obj.ETag ?? "",
  });
  await pipeline(obj.Body as Readable, res);
});

// Async render: accept the job, answer 202 at once, a worker does the CPU work.
// Admission control: when the backlog passes QUEUE_MAX, answer 503 + Retry-After
// instead of accepting work that will finish too late to matter (backpressure).
// Backlog is read every 200 ms, not per request: one XINFO per request would cost
// a Redis round trip each, so the limit is approximate (can overshoot a little).
const QUEUE_MAX = Number(process.env.QUEUE_MAX ?? 0); // 0 = unbounded
const enqueued = new client.Counter({ name: "jobs_enqueued_total", help: "Jobs accepted or rejected", labelNames: ["result"], registers: [registry] });
let depth = 0;
if (QUEUE_MAX > 0) setInterval(() => backlog().then((b) => (depth = b.lag + b.pending), () => {}), 200).unref();
await ensureGroup();

app.post("/docs/:id/render-jobs", async ({ params, res }) => {
  if (QUEUE_MAX > 0 && depth >= QUEUE_MAX) {
    enqueued.inc({ result: "rejected" });
    res.setHeader("retry-after", "1");
    throw new HttpError(503, "queue full");
  }
  const job = randomUUID();
  await queue.xadd(STREAM, "*", "job", job, "doc", params.id, "at", String(Date.now()));
  enqueued.inc({ result: "accepted" });
  res.writeHead(202, { "content-type": "application/json", location: `/jobs/${job}` });
  res.end(JSON.stringify({ job }));
});

// Client polls this (or, better, gets a push over WebSocket/SSE when done).
app.get("/jobs/:id", async ({ params }) => {
  const raw = await queue.get(`job:${params.id}`);
  return raw ? JSON.parse(raw) : { status: "pending" };
});

app.listen(Number(process.env.PORT ?? 3000), async () => {
  await shutdownPools();
  redis?.disconnect();
  queue.disconnect();
});
