# Lab 01 — Scale from zero to millions (cap. 1)

Status: estágios **single → LB → cache → réplica de leitura → object storage + CDN → fila + workers** medidos. Pendentes: sharding, chaos.

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

### E8 — Object storage (S3) + CDN
Config: `stages/cdn.env`. SeaweedFS com API S3 (2 vCPU) faz o papel do S3. O MinIO deixou de publicar imagens Docker em 2025, e o pull de `minio/minio` falha. Um nginx `cdn` (2 vCPU, cache em tmpfs) faz o papel de um edge do CloudFront. O bucket `attachments` tem 500 objetos de 256 KB de bytes aleatórios (incompressíveis); 80% das requests vão para 50 arquivos. `GET /attachments/:key` tem 3 caminhos:
- `proxy`: a API lê do S3 e repassa os bytes (`ATTACH_MODE=proxy`, via nginx).
- `redirect`: a API responde 302 com URL pré-assinada; o cliente baixa direto do S3 (`ATTACH_MODE=redirect`).
- `cdn`: o cliente pede ao edge; o edge busca no S3 só no miss (`TARGET=http://cdn`).

**E8a — entrega de anexos** (carga constante, 40 s):

| caminho | arquivos/s | MB/s | erros | p50 | p99 | CPU S3 | CPU por API (4×) | CPU edge |
|---|---|---|---|---|---|---|---|---|
| proxy | 300 | 79 | 0% | 6.2 ms | 39 ms | 1.47/2 | 0.42 | — |
| proxy | 450 | 118 | 0% | 6.1 ms | 85 ms | 1.85/2 | 0.60 | — |
| proxy | 600 | 157 | 0% | 13 ms | **2457 ms** | **2.02/2** | 0.89 | — |
| redirect | 300 | 79 | 0% | 2.3 ms | 7.5 ms | 1.41/2 | 0.26 | — |
| redirect | 600 | 82 | 3.5% | 2.9 ms | **20.7 s** | **2.09/2** | 0.38 | — |
| redirect | 900 | 3 | **46%** | — | 16 s | 1.76/2 | 0.34 | — |
| cdn | 600 | 158 | 0% | 0.5 ms | 4.9 ms | 0.31 | ~0 | 0.34/2 |
| cdn | 1500 | 394 | 0% | 0.6 ms | 5.8 ms | 0.30 | ~0 | 0.90/2 |
| cdn | 3000 | **788** | 0% | 0.7 ms | 69 ms | 0.25 | ~0 | 1.86/2 |

Hit ratio do edge: 98–99.5%. Na rodada de 3000/s o k6 já usava 2.45 cores, então o teto do edge pode estar um pouco acima disso.

**E8b — cachear o resultado do render no edge.** Com `RENDER_MAX_AGE=10`, a API manda `Cache-Control: public, max-age=10` e o edge guarda a resposta. Rampa até 6000/s: média de 3769/s com 0 erro, 0 iterações descartadas, p99 9 ms e hit 79.5%. Esse hit corresponde aos 80% de tráfego quente; os 20% frios nunca se repetem em 10 s. APIs em 0.6 core. No E5 (só cache de dados no Redis), a mesma rota saturava as APIs em ~1.9k/s de média (0.9 core cada).

**E8c — staleness no edge.** Sobrescrevi `att-7.bin` no S3. A origem passou a devolver o ETag novo (`4341…`), mas o edge continuou servindo o antigo (`a51a…`) como `HIT` até o TTL de 60 s acabar. Com o render acontece o mesmo: até `max-age=10` de resposta velha depois de um `PUT`.

Lições:
- **A origem é o gargalo, não a API.** Servir 256 KB custa mais CPU no object store do que na API: 1.5 core do SeaweedFS para 80 MB/s. Na AWS o S3 não tem esse teto de CPU (escala por prefixo, ~5.5k GET/s por prefixo), mas cobra por request e por GB de saída.
- **O proxy pela API custa ~5.6 ms de CPU por arquivo de 256 KB** (~45 MB/s por core). Ele também deixa a API no caminho dos bytes: cada MB entra e sai da API. Num editor com imagens, isso compete com as requests de doc.
- **A URL pré-assinada tira os bytes da API, mas não protege a origem.** A API caiu de 0.42 para 0.26 core. O presign do SDK v3 não custa "microssegundos": são ~3.5 ms de CPU por URL, por causa da pilha de middleware. Sem um pool de conexões keepalive na frente, centenas de clientes abrem conexões direto no S3. O SeaweedFS desabou antes do que no proxy: 600/s com p99 de 20 s, 900/s com 46% de erro. No modo proxy, a API, com 128 sockets em keepalive, fazia papel de *connection pooler* da origem.
- **O CDN muda a ordem de grandeza.** Entregou 5× mais throughput que o melhor caminho até a origem, com p50 abaixo de 1 ms, a origem em 0.25–0.30 core e as APIs fora do caminho. O limite passou a ser a CPU do edge (e do gerador de carga).
- **Cachear o resultado vence cachear o insumo.** No E5 o Redis guardava o doc, mas cada request refazia 200 hashes. Com `Cache-Control` no resultado, 80% das requests nem chegam à API. A troca é staleness: até 10 s de render velho depois de um `PUT`.
- **Na invalidação, versione a URL em vez de purgar.** Sobrescrever o mesmo key deixa o edge com a versão velha até o TTL. Com key imutável (`att-7.v2.bin`, ou o hash do conteúdo no nome) e TTL longo, não há o que invalidar. O purge (CloudFront invalidation) leva de segundos a minutos, é cobrado acima de 1000 paths/mês e não alcança caches de browser.
- **Problema do lab:** o relógio da VM do Docker Desktop pulou ~2 h para frente e depois voltou. O Prometheus passou a rejeitar amostras ("too old or too far into the future") e os containers mostravam "Up Less than a second". Correção: `docker compose up -d --force-recreate --renew-anon-volumes prometheus`. Os containers que viveram o salto também ficaram com estado ruim (uma réplica fora do pool do nginx); recriar nginx/api/cdn resolveu.

### E9 — Fila (Redis Streams) + workers
Config: `stages/queue.env`. Render pesado (`RENDER_ITER=JOB_ITER=2000`, ~10× o E5) faz o papel de export/PDF/diff. `OP=render` roda inline na API; `OP=enqueue` faz `POST /docs/:id/render-jobs`, que responde 202 com o id do job, e `--scale worker=N` processa. A fila roda num Redis separado do cache (`noeviction` + AOF): um cache pode perder chave, uma fila não. Consumer group com `XREADGROUP BLOCK`; jobs sem ack por mais de `CLAIM_IDLE_MS` voltam via `XAUTOCLAIM`. Entrega é *at-least-once*, então o resultado é gravado por id do job (idempotente). `QUEUE_MAX` > 0 liga admission control: com a fila cheia, a API responde 503 + `Retry-After`.

**E9a — teto síncrono.** Rampa de `OP=render`: ~381 renders/s com as 4 APIs saturadas.

**E9b — pico de 100 → 600/s por 30 s:**

| caminho | iterações descartadas | latência para o cliente | backlog máximo | tempo até o resultado |
|---|---|---|---|---|
| sync (render na API) | 276 | p50 299 ms, p99 959 ms | — | = latência |
| async, 2 workers | **0** | enqueue p99 **3 ms** | 8426 jobs | p99 ~30 s |
| async, 2 workers, `QUEUE_MAX=1000` | 0 (27% recebem 503 rápido) | enqueue p99 ~3 ms | ~1000 | ≤ 5 s |

**E9c — vazão de dreno** (backlog cheio, só workers consumindo):

| workers | jobs/s |
|---|---|
| 1 | ~171 |
| 2 | ~380 |
| 4 | ~609 |

**E9d — matar um worker no meio.** 9001 jobs enfileirados, 9001 resultados gravados. O job que estava com o worker morto ficou pendente e foi reclamado por outro worker depois de ~30 s (`CLAIM_IDLE_MS`).

Lições:
- **Fila não cria capacidade, ela move o tempo.** 2 workers drenam ~380/s, o mesmo que as 4 APIs faziam inline (~381/s): mesma CPU, mesma vazão. A fila troca latência por disponibilidade: o pico vira backlog, o cliente recebe 202 em 3 ms e a API fica livre para as rotas leves.
- **Lei de Little dá o atraso.** Backlog de 8426 ÷ ~380/s ≈ 22 s de espera, coerente com o p99 de ~30 s até o resultado. Para um SLO de "resultado em 5 s", o backlog máximo é ~5 s × vazão de dreno.
- **Fila sem limite é um timeout escondido.** Sem `QUEUE_MAX` nada falha, mas o resultado chega 30 s depois e o usuário já desistiu. Com `QUEUE_MAX=1000`, 27% das requests recebem 503 imediato e o restante sai em até 5 s. Rejeitar cedo (backpressure) é melhor que aceitar trabalho que vai ficar velho. É o mesmo admission control que faltou no E6 e no E7.
- **Workers escalam de forma independente da API.** O dreno cresceu de 171 para 609/s com 4 workers, mas de forma sublinear de 2 para 4 (1.6×). A causa não foi isolada; o suspeito é CPU do host disputada com k6 e APIs. É o argumento para autoscaling por tamanho de fila (backlog por worker), não por CPU da API.
- **At-least-once exige idempotência.** O job do worker morto foi reprocessado por outro; sem o resultado indexado por id, o efeito (e-mail, cobrança, export) aconteceria duas vezes. `CLAIM_IDLE_MS` é a troca: curto demais reprocessa jobs lentos que ainda estão vivos; longo demais atrasa a recuperação (aqui ~30 s).
- **Problema operacional:** consumers mortos continuam no consumer group, com o PEL deles. É preciso limpar com `XGROUP DELCONSUMER` (após reclamar os pendentes), senão `XINFO CONSUMERS` cresce a cada deploy.

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
| Arquivos em object storage | disco local da API (quebra stateless); blob no DB (WAL, réplica) | CPU/banda da origem; custo por request e GB | CPU e net tx do S3; MB/s entregue |
| URL pré-assinada | bytes passando pela API | conexões dos clientes direto na origem; CPU do presign | CPU da API por request; erros/latência da origem |
| CDN (edge cache) | banda e CPU da origem e da API | staleness até o TTL; invalidação | hit ratio (`X-Cache`); CPU da origem ≈ constante com carga subindo |
| Fila + workers | picos de trabalho pesado bloqueando a API | latência até o resultado (backlog); entrega duplicada; consumers órfãos | tamanho do backlog; jobs/s de dreno; idade do job mais velho |
| Limite de fila (`QUEUE_MAX`) | backlog infinito (resultado inútil de tão velho) | requests rejeitadas (503) | taxa de 503; tempo até o resultado ≤ SLO |

---

## 4. Variações ("e se...")

- **Leitura uniforme (sem hot set)**: `HOT=0 scripts/run.sh cache read ...` (ainda não medido). Hipótese: hit ratio cai muito, porque com TTL de 30 s e 100k chaves cada doc é lido raramente dentro da janela; e 110 MB de docs + overhead do Redis encostam nos 128 MB → evicção LRU. Cache só funciona com localidade. Alternativa: aumentar memória do cache, cachear só metadados, ou réplicas de leitura.
- **Escrita pesada** (`OP=write` ou `mixed`): cache vira custo (invalidar a cada write); gargalo vai para WAL/fsync e locks de linha. Testar `PG_SYNC_COMMIT=off` (perde últimos ms em crash) para ver o custo do fsync. Em editor colaborativo, writes vêm em rajadas por documento: agrupar ops no servidor (batch a cada 100–500 ms) em vez de 1 UPDATE por tecla.
- **Payload grande** (docs de 1 MB): gargalo vira rede e serialização (CPU de JSON). Alternativas: paginação, compressão, enviar só delta, armazenar body em S3 e metadados no DB.
- **Hot key extremo** (1 doc com 50% do tráfego, ex.: doc compartilhado com 10k leitores): ativar `CACHE_SINGLEFLIGHT=1`, cache local em memória (L1) com TTL de 1 s antes do Redis (L2).
- **Cache + réplica juntos (bug clássico, ainda não medido)**: o write invalida o cache; a próxima leitura faz miss, lê a réplica atrasada e **grava o valor velho no cache pelo TTL inteiro**. Stale de milissegundos vira stale de 30 s. Correções: popular o cache a partir do primário após o write (write-through); invalidar de novo depois de um atraso maior que o lag (*delayed double delete*); ou guardar a versão no cache e recusar versões menores.
- **Mais réplicas**: leitura escala quase linear até o primário virar gargalo (cada réplica é mais um walsender e mais rede de saída). Escrita não escala com réplicas: para isso, sharding ou batching.
- **Réplica síncrona** (`synchronous_standby_names` + `synchronous_commit=remote_apply`): read-your-writes garantido, mas cada commit espera um round trip até a réplica (entre AZs +1–2 ms; entre regiões +60–150 ms). Testável aqui comparando p99 de `OP=write`.
- **Arquivo grande (vídeo, export de 100 MB)**: o CDN ajuda pouco se cada arquivo é pedido uma vez só. Nesse caso valem range requests, multipart upload direto do cliente (presigned POST/multipart) e storage class mais barata para dado frio.
- **Conteúdo privado por usuário**: CDN com URL assinada (CloudFront signed URL/cookie) em vez de bucket público. A chave do cache precisa ignorar a assinatura; senão cada usuário vira um miss.
- **Trabalho com prioridades** (export pedido pelo usuário × reindexação em lote): uma fila por prioridade ou workers dedicados; senão o lote enche o backlog e o pedido interativo espera atrás dele.
- **Ordem por documento**: Redis Streams com vários consumers não garante ordem por doc. Se a ordem importa (aplicar ops de um doc), particione a fila por docId (Kafka/Kinesis com chave de partição, SQS FIFO com `MessageGroupId`).
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
| SeaweedFS (API S3) | S3 | sem teto de CPU próprio, mas ~5.5k GET/s por prefixo; cobra por request (~$0.4/milhão de GET) e por saída (~$0.09/GB) |
| `ATTACH_MODE=redirect` | S3 presigned URL | mesmo código do SDK; a URL expira (aqui 60 s); upload direto do browser com presigned PUT/POST |
| nginx `cdn` | CloudFront | dezenas de edges perto do usuário; Origin Access Control deixa o bucket privado; Origin Shield = uma camada a mais de cache antes da origem |
| `RENDER_MAX_AGE` | CloudFront cache policy / `Cache-Control` | TTL min/default/max por behavior; saída do CloudFront é mais barata que saída direta do S3 |
| `postgres-replica` (streaming, slot) | RDS read replica / Aurora Replica | RDS: réplica assíncrona, lag de segundos sob carga de escrita. Aurora: réplicas leem o mesmo storage, lag típico < 20 ms, até 15 réplicas |
| `READ_FROM=both` | Aurora reader endpoint | balanceia por DNS entre réplicas; o app precisa de 2 pools (writer e reader) e decide por query |
| `RYW` (version/lsn) | DynamoDB `ConsistentRead`; Cosmos DB session consistency | DynamoDB cobra 2× por leitura fortemente consistente: a mesma troca de custo do E7b |
| `REPLICA_DELAY=100ms` | réplica cross-region (Aurora Global Database, lag ~1 s) | leitura local rápida; escrita sempre na região primária |
| `queue` (Redis Streams) | SQS / Kinesis / MSK | SQS: visibility timeout = `CLAIM_IDLE_MS`, DLQ após N recebimentos, sem limite de backlog prático; Kinesis/MSK: ordem por shard/partição |
| `worker` com `--scale` | ECS service escalando por `ApproximateNumberOfMessagesVisible` / Lambda com SQS | escalar por backlog por worker; Lambda escala sozinho mas tem limite de concorrência e cold start |
| `QUEUE_MAX` + 503 | API Gateway throttling / limite no produtor | SQS não rejeita por tamanho de fila: o limite precisa estar no produtor |
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
- **CDN ↔ bundle com hash no nome.** O E8c é o motivo de existir o `main.3f9a1c.js`: URL imutável com `Cache-Control: immutable, max-age=31536000`, e só o `index.html` com TTL curto. Imagens coladas no editor seguem o mesmo padrão: upload direto ao S3 por URL pré-assinada (o servidor de colaboração nunca vê os bytes), e o doc guarda só a referência imutável.
- **Fila ↔ fila de ops offline e Web Workers.** O cliente de um editor já tem uma fila: ops feitas offline esperam e são reenviadas (at-least-once), por isso cada op carrega um id e o servidor deduplica. Trabalho pesado no browser (diff, export, parse) vai para um Web Worker pelo mesmo motivo do E9: manter o thread que responde ao usuário livre. E `QUEUE_MAX` é o equivalente a descartar/compactar ops antigas em vez de deixar a fila crescer sem limite.
- **Sharding por usuário ↔ particionar por documento/room.** A chave de partição natural de um editor é o documento; hotspot = doc viral.

---

## 7. Próximos estágios deste lab

1. ~~Réplica de leitura PG~~ (E7). Faltam: cache + réplica (valor velho no cache), réplica síncrona, matar a réplica sob carga.
2. ~~Object storage + CDN~~ (E8). Faltam: upload direto com presigned PUT, Origin Shield (2 níveis de cache).
3. ~~Fila + worker~~ (E9). Faltam: dead-letter queue (job que falha sempre), autoscaling por backlog, filas por prioridade.
4. Sharding manual (2 PGs, `owner_id % 2`): hotspot e query cross-shard.
5. Chaos: toxiproxy (latência entre "AZs"), matar réplica, derrubar Redis (o código cai para o DB — medir o impacto).
6. Admission control no BFF (rejeitar quando event loop lag > 100 ms) e repetir E6 a 300 rps.
