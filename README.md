# System Design Lab

Laboratório local para estudar os capítulos de *System Design Interview* (Alex Xu, vol. 1) medindo de verdade: qual recurso satura, para onde o gargalo migra, quais alternativas existem e como isso se traduz em AWS.

## Labs

| cap. | lab | status |
|---|---|---|
| 1 | [Scale from zero to millions](labs/01-scale-zero-to-millions/NOTES.md) | single → LB → cache → réplica → S3 + CDN → fila medidos; sharding pendente (chaos no lab 02) |
| 2 | [Back-of-the-envelope estimation](labs/02-back-of-envelope/NOTES.md) | latência local/rede medida, teto do lab 01 previsto × medido, disponibilidade com chaos |
| 4 | Rate limiter | pendente |
| 5 | Consistent hashing | pendente |
| 12, 15, 11 | Chat, Google Drive, News feed | depois da fundação |

Referência: [método de medição](docs/method.md), [mapa local ↔ AWS](docs/aws-map.md).

## Requisitos
- Docker Desktop (WSL2). Recomendado reservar ~12 vCPU / 12 GB para o Docker.
- Git Bash para rodar os scripts.

## Uso (lab 01)
```bash
cd labs/01-scale-zero-to-millions
./scripts/run.sh single read ramp 6000      # estágio, operação, modo, taxa
WINDOW=2m ./scripts/snapshot.sh             # pico de CPU/mem/pool/lag do último teste
```
- Grafana: http://localhost:3001 (dashboard "Lab overview (RED + USE)")
- Prometheus: http://localhost:9090
- Resultados do k6: `labs/01-scale-zero-to-millions/results/*.json`

Parar tudo: `docker compose down` (adicione `-v` para apagar o volume do Postgres).

## Estrutura
- `infra/observability/` — Prometheus, Grafana, exporter de métricas por container (via Docker API).
- `shared/ts/` — servidor HTTP mínimo com métricas Prometheus, usado por todos os serviços.
- `labs/NN-*/` — compose, serviços, scripts de carga e `NOTES.md` de cada capítulo.
- `book/` — texto extraído do PDF, só local (ignorado pelo git).
