#!/usr/bin/env bash
# Failure under load, to turn availability math into measured error budget.
# Runs lab 01 at a constant rate, injects one failure at T=20s, undoes it at T=40s.
#
# Usage: scripts/chaos.sh <kind> [stage] [rate]
#   kill-api    SIGKILL one API replica (crash: connection refused)        undo: docker start
#   pause-api   freeze one API replica (hang: TCP open, nothing answers)    undo: docker unpause
#   stop-pg     stop the Postgres primary (hard dependency down)            undo: docker start
# Writes results/chaos-<kind>.log (k6 summary).
set -euo pipefail
export MSYS_NO_PATHCONV=1
HERE="$(cd "$(dirname "$0")/.." && pwd)"
KIND=${1:?kind}; STAGE=${2:-lb}; RATE=${3:-1500}
LOG="$HERE/results/chaos-$KIND.log"

case "$KIND" in
  kill-api)  VICTIM=lab01-api-2;      DO="docker kill $VICTIM";  UNDO="docker start $VICTIM" ;;
  pause-api) VICTIM=lab01-api-2;      DO="docker pause $VICTIM"; UNDO="docker unpause $VICTIM" ;;
  stop-pg)   VICTIM=lab01-postgres-1; DO="docker stop -t 1 $VICTIM"; UNDO="docker start $VICTIM" ;;
  *) echo "unknown kind $KIND"; exit 1 ;;
esac

cd "$HERE/../01-scale-zero-to-millions"
(
  sleep 20; echo ">> T+20s $DO"; $DO >/dev/null
  sleep 20; echo ">> T+40s $UNDO"; $UNDO >/dev/null
) &
DURATION=60s RUN_NAME="chaos-$KIND" scripts/run.sh "$STAGE" read constant "$RATE" 2>&1 | grep -v "Container\|Image\|Network\|Volume" | tee "$LOG"
wait
