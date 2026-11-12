// One script, many experiments. All knobs are env vars (set by scripts/run.sh):
//   TARGET    base URL (http://api:3000 direct, http://nginx via LB, http://bff:4000)
//   OP        read | mixed | write | render | list | bff
//   MODE      constant (fixed RATE for DURATION) | ramp (0 -> MAX_RATE, find the knee)
//   RATE, MAX_RATE, DURATION, HOT (fraction of traffic on hot docs, 0..1)
//
// Open model (arrival-rate executors): requests arrive at a fixed rate whether or not
// the server keeps up, like real users. A closed model (fixed VUs, wait for response)
// slows itself down when the server slows down and hides latency (coordinated omission).
import http from "k6/http";
import { check } from "k6";

const TARGET = __ENV.TARGET || "http://nginx";
const OP = __ENV.OP || "read";
const MODE = __ENV.MODE || "constant";
const RATE = Number(__ENV.RATE || 500);
const MAX_RATE = Number(__ENV.MAX_RATE || 5000);
const DURATION = __ENV.DURATION || "60s";
const HOT = Number(__ENV.HOT || 0.8);      // 80% of requests...
const HOT_SET = Number(__ENV.HOT_SET || 1000); // ...go to 1% of docs (1000 of 100k)
const DOCS = 100000;
const USERS = 10000;

const scenario =
  MODE === "ramp"
    ? {
        executor: "ramping-arrival-rate",
        startRate: 50,
        timeUnit: "1s",
        preAllocatedVUs: 200,
        maxVUs: 3000,
        stages: [
          { target: MAX_RATE, duration: __ENV.RAMP || "120s" },
          { target: MAX_RATE, duration: "20s" },
        ],
      }
    : {
        executor: "constant-arrival-rate",
        rate: RATE,
        timeUnit: "1s",
        duration: DURATION,
        preAllocatedVUs: Math.min(RATE, 500),
        maxVUs: 3000,
      };

export const options = {
  scenarios: { main: scenario },
  discardResponseBodies: true,
  summaryTrendStats: ["avg", "p(50)", "p(95)", "p(99)", "max"],
  tags: { op: OP, mode: MODE },
};

function docId() {
  if (Math.random() < HOT) return 1 + Math.floor(Math.random() * HOT_SET);
  return 1 + Math.floor(Math.random() * DOCS);
}
const userId = () => 1 + Math.floor(Math.random() * USERS);

const body = JSON.stringify({ body: "edited ".repeat(150) });
const params = { headers: { "content-type": "application/json" }, timeout: "10s" };

const ops = {
  read: () => http.get(`${TARGET}/docs/${docId()}`, { tags: { name: "GET /docs/:id" } }),
  write: () => http.put(`${TARGET}/docs/${docId()}`, body, { ...params, tags: { name: "PUT /docs/:id" } }),
  mixed: () => (Math.random() < 0.9 ? ops.read() : ops.write()),
  list: () => http.get(`${TARGET}/users/${userId()}/docs`, { tags: { name: "GET /users/:id/docs" } }),
  render: () => http.get(`${TARGET}/docs/${docId()}/render`, { tags: { name: "GET /docs/:id/render" } }),
  bff: () => http.get(`${TARGET}/workspace/${userId()}`, { tags: { name: "GET /workspace/:id" } }),
};

export default function () {
  const res = ops[OP]();
  check(res, { "status 2xx": (r) => r.status >= 200 && r.status < 300 });
}

// Compact summary: the numbers that go into NOTES.md.
export function handleSummary(data) {
  const m = data.metrics;
  const d = m.http_req_duration.values;
  const ms = (v) => (v === undefined ? "-" : v.toFixed(1) + "ms");
  const run = __ENV.RUN_NAME || `${OP}-${MODE}`;
  const out = {
    run,
    target: TARGET,
    op: OP,
    mode: MODE,
    rate_requested: MODE === "ramp" ? MAX_RATE : RATE,
    rps_achieved: m.http_reqs.values.rate,
    p50: d["p(50)"], p95: d["p(95)"], p99: d["p(99)"], max: d.max,
    error_rate: m.http_req_failed.values.rate,
    dropped_iterations: m.dropped_iterations ? m.dropped_iterations.values.count : 0,
  };
  const text =
    `\n=== ${run} ===\n` +
    `target=${TARGET} op=${OP} mode=${MODE} requested=${out.rate_requested}/s\n` +
    `achieved=${out.rps_achieved.toFixed(0)}/s  errors=${(out.error_rate * 100).toFixed(2)}%  dropped=${out.dropped_iterations}\n` +
    `latency p50=${ms(out.p50)} p95=${ms(out.p95)} p99=${ms(out.p99)} max=${ms(out.max)}\n` +
    `(dropped > 0 => k6 had no free VU: server too slow for requested rate, i.e. saturated)\n`;
  return { stdout: text, [`/results/${run}.json`]: JSON.stringify(out, null, 2) };
}
