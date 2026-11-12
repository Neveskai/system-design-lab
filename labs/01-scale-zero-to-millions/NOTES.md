# Lab 01 — Scale from zero to millions (cap. 1)

Status: estágios **single → LB → cache → réplica de leitura** medidos. Pendentes: CDN/MinIO, fila + worker, sharding, chaos.

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

### E7 — Réplica de leitura (streaming replication assíncrona)
Config: `stages/replica.env`. Primário + 1 réplica (`pg_basebackup` + slot `replica1`), ambos com 2 vCPU. `READ_FROM=both` alterna leituras entre primário e réplica (como o reader endpoint do Aurora); `READ_FROM=replica` manda todas as leituras para a réplica. Writes sempre no primário.

**E7a — capacidade de leitura.** Carga constante, sem cache, `GET /docs/:id`.

| config | rps pedido | rps entregue | erros | p50 | p99 | CPU primário | CPU réplica | gargalo |
|---|---|---|---|---|---|---|---|---|
| lb, 4 APIs, nginx 1 core | 4500 | 4431 | 0.04% | 8.7 ms | 282 ms | 1.90 | — | PG + nginx |
| réplica, 4 APIs, nginx 1 core | 4500 | 4401 | 0% | 16.9 ms | 415 ms | 1.30 | 0.93 | **nginx (1.0/1)** |
| lb, 4 APIs, nginx 2 cores | 5000 | 4660 | 0% | 153 ms | 774 ms | **1.97** | — | PG + API |
| réplica, 4 APIs, nginx 2 cores | 5000 | 4760 | 0% | 30 ms | 537 ms | 1.28 | 1.05 | **CPU das APIs (~0.9/1)** |
| lb, **6 APIs**, nginx 2 cores | 6000 | 4775 | **13.1%** | 457 ms | 1560 ms | **2.02** | — | **PG** |
| réplica, **6 APIs**, nginx 2 cores | 6000 | **5875** | 0% | **8.6 ms** | **157 ms** | 1.24 | 1.23 | nenhum ainda (DB com folga) |

Rampa até 10k (`READ_FROM=both`, 4 APIs, nginx 1 core): pico ~6.8k rps (E3 sem réplica: ~5.4k), mas com **20% de erro**: 118k `no live upstreams` + 15k `upstream timed out` no nginx.

Lições:
- **A réplica só aparece no resultado quando o DB é o gargalo.** Com nginx em 1 core ou APIs saturadas, primário e réplica dividiram a carga (1.9 → 1.3 + 0.9), mas os números do cliente não mudaram. Antes de comprar réplica, prove com USE que o DB é o recurso saturado.
- Sem os outros gargalos (6 APIs, nginx 2 cores), a réplica levou o sistema de PG saturado com 13% de erro para 0 erro e p99 10× menor. Capacidade de leitura do DB ≈ soma de primário + réplicas.
- **Cascata por health check passivo.** Na rampa, as APIs sobrecarregadas estouraram o `proxy_read_timeout` de 5 s. O `max_fails=3` então marcou as 4 réplicas como down, e o nginx passou a recusar tudo (`no live upstreams`) com as APIs ainda vivas. Sobrecarga virou indisponibilidade total. Mitigações: admission control na API (503 rápido em vez de timeout), timeout da API menor que o do LB, `max_fails` mais tolerante, health check ativo separado do tráfego.
- O gargalo seguiu a ordem prevista: PG → nginx → CPU das APIs. Cada componente que ganha folga expõe o próximo.

**E7b — read-your-writes.** `OP=ryw`: 30% das iterações fazem `PUT /docs/:id` e logo em seguida `GET` do mesmo doc; o k6 conta as leituras que voltam com `version` menor que a recém-escrita. 1500 iterações/s, `READ_FROM=replica`, sem cache. `REPLICA_DELAY` usa `recovery_min_apply_delay` para simular uma réplica distante.

| atraso da réplica | estratégia `RYW` | leituras stale | p50 | p99 | custo |
|---|---|---|---|---|---|
| 0 (mesmo host, lag ~0.2 ms) | none | **28.1%** | 2.1 ms | 75 ms | — |
| 100 ms | none | **99.9%** | 2.2 ms | 35 ms | — |
| 100 ms | primary (após write, lê do primário) | 0% | 2.2 ms | 49 ms | 20k leituras no primário (30% das leituras) |
| 100 ms | version (lê réplica; se `version` < esperada, relê no primário) | 0% | 2.5 ms | 106 ms | 2 leituras para cada leitura stale (19.5k releituras) |
| 100 ms | lsn (espera a réplica aplicar o LSN do write, até 200 ms) | 0% | **17 ms** | 174 ms | **réplica 2.06/2 cores**: polling de 1 ms gerou 9.9k TPS para ~1.5k leituras reais |

Lições:
- **Lag "zero" não existe.** Na mesma máquina, com lag medido de 0.2 ms, 28% das leituras logo após o write vieram velhas. O cliente lê mais rápido do que o WAL é aplicado. Replicação assíncrona = consistência eventual, sempre.
- Com réplica distante (100 ms), praticamente toda leitura após escrita é stale. Para o usuário: "salvei e a mudança sumiu".
- **Cada estratégia tem um custo diferente:**
  - `primary`: simples, mas joga no primário justamente o tráfego que a réplica deveria tirar dele. Em produção: janela de N segundos após o write (cookie/sessão).
  - `version`: o cliente precisa conhecer a versão da entidade (um editor já conhece). Custa uma releitura só quando a réplica está atrasada.
  - `lsn`: genérica (qualquer query, qualquer tabela), mas esperar por polling é caro: soma latência (p50 17 ms) e o polling satura a réplica. Melhor: checar uma vez e cair para o primário. PG 17 não tem espera nativa por LSN; outros bancos expõem *session tokens* ou *bounded staleness* para isso.
- **A réplica cancela queries.** No modo `version` apareceram 72 erros `canceling statement due to conflict with recovery`: o replay do WAL (UPDATE em docs quentes + limpeza de versões antigas) removeu linhas que uma leitura na réplica ainda via. O fallback para o primário absorveu todos (0 erro no cliente). Ajustes: `max_standby_streaming_delay` (mais lag, menos cancelamentos) ou `hot_standby_feedback=on` (primário adia limpeza, mais bloat).
- **Slot de replicação é armadilha operacional.** Com a réplica parada, o primário guarda todo WAL que ela não recebeu. Sem `max_slot_wal_keep_size` (aqui 1 GB) o disco do primário enche e as escritas param.

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
| Réplica de leitura assíncrona | CPU/IO de leitura do DB | consistência (stale reads), queries canceladas, WAL retido pelo slot | CPU por instância PG; `stale_reads`; `pg_replication_lag_seconds`; `conflict with recovery` |
| Read-your-writes | dado "sumindo" após salvar | carga no primário (`primary`), releitura (`version`) ou espera/polling (`lsn`) | `db_reads_total{pool,reason}`; p50 do read-after-write |
| Health check passivo no LB | tráfego para instância morta | cascata: sobrecarga marca todas as instâncias como down | `no live upstreams` com APIs vivas |

---

## 4. Variações ("e se...")

- **Leitura uniforme (sem hot set)**: `HOT=0 scripts/run.sh cache read ...` (ainda não medido). Hipótese: hit ratio cai muito, porque com TTL de 30 s e 100k chaves cada doc é lido raramente dentro da janela; e 110 MB de docs + overhead do Redis encostam nos 128 MB → evicção LRU. Cache só funciona com localidade. Alternativa: aumentar memória do cache, cachear só metadados, ou réplicas de leitura.
- **Escrita pesada** (`OP=write` ou `mixed`): cache vira custo (invalidar a cada write); gargalo vai para WAL/fsync e locks de linha. Testar `PG_SYNC_COMMIT=off` (perde últimos ms em crash) para ver o custo do fsync. Em editor colaborativo, writes vêm em rajadas por documento: agrupar ops no servidor (batch a cada 100–500 ms) em vez de 1 UPDATE por tecla.
- **Payload grande** (docs de 1 MB): gargalo vira rede e serialização (CPU de JSON). Alternativas: paginação, compressão, enviar só delta, armazenar body em S3 e metadados no DB.
- **Hot key extremo** (1 doc com 50% do tráfego, ex.: doc compartilhado com 10k leitores): ativar `CACHE_SINGLEFLIGHT=1`, cache local em memória (L1) com TTL de 1 s antes do Redis (L2).
- **Cache + réplica juntos (bug clássico, ainda não medido)**: o write invalida o cache; a próxima leitura faz miss, lê a réplica atrasada e **grava o valor velho no cache pelo TTL inteiro**. Stale de milissegundos vira stale de 30 s. Correções: popular o cache a partir do primário após o write (write-through); invalidar de novo depois de um atraso maior que o lag (*delayed double delete*); ou guardar a versão no cache e recusar versões menores.
- **Mais réplicas**: leitura escala quase linear até o primário virar gargalo (cada réplica é mais um walsender e mais rede de saída). Escrita não escala com réplicas: para isso, sharding ou batching.
- **Réplica síncrona** (`synchronous_standby_names` + `synchronous_commit=remote_apply`): read-your-writes garantido, mas cada commit espera um round trip até a réplica (entre AZs +1–2 ms; entre regiões +60–150 ms). Testável aqui comparando p99 de `OP=write`.
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
| `postgres-replica` (streaming, slot) | RDS read replica / Aurora Replica | RDS: réplica assíncrona, lag de segundos sob carga de escrita. Aurora: réplicas leem o mesmo storage, lag típico < 20 ms, até 15 réplicas |
| `READ_FROM=both` | Aurora reader endpoint | balanceia por DNS entre réplicas; o app precisa de 2 pools (writer e reader) e decide por query |
| `RYW` (version/lsn) | DynamoDB `ConsistentRead`; Cosmos DB session consistency | DynamoDB cobra 2× por leitura fortemente consistente: a mesma troca de custo do E7b |
| `REPLICA_DELAY=100ms` | réplica cross-region (Aurora Global Database, lag ~1 s) | leitura local rápida; escrita sempre na região primária |
| rede bridge local (~0.05 ms) | mesma AZ ~0.1–0.3 ms, entre AZs ~0.5–2 ms | multi-AZ dobra round trips caros; testar com toxiproxy (próximo estágio) |
| Prometheus/Grafana | CloudWatch / Managed Prometheus + Grafana | métricas de 1 min no CloudWatch padrão escondem picos de segundos |

---

## 6. Ponte com frontend / editores colaborativos

- **Cache-aside ↔ estado otimista no cliente.** O cliente já é um cache: React Query/SWR com `staleTime` é um TTL. O mesmo dilema de consistência (quanto tempo aceito dado velho?) e de invalidação (write → invalidar a query).
- **Thundering herd ↔ refetch on focus.** 10k abas voltando ao foco ao mesmo tempo = stampede no backend. Jitter e deduplicação (singleflight) resolvem nos dois lados.
- **BFF fan-out ↔ waterfall de componentes.** `await` encadeado em componentes aninhados é o `FANOUT=serial`. O BFF move o waterfall para uma rede de 0.1 ms em vez de 50–200 ms do usuário — mas paga CPU por isso (E6).
- **Event loop lag ↔ long tasks no browser.** Mesma causa (trabalho síncrono longo), mesma métrica (lag/INP), mesmas soluções (dividir trabalho, workers).
- **LB stateless ↔ servidor de colaboração stateful.** Editor colaborativo precisa que todos os clientes de um doc caiam no mesmo processo (estado do doc em memória, CRDT/OT). Isso é *sticky routing por documento* — o oposto do web tier stateless do livro. Solução comum: roteamento por hash do docId (consistent hashing, cap. 5) + pub/sub entre nós. Lab futuro (chat system, cap. 12).
- **Read-your-writes ↔ UI otimista + versão.** O E7b é o bug "salvei e voltou o texto antigo" que aparece ao refazer o fetch logo após uma mutation. No cliente a solução é a mesma da estratégia `version`: manter o estado otimista até o servidor devolver `version >= a minha`. Em CRDT/OT, o vetor de versões (ou o número da última op) é exatamente o token que diz se uma réplica está em dia.
- **Sharding por usuário ↔ particionar por documento/room.** A chave de partição natural de um editor é o documento; hotspot = doc viral.

---

## 7. Próximos estágios deste lab

1. ~~Réplica de leitura PG~~ (E7). Faltam: cache + réplica (valor velho no cache), réplica síncrona, matar a réplica sob carga.
2. MinIO como S3 + nginx como CDN para assets estáticos.
3. Fila (Redis Streams) + worker para `/render`: comparar com E5.
4. Sharding manual (2 PGs, `owner_id % 2`): hotspot e query cross-shard.
5. Chaos: toxiproxy (latência entre "AZs"), matar réplica, derrubar Redis (o código cai para o DB — medir o impacto).
6. Admission control no BFF (rejeitar quando event loop lag > 100 ms) e repetir E6 a 300 rps.
