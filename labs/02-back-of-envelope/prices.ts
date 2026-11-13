// Cloud prices and cost helpers shared by systems.ts (chapter 2 cases) and stages.ts (chapter 1 stages).
// AWS list prices, us-east-1, on-demand [R]. Checked on 2026-11-13 against third-party price trackers
// (Vantage, DoiT, Sparecores, Bytebase, pricing blogs): all values below match. Not checked on aws.amazon.com itself.
// Free tiers (100 GB egress, 1 TB CloudFront, 1M SQS requests per month) are ignored.
// Savings plans / reserved instances cut ~30-50%; CDN and egress contracts at PB scale cut more.

export const HOURS_PER_MONTH = 730, SEC_PER_MONTH = HOURS_PER_MONTH * 3600;
export const PRICE = {
  ec2C7gXlargeHour: 0.145,    // EC2 c7g.xlarge, 4 vCPU, 8 GiB (c7g is linear: $0.03625 per vCPU-hour)
  cacheR7gLargeHour: 0.219,   // ElastiCache cache.r7g.large, 13 GiB, Redis OSS (Valkey is ~20% cheaper)
  cacheR7gXlargeHour: 0.437,  // ElastiCache cache.r7g.xlarge, 26 GiB
  rdsGp3GbMonth: 0.115,       // RDS gp3, per copy (Multi-AZ standby and each read replica hold a full copy)
  s3StandardGbMonth: 0.021,   // S3 Standard, tier above 500 TB (0.023 for the first 50 TB)
  s3IaGbMonth: 0.0125,        // S3 Standard-IA
  s3GlacierIrGbMonth: 0.004,  // S3 Glacier Instant Retrieval (retrieval fee $0.03/GB not included)
  s3GetPerThousand: 0.0004,   // S3 GET requests
  interAzGb: 0.02,            // $0.01 out + $0.01 in, EC2 <-> EC2/ElastiCache/RDS in another AZ
  kinesisShardHour: 0.015,    // Kinesis Data Streams provisioned: 1 MB/s or 1000 records/s in per shard
  kinesisPutPerMillion: 0.014,// per million PUT payload units of 25 KB
  sqsPerMillion: 0.4,         // SQS standard, per million requests (send, receive and delete are 3 requests)
  albHour: 0.0225, albLcuHour: 0.008, // LCU = max of: 25 new conn/s, 3000 active conn, 1 GB/h processed, 1000 rule evals/s
};
// RDS for PostgreSQL, Graviton r7g, single-AZ $/h. Multi-AZ (primary + standby) = 2x. Price per vCPU is flat across sizes.
export const RDS_PG = [
  { cls: "db.r7g.large", vcpu: 2, hour: 0.24 },
  { cls: "db.r7g.xlarge", vcpu: 4, hour: 0.48 },
  { cls: "db.r7g.2xlarge", vcpu: 8, hour: 0.96 },
  { cls: "db.r7g.4xlarge", vcpu: 16, hour: 1.92 },
  { cls: "db.r7g.8xlarge", vcpu: 32, hour: 3.84 },
  { cls: "db.r7g.16xlarge", vcpu: 64, hour: 7.68 },
];
// $/GB by monthly volume tier: [GB in the tier, price].
const CDN_TIERS: [number, number][] = [[10e3, 0.085], [40e3, 0.08], [100e3, 0.06], [350e3, 0.04], [524e3, 0.03], [4e6, 0.025], [Infinity, 0.02]]; // CloudFront, North America
const EGRESS_TIERS: [number, number][] = [[10e3, 0.09], [40e3, 0.085], [100e3, 0.07], [Infinity, 0.05]]; // EC2/S3 to internet
// Workload-dependent DB cost that is NOT measured yet [E]: lab 02 got 1.1k writes/s on 2 vCPU
// (UPDATE by PK, hot rows, pool 10, fsync per commit). Batched inserts: higher; more indexes or UUIDv4 keys: lower.
export const WRITES_PER_PG_VCPU = 500;

const fmt = (n: number, digits = 2) => Number(n.toPrecision(digits)).toLocaleString("en-US");
export const monthly = (hourly: number, count = 1) => hourly * HOURS_PER_MONTH * count;
export const usd = (n: number) => (n >= 1e6 ? `$${fmt(n / 1e6)}M` : n >= 1e3 ? `$${fmt(n / 1e3)}k` : `$${fmt(n)}`);
function tiered(gb: number, tiers: [number, number][]) {
  let left = gb, total = 0;
  for (const [size, price] of tiers) {
    const x = Math.min(left, size);
    total += x * price;
    left -= x;
    if (left <= 0) break;
  }
  return total;
}
export const cdnCost = (gb: number) => tiered(gb, CDN_TIERS);
export const egressCost = (gb: number) => tiered(gb, EGRESS_TIERS);
// EC2 instances of 4 vCPU for `vcpu` of work at `util`, at least `min` (one per AZ).
export function ec2Fleet(vcpu: number, min = 2, util = 0.6) {
  const count = Math.max(min, Math.ceil(vcpu / util / 4));
  return { count, cost: monthly(PRICE.ec2C7gXlargeHour, count) };
}
// Smallest RDS class that serves `vcpu` of work at `util`; above the largest class, N x the largest.
export function pickRds(vcpu: number, multiAz: boolean, util = 0.6) {
  const need = vcpu / util;
  const fit = RDS_PG.find((r) => r.vcpu >= need);
  const r = fit ?? RDS_PG[RDS_PG.length - 1];
  const count = fit ? 1 : Math.ceil(need / r.vcpu);
  return { label: `${count > 1 ? `${count} x ` : ""}${r.cls}${multiAz ? " Multi-AZ" : ""}`, count, fits: !!fit, cost: monthly(r.hour, count) * (multiAz ? 2 : 1) };
}
export type Item = { name: string; choice: string; usd: number };
