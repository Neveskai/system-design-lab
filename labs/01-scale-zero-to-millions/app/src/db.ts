import pg from "pg";
import { client, registry } from "../../../../shared/ts/http.ts";

// Pool size is a key knob: too small => requests queue inside Node (db_pool_waiting),
// too big => Postgres spends CPU on context switches and lock contention.
// Rule of thumb from PG folks: connections ~= (PG cores * 2) + spindles, across ALL replicas.
function makePool(url: string | undefined) {
  return new pg.Pool({
    connectionString: url,
    max: Number(process.env.PG_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS ?? 5_000),
    statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS ?? 5_000),
  });
}

// Primary takes every write. The replica (streaming replication, async) only serves reads.
export const pool = makePool(process.env.PG_URL);
export const replicaPool = process.env.PG_REPLICA_URL ? makePool(process.env.PG_REPLICA_URL) : null;

// READ_FROM=primary  -> replica unused (stages single/lb/cache)
// READ_FROM=replica  -> all reads on the replica: primary keeps its CPU for writes
// READ_FROM=both     -> alternate reads between primary and replica: 2x read capacity
//                       (Aurora reader endpoint does this over N readers, via DNS)
const READ_FROM = replicaPool ? (process.env.READ_FROM ?? "replica") : "primary";
let rr = 0;
export function readPool(): pg.Pool {
  if (READ_FROM === "primary" || !replicaPool) return pool;
  if (READ_FROM === "replica") return replicaPool;
  return rr++ % 2 === 0 ? pool : replicaPool;
}

const pools = { primary: pool, ...(replicaPool ? { replica: replicaPool } : {}) };
for (const [metric, help, read] of [
  ["db_pool_total", "Open connections in pool", (p: pg.Pool) => p.totalCount],
  ["db_pool_idle", "Idle connections in pool", (p: pg.Pool) => p.idleCount],
  ["db_pool_waiting", "Queries waiting for a free connection", (p: pg.Pool) => p.waitingCount],
] as const) {
  new client.Gauge({
    name: metric,
    help,
    labelNames: ["pool"],
    registers: [registry],
    collect() {
      for (const [name, p] of Object.entries(pools)) this.set({ pool: name }, read(p));
    },
  });
}

export const shutdownPools = () => Promise.all(Object.values(pools).map((p) => p.end()));
