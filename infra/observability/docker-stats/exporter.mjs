// Tiny per-container metrics exporter: reads the Docker Engine API over the unix socket.
// Replaces cAdvisor, which cannot map containers on Docker Desktop with the containerd
// image store. Exposes cAdvisor-compatible metric names so dashboards stay the same.
import http from "node:http";

const SOCK = "/var/run/docker.sock";
const PROJECT = process.env.PROJECT_FILTER ?? ""; // e.g. "lab01" -> only that compose project

function dockerGet(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ socketPath: SOCK, path }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.setTimeout(3000, () => req.destroy(new Error("timeout")));
  });
}

let snapshot = "";

async function collect() {
  const list = await dockerGet("/containers/json");
  const lines = [
    "# TYPE container_cpu_usage_seconds_total counter",
    "# TYPE container_memory_working_set_bytes gauge",
    "# TYPE container_network_receive_bytes_total counter",
    "# TYPE container_network_transmit_bytes_total counter",
    "# TYPE container_spec_cpu_quota_cores gauge",
  ];
  await Promise.all(
    list.map(async (c) => {
      const name = c.Names[0].replace(/^\//, "");
      if (PROJECT && c.Labels["com.docker.compose.project"] !== PROJECT) return;
      // one-shot=true returns immediately (no 1s wait for a second CPU sample).
      const s = await dockerGet(`/containers/${c.Id}/stats?stream=false&one-shot=true`).catch(() => null);
      if (!s?.cpu_stats) return;
      const service = c.Labels["com.docker.compose.service"] ?? name;
      const l = `{name="${name}",service="${service}"}`;
      const cpu = s.cpu_stats.cpu_usage.total_usage / 1e9;
      const mem = (s.memory_stats.usage ?? 0) - (s.memory_stats.stats?.inactive_file ?? 0);
      let rx = 0, tx = 0;
      for (const n of Object.values(s.networks ?? {})) { rx += n.rx_bytes; tx += n.tx_bytes; }
      lines.push(`container_cpu_usage_seconds_total${l} ${cpu}`);
      lines.push(`container_memory_working_set_bytes${l} ${mem}`);
      lines.push(`container_network_receive_bytes_total${l} ${rx}`);
      lines.push(`container_network_transmit_bytes_total${l} ${tx}`);
      const inspect = await dockerGet(`/containers/${c.Id}/json`).catch(() => null);
      const nano = inspect?.HostConfig?.NanoCpus;
      if (nano) lines.push(`container_spec_cpu_quota_cores${l} ${nano / 1e9}`);
    }),
  );
  snapshot = lines.join("\n") + "\n";
}

setInterval(() => collect().catch((e) => console.error(e.message)), 2000);
collect().catch((e) => console.error(e.message));

http
  .createServer((req, res) => {
    if (req.url !== "/metrics") return res.writeHead(404).end();
    res.writeHead(200, { "content-type": "text/plain; version=0.0.4" }).end(snapshot);
  })
  .listen(8080, () => console.log("docker-stats exporter on :8080"));
