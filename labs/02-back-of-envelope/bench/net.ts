// Network round-trip costs, measured from a client container.
//
// Every target is reached through four "distances":
//   direct  - container to container on the Docker bridge
//   proxy   - through toxiproxy with no delay (isolates the proxy's own cost)
//   az      - +1 ms RTT, roughly two AZs in one AWS region
//   region  - +110 ms RTT, roughly São Paulo client to us-east-1
// Delay is split between the two directions.
//
// Output: one JSON line per measurement (stdout), table on stderr.
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import Redis from "ioredis";
import pg from "pg";

const TOXI = process.env.TOXIPROXY ?? "http://toxiproxy:8474";
const ONLY = process.env.PROFILES?.split(",");
const label = process.env.LABEL ?? "docker";

type Profile = { name: string; rttMs: number; host: (t: Target) => [string, number] };
type Target = { name: string; host: string; port: number; proxyPort: number };

const targets: Target[] = [
  { name: "tcp", host: "server", port: 7000, proxyPort: 17000 },
  { name: "http", host: "server", port: 7001, proxyPort: 17001 },
  { name: "https", host: "server", port: 7002, proxyPort: 17002 },
  { name: "redis", host: "redis", port: 6379, proxyPort: 16379 },
  { name: "pg", host: "postgres", port: 5432, proxyPort: 15432 },
];

// Each delayed profile gets its own port range: proxyPort + offset.
const profiles: Profile[] = [
  { name: "direct", rttMs: 0, host: (t) => [t.host, t.port] },
  { name: "proxy", rttMs: 0, host: (t) => ["toxiproxy", t.proxyPort] },
  { name: "az", rttMs: 1, host: (t) => ["toxiproxy", t.proxyPort + 1000] },
  { name: "region", rttMs: 110, host: (t) => ["toxiproxy", t.proxyPort + 2000] },
].filter((p) => !ONLY || ONLY.includes(p.name));

async function toxi(method: string, path: string, body?: unknown) {
  const r = await fetch(TOXI + path, { method, body: body ? JSON.stringify(body) : undefined, headers: { "content-type": "application/json" } });
  if (!r.ok && r.status !== 404 && r.status !== 409) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`);
}

async function setupProxies() {
  for (const p of profiles.filter((p) => p.name !== "direct")) {
    for (const t of targets) {
      const name = `${t.name}-${p.name}`;
      const [, port] = p.host(t);
      await toxi("DELETE", `/proxies/${name}`);
      await toxi("POST", "/proxies", { name, listen: `0.0.0.0:${port}`, upstream: `${t.host}:${t.port}`, enabled: true });
      if (p.rttMs > 0) {
        // Toxiproxy takes whole milliseconds: split the RTT, odd remainder goes downstream.
        const up = Math.floor(p.rttMs / 2);
        for (const [stream, latency] of [["upstream", up], ["downstream", p.rttMs - up]] as const) {
          if (latency === 0) continue;
          await toxi("POST", `/proxies/${name}/toxics`, {
            name: `lat-${stream}`, type: "latency", stream, attributes: { latency, jitter: 0 },
          });
        }
      }
    }
  }
}

const now = () => process.hrtime.bigint();
const pct = (xs: number[], q: number) => xs[Math.min(xs.length - 1, Math.floor(q * xs.length))];

type Row = { profile: string; name: string; p50: number; p99: number; n: number };
const rows: Row[] = [];

// Run `fn` n times sequentially, report p50/p99 in ms.
async function measure(profile: Profile, name: string, fn: () => Promise<unknown>) {
  const n = profile.rttMs >= 100 ? 15 : profile.rttMs >= 1 ? 200 : 1000;
  for (let i = 0; i < Math.min(20, n); i++) await fn(); // warm-up
  const xs: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = now();
    await fn();
    xs.push(Number(now() - t0) / 1e6);
  }
  xs.sort((a, b) => a - b);
  const row = { profile: profile.name, name, p50: +pct(xs, 0.5).toPrecision(3), p99: +pct(xs, 0.99).toPrecision(3), n };
  rows.push(row);
  console.log(JSON.stringify({ label, ...row }));
}

const tcpConnect = (host: string, port: number) =>
  new Promise<net.Socket>((res, rej) => { const s = net.connect({ host, port, noDelay: true }, () => res(s)); s.once("error", rej); });

const tlsConnect = (host: string, port: number, session?: Buffer) =>
  new Promise<tls.TLSSocket>((res, rej) => {
    const s = tls.connect({ host, port, rejectUnauthorized: false, servername: "server", session }, () => res(s));
    s.once("error", rej);
  });

function echo(s: net.Socket) {
  return new Promise<void>((res) => { s.once("data", () => res()); s.write("x"); });
}

function httpGet(mod: typeof http | typeof https, host: string, port: number, agent: http.Agent | false) {
  return new Promise<void>((res, rej) => {
    const r = mod.get({ host, port, path: "/", agent, rejectUnauthorized: false } as any, (resp) => { resp.resume(); resp.on("end", res); });
    r.once("error", rej);
  });
}

async function runProfile(p: Profile) {
  const at = (name: string) => p.host(targets.find((t) => t.name === name)!);

  // TCP: handshake only, then one small round trip on an open socket.
  {
    const [h, port] = at("tcp");
    await measure(p, "TCP connect (SYN, SYN-ACK)", async () => (await tcpConnect(h, port)).destroy());
    const s = await tcpConnect(h, port);
    await measure(p, "TCP 1-byte round trip, open socket", () => echo(s));
    s.destroy();
  }
  // HTTP over plain TCP: new connection vs keep-alive.
  {
    const [h, port] = at("http");
    await measure(p, "HTTP GET, new connection", () => httpGet(http, h, port, false));
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    await measure(p, "HTTP GET, keep-alive", () => httpGet(http, h, port, agent));
    agent.destroy();
  }
  // TLS 1.3: full handshake, resumed handshake, and keep-alive request.
  {
    const [h, port] = at("https");
    await measure(p, "TLS 1.3 connect (TCP + full handshake)", async () => (await tlsConnect(h, port)).destroy());
    let session: Buffer | undefined;
    const first = await tlsConnect(h, port);
    first.once("session", (s) => (session = s));
    await new Promise<void>((r) => first.write("GET / HTTP/1.1\r\nHost: server\r\n\r\n", () => first.once("data", () => r())));
    first.destroy();
    await measure(p, "TLS 1.3 connect, session resumed", async () => (await tlsConnect(h, port, session)).destroy());
    await measure(p, "HTTPS GET, new connection", () => httpGet(https, h, port, false));
    const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });
    await measure(p, "HTTPS GET, keep-alive", () => httpGet(https, h, port, agent));
    agent.destroy();
  }
  // Redis: one command, then 10 keys three ways (serial, MGET, pipeline).
  {
    const [h, port] = at("redis");
    const r = new Redis({ host: h, port, lazyConnect: true, enableOfflineQueue: false });
    await r.connect();
    const keys = Array.from({ length: 10 }, (_, i) => `k${i}`);
    await r.mset(Object.fromEntries(keys.map((k) => [k, "v".repeat(100)])));
    await measure(p, "Redis GET", () => r.get("k0"));
    await measure(p, "Redis 10 GETs, sequential", async () => { for (const k of keys) await r.get(k); });
    await measure(p, "Redis 10 keys, MGET", () => r.mget(keys));
    await measure(p, "Redis 10 GETs, pipelined", () => { const pl = r.pipeline(); for (const k of keys) pl.get(k); return pl.exec(); });
    r.disconnect();
  }
  // Postgres: connection setup (TCP + startup + SCRAM auth), query on open connection, durable commit.
  {
    const [h, port] = at("pg");
    const cfg = { host: h, port, user: "lab", password: "lab", database: "lab" };
    await measure(p, "PG new connection (TCP + SCRAM auth)", async () => { const c = new pg.Client(cfg); await c.connect(); await c.end(); });
    const c = new pg.Client(cfg);
    await c.connect();
    await c.query("CREATE TABLE IF NOT EXISTS bench (id bigserial primary key, v text)");
    await c.query("INSERT INTO bench (v) SELECT md5(g::text) FROM generate_series(1, 10000) g ON CONFLICT DO NOTHING");
    await measure(p, "PG SELECT 1", () => c.query("SELECT 1"));
    await measure(p, "PG SELECT by primary key", () => c.query("SELECT v FROM bench WHERE id = $1", [1 + Math.floor(Math.random() * 10000)]));
    await measure(p, "PG INSERT + commit (fsync)", () => c.query("INSERT INTO bench (v) VALUES ('x')"));
    const ids = Array.from({ length: 10 }, (_, i) => i + 1);
    await measure(p, "PG 10 rows, 10 queries (N+1)", async () => { for (const id of ids) await c.query("SELECT v FROM bench WHERE id = $1", [id]); });
    await measure(p, "PG 10 rows, 1 query (= ANY)", () => c.query("SELECT v FROM bench WHERE id = ANY($1)", [ids]));
    await c.end();
  }
}

await setupProxies();
for (const p of profiles) {
  console.error(`-- profile ${p.name} (+${p.rttMs} ms RTT)`);
  await runProfile(p);
}

console.error(`\n${"measurement".padEnd(42)}` + profiles.map((p) => p.name.padStart(16)).join(""));
for (const name of [...new Set(rows.map((r) => r.name))]) {
  const cells = profiles.map((p) => {
    const r = rows.find((x) => x.name === name && x.profile === p.name);
    return (r ? `${r.p50}/${r.p99}` : "-").padStart(16);
  });
  console.error(name.padEnd(42) + cells.join(""));
}
console.error("(cells: p50/p99 ms)");
