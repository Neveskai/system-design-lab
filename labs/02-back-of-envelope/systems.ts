// Capacity estimates for three systems, each tied to an architecture draft in NOTES.md (section 3).
// Run: node systems.ts
//
// Every estimate follows the same steps:
//   assumptions -> traffic (avg, peak) -> per-component load -> instances -> storage -> bandwidth -> latency budget
// Unit costs are not guessed: they come from the measurements of this lab and lab 01 (see UNIT below).

import { HOURS_PER_MONTH, SEC_PER_MONTH, PRICE, WRITES_PER_PG_VCPU, monthly, usd, cdnCost, pickRds, type Item } from "./prices.ts";
const fmt = (n: number, digits = 2) => Number(n.toPrecision(digits)).toLocaleString("en-US");
const SEC_PER_DAY = 86_400;
const KB = 1e3, MB = 1e6, GB = 1e9, TB = 1e12, PB = 1e15;
const bytes = (b: number) =>
  b >= PB ? `${fmt(b / PB)} PB` : b >= TB ? `${fmt(b / TB)} TB` : b >= GB ? `${fmt(b / GB)} GB` : b >= MB ? `${fmt(b / MB)} MB` : `${fmt(b / KB)} KB`;
const bits = (bytesPerSec: number) => {
  const b = bytesPerSec * 8;
  return b >= 1e12 ? `${fmt(b / 1e12)} Tbit/s` : b >= 1e9 ? `${fmt(b / 1e9)} Gbit/s` : `${fmt(b / 1e6)} Mbit/s`;
};

// Unit costs measured on this machine (CPU-ms per operation, near saturation = marginal cost).
// Source of each number in the comment. A real fleet (Graviton/x86 in AWS) is within ~1.5x of these.
const UNIT = {
  apiReadMs: 0.55,      // lab 01 cache stage: 4 API cores / 7.5k rps; single stage at 2k rps: 0.50
  apiWriteMs: 0.82,     // lab 02 unit-cost single write: 0.82 ms at 500 and 1000 rps
  bffCallMs: 5.5,       // lab 01 E6: 1 BFF core ~180 rps, each request = 6 upstream calls
  pgReadPerVcpu: 2_500, // lab 01 E3: PG 2 vCPU saturated at ~5.7k TPS of PK reads
  pgWritePerPrimary: 1_000, // lab 02: single primary (2 vCPU, pool 10) tops at ~1.1k writes/s on hot rows
  lbRpsPerVcpu: 7_500,  // lab 02 cache ramp: nginx 1 core saturated at 7.5k rps
  // Fan-out on write and timeline reads in Redis (lab 02 bench/fanout.ts, results/fanout-docker.txt):
  fanoutWorkerMs: 0.009,   // worker CPU per timeline write (LPUSH + LTRIM), pipeline of 100: 7.8-8.8 µs
  redisWriteUs: 2.7,       // Redis CPU per timeline write, pipeline of 100
  redisReadUs: 52,         // Redis CPU per timeline read (LRANGE 50 ids + MGET 50 posts of 304 B)
  redisBytesPerId: 10.3,   // MEMORY USAGE of an 800-id list of 64-bit ids: 8240 B
  redisBytesPerPost: 368,  // MEMORY USAGE of one 304 B post string
  wsMsgMs: 0.02,        // estimate: WebSocket frame + JSON.parse of 200 B (~1 µs, lab 02 E1) + syscall (~10 µs)
  wsConnBytes: 50 * KB, // Node ws: socket buffers + per-connection state; plan value, measure in the chat lab
};
const TARGET_UTIL = 0.6; // plan for 60% CPU: headroom for the tail (lab 01 hockey stick) and estimate error
const VCPU_PER_INSTANCE = 4;

// vCPUs and instances needed to serve `opsPerSec` at `msPerOp` CPU each, at TARGET_UTIL.
function fleet(opsPerSec: number, msPerOp: number, minInstances = 2) {
  const vcpu = (opsPerSec * msPerOp) / 1000 / TARGET_UTIL;
  return { vcpu, instances: Math.max(minInstances, Math.ceil(vcpu / VCPU_PER_INSTANCE)) };
}

const PG_TIMELINE_QUERY_MS = 2; // [E] fan-out on read in one query: author_id = ANY(200 ids), index (author_id, created_at), LIMIT 50

function table(title: string, rows: (string | number)[][]) {
  console.log(`\n## ${title}`);
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  for (const r of rows) console.log("  " + r.map((c, i) => String(c).padEnd(w[i])).join("  "));
}
type Row = [string, string, string];
const header: Row = ["item", "estimate", "how"];

// ============================================================ A. Feed (book example, extended)
// Source tags in the "how" column: [P] product assumption, [M] measured in this lab, [R] book / vendor doc, [E] estimate.
{
  const a = {
    mau: 300e6, dailyFraction: 0.5, postsPerUserDay: 2, mediaFraction: 0.1, mediaBytes: 1 * MB,
    readsPerUserDay: 100,    // timeline loads x posts viewed: drives the read path (not in the book)
    followersAvg: 200,       // fan-out on write: each post lands in 200 home timelines
    timelineLen: 800,        // post ids kept per home timeline in the cache
    postBytes: 64 + 140 + 100, peak: 2, retentionYears: 5, replicas: 3,
    cacheNodeBytes: 25 * GB, // usable memory per cache node (r7g.xlarge-like: 26 GiB, minus reserved)
    cacheFragmentation: 1.2, // allocator overhead on top of MEMORY USAGE; typical mem_fragmentation_ratio
    cacheReplicasPerShard: 1,
    bigPrimaryWritesPerSec: 10_000, // large RDS/Aurora instance, small-row inserts; to confirm with a bench
    clusterMaxBytes: 128 * 2 ** 40, // Aurora cluster volume limit, 128 TiB
    celebrityFollowers: 50e6,
  };
  const dau = a.mau * a.dailyFraction;
  const writeAvg = (dau * a.postsPerUserDay) / SEC_PER_DAY, writePeak = writeAvg * a.peak;
  const readAvg = (dau * a.readsPerUserDay) / SEC_PER_DAY, readPeak = readAvg * a.peak;
  const fanoutPeak = writePeak * a.followersAvg;                        // cache writes/s
  const readApi = fleet(readPeak, UNIT.apiReadMs), writeApi = fleet(writePeak, UNIT.apiWriteMs);
  const fanoutWorkers = fleet(fanoutPeak, UNIT.fanoutWorkerMs);

  // Cache: only active users have a precomputed timeline; inactive ones are rebuilt on read.
  const timelineCache = dau * a.timelineLen * UNIT.redisBytesPerId * a.cacheFragmentation;
  const postCache = dau * a.postsPerUserDay * 2 * UNIT.redisBytesPerPost * a.cacheFragmentation; // ~2 days hot
  const cacheBytes = timelineCache + postCache;
  const byMemory = Math.ceil(cacheBytes / a.cacheNodeBytes);
  // Redis runs commands on one core: a node gives 1 core x 60% of command CPU.
  const cacheCores = (fanoutPeak * UNIT.redisWriteUs + readPeak * UNIT.redisReadUs) / 1e6;
  const byCpu = Math.ceil(cacheCores / TARGET_UTIL);
  const cachePrimaries = Math.max(byMemory, byCpu);
  const cacheNodes = cachePrimaries * (1 + a.cacheReplicasPerShard);

  // Post store: shards needed by write rate (small and large primaries) and by volume over 5 years.
  const textPerDay = dau * a.postsPerUserDay * a.postBytes;
  const logical5y = textPerDay * 365 * a.retentionYears;
  const shardsSmall = Math.ceil(writePeak / (UNIT.pgWritePerPrimary * TARGET_UTIL));
  const shardsBig = Math.ceil(writePeak / (a.bigPrimaryWritesPerSec * TARGET_UTIL));
  const shardsVolume = Math.ceil(logical5y / a.clusterMaxBytes);
  const yearsToFill = a.clusterMaxBytes / (textPerDay * 365);

  const mediaPerDay = dau * a.postsPerUserDay * a.mediaFraction * a.mediaBytes;
  const egress = readAvg * a.mediaFraction * a.mediaBytes;
  const celebritySec = a.celebrityFollowers / fanoutPeak;
  const fanoutOnReadLookups = readPeak * a.followersAvg;
  table("A. Feed / Twitter-like (book assumptions + read path)", [
    header,
    ["DAU", fmt(dau), "[P] 300M MAU x 50%"],
    ["post writes/s (avg / peak)", `${fmt(writeAvg)} / ${fmt(writePeak)}`, "[P] DAU x 2 / 86400; peak 2x"],
    ["timeline reads/s (avg / peak)", `${fmt(readAvg)} / ${fmt(readPeak)}`, "[E] DAU x 100 / 86400"],
    ["fan-out cache writes/s (peak)", fmt(fanoutPeak), "[E] peak writes x 200 followers"],
    ["one celebrity post (50M followers)", `${fmt(celebritySec)} s of all fan-out capacity`, "why the hybrid exists"],
    ["fan-out on read instead", `${fmt(fanoutOnReadLookups)} lookups/s`, "peak reads x 200 followees, on the request path"],
    ["read API", `${fmt(readApi.vcpu)} vCPU = ${readApi.instances} x 4 vCPU`, `[M] ${UNIT.apiReadMs} ms/req at 60%`],
    ["write API", `${fmt(writeApi.vcpu)} vCPU = ${writeApi.instances} x 4 vCPU`, `[M] ${UNIT.apiWriteMs} ms/req at 60%`],
    ["fan-out workers", `${fmt(fanoutWorkers.vcpu)} vCPU = ${fanoutWorkers.instances} x 4 vCPU`, `[M] ${UNIT.fanoutWorkerMs * 1000} µs/write, pipeline 100; excludes follower-list read and queue`],
    ["timeline cache memory", bytes(timelineCache), `[M] DAU x 800 ids x ${UNIT.redisBytesPerId} B x ${a.cacheFragmentation} frag`],
    ["post cache memory", bytes(postCache), `[M] 2 days of posts x ${UNIT.redisBytesPerPost} B x ${a.cacheFragmentation} frag`],
    ["cache primaries by memory / by CPU", `${byMemory} / ${byCpu}`, `${bytes(cacheBytes)} / 25 GB vs ${fmt(cacheCores)} Redis cores / 60%`],
    ["cache nodes incl. replicas", `${cacheNodes}`, `${cachePrimaries} primaries x (1 + ${a.cacheReplicasPerShard} replica)`],
    ["post store shards by writes (small / large primary)", `${shardsSmall} / ${shardsBig}`, `[M] 1k/s on 2 vCPU; [E] 10k/s on a large instance`],
    ["post store shards by volume, 5 years", `${shardsVolume}`, `${bytes(logical5y)} logical / 128 TiB per cluster; one cluster full in ${fmt(yearsToFill)} years`],
    ["post storage, 5 years x 3 replicas", bytes(logical5y * a.replicas), `${bytes(textPerDay)}/day`],
    ["media storage, 5 years", bytes(mediaPerDay * 365 * a.retentionYears), `[R] ${bytes(mediaPerDay)}/day, object store`],
    ["media egress (avg)", bits(egress), "reads x 10% media x 1 MB: CDN, not origin"],
  ]);
}

// ============================================================ B. Collaborative document editor
{
  const a = {
    mau: 10e6, dailyFraction: 0.2, concurrentFraction: 0.1, // concurrent editors at peak = 10% of DAU
    docsOpenedPerUserDay: 20, docsPerUser: 100, docBytes: 50 * KB,
    msgsPerEditorSec: 2,     // client batches keystrokes every ~500 ms
    msgBytes: 200, collaboratorsPerDoc: 1.5, // other people in the same doc receive each op
    snapshotEverySec: 30,    // persist a doc snapshot every 30 s while edited
    opLogDays: 7, peak: 5,   // workday peak vs daily average for doc opens
    wsConnsPerProcess: 25_000,
  };
  const dau = a.mau * a.dailyFraction;
  const editors = dau * a.concurrentFraction;
  const activeDocs = editors / a.collaboratorsPerDoc;
  const msgIn = editors * a.msgsPerEditorSec;
  const msgOut = msgIn * (a.collaboratorsPerDoc - 1 + 1); // ack to sender + broadcast to others
  const ws = fleet(msgIn + msgOut, UNIT.wsMsgMs);
  const wsByConns = Math.ceil(editors / a.wsConnsPerProcess);
  const opensPeak = ((dau * a.docsOpenedPerUserDay) / SEC_PER_DAY) * a.peak;
  const openApi = fleet(opensPeak * 3, UNIT.apiReadMs); // 3 calls per open: metadata, permissions, snapshot URL
  const snapshotsPerSec = activeDocs / a.snapshotEverySec;
  const metaShards = Math.ceil(snapshotsPerSec / (UNIT.pgWritePerPrimary * TARGET_UTIL));
  const opLogPerDay = msgIn * a.msgBytes * SEC_PER_DAY * 0.35; // edit traffic is ~1/3 of the day at peak level
  table("B. Collaborative document editor (lab 01 domain at scale)", [
    header,
    ["DAU / concurrent editors (peak)", `${fmt(dau)} / ${fmt(editors)}`, "10M MAU x 20%; 10% of DAU at once"],
    ["active docs (peak)", fmt(activeDocs), "editors / 1.5 per doc"],
    ["WebSocket msgs/s in / out", `${fmt(msgIn)} / ${fmt(msgOut)}`, "2 msgs/s per editor; ack + broadcast"],
    ["WS gateway by CPU", `${fmt(ws.vcpu)} vCPU = ${ws.instances} x 4 vCPU`, `${UNIT.wsMsgMs * 1000} µs per message`],
    ["WS gateway by connections", `${wsByConns} processes`, `${fmt(a.wsConnsPerProcess)} conns per process`],
    ["WS connection memory", bytes(editors * UNIT.wsConnBytes), "50 KB per connection"],
    ["ingress bandwidth (ops)", bits(msgIn * a.msgBytes), "200 B per message"],
    ["doc opens/s (peak)", fmt(opensPeak), "DAU x 20 / 86400 x 5"],
    ["doc-open API", `${fmt(openApi.vcpu)} vCPU = ${openApi.instances} x 4 vCPU`, "3 calls per open"],
    ["snapshot writes/s", fmt(snapshotsPerSec), "active docs / 30 s"],
    ["metadata DB primaries", `${metaShards}`, "1 row update per snapshot"],
    ["doc storage (snapshots)", bytes(a.mau * a.docsPerUser * a.docBytes), "10M x 100 docs x 50 KB, object store"],
    ["op log per day / retained", `${bytes(opLogPerDay)} / ${bytes(opLogPerDay * a.opLogDays)}`, "append-only log, 7 days, then compacted"],
  ]);
}

// ============================================================ C. B2B backoffice, users far from the region
{
  const a = {
    dau: 20_000, workdayHours: 8, peakOverWorkday: 3,
    screensPerUserDay: 30, callsPerScreen: 8, upstreamPerCall: 2,
    responseBytes: 15 * KB, rttMs: 110, serverMs: 130, edgeRttMs: 30,
  };
  const avg = (a.dau * a.screensPerUserDay * a.callsPerScreen) / (a.workdayHours * 3600);
  const peak = avg * a.peakOverWorkday;
  const bff = fleet(peak, UNIT.bffCallMs / 6 * a.upstreamPerCall); // E6 cost was for 6 upstream calls
  const backend = fleet(peak * a.upstreamPerCall, UNIT.apiReadMs);
  // Latency: one call = round trips x RTT + server. Screen = sequential waves of calls.
  const call = (rts: number, rtt = a.rttMs) => rts * rtt + a.serverMs;
  table("C. B2B backoffice (BFF + microfrontends, users ~110 ms from the region)", [
    header,
    ["API calls/s (workday avg / peak)", `${fmt(avg)} / ${fmt(peak)}`, "20k DAU x 30 screens x 8 calls / 8 h"],
    ["BFF", `${fmt(bff.vcpu)} vCPU = ${bff.instances} x 4 vCPU`, "lab 01 E6 cost per upstream call"],
    ["backend", `${fmt(backend.vcpu)} vCPU = ${backend.instances} x 4 vCPU`, "2 upstream calls per API call"],
    ["egress (peak)", bits(peak * a.responseBytes), "15 KB per response: bandwidth is not the issue"],
    ["call, cold (TCP + TLS + preflight + request)", `${call(4)} ms`, "4 RTT + server"],
    ["call, warm, preflight not cached", `${call(2)} ms`, "2 RTT + server"],
    ["call, warm, same origin via edge", `${call(1)} ms`, "1 RTT + server"],
    ["screen, 4 waves warm with preflight", `${4 * call(2)} ms`, "today-like"],
    ["screen, 2 waves, same origin", `${2 * call(1)} ms`, "after removing waves and preflight"],
    ["call, cold, same origin via edge", `${2 * a.edgeRttMs + a.rttMs + a.serverMs} ms`, "TCP + TLS end at the edge (2 x 30 ms); edge -> origin pool is warm"],
  ]);
  console.log("  Capacity is trivial (a few vCPU). The budget is spent on round trips: the design decision is about latency.");
}

// ============================================================ Cost by order of magnitude
// Same per-user assumptions as A and B, at several scales. At each scale the model picks the cheapest option
// that meets the load, and prints the price of the rejected option next to it. Prices: PRICE above, list, monthly.
function costTable(title: string, items: Item[], mau: number) {
  const total = items.reduce((s, i) => s + i.usd, 0);
  table(title, [
    ["item", "choice", "$/month"],
    ...items.map((i) => [i.name, i.choice, usd(i.usd)]),
    ["total", `${usd(total / mau)} per MAU`, usd(total)],
  ]);
  return total;
}

// ------------------------------------------------------------ A$. Feed
type FeedOpts = { mediaTiering: boolean; archive: boolean; azLocalCache: boolean; timeline: "cheapest" | "write" };
const FEED_LEAN: FeedOpts = { mediaTiering: true, archive: true, azLocalCache: true, timeline: "cheapest" };
const FEED_BOOK: FeedOpts = { mediaTiering: false, archive: false, azLocalCache: false, timeline: "write" };

function feedCost(mau: number, o: FeedOpts): Item[] {
  const dau = mau * 0.5, posts = dau * 2, postBytes = 304;
  const writePeak = (posts / SEC_PER_DAY) * 2;
  const readAvg = (dau * 100) / SEC_PER_DAY, readPeak = readAvg * 2;
  const readBytes = 50 * postBytes; // one timeline read returns 50 posts
  const ec2 = (n: number) => monthly(PRICE.ec2C7gXlargeHour, n);
  const items: Item[] = [];

  const api = fleet(readPeak, UNIT.apiReadMs).instances + fleet(writePeak, UNIT.apiWriteMs).instances;
  items.push({ name: "API (read + write)", choice: `${api} x c7g.xlarge`, usd: ec2(api) });

  // Post store. Archive = posts older than 1 year move to S3 IA (Parquet); worth it only above ~50 TB.
  const textPerYear = posts * 365 * postBytes, text5y = textPerYear * 5;
  const archive = o.archive && text5y > 50 * TB;
  const hotBytes = archive ? textPerYear : text5y;
  const shards = Math.ceil(hotBytes / (50 * TB)); // RDS PG limit 64 TiB per instance, keep a margin
  const primary = pickRds(writePeak / shards / WRITES_PER_PG_VCPU, true);

  // Timeline, option 1: fan-out on read, one PG query per timeline load, served by read replicas.
  const interAz = ((readAvg * readBytes * (2 / 3) * SEC_PER_MONTH) / GB) * PRICE.interAzGb; // 2 of 3 AZs are remote
  const replicas = pickRds((readPeak * PG_TIMELINE_QUERY_MS) / 1000, false);
  const replicaStorage = replicas.count * (hotBytes / GB) * PRICE.rdsGp3GbMonth;
  const onRead = replicas.cost + replicaStorage + interAz;
  // Timeline, option 2: fan-out on write into Redis (sizing from section A, measured unit costs).
  const cacheBytes = (dau * 800 * UNIT.redisBytesPerId + posts * 2 * UNIT.redisBytesPerPost) * 1.2;
  const cacheCores = (writePeak * 200 * UNIT.redisWriteUs + readPeak * UNIT.redisReadUs) / 1e6;
  const cachePrimaries = Math.max(Math.ceil(cacheBytes / (25 * GB)), Math.ceil(cacheCores / TARGET_UTIL));
  const workers = fleet(writePeak * 200, UNIT.fanoutWorkerMs).instances;
  const node = monthly(PRICE.cacheR7gXlargeHour);
  const azLocal = o.azLocalCache && cachePrimaries * node < interAz; // one more replica per shard = a copy in every AZ
  const cacheNodes = cachePrimaries * (azLocal ? 3 : 2);
  const onWrite = cacheNodes * node + ec2(workers) + (azLocal ? 0 : interAz);
  const useWrite = o.timeline === "write" || onWrite < onRead;
  const interAzTb = interAz / PRICE.interAzGb / 1e3;

  if (useWrite) {
    items.push({ name: "timeline", choice: `fan-out on write: ${cacheNodes} x cache.r7g.xlarge + ${workers} workers (on read: ${usd(onRead)})`, usd: cacheNodes * node + ec2(workers) });
    items.push({ name: "cross-AZ, timeline reads", choice: azLocal ? `0: replica in each AZ (instead of ${usd(interAz)})` : `${fmt(interAzTb)} TB/month`, usd: azLocal ? 0 : interAz });
  } else {
    items.push({ name: "timeline", choice: `fan-out on read: ${replicas.label} replica(s) (on write: ${usd(onWrite)})`, usd: replicas.cost + replicaStorage });
    items.push({ name: "cross-AZ, timeline reads", choice: `${fmt(interAzTb)} TB/month`, usd: interAz });
  }
  items.push({ name: "post store", choice: `${shards > 1 ? `${shards} shards x ` : ""}${primary.label}`, usd: shards * primary.cost });
  items.push({ name: "post storage", choice: `${bytes(hotBytes)} x 2 copies (${archive ? "1 year hot" : "5 years"})`, usd: (hotBytes / GB) * 2 * PRICE.rdsGp3GbMonth });
  if (archive) items.push({ name: "post archive", choice: `${bytes(text5y - hotBytes)} in S3 IA`, usd: ((text5y - hotBytes) / GB) * PRICE.s3IaGbMonth });

  // Media at year 5 (worst month). Tiering: last 90 days Standard, up to 1 year IA, older Glacier IR.
  const mediaDay = (posts * 0.1 * MB) / GB; // GB per day
  const media5y = mediaDay * 365 * 5;
  const mediaUsd = o.mediaTiering
    ? mediaDay * (90 * PRICE.s3StandardGbMonth + 275 * PRICE.s3IaGbMonth + 365 * 4 * PRICE.s3GlacierIrGbMonth)
    : media5y * PRICE.s3StandardGbMonth;
  items.push({ name: "media storage, year 5", choice: `${bytes(media5y * GB)}${o.mediaTiering ? ", tiered" : ", all Standard"}`, usd: mediaUsd });
  const egressGb = (readAvg * 0.1 * MB * SEC_PER_MONTH) / GB;
  items.push({ name: "CDN egress", choice: `${bytes(egressGb * GB)}/month, list tiers`, usd: cdnCost(egressGb) });
  return items;
}

{
  const totals: (string | number)[][] = [["MAU", "total $/month", "$ per MAU", "largest item"]];
  for (const mau of [1e6, 10e6, 100e6, 300e6]) {
    const items = feedCost(mau, FEED_LEAN);
    const total = costTable(`A$. Feed at ${fmt(mau)} MAU (cheapest option per item)`, items, mau);
    const top = items.reduce((a, b) => (b.usd > a.usd ? b : a));
    totals.push([fmt(mau), usd(total), usd(total / mau), `${top.name} ${Math.round((top.usd / total) * 100)}%`]);
  }
  const book = costTable("A$. Feed at 300M MAU, design as in section A (no tiering, no archive, 1 cache replica)", feedCost(300e6, FEED_BOOK), 300e6);
  totals.push(["300M, section A design", usd(book), usd(book / 300e6), ""]);
  table("A$. Feed: cost by scale", totals);
}

// ------------------------------------------------------------ B$. Collaborative editor
function editorCost(mau: number): Item[] {
  const dau = mau * 0.2, editors = dau * 0.1, docs = editors / 1.5;
  const msgIn = editors * 2, msgOut = msgIn, msgBytes = 200;
  const avgOverPeak = 0.35; // edit traffic averaged over the month, as in section B
  const ec2 = (n: number) => monthly(PRICE.ec2C7gXlargeHour, n);
  const items: Item[] = [];

  const gw = Math.max(fleet(msgIn + msgOut, UNIT.wsMsgMs).instances, Math.ceil(editors / 25_000), 2);
  items.push({ name: "WS gateway + sessions", choice: `${gw} x c7g.xlarge`, usd: ec2(gw) });
  // LCU is billed per hour on that hour's usage: use the month average, not the peak.
  const lcu = avgOverPeak * Math.max(editors / 3000, ((msgIn + msgOut) * msgBytes * 3600) / GB);
  items.push({ name: "ALB", choice: `${fmt(lcu)} LCU avg (bytes processed: ~$0.008/GB)`, usd: monthly(PRICE.albHour) + monthly(PRICE.albLcuHour, lcu) });

  // Op log: three ways to make each op durable.
  const pgPerOp = pickRds(msgIn / WRITES_PER_PG_VCPU, true);
  const putUsd = (recordsPerSec: number) => ((recordsPerSec * avgOverPeak * SEC_PER_MONTH) / 1e6) * PRICE.kinesisPutPerMillion;
  const shardUsd = (n: number) => monthly(PRICE.kinesisShardHour, n);
  const mbPerSec = (msgIn * msgBytes) / MB;
  const perOpShards = Math.max(Math.ceil(msgIn / 1000), Math.ceil(mbPerSec));
  const kinesisPerOp = shardUsd(perOpShards) + putUsd(msgIn);
  // Each gateway process buffers ops for 100 ms and writes records of up to 25 KB.
  const batchedRecords = Math.max((msgIn * msgBytes) / 25_000, gw * 10);
  const batchedShards = Math.max(1, Math.ceil(mbPerSec), Math.ceil(batchedRecords / 1000));
  const kinesisBatched = shardUsd(batchedShards) + putUsd(batchedRecords);
  items.push({
    name: "op log",
    choice: `Kinesis, batched 100 ms: ${batchedShards} shards (one record per op: ${usd(kinesisPerOp)}; each op in PG: ${pgPerOp.label} = ${usd(pgPerOp.cost)})`,
    usd: kinesisBatched,
  });

  // Snapshots: every 30 s while edited vs every 5 min (the op log already holds every op; the snapshot only compacts it).
  const snap30 = pickRds(docs / 30 / WRITES_PER_PG_VCPU, true), snap300 = pickRds(docs / 300 / WRITES_PER_PG_VCPU, true);
  items.push({ name: "metadata DB", choice: `snapshot every 5 min: ${snap300.label} (every 30 s: ${snap30.label} = ${usd(snap30.cost)})`, usd: snap300.cost });
  const docGb = (mau * 100 * 50 * KB) / GB;
  items.push({ name: "snapshot storage", choice: `${bytes(docGb * GB)}; 80% not opened in 30 days, in IA [E]`, usd: docGb * (0.2 * PRICE.s3StandardGbMonth + 0.8 * PRICE.s3IaGbMonth) });

  const opensPeak = ((dau * 20) / SEC_PER_DAY) * 5;
  const open = fleet(opensPeak * 3, UNIT.apiReadMs).instances;
  items.push({ name: "doc-open API", choice: `${open} x c7g.xlarge`, usd: ec2(open) });
  const crossAzGb = ((msgIn + msgOut) * avgOverPeak * msgBytes * (2 / 3) * SEC_PER_MONTH) / GB;
  items.push({ name: "cross-AZ, gateway <-> session", choice: `${bytes(crossAzGb * GB)}/month`, usd: crossAzGb * PRICE.interAzGb });
  return items;
}

{
  const totals: (string | number)[][] = [["MAU", "total $/month", "$ per MAU", "largest item"]];
  for (const mau of [100e3, 1e6, 10e6, 50e6]) {
    const items = editorCost(mau);
    const total = costTable(`B$. Editor at ${fmt(mau)} MAU`, items, mau);
    const top = items.reduce((a, b) => (b.usd > a.usd ? b : a));
    totals.push([fmt(mau), usd(total), usd(total / mau), `${top.name} ${Math.round((top.usd / total) * 100)}%`]);
  }
  table("B$. Editor: cost by scale", totals);
  console.log("  List prices, on-demand, us-east-1 [R], from memory: verify. Engineering time to run each option is not in the numbers.");
}
