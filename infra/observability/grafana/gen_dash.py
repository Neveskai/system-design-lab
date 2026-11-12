# Generates dashboards/lab-overview.json. Usage: python gen_dash.py dashboards/lab-overview.json
import json,sys
P=[
 ("Client view (k6): RPS","sum(irate(k6_http_reqs_total[5s]))","reqps"),
 ("Client view (k6): latency p50/p95/p99",["max(k6_http_req_duration_p50)","max(k6_http_req_duration_p95)","max(k6_http_req_duration_p99)"],"s"),
 ("Server RPS by job/route","sum by (job,route) (rate(http_requests_total[10s]))","reqps"),
 ("Server latency p99 by job/route","histogram_quantile(0.99, sum by (le,job,route) (rate(http_request_duration_seconds_bucket[10s])))","s"),
 ("Server 5xx rate","sum by (job) (rate(http_requests_total{status=~\"5..\"}[10s]))","reqps"),
 ("Node event loop lag p99 (per replica)","nodejs_eventloop_lag_p99_seconds","s"),
 ("Container CPU (cores)","sum by (name) (rate(container_cpu_usage_seconds_total{name=~\".+\"}[10s]))","none"),
 ("Container memory working set","sum by (name) (container_memory_working_set_bytes{name=~\".+\"})","bytes"),
 ("DB pool: waiting clients (queue before PG)","sum by (instance,pool) (db_pool_waiting)","none"),
 ("DB pool: in use","sum by (instance,pool) (db_pool_total - db_pool_idle)","none"),
 ("Cache hit ratio","sum(rate(cache_hits_total[10s])) / (sum(rate(cache_hits_total[10s])) + sum(rate(cache_misses_total[10s])))","percentunit"),
 ("Postgres TPS (primary / replica)","sum by (instance) (rate(pg_stat_database_xact_commit{datname=\"lab\"}[10s]))","ops"),
 ("Postgres connections by state","sum by (state) (pg_stat_activity_count{datname=\"lab\"})","none"),
 ("Redis ops/s","rate(redis_commands_processed_total[10s])","ops"),
 ("Nginx active connections","nginx_connections_active","none"),
 ("Replication lag (replica, seconds)","pg_replication_lag_seconds{instance=\"postgres-replica-exporter:9187\"}","s"),
 ("Replication lag (WAL bytes held by slot)","pg_replication_slots_pg_wal_lsn_diff","bytes"),
 ("Doc reads by pool / reason","sum by (pool,reason) (rate(db_reads_total[10s]))","ops"),
 ("Client view (k6): stale reads after write","max(k6_stale_reads_rate)","percentunit"),
 ("Container network TX","sum by (name) (rate(container_network_transmit_bytes_total{name=~\".+\"}[10s]))","Bps"),
]
panels=[]
for i,(t,q,u) in enumerate(P):
  qs=q if isinstance(q,list) else [q]
  panels.append({"id":i+1,"type":"timeseries","title":t,"datasource":{"type":"prometheus","uid":"prom"},
   "gridPos":{"h":8,"w":12,"x":(i%2)*12,"y":(i//2)*8},
   "fieldConfig":{"defaults":{"unit":u},"overrides":[]},
   "options":{"legend":{"displayMode":"list","placement":"bottom"},"tooltip":{"mode":"multi"}},
   "targets":[{"refId":chr(65+j),"expr":e,"legendFormat":"__auto"} for j,e in enumerate(qs)]})
d={"uid":"lab-overview","title":"Lab overview (RED + USE)","schemaVersion":39,"refresh":"5s",
   "time":{"from":"now-15m","to":"now"},"panels":panels}
json.dump(d,open(sys.argv[1],"w"),indent=1)
