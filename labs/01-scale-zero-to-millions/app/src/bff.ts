// BFF (backend for frontend): one call from the editor's "workspace" screen
// becomes 1 + N calls to the API. This is where frontend latency is born.
//
// FANOUT=serial    -> latency = sum of all calls        (waterfall, like nested awaits in a component)
// FANOUT=parallel  -> latency = slowest call            (Promise.all)
// Tail amplification: with N parallel calls, P(any call slower than its p99) = 1 - 0.99^N.
// N=5 -> ~5% of BFF requests see an API p99. N=20 -> ~18%.
import { createApp, HttpError } from "../../../../shared/ts/http.ts";

const API = process.env.API_URL ?? "http://nginx";
const FANOUT = process.env.FANOUT ?? "parallel";
const PREVIEWS = Number(process.env.PREVIEWS ?? 5);
const TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS ?? 2_000);

const app = createApp();

async function call(path: string) {
  // Timeout per upstream call: without it, one slow dependency holds sockets and memory forever.
  const r = await fetch(API + path, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) throw new HttpError(502, `upstream ${path} -> ${r.status}`);
  return r.json();
}

app.get("/workspace/:userId", async ({ params }) => {
  const docs: any[] = await call(`/users/${params.userId}/docs?limit=20`);
  const ids = docs.slice(0, PREVIEWS).map((d) => d.id);

  let previews: any[];
  if (FANOUT === "serial") {
    previews = [];
    for (const id of ids) previews.push(await call(`/docs/${id}`));
  } else {
    previews = await Promise.all(ids.map((id) => call(`/docs/${id}`)));
  }

  // Shape the payload for the screen: the client gets only what it renders.
  return {
    docs,
    previews: previews.map((p) => ({ id: p.id, title: p.title, excerpt: p.body.slice(0, 200) })),
  };
});

app.listen(Number(process.env.PORT ?? 4000));
