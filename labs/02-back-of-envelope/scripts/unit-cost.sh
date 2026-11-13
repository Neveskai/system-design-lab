#!/usr/bin/env bash
# Unit cost: CPU-milliseconds that each container spends per request, at LOW load.
# Low load = no queueing, so CPU per request is the "pure" work (the number an
# estimate should start from). The estimator then extrapolates to the ceiling.
#
# Usage: scripts/unit-cost.sh <lab01-stage> [rate] [op]
#   scripts/unit-cost.sh lb 1000 read
# Writes results/unit-cost-<stage>-<op>-<rate>.json
set -euo pipefail
export MSYS_NO_PATHCONV=1
HERE="$(cd "$(dirname "$0")/.." && pwd -W 2>/dev/null || pwd)"
STAGE=${1:?stage}; RATE=${2:-1000}; OP=${3:-read}
OUT="$HERE/results/unit-cost-$STAGE-$OP-$RATE.json"

(cd "$HERE/../01-scale-zero-to-millions" && DURATION=${DURATION:-60s} RUN_NAME="unit-$STAGE-$OP-$RATE" scripts/run.sh "$STAGE" "$OP" constant "$RATE" > "$HERE/results/unit-cost-$STAGE-$OP-$RATE.log" 2>&1)

# Average over the steady part of the run (skip the first seconds).
W=${WINDOW:-40s}
q() { curl -s --get localhost:9090/api/v1/query --data-urlencode "query=$1"; }
python - "$OUT" "$STAGE" "$OP" "$RATE" \
  "$(q "sum(rate(http_requests_total{job=\"api\"}[$W]))")" \
  "$(q "sum by (name) (rate(container_cpu_usage_seconds_total{name=~\"lab01-.+\"}[$W]))")" \
  "$(q "sum(rate(cache_hits_total[$W])) / (sum(rate(cache_hits_total[$W])) + sum(rate(cache_misses_total[$W])))")" \
  "$(q "sum(rate(pg_stat_database_xact_commit{datname=\"lab\"}[$W]))")" <<'EOF'
import json, re, sys
out, stage, op, rate, rps, cpu, hit, tps = sys.argv[1:]
val = lambda s: [float(x["value"][1]) for x in json.loads(s)["data"]["result"]]
rps = val(rps)[0]
hit = (val(hit) or [None])[0]
hit = None if hit is None or hit != hit else round(hit, 3)  # NaN when the stage has no cache
tps = val(tps)[0]
by_role = {}
for x in json.loads(cpu)["data"]["result"]:
    name = x["metric"]["name"]
    role = re.sub(r"^lab01-|-\d+$|-run-\w+$", "", name)
    by_role[role] = by_role.get(role, 0) + float(x["value"][1])
res = {
    "stage": stage, "op": op, "rate": float(rate), "api_rps": round(rps, 1),
    "pg_tps": round(tps, 1), "cache_hit": hit,
    "cpu_cores": {k: round(v, 3) for k, v in sorted(by_role.items(), key=lambda kv: -kv[1])},
    "cpu_ms_per_request": {k: round(v / rps * 1000, 4) for k, v in by_role.items() if v > 0.005},
}
json.dump(res, open(out, "w"), indent=2)
print(json.dumps(res, indent=2))
EOF
