import { createHash } from "node:crypto";

// Stand-in for server-side render / export / diff: pure CPU, blocks the event loop.
// Shared by the sync route (API) and the async worker, so both pay the same cost.
export function render(body: string, iterations: number) {
  let h = body;
  for (let i = 0; i < iterations; i++) h = createHash("sha256").update(h).digest("hex") + body;
  return h.slice(0, 64);
}
