# Local ↔ AWS

| componente local | AWS | o que muda de verdade |
|---|---|---|
| container com `cpus`/`mem_limit` | EC2 / ECS Fargate task | família t* tem burst credits; rede e EBS têm limite por tamanho de instância |
| `docker compose --scale` | Auto Scaling Group / ECS desired count | scale-out leva minutos; health checks e warm-up |
| nginx (LB) | ALB (L7) / NLB (L4) | ALB escala sozinho, cobra por LCU; NLB tem latência menor e preserva IP |
| nginx cache estático | CloudFront | edge perto do usuário; invalidação custa e demora; versionar URLs |
| Postgres | RDS / Aurora | Aurora separa storage (6 cópias em 3 AZs) de compute; réplicas com lag de ms |
| réplica de leitura | RDS read replica / Aurora reader endpoint | reader endpoint faz o balanceamento por DNS |
| Redis | ElastiCache (Valkey/Redis) / MemoryDB | ElastiCache = cache (pode perder dado); MemoryDB = durável |
| MinIO | S3 | latência de primeiro byte 10–100 ms; throughput escala por prefixo |
| Redis Streams / RabbitMQ | SQS / Kinesis / MSK | SQS = fila sem ordem global (FIFO tem limite); Kinesis/MSK = log particionado |
| Docker DNS | Route 53 / Cloud Map | TTL e health checks controlam failover |
| toxiproxy | latência real entre AZs/regiões | mesma AZ ~0.1–0.3 ms; entre AZs ~0.5–2 ms; entre regiões 60–150+ ms |
| Prometheus + Grafana | CloudWatch / Amazon Managed Prometheus + Grafana | granularidade padrão de 1 min esconde picos |

Custo de rede é parte da arquitetura na AWS: tráfego entre AZs e saída para internet são cobrados por GB. Um cache na mesma AZ economiza latência e dinheiro.
