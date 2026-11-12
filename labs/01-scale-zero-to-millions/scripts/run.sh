#!/usr/bin/env bash
# Usage: scripts/run.sh <stage> <op> [mode] [rate]
#   stage: single | lb | cache | replica   (stages/<stage>.env)
#   op:    read | mixed | write | list | render | bff | ryw
#   mode:  constant (default) | ramp
#   rate:  req/s for constant, max req/s for ramp
# Any extra knob can be passed as env: DURATION=30s HOT=0.5 API_REPLICAS=2 scripts/run.sh lb read
set -euo pipefail
export MSYS_NO_PATHCONV=1   # Git Bash on Windows: do not rewrite /load/... into C:/...
cd "$(dirname "$0")/.."

STAGE=${1:?stage}; OP=${2:?op}; MODE=${3:-constant}; RATE=${4:-500}

# Stage file gives defaults; variables already set in the shell win.
while IFS='=' read -r k v; do
  [[ -z "$k" || "$k" == \#* ]] && continue
  [[ -z "${!k:-}" ]] && export "$k=$v"
done < "stages/$STAGE.env"

[[ "$OP" == "bff" ]] && TARGET=http://bff:4000
export MODE OP TARGET
if [[ "$MODE" == "ramp" ]]; then export MAX_RATE=$RATE; else export RATE; fi
export RUN_NAME="${RUN_NAME:-$(date +%H%M%S)-$STAGE-$OP-$MODE-$RATE}"

echo ">> stage=$STAGE replicas=$API_REPLICAS cache=$CACHE_MODE pool=$PG_POOL_MAX read_from=${READ_FROM:-primary} ryw=${RYW:-none} delay=${REPLICA_DELAY:-0} target=$TARGET"
docker compose up -d --build --scale api="$API_REPLICAS" --wait >/dev/null
sleep 5   # let nginx re-resolve replicas and Prometheus discover them

docker compose run --rm \
  -e TARGET -e OP -e MODE -e RATE -e MAX_RATE -e RUN_NAME \
  -e DURATION -e RAMP -e HOT -e HOT_SET -e RYW_FRAC \
  k6 run --quiet -o experimental-prometheus-rw /load/test.js
