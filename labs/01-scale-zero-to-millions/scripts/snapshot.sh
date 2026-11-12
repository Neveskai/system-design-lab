#!/usr/bin/env bash
# Peak resource usage over the last WINDOW (default 2m): who saturated first?
# Usage: WINDOW=2m scripts/snapshot.sh
W=${WINDOW:-2m}
q() { curl -s --get localhost:9090/api/v1/query --data-urlencode "query=$2" |
  python -c "import json,sys
r=json.load(sys.stdin)['data']['result']
for x in sorted(r,key=lambda x:-float(x['value'][1]))[:8]:
  l=x['metric']; n=l.get('name') or l.get('instance') or l.get('state') or ''
  print(f\"  {'$1':38} {n:28} {float(x['value'][1]):.3f}\")"; }
q "cpu cores (peak)"            "max_over_time((sum by (name) (rate(container_cpu_usage_seconds_total{name=~\"lab01-.+\"}[10s])))[$W:2s])"
q "mem MB (peak)"               "max_over_time((sum by (name) (container_memory_working_set_bytes{name=~\"lab01-.+\"}) / 1e6)[$W:2s])"
q "event loop lag p99 s (peak)" "max_over_time(nodejs_eventloop_lag_p99_seconds[$W])"
q "db pool waiting (peak)"      "max_over_time((sum by (instance) (db_pool_waiting))[$W:2s])"
q "pg TPS (peak)"               "max_over_time((sum(rate(pg_stat_database_xact_commit{datname=\"lab\"}[10s])))[$W:2s])"
q "pg blks hit ratio (avg)"     "sum(rate(pg_stat_database_blks_hit{datname=\"lab\"}[$W])) / (sum(rate(pg_stat_database_blks_hit{datname=\"lab\"}[$W])) + sum(rate(pg_stat_database_blks_read{datname=\"lab\"}[$W])))"
q "cache hit ratio (avg)"       "sum(rate(cache_hits_total[$W])) / (sum(rate(cache_hits_total[$W])) + sum(rate(cache_misses_total[$W])))"
q "server p99 s by job (peak)"  "max_over_time((histogram_quantile(0.99, sum by (le,job) (rate(http_request_duration_seconds_bucket[10s]))))[$W:2s])"
