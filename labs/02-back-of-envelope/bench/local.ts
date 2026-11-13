// "Latency numbers every programmer should know", measured on this machine.
// No dependencies: runs on the host (`node bench/local.ts`) and inside a container.
// Output: one JSON line per measurement on stdout, human table on stderr.
//
// Each number is the median of several rounds, after a warm-up round,
// so JIT tier-up and page faults do not leak into the result.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

type Result = { name: string; value: number; unit: string; note?: string };
const results: Result[] = [];
const label = process.env.LABEL ?? `${os.platform()}-${process.arch}`;

function emit(name: string, value: number, unit: string, note?: string) {
  const r = { name, value: Number(value.toPrecision(3)), unit, note };
  results.push(r);
  console.log(JSON.stringify({ label, ...r }));
}

const now = () => process.hrtime.bigint();
const ns = (a: bigint, b: bigint) => Number(b - a);

// Median of `rounds` timings, first call discarded as warm-up.
function median(rounds: number, fn: () => number): number {
  fn();
  const xs = Array.from({ length: rounds }, fn).sort((a, b) => a - b);
  return xs[Math.floor(xs.length / 2)];
}

// --- Memory: pointer chasing ------------------------------------------------
// A random single cycle (Sattolo) defeats the prefetcher: every load depends
// on the previous one, so time per step = latency of the level that holds the set.
function chase(bytes: number): number {
  const n = bytes / 4;
  const next = new Uint32Array(n);
  for (let i = 0; i < n; i++) next[i] = i;
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * i);
    const t = next[i]; next[i] = next[j]; next[j] = t;
  }
  const steps = 20_000_000;
  return median(5, () => {
    let p = 0;
    const t0 = now();
    for (let i = 0; i < steps; i++) p = next[p];
    const t1 = now();
    if (p === -1) console.log(p); // keep the loop alive
    return ns(t0, t1) / steps;
  });
}

for (const [size, tag] of [
  [16 << 10, "16 KB (L1)"],
  [512 << 10, "512 KB (L2)"],
  [6 << 20, "6 MB (L3)"],
  [256 << 20, "256 MB (DRAM)"],
] as const) {
  emit(`memory random read, working set ${tag}`, chase(size), "ns/op");
}

// Sequential read: the prefetcher wins, bandwidth instead of latency.
{
  const a = new Float64Array(32 << 20); // 256 MB
  a.fill(1);
  const t = median(5, () => {
    let s = 0;
    const t0 = now();
    for (let i = 0; i < a.length; i++) s += a[i];
    const t1 = now();
    if (s === -1) console.log(s);
    return ns(t0, t1);
  });
  emit("memory sequential read", a.byteLength / t, "GB/s");
  emit("read 1 MB sequentially from memory", (1 << 20) / (a.byteLength / t) / 1000, "µs");
}

// --- CPU work per MB ---------------------------------------------------------
// Realistic payload: JSON of objects (compressible like API responses).
const rows = Array.from({ length: 6000 }, (_, i) => ({
  id: i, uuid: crypto.randomUUID(), title: `Question ${i} about topic ${i % 37}`,
  tags: ["math", "grade-" + (i % 12)], score: Math.random(), active: i % 3 === 0,
}));
const json = JSON.stringify(rows);
const buf = Buffer.from(json);
const mb = buf.length / (1 << 20);
emit("payload size (6000 rows JSON)", mb, "MB");

const perMb = (fn: () => void) => median(7, () => { const t0 = now(); fn(); return ns(t0, now()); }) / 1e6 / mb;
emit("JSON.parse", perMb(() => JSON.parse(json)), "ms/MB");
emit("JSON.stringify", perMb(() => JSON.stringify(rows)), "ms/MB");
emit("sha256", perMb(() => crypto.createHash("sha256").update(buf).digest()), "ms/MB");

const gz1 = zlib.gzipSync(buf, { level: 1 });
const gz6 = zlib.gzipSync(buf, { level: 6 });
const br4 = zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } });
emit("gzip level 1 compress", perMb(() => zlib.gzipSync(buf, { level: 1 })), "ms/MB", `ratio ${(buf.length / gz1.length).toFixed(1)}x`);
emit("gzip level 6 compress", perMb(() => zlib.gzipSync(buf, { level: 6 })), "ms/MB", `ratio ${(buf.length / gz6.length).toFixed(1)}x`);
emit("brotli q4 compress", perMb(() => zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } })), "ms/MB", `ratio ${(buf.length / br4.length).toFixed(1)}x`);
emit("gzip decompress", perMb(() => zlib.gunzipSync(gz6)), "ms/MB (uncompressed)");
if (typeof (zlib as any).zstdCompressSync === "function") {
  const z = zlib as any;
  const zs = z.zstdCompressSync(buf);
  emit("zstd default compress", perMb(() => z.zstdCompressSync(buf)), "ms/MB", `ratio ${(buf.length / zs.length).toFixed(1)}x`);
}

// JWT-like: HMAC-SHA256 of a small token, and RSA-2048 verify (RS256).
{
  const token = Buffer.from("x".repeat(600));
  const key = crypto.randomBytes(32);
  const n = 50_000;
  const hmac = median(5, () => { const t0 = now(); for (let i = 0; i < n; i++) crypto.createHmac("sha256", key).update(token).digest(); return ns(t0, now()) / n; });
  emit("HMAC-SHA256 of 600 B token (HS256 verify)", hmac / 1000, "µs");
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const sig = crypto.sign("sha256", token, privateKey);
  const m = 5000;
  const rsa = median(5, () => { const t0 = now(); for (let i = 0; i < m; i++) crypto.verify("sha256", token, publicKey, sig); return ns(t0, now()) / m; });
  emit("RSA-2048 verify (RS256 verify)", rsa / 1000, "µs");
}

// --- Disk ----------------------------------------------------------------------
// Data dir from env so the container can point at its own filesystem.
const dir = process.env.BENCH_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), "bench-"));
fs.mkdirSync(dir, { recursive: true });
{
  const file = path.join(dir, "fsync.bin");
  const fd = fs.openSync(file, "w");
  const block = Buffer.alloc(4096, 1);
  const n = 200;
  const t = median(3, () => {
    const t0 = now();
    for (let i = 0; i < n; i++) { fs.writeSync(fd, block); fs.fsyncSync(fd); }
    return ns(t0, now()) / n;
  });
  fs.closeSync(fd);
  emit("write 4 KB + fsync (commit latency)", t / 1000, "µs", "what a DB pays per durable commit");
}
{
  const file = path.join(dir, "seq.bin");
  const size = 512 << 20;
  const chunk = Buffer.alloc(1 << 20, 7);
  const fd = fs.openSync(file, "w");
  const t0 = now();
  for (let i = 0; i < size / chunk.length; i++) fs.writeSync(fd, chunk);
  fs.fsyncSync(fd);
  const tw = ns(t0, now());
  fs.closeSync(fd);
  emit("sequential write 512 MB + fsync", size / tw, "GB/s");
  // Read back: mostly page cache (same as a warm DB). True cold read needs root to drop caches.
  const rfd = fs.openSync(file, "r");
  const tr = median(3, () => {
    const t1 = now();
    for (let off = 0; off < size; off += chunk.length) fs.readSync(rfd, chunk, 0, chunk.length, off);
    return ns(t1, now());
  });
  // Random 4 KB reads over the same file (page cache: memory + syscall cost).
  const small = Buffer.alloc(4096);
  const k = 50_000;
  const trand = median(3, () => {
    const t1 = now();
    for (let i = 0; i < k; i++) fs.readSync(rfd, small, 0, 4096, Math.floor(Math.random() * (size / 4096)) * 4096);
    return ns(t1, now()) / k;
  });
  fs.closeSync(rfd);
  emit("sequential read 1 MB (page cache)", tr / (size >> 20) / 1000, "µs");
  emit("random read 4 KB (page cache, pread syscall)", trand / 1000, "µs");
  fs.rmSync(file);
}
fs.rmSync(path.join(dir, "fsync.bin"), { force: true });

// --- Event loop / scheduling --------------------------------------------------
{
  const n = 100_000;
  const t = await new Promise<number>((resolve) => {
    let i = 0; const t0 = now();
    const tick = () => (++i < n ? setImmediate(tick) : resolve(ns(t0, now()) / n));
    setImmediate(tick);
  });
  emit("setImmediate round trip (event loop turn)", t / 1000, "µs");
}

console.error(`\n${label}: ${os.cpus()[0].model}, ${os.cpus().length} threads, node ${process.version}`);
for (const r of results) console.error(`${r.name.padEnd(48)} ${String(r.value).padStart(10)} ${r.unit}${r.note ? `  (${r.note})` : ""}`);
