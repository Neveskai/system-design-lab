// Back-of-the-envelope calculator. Every number carries its unit in the name.
// Run: node estimate.ts   (no dependencies)
//
// Sections:
//   1. Book example (Twitter QPS + storage). Full per-system estimates live in systems.ts.
//   2. Capacity: predict lab 01 ceilings from unit cost (CPU-ms per request) measured at low load,
//      then compare with the ceilings measured by a ramp on the same day.
//   3. Latency budget: a page load as a sum of round trips (uses results/net-docker.jsonl).
//   4. Availability: serial and parallel composition.
import fs from "node:fs";

const fmt = (n: number, digits = 2) => Number(n.toPrecision(digits)).toLocaleString("en-US");
const SEC_PER_DAY = 86_400;
const KB = 1e3, MB = 1e6, GB = 1e9, TB = 1e12, PB = 1e15; // decimal units, like disks and bills

function table(title: string, rows: (string | number)[][]) {
  console.log(`\n## ${title}`);
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  for (const r of rows) console.log("  " + r.map((c, i) => String(c).padEnd(w[i])).join("  "));
}

// ---------------------------------------------------------------- 1. Twitter
{
  const mau = 300e6, dailyFraction = 0.5, tweetsPerUserDay = 2, mediaFraction = 0.1;
  const mediaBytes = 1 * MB, retentionYears = 5, peakFactor = 2;
  const dau = mau * dailyFraction;
  const writeQps = (dau * tweetsPerUserDay) / SEC_PER_DAY;
  const mediaPerDay = dau * tweetsPerUserDay * mediaFraction * mediaBytes;
  // Same model with numbers the book leaves out: reads dominate a timeline product.
  const readsPerUserDay = 100; // timeline refreshes x tweets fetched, a guess to vary
  const readQps = (dau * readsPerUserDay) / SEC_PER_DAY;
  const textBytes = 64 + 140 + 100; // id + text + metadata
  table("1. Twitter example (book assumptions)", [
    ["quantity", "value", "note"],
    ["DAU", fmt(dau), "300M MAU x 50%"],
    ["write QPS (avg)", fmt(writeQps), "book: ~3500"],
    ["write QPS (peak)", fmt(writeQps * peakFactor), "peak = 2x avg"],
    ["media / day", `${fmt(mediaPerDay / TB)} TB`, "book: 30 TB"],
    ["media, 5 years", `${fmt((mediaPerDay * 365 * retentionYears) / PB)} PB`, "book: ~55 PB"],
    ["text / day", `${fmt((dau * tweetsPerUserDay * textBytes) / GB)} GB`, "~1000x smaller than media"],
    ["read QPS (avg), 100 reads/user/day", fmt(readQps), "read:write ~50:1"],
    ["egress if each read = 1 media", `${fmt((readQps * mediaFraction * mediaBytes * 8) / 1e12)} Tbit/s`, "this is why media lives on a CDN"],
  ]);
}

// ---------------------------------------------------------------- 2. Capacity from unit cost
type UnitCost = { stage: string; rate: number; api_rps: number; pg_tps: number; cache_hit: number | null; cpu_cores: Record<string, number> };
const load = (f: string): UnitCost | null => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null);

// Container CPU limits used in lab 01 (docker-compose.yml): cores available per role.
const limits: Record<string, Record<string, number>> = {
  single: { api: 1, postgres: 2 },
  lb: { api: 4, postgres: 2, nginx: 1 },
  cache: { api: 4, postgres: 2, nginx: 1, redis: 1 },
};
// Ceilings measured by a ramp the same day (results/*-ramp-*.log + Prometheus peak), and in lab 01 NOTES.
const measured: Record<string, { today: string; lab01: string }> = {
  single: { today: "2.0k (API at 1.0 core at 2000 rps)", lab01: "2.3-2.5k sustained, 3.5k peak" },
  lb: { today: "3.3k avg, 4.2k peak (API + PG + nginx all saturated)", lab01: "5.4k peak" },
  cache: { today: "5.1k avg, 7.5k peak (nginx saturated)", lab01: "7.8k peak" },
};

{
  const rows: (string | number)[][] = [["stage", "measured at", "role", "CPU-ms/req", "predicted ceiling", "measured ceiling"]];
  for (const [stage, rate] of [["single", 1000], ["lb", 3000], ["cache", 3000]] as const) {
    const u = load(`results/unit-cost-${stage}-read-${rate}.json`);
    if (!u) continue;
    let best = { role: "", rps: Infinity };
    for (const [role, cores] of Object.entries(limits[stage])) {
      const ms = ((u.cpu_cores[role] ?? 0) / u.api_rps) * 1000;
      const ceiling = (cores / ms) * 1000; // requests/s if this role ran at 100% of its limit
      if (ceiling < best.rps) best = { role, rps: ceiling };
      rows.push([stage, `${rate} rps`, `${role} (${cores} core)`, fmt(ms, 3), `${fmt(ceiling)} rps`, ""]);
    }
    rows.push([stage, "", `=> first to saturate: ${best.role}`, "", `${fmt(best.rps)} rps`, `today ${measured[stage].today}; lab01 ${measured[stage].lab01}`]);
  }
  table("2. Lab 01 ceilings: unit cost x cores vs ramp", rows);

  // Unit cost is not constant: it falls as load rises (wake-ups and syscalls amortized across requests).
  const curve = [500, 1000, 2000].map((r) => load(`results/unit-cost-single-read-${r}.json`)).filter(Boolean) as UnitCost[];
  if (curve.length) {
    table("2b. Single stage: CPU-ms per request vs load", [
      ["api rps", "API CPU-ms/req", "PG CPU-ms/query", "API cores used"],
      ...curve.map((u) => [fmt(u.api_rps, 3), fmt((u.cpu_cores.api / u.api_rps) * 1000, 3), fmt((u.cpu_cores.postgres / u.pg_tps) * 1000, 3), fmt(u.cpu_cores.api, 3)]),
    ]);
    // Linear fit cores = fixed + marginal * rps, from the two lowest points.
    const [a, b] = curve;
    const marginal = (b.cpu_cores.api - a.cpu_cores.api) / (b.api_rps - a.api_rps);
    const fixed = a.cpu_cores.api - marginal * a.api_rps;
    console.log(`  linear fit: API cores = ${fmt(fixed, 2)} + ${fmt(marginal * 1000, 2)} ms x rps  =>  ceiling at 1 core = ${fmt((1 - fixed) / marginal)} rps`);
  }
}

// ---------------------------------------------------------------- 3. Latency budget
{
  type Net = { profile: string; name: string; p50: number };
  const f = "results/net-docker.jsonl";
  const net: Net[] = fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  const p50 = (profile: string, name: string) => net.find((n) => n.profile === profile && n.name === name)?.p50 ?? NaN;

  // Model: cost of one API call = round trips x RTT + server time.
  // TCP 1, TLS 1.3 1, CORS preflight 1, request 1.
  const rtt = 110, server = 130;
  const scenarios: [string, number][] = [
    ["cold: TCP + TLS + preflight + request", 4],
    ["warm connection, preflight not cached", 2],
    ["warm connection, preflight cached / same origin", 1],
  ];
  const rows: (string | number)[][] = [["call", "round trips", `model (RTT ${rtt} ms + server ${server} ms)`]];
  for (const [name, rts] of scenarios) rows.push([name, rts, `${rts * rtt + server} ms`]);
  for (const waves of [4, 2, 1]) rows.push([`${waves} sequential wave(s) of warm calls (2 RT each)`, waves * 2, `${waves * (2 * rtt + server)} ms`]);
  table("3. Latency budget: round trips x RTT", rows);

  if (net.length) {
    table("3b. Model check against toxiproxy at +110 ms RTT (p50)", [
      ["measurement", "measured", "model", "note"],
      ["HTTPS GET, keep-alive", `${p50("region", "HTTPS GET, keep-alive")} ms`, `${rtt} ms`, "1 RT"],
      ["HTTPS GET, new connection", `${p50("region", "HTTPS GET, new connection")} ms`, `${2 * rtt} ms`, "TLS + request; toxiproxy accepts TCP locally, real world adds 1 RT"],
      ["PG new connection (SCRAM)", `${p50("region", "PG new connection (TCP + SCRAM auth)")} ms`, `${3 * rtt} ms`, "startup + 2 SCRAM steps (~3.6 RT measured); why pools and RDS Proxy exist"],
      ["PG 10 rows, N+1 queries", `${p50("region", "PG 10 rows, 10 queries (N+1)")} ms`, `${10 * rtt} ms`, "10 RT"],
      ["PG 10 rows, one query", `${p50("region", "PG 10 rows, 1 query (= ANY)")} ms`, `${rtt} ms`, "1 RT"],
      ["Redis 10 GETs sequential vs pipeline", `${p50("region", "Redis 10 GETs, sequential")} / ${p50("region", "Redis 10 GETs, pipelined")} ms`, `${10 * rtt} / ${rtt} ms`, "pipelining = batching round trips"],
      ["same N+1 inside one AZ (+1 ms)", `${p50("az", "PG 10 rows, 10 queries (N+1)")} ms`, `${fmt(10 * p50("az", "PG SELECT by primary key"), 2)} ms (10 x 1 query)`, "N+1 is invisible at 1 ms RTT, fatal at 110 ms"],
    ]);
  }
}

// ---------------------------------------------------------------- 4. Availability
{
  const serial = (...a: number[]) => a.reduce((x, y) => x * y, 1);
  const parallel = (a: number, n: number) => 1 - (1 - a) ** n; // n independent copies, any one is enough
  const downtime = (a: number) => {
    const min = (1 - a) * 365 * 24 * 60;
    return min > 600 ? `${fmt(min / 60)} h/year` : `${fmt(min)} min/year`;
  };
  const lb = 0.9999, api = 0.995, pg = 0.999, redis = 0.999;
  const rows: (string | number)[][] = [["topology", "availability", "downtime"]];
  const add = (name: string, a: number) => rows.push([name, `${(a * 100).toFixed(4)}%`, downtime(a)]);
  add("one API instance (99.5%)", api);
  add("LB -> 1 API -> PG", serial(lb, api, pg));
  add("LB -> 4 APIs -> PG", serial(lb, parallel(api, 4), pg));
  add("LB -> 4 APIs -> PG primary + standby (Multi-AZ)", serial(lb, parallel(api, 4), parallel(pg, 2)));
  add("+ Redis on the request path (hard dependency)", serial(lb, parallel(api, 4), parallel(pg, 2), redis));
  add("BFF fan-out to 6 services in series, 99.9% each", serial(...Array(6).fill(0.999)));
  table("4. Availability composition (independent failures assumed)", rows);
  console.log("  Serial dependencies multiply: every hard dependency lowers the ceiling. Redundancy only helps the layer it covers,");
  console.log("  and only if failover is fast and failures are independent (same AZ, same deploy, same bug = not independent).");
}
