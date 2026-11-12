# Lab 01 — Scale from zero to millions (cap. 1)

Status: estágios **single → LB → cache** medidos. Pendentes: réplica de leitura, CDN/MinIO, fila + worker, sharding, chaos.

Domínio usado: backend de um editor colaborativo. `documents` (100k docs de ~1 KB, 10k usuários), API de docs, BFF que monta a tela "workspace" (lista + 5 previews).

---

## 1. O que o livro propõe (resumo)

Evolução incremental: um servidor → separar web e DB → load balancer + web tier stateless → replicação master/réplica → cache → CDN para estáticos → múltiplos data centers → fila para desacoplar → logs/métricas/automação → sharding. Cada passo resolve o gargalo ou o SPOF do passo anterior e cria um novo problema (consistência do cache, lag de réplica, resharding, hotspot).

O lab mede exatamente isso: **cada passo move o gargalo para outro lugar**.

---

## 2. Experimentos e resultados

Ambiente: i5-13420H, Docker Desktop (WSL2) com 12 vCPU / 12 GB. Limites por container: API 1 vCPU / 512 MB (≈ uma instância pequena), Postgres 2 vCPU / 1 GB, Redis 1 vCPU, nginx 1 vCPU (2 no E4), k6 3–4 vCPU.

"Pico servidor" = máximo de `sum(rate(http_requests_total{job="api"}[10s]))` no Prometheus. "Média k6" = média do teste inteiro (inclui a rampa), por isso fica abaixo do pico.

### E1 — Single node (1 réplica, sem cache, cliente direto na API)
`RAMP=90s scripts/run.sh single read ramp 6000`

| métrica | valor |
|---|---|
| pico servidor | ~3.5k rps (platô sustentado ~2.3–2.5k) |
| latência no fim da rampa | p50 159 ms, p99 1.65 s |
| CPU API | **1.02 / 1.0 core (saturado)** |
| CPU Postgres | 0.86 / 2.0 |
| `db_pool_waiting` | 2980 (requests esperando conexão) |
| event loop lag p99 | 83 ms |

**Gargalo: CPU do processo Node.** Cada leitura custa CPU em parse do protocolo PG, montagem de objeto e `JSON.stringify`. O pool cheio (2980 esperando) é sintoma, não causa: o processo não consegue processar as respostas que chegam do banco.

### E2 — Mesma carga fixa (2000 rps) nos três estágios
`DURATION=40s scripts/run.sh <stage> read constant 2000`

| estágio | p50 | p95 | p99 | dropped |
|---|---|---|---|---|
| single | 0.7 ms | 276 ms | 620 ms | 1006 |
| lb (4 réplicas) | 1.5 ms | 2.3 ms | 7.2 ms | 0 |
| cache (4 + Redis) | 1.2 ms | 2.6 ms | 7.5 ms | 0 |

Lições:
- **Curva em "taco de hóquei".** 2000 rps está perto do joelho do single node. p50 ainda é ótimo (0.7 ms), mas a cauda explode: fila. Lei de Little: `concorrência = throughput × latência`; perto de 100% de utilização a fila cresce sem limite.
- **O LB custa ~0.8 ms no p50** (um hop TCP a mais + proxy), mas elimina a cauda porque divide a carga. Trade-off clássico: latência mínima × capacidade.
- **Cache não melhorou latência nesta carga.** Com PG folgado e dados no page cache do SO, um GET no Redis custa quase o mesmo que um SELECT por PK. Cache ganha em **capacidade e proteção do DB**, não necessariamente em latência — ver E3/E4.

### E3 — Load balancer + 4 réplicas, sem cache
`RAMP=90s scripts/run.sh lb read ramp 10000`

| métrica | valor |
|---|---|
| pico servidor | ~5.4k rps (**só ~1.6–1.8× com 4× réplicas**) |
| CPU Postgres | **2.0 / 2.0 (saturado)** |
| CPU nginx | 0.98 / 1.0 (quase saturado) |
| CPU de cada API | ~0.8 / 1.0 |
| pg TPS pico | 5.7k |
| `db_pool_waiting` | ~730 por réplica |

**Gargalo migrou para o Postgres** (e o LB está logo atrás). Escalar o web tier horizontalmente é linear só até o próximo recurso compartilhado. 4 réplicas × pool 10 = 40 conexões; aumentar pool não resolve com CPU do PG em 100%.

### E4 — LB + cache-aside (Redis)
`RAMP=90s scripts/run.sh cache read ramp 12000` (nginx 1 core) e `NGINX_CPUS=2 K6_CPUS=4 ...` (nginx 2 cores)

| | nginx 1 core | nginx 2 cores |
|---|---|---|
| pico servidor | ~7.8k rps | **~12k rps (sem saturar)** |
| latência | p99 838 ms (fila no LB) | **p99 16 ms** |
| CPU nginx | **0.99 / 1 (saturado)** | 1.65 / 2 |
| CPU Postgres | 0.57 | 0.56 |
| cache hit ratio | 85% | 86% |
| server p99 (medido na API) | 86 ms | 10 ms |

Lições:
- Com 80% do tráfego em 1% dos docs, hit ratio 85% tirou **~75% da CPU do Postgres** (2.0 → 0.57).
- **Gargalo migrou para o load balancer.** Diferença entre p99 do cliente (838 ms) e p99 do servidor (86 ms) = tempo de fila *antes* da API, ou seja, no LB. Sempre compare latência do cliente com latência do servidor para localizar a fila.
- Com nginx em 2 cores o sistema aguentou 12k rps (o máximo pedido). O limite passou a ser **o próprio gerador de carga** (k6 em 3.1/4 cores) e o host (~9 de 12 cores em uso). A partir daqui, números absolutos param de valer: ver `docs/method.md`.

### E5 — Rota CPU-bound (`/docs/:id/render`, 200 × sha256)
`RAMP=60s scripts/run.sh cache render ramp 3000`

- Pico ~3k rps, 4 réplicas em 0.9 core cada. Postgres em 0.24, Redis em 0.23.
- Event loop lag p99 ~55 ms: durante o hash, **todas** as outras requests da réplica esperam.
- Lição: para trabalho CPU-bound, cache de dados não ajuda; o recurso é CPU do web tier. Opções: `worker_threads`, mover para worker assíncrono (fila), cachear o *resultado* do render, ou linguagem com melhor custo por CPU (Go/Rust) neste hot path.

### E6 — BFF: fan-out serial × paralelo, e um bug de service discovery
`FANOUT=serial|parallel scripts/run.sh cache bff constant 100`

Cada request do BFF = 1 chamada de lista + 5 previews = 6 chamadas à API.

| fanout | rps | p50 | p95 | p99 |
|---|---|---|---|---|
| serial | 100 | 10.1 ms | 98 ms | 478 ms |
| parallel | 100 | 6.1 ms | 22 ms | 99 ms |
| parallel (repetição após fix DNS) | 100 | 6.0 ms | 75 ms | 367 ms |
| serial / parallel | 300 | **saturado: p99 23–34 s** | | |

Lições:
- **BFF é CPU-bound antes da API.** 1 core de BFF aguenta ~180 rps (0.55 core a 100 rps). Cada `fetch` + `JSON.parse` de upstream custa CPU. A 300 rps a fila no event loop chegou a 30 s **sem nenhum erro**: não existe timeout para trabalho que ainda não começou. Falta *admission control* / load shedding (rejeitar cedo com 503 quando lag > X ms).
- Serial ≈ soma das latências; paralelo ≈ a mais lenta. Paralelo reduziu p50 em 40% e p99 em ~5× na primeira rodada.
- Variância entre rodadas iguais (p99 99 ms × 367 ms): host compartilhado, GC, scheduler do WSL. Rodar cada experimento 3× antes de concluir algo sobre p99.
- **Bug real encontrado:** 4–6% de 502. Log do nginx: `api could not be resolved` seguido de `no live upstreams`. Com `resolver valid=5s`, uma falha pontual do DNS do Docker sob carga esvaziou o pool de upstreams. Fix: `valid=30s` + `resolver_timeout 2s` → 0 erros. Mesmo problema existe em produção: TTL de DNS curto + resolver instável = indisponibilidade; ALB/Cloud Map/Envoy resolvem isso mantendo o último conjunto saudável.

---

## 3. Mapa decisão × gargalo

| decisão | gargalo que resolve | gargalo que aparece | métrica que prova |
|---|---|---|---|
| Single node | — | CPU do processo da API | CPU do container = limite; event loop lag; pool waiting |
| Separar web e DB | disputa de CPU/mem entre app e DB | rede (hop extra ~0.1–1 ms) | latência p50 sobe pouco |
| LB + N réplicas stateless | CPU do web tier, SPOF do web | CPU/conexões do DB; CPU do LB | CPU do PG = 100%; ganho sublinear de rps |
| Pool de conexões | custo de handshake por request | fila dentro do app (`db_pool_waiting`) | waiting > 0 com PG ocioso = pool pequeno; com PG cheio = DB é o limite |
| Cache-aside | CPU/IO do DB em leitura | LB, consistência (dados velhos até TTL), thundering herd | hit ratio, CPU do PG, p99 cliente × servidor |
| CPU-bound na API | — | event loop (todas as requests esperam) | event loop lag p99 |
| BFF com fan-out | round trips do cliente (mobile/3G) | CPU do BFF, amplificação de cauda | CPU do BFF; p99 BFF ≫ p99 API |
| DNS para service discovery | config estática de IPs | indisponibilidade em falha de DNS | 502 + `no live upstreams` |

---

## 4. Variações ("e se...")

- **Leitura uniforme (sem hot set)**: `HOT=0 scripts/run.sh cache read ...` (ainda não medido). Hipótese: hit ratio cai muito, porque com TTL de 30 s e 100k chaves cada doc é lido raramente dentro da janela; e 110 MB de docs + overhead do Redis encostam nos 128 MB → evicção LRU. Cache só funciona com localidade. Alternativa: aumentar memória do cache, cachear só metadados, ou réplicas de leitura.
- **Escrita pesada** (`OP=write` ou `mixed`): cache vira custo (invalidar a cada write); gargalo vai para WAL/fsync e locks de linha. Testar `PG_SYNC_COMMIT=off` (perde últimos ms em crash) para ver o custo do fsync. Em editor colaborativo, writes vêm em rajadas por documento: agrupar ops no servidor (batch a cada 100–500 ms) em vez de 1 UPDATE por tecla.
- **Payload grande** (docs de 1 MB): gargalo vira rede e serialização (CPU de JSON). Alternativas: paginação, compressão, enviar só delta, armazenar body em S3 e metadados no DB.
- **Hot key extremo** (1 doc com 50% do tráfego, ex.: doc compartilhado com 10k leitores): ativar `CACHE_SINGLEFLIGHT=1`, cache local em memória (L1) com TTL de 1 s antes do Redis (L2).
- **Multi-região**: latência entre regiões de 60–150 ms muda tudo. Leitura local com réplica regional; escrita no primário (ou multi-primário com CRDT — caso do editor colaborativo).

---

## 5. Paralelo AWS

| aqui | AWS | diferença importante |
|---|---|---|
| container `api` com `cpus: 1` | EC2 c7i.large (2 vCPU) / Fargate task 1 vCPU | t3/t4g têm *burst credits*: o teste passa em 5 min e falha em 1 h |
| `--scale api=4` | Auto Scaling Group / ECS service desired count | scale-out leva 1–3 min; precisa de folga ou scale preditivo |
| nginx | ALB | ALB escala sozinho (mas tem warm-up; picos súbitos podem dar 503 — "pre-warming") |
| Postgres 2 vCPU | RDS db.m7g.large / Aurora | IOPS de EBS (gp3 3000 baseline) e rede da instância também viram teto |
| Redis | ElastiCache (Redis/Valkey) | cluster mode para escalar escrita; réplicas para leitura e failover |
| DNS do Docker | Route 53 / Cloud Map | TTLs e health checks; mesmo problema do E6 em escala |
| rede bridge local (~0.05 ms) | mesma AZ ~0.1–0.3 ms, entre AZs ~0.5–2 ms | multi-AZ dobra round trips caros; testar com toxiproxy (próximo estágio) |
| Prometheus/Grafana | CloudWatch / Managed Prometheus + Grafana | métricas de 1 min no CloudWatch padrão escondem picos de segundos |

---

## 6. Ponte com frontend / editores colaborativos

- **Cache-aside ↔ estado otimista no cliente.** O cliente já é um cache: React Query/SWR com `staleTime` é um TTL. O mesmo dilema de consistência (quanto tempo aceito dado velho?) e de invalidação (write → invalidar a query).
- **Thundering herd ↔ refetch on focus.** 10k abas voltando ao foco ao mesmo tempo = stampede no backend. Jitter e deduplicação (singleflight) resolvem nos dois lados.
- **BFF fan-out ↔ waterfall de componentes.** `await` encadeado em componentes aninhados é o `FANOUT=serial`. O BFF move o waterfall para uma rede de 0.1 ms em vez de 50–200 ms do usuário — mas paga CPU por isso (E6).
- **Event loop lag ↔ long tasks no browser.** Mesma causa (trabalho síncrono longo), mesma métrica (lag/INP), mesmas soluções (dividir trabalho, workers).
- **LB stateless ↔ servidor de colaboração stateful.** Editor colaborativo precisa que todos os clientes de um doc caiam no mesmo processo (estado do doc em memória, CRDT/OT). Isso é *sticky routing por documento* — o oposto do web tier stateless do livro. Solução comum: roteamento por hash do docId (consistent hashing, cap. 5) + pub/sub entre nós. Lab futuro (chat system, cap. 12).
- **Sharding por usuário ↔ particionar por documento/room.** A chave de partição natural de um editor é o documento; hotspot = doc viral.

---

## 7. Próximos estágios deste lab

1. Réplica de leitura PG (streaming replication): medir lag de replicação e quebrar *read-your-writes* de propósito.
2. MinIO como S3 + nginx como CDN para assets estáticos.
3. Fila (Redis Streams) + worker para `/render`: comparar com E5.
4. Sharding manual (2 PGs, `owner_id % 2`): hotspot e query cross-shard.
5. Chaos: toxiproxy (latência entre "AZs"), matar réplica, derrubar Redis (o código cai para o DB — medir o impacto).
6. Admission control no BFF (rejeitar quando event loop lag > 100 ms) e repetir E6 a 300 rps.
