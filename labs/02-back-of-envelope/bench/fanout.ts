// Fan-out on write cost: one post id pushed into N home timelines (LPUSH + LTRIM to 800).
// Measures, per timeline write:
//   - worker CPU (this Node process, process.cpuUsage)
//   - Redis CPU (INFO cpu delta) and Redis throughput on 1 core
// for different pipeline batch sizes. Feeds UNIT.fanoutWriteMs and the cache-node ops limit in systems.ts.
// Run: docker compose run --rm bench node fanout.ts
import Redis from "ioredis";

const redis = new Redis({ host: process.env.REDIS_HOST ?? "redis", port: 6379 });
const FOLLOWER_KEYS = 1_000_000; // distinct home timelines written
const SECONDS = Number(process.env.SECONDS ?? 5);
const IN_FLIGHT = 4; // pipelines in flight at once (one worker with some concurrency)

async function redisCpuSec() {
  const info = await redis.info("cpu");
  const get = (k: string) => Number(info.match(new RegExp(`${k}:([\\d.]+)`))![1]);
  return get("used_cpu_user") + get("used_cpu_sys");
}

async function run(batch: number) {
  let next = 0, writes = 0, postId = 1;
  const deadline = performance.now() + SECONDS * 1000;
  const redis0 = await redisCpuSec();
  const cpu0 = process.cpuUsage();
  const t0 = performance.now();
  async function lane() {
    while (performance.now() < deadline) {
      const p = redis.pipeline();
      for (let i = 0; i < batch; i++) {
        const key = `tl:${next++ % FOLLOWER_KEYS}`;
        p.lpush(key, postId).ltrim(key, 0, 799);
      }
      postId++;
      await p.exec();
      writes += batch;
    }
  }
  await Promise.all(Array.from({ length: IN_FLIGHT }, lane));
  const wallSec = (performance.now() - t0) / 1000;
  const cpu = process.cpuUsage(cpu0);
  const redisSec = (await redisCpuSec()) - redis0;
  return {
    name: "fanout LPUSH+LTRIM", batch, writes,
    writes_per_sec: Math.round(writes / wallSec),
    worker_us_per_write: +(((cpu.user + cpu.system) / writes)).toFixed(2),
    redis_us_per_write: +((redisSec * 1e6) / writes).toFixed(2),
    redis_cores: +(redisSec / wallSec).toFixed(2),
  };
}

await redis.flushall();
for (const batch of [1, 10, 100, 1000]) {
  const r = await run(batch);
  console.log(JSON.stringify(r));
  console.error(`batch ${String(batch).padStart(4)}  ${String(r.writes_per_sec).padStart(8)} writes/s  worker ${r.worker_us_per_write} µs/write  redis ${r.redis_us_per_write} µs/write  redis ${r.redis_cores} cores`);
}

// Read path on the same data: one timeline read = LRANGE 50 ids + MGET 50 posts of 304 B.
{
  const POSTS = 100_000, body = "x".repeat(304);
  for (let i = 0; i < POSTS; i += 1000) {
    const p = redis.pipeline();
    for (let j = i; j < i + 1000; j++) p.set(`post:${j}`, body);
    await p.exec();
  }
  let reads = 0, n = 0;
  const deadline = performance.now() + SECONDS * 1000;
  const redis0 = await redisCpuSec(), cpu0 = process.cpuUsage(), t0 = performance.now();
  async function lane() {
    while (performance.now() < deadline) {
      const p = redis.pipeline();
      for (let i = 0; i < 10; i++) {
        p.lrange(`tl:${n++ % FOLLOWER_KEYS}`, 0, 49);
        const base = (n * 50) % (POSTS - 50);
        p.mget(...Array.from({ length: 50 }, (_, k) => `post:${base + k}`));
      }
      await p.exec();
      reads += 10;
    }
  }
  await Promise.all(Array.from({ length: IN_FLIGHT }, lane));
  const wallSec = (performance.now() - t0) / 1000, cpu = process.cpuUsage(cpu0), redisSec = (await redisCpuSec()) - redis0;
  const r = {
    name: "timeline read LRANGE 50 + MGET 50", batch: 10, reads,
    reads_per_sec: Math.round(reads / wallSec),
    worker_us_per_read: +((cpu.user + cpu.system) / reads).toFixed(2),
    redis_us_per_read: +((redisSec * 1e6) / reads).toFixed(2),
    redis_cores: +(redisSec / wallSec).toFixed(2),
  };
  console.log(JSON.stringify(r));
  console.error(`read     ${String(r.reads_per_sec).padStart(8)} reads/s   client ${r.worker_us_per_read} µs/read   redis ${r.redis_us_per_read} µs/read   redis ${r.redis_cores} cores`);
}
const mem = await redis.info("memory");
console.error(`redis used_memory_human: ${mem.match(/used_memory_human:(\S+)/)![1]}`);
await redis.flushall();
redis.disconnect();
