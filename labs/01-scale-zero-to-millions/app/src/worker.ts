// Render worker: pulls jobs from the stream, renders, stores the result, acks.
// One process = one CPU-bound job at a time (Node is single-threaded): scale with
// `--scale worker=N`, like adding consumers to an SQS queue.
import { hostname } from "node:os";
import { client, createApp, registry } from "../../../../shared/ts/http.ts";
import { pool } from "./db.ts";
import { backlog, ensureGroup, GROUP, queue, STREAM } from "./queue.ts";
import { render } from "./render.ts";

const ITER = Number(process.env.JOB_ITER ?? 2000);
const BATCH = Number(process.env.WORKER_BATCH ?? 10);
const CLAIM_IDLE_MS = Number(process.env.CLAIM_IDLE_MS ?? 30_000);
const me = hostname();

const processed = new client.Counter({ name: "jobs_processed_total", help: "Jobs done", labelNames: ["result"], registers: [registry] });
// Enqueue -> done. This is what the user waits for. Grows with queue depth (Little's law).
const e2e = new client.Histogram({
  name: "job_end_to_end_seconds",
  help: "Time from enqueue to result stored",
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300],
  registers: [registry],
});
new client.Gauge({
  name: "queue_backlog",
  help: "Jobs waiting (lag) and in flight (pending)",
  labelNames: ["state"],
  registers: [registry],
  async collect() {
    const b = await backlog();
    this.set({ state: "lag" }, b.lag);
    this.set({ state: "pending" }, b.pending);
  },
});

type Entry = [id: string, fields: string[]];

async function handle([id, fields]: Entry) {
  const f: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) f[fields[i]] = fields[i + 1];
  const r = await pool.query("SELECT body, version FROM documents WHERE id = $1", [Number(f.doc)]);
  const doc = r.rows[0];
  const result = doc ? { status: "done", hash: render(doc.body, ITER), version: doc.version } : { status: "not_found" };
  // Result keyed by job id: running the same job twice writes the same value (idempotent).
  await queue.multi().set(`job:${f.job}`, JSON.stringify(result), "EX", 600).xack(STREAM, GROUP, id).exec();
  processed.inc({ result: result.status });
  e2e.observe((Date.now() - Number(f.at)) / 1000);
  // Yield between jobs so /metrics can be served (event loop is busy during render).
  await new Promise((res) => setImmediate(res));
}

async function loop() {
  await ensureGroup();
  let claimFrom = "0-0";
  for (;;) {
    // 1) Take over jobs another worker left pending for too long (crashed mid-job).
    const [next, claimed] = (await queue.xautoclaim(STREAM, GROUP, me, CLAIM_IDLE_MS, claimFrom, "COUNT", BATCH)) as [string, Entry[]];
    claimFrom = next;
    for (const e of claimed) e && (await handle(e));
    // 2) New jobs. BLOCK = long poll, like SQS WaitTimeSeconds.
    const res = (await queue.xreadgroup("GROUP", GROUP, me, "COUNT", BATCH, "BLOCK", 1000, "STREAMS", STREAM, ">")) as
      | [string, Entry[]][]
      | null;
    for (const e of res?.[0]?.[1] ?? []) await handle(e);
  }
}

const app = createApp();
app.listen(Number(process.env.PORT ?? 3001), async () => {
  await pool.end();
  queue.disconnect();
});
loop().catch((e) => {
  console.error("worker loop", e);
  process.exit(1);
});
