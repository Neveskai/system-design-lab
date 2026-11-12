import pg from "pg";
import { client, registry } from "../../../../shared/ts/http.ts";

// Pool size is a key knob: too small => requests queue inside Node (db_pool_waiting),
// too big => Postgres spends CPU on context switches and lock contention.
// Rule of thumb from PG folks: connections ~= (PG cores * 2) + spindles, across ALL replicas.
export const pool = new pg.Pool({
  connectionString: process.env.PG_URL,
  max: Number(process.env.PG_POOL_MAX ?? 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS ?? 5_000),
  statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS ?? 5_000),
});

new client.Gauge({
  name: "db_pool_total",
  help: "Open connections in pool",
  registers: [registry],
  collect() { this.set(pool.totalCount); },
});
new client.Gauge({
  name: "db_pool_idle",
  help: "Idle connections in pool",
  registers: [registry],
  collect() { this.set(pool.idleCount); },
});
new client.Gauge({
  name: "db_pool_waiting",
  help: "Queries waiting for a free connection",
  registers: [registry],
  collect() { this.set(pool.waitingCount); },
});
