// Minimal HTTP toolkit shared by every lab service.
// Plain node:http on purpose: no framework overhead hides where time goes.
import http from "node:http";
import client from "prom-client";

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, eventLoopMonitoringPrecision: 10 });

const requests = new client.Counter({
  name: "http_requests_total",
  help: "HTTP requests handled",
  labelNames: ["method", "route", "status"],
  registers: [registry],
});

// Buckets from 1ms to 5s: covers cache hit (~1ms) to saturated DB (seconds).
const duration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "Server-side request duration",
  labelNames: ["method", "route"],
  buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export type Ctx = {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  body: () => Promise<any>;
};
export type Handler = (ctx: Ctx) => Promise<unknown> | unknown;

type Route = { method: string; pattern: RegExp; keys: string[]; name: string; handler: Handler };

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function createApp() {
  const routes: Route[] = [];

  function add(method: string, path: string, handler: Handler) {
    const keys: string[] = [];
    const pattern = new RegExp(
      "^" + path.replace(/:(\w+)/g, (_m, k) => (keys.push(k), "([^/]+)")) + "$",
    );
    routes.push({ method, pattern, keys, name: path, handler });
  }

  function readBody(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        if (chunks.length === 0) return resolve(undefined);
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          reject(new HttpError(400, "invalid json"));
        }
      });
      req.on("error", reject);
    });
  }

  function send(res: http.ServerResponse, status: number, payload: unknown) {
    const body = typeof payload === "string" ? payload : JSON.stringify(payload);
    res.writeHead(status, {
      "content-type": typeof payload === "string" ? "text/plain" : "application/json",
      "content-length": Buffer.byteLength(body),
    });
    res.end(body);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/metrics") {
      res.writeHead(200, { "content-type": registry.contentType });
      return res.end(await registry.metrics());
    }
    if (url.pathname === "/healthz") return send(res, 200, "ok");

    const route = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
    if (!route) return send(res, 404, { error: "not found" });

    const m = route.pattern.exec(url.pathname)!;
    const params: Record<string, string> = {};
    route.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));

    const end = duration.startTimer({ method: req.method, route: route.name });
    let status = 200;
    try {
      const out = await route.handler({ req, res, params, query: url.searchParams, body: () => readBody(req) });
      if (!res.headersSent) send(res, 200, out ?? { ok: true });
    } catch (err: any) {
      status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) console.error(route.name, err?.message ?? err);
      if (!res.headersSent) send(res, status, { error: err?.message ?? "error" });
    } finally {
      end();
      requests.inc({ method: req.method, route: route.name, status: String(status) });
    }
  });

  // Keep-alive longer than the LB's upstream keepalive timeout, so nginx closes first.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  return {
    get: (p: string, h: Handler) => add("GET", p, h),
    put: (p: string, h: Handler) => add("PUT", p, h),
    post: (p: string, h: Handler) => add("POST", p, h),
    listen(port: number, onShutdown?: () => Promise<void>) {
      server.listen(port, () => console.log(`listening on :${port}`));
      const stop = async () => {
        server.close();
        await onShutdown?.();
        process.exit(0);
      };
      process.on("SIGTERM", stop);
      process.on("SIGINT", stop);
    },
  };
}

export { client };
