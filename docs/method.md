# Método de medição

## Padrão de análise de cada capítulo

Todo capítulo do livro segue a mesma linha, do desenho até a conta mensal:

1. **Premissas ancoradas em dado público.** Cada premissa traz a fonte (ex.: Twitter 2013, 500M tweets/dia; Pew 2019, mediana de 2 tweets/mês). Razão por usuário transfere entre empresas; número absoluto de infra não transfere. Chute só quando não há referência, e marcado como chute.
2. **Origem de cada número:** [P] premissa de produto, [M] medido neste lab, [R] livro, fornecedor ou referência pública, [E] estimativa ainda não medida. Cada [E] vira item de experimento.
3. **Carga de trabalho explícita.** Nenhum "X writes/s" sem dizer: motor (PG, MySQL, Mongo, Cassandra, DynamoDB), B-tree ou LSM, índices, tipo de chave (sequencial ou aleatória), unique, modo de commit, batch, replicação, linha quente. Um teto de vazão vale só para aquela carga.
4. **Cadeia de contas:** premissa, tráfego (média e pico), carga por componente, instâncias a 60% de utilização (N+1 de AZ), storage, banda, latência.
5. **Custo por mês em cada escala.** A mesma premissa por usuário em 3–4 ordens de grandeza (ex.: 1M, 10M, 100M, 300M MAU). Em cada decisão, a opção mais barata que aguenta a carga e o preço da opção rejeitada ao lado. Incluir rede (saída para a internet, CDN, tráfego entre AZs, LB por GB), não só compute.
6. **Comparar com o desenho do livro** na mesma carga, para mostrar quanto custa superdimensionar.
7. **Gatilhos de mudança:** o número medido que faz trocar de arquitetura (ex.: "shard quando a escrita passar de 60% do maior primário"), não "quando crescer".
8. **Sensibilidade:** a decisão aguenta errar 3× nas premissas de tráfego?
9. **O que ficou fora da conta:** tempo de engenharia, observabilidade, backups, staging. Preço de tabela, data e "conferir no dia".

Relatório (NOTES.md): tabela por escala (total/mês, US$ por MAU, maior item), depois as conclusões em bullets curtos com o número que justifica cada uma. Código: `labs/02-back-of-envelope/prices.ts` (preços e helpers), `systems.ts` (seções `A$`/`B$`), `stages.ts` (cap. 1).

## Perguntas em cada experimento
1. **Qual recurso satura primeiro?** (o gargalo)
2. **Onde está a fila?** (onde o tempo é gasto esperando, não trabalhando)
3. **O que muda quando removo esse gargalo?** (para onde ele migra)

## USE e RED
- **USE** (por recurso: CPU, memória, disco, rede, pool de conexões): *Utilization*, *Saturation* (fila), *Errors*.
- **RED** (por serviço): *Rate*, *Errors*, *Duration* (p50/p95/p99).
- Comece pelo RED do cliente (k6). Se a latência sobe, procure no USE qual recurso está em ~100% ou com fila.

Sinais de saturação usados nos labs:

| recurso | utilização | saturação (fila) |
|---|---|---|
| CPU do container | `rate(container_cpu_usage_seconds_total)` ≈ `cpus` | event loop lag (Node), run queue |
| pool PG no app | `db_pool_total - db_pool_idle` = max | `db_pool_waiting` > 0 |
| Postgres | CPU do container, TPS | `pg_stat_activity` em `active`/espera de lock |
| LB | CPU do nginx | p99 cliente ≫ p99 servidor |
| gerador de carga | CPU do k6 | `dropped_iterations` > 0 com servidor folgado |

## Lei de Little
`L = λ × W` — requests em voo = throughput × latência. 2000 rps a 5 ms = 10 em voo; a 500 ms = 1000 em voo (1000 sockets, 1000 promises, memória). Latência alta **é** consumo de recursos.

## Modelo aberto × fechado
k6 usa `constant-arrival-rate` / `ramping-arrival-rate`: as requests chegam no ritmo pedido mesmo que o servidor atrase, como usuários reais. Num modelo fechado (N VUs em loop) o cliente desacelera junto com o servidor e esconde a fila (*coordinated omission*). `dropped_iterations` > 0 = k6 não tinha VU livre = sistema não acompanhou.

## Achar o teto
1. Rampa (`MODE=ramp`) até bem acima do esperado: mostra o joelho e o pico.
2. Carga constante em ~70–80% do pico: latência estável para comparar arquiteturas.
3. Mesma carga constante em todos os estágios: comparação justa.
4. Repetir 3× antes de concluir qualquer coisa sobre p99.

## Limites do lab local
- Tudo roda no mesmo host: a rede bridge tem ~0.05 ms, bem menos que entre AZs (0.5–2 ms). Use toxiproxy para simular.
- O k6 disputa CPU com o sistema testado. Se o k6 está perto do limite dele, o teste mede o k6.
- WSL2 e Windows dividem a CPU: abrir o browser durante o teste muda os números.
- Conclusões valem **em termos relativos** (antes/depois, qual recurso satura), não em números absolutos para produção.
