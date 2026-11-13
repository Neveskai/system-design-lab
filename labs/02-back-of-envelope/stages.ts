// Chapter 1 (scale from zero to millions) priced: what each stage of lab 01 costs per month, and at which
// load it starts to pay for itself. Same method as the A$/B$ sections of systems.ts.
// Run: node stages.ts
//
// For each traffic tier the model takes each stage decision on cost (cheapest option that holds the load,
// with at least 2 instances in 2 AZs) and prints the rejected option's price next to it. It then prices the
// book's final architecture (every stage on) at the same load, to show what over-provisioning costs.
// Source tags: [M] measured in lab 01/02, [R] vendor price or public reference, [E] estimate, not measured.
import { SEC_PER_MONTH, PRICE, WRITES_PER_PG_VCPU, monthly, usd, cdnCost, egressCost, ec2Fleet, pickRds, type Item } from "./prices.ts";

const fmt = (n: number, digits = 2) => Number(n.toPrecision(digits)).toLocaleString("en-US");
const KB = 1e3, GB = 1e9;
function table(title: string, rows: (string | number)[][]) {
  console.log(`\n## ${title}`);
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  for (const r of rows) console.log("  " + r.map((c, i) => String(c).padEnd(w[i])).join("  "));
}

// Workload: the lab 01 doc app. Request mix is [E]; per-request costs are measured.
const MIX = { reads: 0.9, writes: 0.09, attachments: 0.01, renders: 0.001 }; // share of peak requests
const COST = {
  apiReadMs: 0.55,    // [M] lab 01 E4
  apiWriteMs: 0.82,   // [M] lab 02 unit-cost write
  proxyMs: 5.6,       // [M] lab 01 E8: API CPU per 256 KB file proxied from S3
  presignMs: 3.5,     // [M] lab 01 E8: SDK v3 presign per URL
  renderMs: 10.5,     // [M] lab 01 E9a: 4 API cores saturated at ~381 renders/s
  pgReadMs: 0.4,      // [M] lab 01 E3: 2.5k PK reads/s per PG vCPU
  pgWriteMs: 1000 / WRITES_PER_PG_VCPU, // [E] see prices.ts
  redisOpUs: 10,      // [E] GET of 1 KB incl. network stack; Redis does ~100k simple ops/s per core
  cacheHit: 0.85,     // [M] lab 01 E4, 80% of traffic on 1% of docs
  cdnHit: 0.98,       // [M] lab 01 E8: 98-99.5%
};
const BYTES = { response: 1 * KB, attachment: 256 * KB };
const AVG_OVER_PEAK = 0.5;   // monthly average = half the peak, as the book's peak = 2x average
const RENDER_SPIKE = 6;      // [M] lab 01 E9b: 100 -> 600 renders/s for 30 s
const NEW_CONN_SHARE = 0.1;  // [E] share of requests that open a new TCP/TLS connection at the ALB
const VCPU_MONTH = monthly(PRICE.ec2C7gXlargeHour) / 4 / 0.6; // $ per vCPU of work at 60% utilization

type Opts = { book: boolean };
function stagesCost(peakRps: number, o: Opts): Item[] {
  const reads = peakRps * MIX.reads, writes = peakRps * MIX.writes, att = peakRps * MIX.attachments;
  const renderAvg = peakRps * MIX.renders * AVG_OVER_PEAK, renderPeak = renderAvg * RENDER_SPIKE;
  const perMonth = (perSecPeak: number) => perSecPeak * AVG_OVER_PEAK * SEC_PER_MONTH; // events per month
  const items: Item[] = [];
  let apiVcpu = (reads * COST.apiReadMs + writes * COST.apiWriteMs) / 1000;

  // Attachments: proxy through the API, presigned URL straight to S3, or CDN in front of S3.
  const attGb = (perMonth(att) * BYTES.attachment) / GB;
  const s3Gets = (n: number) => (n / 1000) * PRICE.s3GetPerThousand;
  const attOpts = {
    proxy: { cpu: (att * COST.proxyMs) / 1000, usd: egressCost(attGb) + s3Gets(perMonth(att)) },
    presigned: { cpu: (att * COST.presignMs) / 1000, usd: egressCost(attGb) + s3Gets(perMonth(att)) },
    cdn: { cpu: 0, usd: cdnCost(attGb) + s3Gets(perMonth(att) * (1 - COST.cdnHit)) }, // immutable URL in the doc; S3 -> CloudFront is free
  };
  const attTotal = (k: keyof typeof attOpts) => attOpts[k].usd + attOpts[k].cpu * VCPU_MONTH;
  const attPick = o.book ? "cdn" : (Object.keys(attOpts) as (keyof typeof attOpts)[]).reduce((a, b) => (attTotal(b) < attTotal(a) ? b : a));
  apiVcpu += attOpts[attPick].cpu;
  const others = (Object.keys(attOpts) as (keyof typeof attOpts)[]).filter((k) => k !== attPick).map((k) => `${k} ${usd(attTotal(k))}`).join(", ");
  items.push({ name: "attachments", choice: `${attPick}: ${fmt(attGb / 1e3)} TB/month (${others})`, usd: attOpts[attPick].usd });

  // Heavy job (render/export): inline on the API, sized for the spike, or queue + workers sized for the average.
  const syncFleet = ec2Fleet(apiVcpu + (renderPeak * COST.renderMs) / 1000);
  const apiOnly = ec2Fleet(apiVcpu);
  const workers = ec2Fleet((renderAvg * 1.2 * COST.renderMs) / 1000, 1);
  const sqs = ((perMonth(peakRps * MIX.renders) * 3) / 1e6) * PRICE.sqsPerMillion;
  const queueUsd = workers.cost + sqs, syncExtra = syncFleet.cost - apiOnly.cost;
  const useQueue = o.book || queueUsd < syncExtra;
  if (useQueue) {
    items.push({ name: "API fleet", choice: `${apiOnly.count} x c7g.xlarge`, usd: apiOnly.cost });
    items.push({ name: "render jobs", choice: `queue: SQS + ${workers.count} worker(s) (inline would add ${usd(syncExtra)})`, usd: queueUsd });
  } else {
    items.push({ name: "API fleet", choice: `${syncFleet.count} x c7g.xlarge, render inline (queue: ${usd(queueUsd)})`, usd: syncFleet.cost });
  }

  // Load balancer and internet egress of API responses.
  const lbBytesPerHour = ((reads + writes) * BYTES.response + (attPick === "proxy" ? att * BYTES.attachment : 0)) * AVG_OVER_PEAK * 3600;
  const lcu = Math.max((peakRps * AVG_OVER_PEAK * NEW_CONN_SHARE) / 25, lbBytesPerHour / GB);
  items.push({ name: "ALB", choice: `${fmt(lcu)} LCU avg`, usd: monthly(PRICE.albHour) + monthly(PRICE.albLcuHour, lcu) });
  const respGb = (perMonth(reads + writes) * BYTES.response) / GB;
  items.push({ name: "API egress", choice: `${fmt(respGb / 1e3)} TB/month of 1 KB responses`, usd: egressCost(respGb) });

  // Database, with or without a cache in front. A replica only when one primary cannot hold the reads
  // (RDS price per vCPU is flat across sizes, so scaling up costs the same as a replica up to 64 vCPU).
  const writeVcpu = (writes * COST.pgWriteMs) / 1000;
  const db = (readShare: number) => pickRds((reads * readShare * COST.pgReadMs) / 1000 + writeVcpu, true);
  const cacheNodes = 2 * Math.max(1, Math.ceil((reads * COST.redisOpUs) / 1e6 / 0.6)); // primary + replica per shard
  const cacheUsd = monthly(PRICE.cacheR7gLargeHour, cacheNodes);
  const noCache = db(1), withCache = db(1 - COST.cacheHit);
  const useCache = o.book || withCache.cost + cacheUsd < noCache.cost;
  const chosen = useCache ? withCache : noCache;
  const shards = Math.max(o.book ? 2 : 1, Math.ceil(writeVcpu / 0.6 / 64));
  let dbLabel = chosen.label, dbUsd = chosen.cost;
  if (shards > 1) {
    const perShard = pickRds(((reads * (useCache ? 1 - COST.cacheHit : 1) * COST.pgReadMs) / 1000 + writeVcpu) / shards, true);
    dbLabel = `${shards} shards x ${perShard.label}`;
    dbUsd = shards * perShard.cost;
  } else if (!chosen.fits) dbLabel = `primary + ${chosen.count - 1} read replica(s), ${chosen.label}`;
  if (o.book) {
    dbLabel += " + 1 read replica per shard";
    dbUsd *= 1.5; // one single-AZ replica the size of each Multi-AZ primary
  }
  items.push({ name: "database", choice: dbLabel, usd: dbUsd });
  if (useCache) items.push({ name: "cache", choice: `${cacheNodes} x cache.r7g.large (DB without cache: ${usd(noCache.cost)})`, usd: cacheUsd });
  else items.push({ name: "cache", choice: `none (cache ${usd(cacheUsd)} + smaller DB ${usd(withCache.cost)})`, usd: 0 });

  const crossAzGb = (perMonth(reads + writes) * BYTES.response * 0.5) / GB; // 2 AZs: half the calls cross
  items.push({ name: "cross-AZ, API <-> DB/cache", choice: `${fmt(crossAzGb / 1e3)} TB/month`, usd: crossAzGb * PRICE.interAzGb });
  return items;
}

// One box with API + Postgres, no LB, no standby: the book's first stage. Cheapest, no availability.
function singleBox(peakRps: number) {
  const vcpu = (peakRps * MIX.reads * (COST.apiReadMs + COST.pgReadMs) + peakRps * MIX.writes * (COST.apiWriteMs + COST.pgWriteMs)
    + peakRps * MIX.attachments * COST.proxyMs + peakRps * MIX.renders * RENDER_SPIKE * AVG_OVER_PEAK * COST.renderMs) / 1000;
  const fleet = ec2Fleet(vcpu, 1);
  return fleet.count * 4 <= 64 ? `${usd(fleet.cost)} (${fleet.count * 4} vCPU)` : "does not fit in one box";
}

const summary: (string | number)[][] = [["peak rps", "lean $/month", "book final design $/month", "1 box, no HA"]];
for (const rps of [100, 1_000, 10_000, 100_000]) {
  const lean = stagesCost(rps, { book: false }), book = stagesCost(rps, { book: true });
  const total = (items: Item[]) => items.reduce((s, i) => s + i.usd, 0);
  table(`Chapter 1 stages at ${fmt(rps)} peak rps (cheapest option per decision)`, [
    ["item", "choice", "$/month"],
    ...lean.map((i) => [i.name, i.choice, usd(i.usd)]),
    ["total", "", usd(total(lean))],
  ]);
  summary.push([fmt(rps), usd(total(lean)), `${usd(total(book))} (${fmt(total(book) / total(lean))}x)`, singleBox(rps)]);
}
table("Chapter 1: cost by scale", summary);
console.log("  Book final design = LB + cache + CDN + queue + 2 shards with 1 read replica each, at any load.");
console.log("  Anchor [R]: Stack Overflow 2016 served ~209M HTTP requests/day (~2.4k/s average, ~5k peak) on 9 web servers.");
console.log("  List prices, on-demand, us-east-1 [R], from memory: verify. Engineering time is not in the numbers.");
