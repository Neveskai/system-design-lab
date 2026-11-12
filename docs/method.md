# Método de medição

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
