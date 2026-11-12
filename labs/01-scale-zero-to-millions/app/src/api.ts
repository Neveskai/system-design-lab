// Backend API: documents of a collaborative editor.
// Each route stresses a different resource on purpose:
//   GET  /docs/:id          -> DB read (or cache)         : network + DB IO/CPU
//   PUT  /docs/:id          -> DB write + cache invalidate : WAL/fsync, row locks
//   GET  /users/:id/docs    -> index range scan           : DB CPU, payload size
//   GET  /docs/:id/render   -> CPU-bound work in Node     : event loop blocking
import { createHash } from "node:crypto";
import { createApp, HttpError } from "../../../../shared/ts/http.ts";
import { pool } from "./db.ts";
import { cached, invalidate, redis } from "./cache.ts";

const app = createApp();
const RENDER_ITER = Number(process.env.RENDER_ITER ?? 200);

type Doc = { id: number; owner_id: number; title: string; body: string; version: number; updated_at: string };

function loadDoc(id: number): Promise<Doc | null> {
  return pool
    .query<Doc>("SELECT id, owner_id, title, body, version, updated_at FROM documents WHERE id = $1", [id])
    .then((r) => r.rows[0] ?? null);
}

app.get("/docs/:id", async ({ params }) => {
  const id = Number(params.id);
  const doc = await cached(`doc:${id}`, () => loadDoc(id));
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
  return r.rows[0];
});

app.get("/users/:id/docs", async ({ params, query }) => {
  const limit = Math.min(Number(query.get("limit") ?? 20), 100);
  const userId = Number(params.id);
  // List view does not need body: selecting fewer columns = less IO and less network.
  return cached(`user-docs:${userId}:${limit}`, () =>
    pool
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
app.get("/docs/:id/render", async ({ params }) => {
  const id = Number(params.id);
  const doc = await cached(`doc:${id}`, () => loadDoc(id));
  if (!doc) throw new HttpError(404, "doc not found");
  let h = doc.body;
  for (let i = 0; i < RENDER_ITER; i++) h = createHash("sha256").update(h).digest("hex") + doc.body;
  return { id, hash: h.slice(0, 64), words: doc.body.split(/\s+/).length };
});

app.listen(Number(process.env.PORT ?? 3000), async () => {
  await pool.end();
  redis?.disconnect();
});
