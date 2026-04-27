# Simorgh compose layout

Every service has its own file. The master `../docker-compose.yml` just
`include:`s them. Comment a line in the master to disable a service.

## Hardware topology

| Server | Role | Compose file |
|---|---|---|
| **192.168.1.68** | Main CPU — backend, frontend, datastores, microservices, host nginx (SSL) | `simorgh-agent/docker-compose.yml` (this) |
| **192.168.1.69** | Shell agent + git runtime | `simorgh-agent/docker-compose-shell.yml` |
| **192.168.1.61** | Local LLM endpoint #1 (GPU) | `llms/docker-compose.yml` |
| **192.168.1.62** | Local LLM endpoint #2 (GPU) | `llms/docker-compose.yml` |

SSL terminates at the **host nginx on .68**. The container nginx serves plain
HTTP on port 85. Do not enable certbot containers.

## Files

### Infrastructure
| File | Service | On by default | Notes |
|---|---|---|---|
| `infra-redis.yml` | `redis` | ✅ | cache + sessions + chat history + agent DB |
| `infra-qdrant.yml` | `qdrant` | ✅ | vector DB (RAG) |
| `infra-postgres-auth.yml` | `postgres_auth` | ✅ | auth + projects + tasks + messages |
| `infra-neo4j.yml` | `neo4j` | ❌ | knowledge graph (legacy GraphRAG) |
| `infra-cocoindex-db.yml` | `cocoindex_db` | ❌ | pgvector DB for CocoIndex |
| `infra-cocoindex.yml` | `cocoindex` | ❌ | CocoIndex pipeline (needs cocoindex-db) |

### Core app
| File | Service | Notes |
|---|---|---|
| `core-backend.yml` | `backend` | FastAPI monolith, port 8890 (will be split in phases 2–10) |
| `core-frontend.yml` | `frontend` | React+Vite static build, port 80 |
| `core-nginx.yml` | `nginx` | reverse proxy, port 85 (HTTP only) |

### Microservices
All on the `simorgh_app_net` network. AI / chain-of-thought talks to them via
**MCP** (`/mcp` endpoint); backend fallbacks talk **REST**.

| File | Service | Port | Protocol |
|---|---|---|---|
| `svc-doc-processor.yml` | `doc-processor` | 8000 | REST (internal) |
| `svc-stt.yml` | `stt-service` | 8001 | REST |
| `svc-tts.yml` | `tts-service` | 8002 | REST |
| `svc-search.yml` | `search-service` | 8020 | MCP + REST |
| `svc-tpms-fetcher.yml` | `tpms-fetcher` | 8021 | MCP + REST |
| `svc-project-init.yml` | `project-init` | 8022 | MCP + REST |
| `svc-project-analysis.yml` | `project-analysis` | 8023 | MCP + REST |
| `svc-command-gen.yml` | `command-gen` | 8024 | MCP + REST |
| `svc-file-export.yml` | `file-export` | 8025 | MCP + REST |
| `svc-eplan-bridge.yml` | `eplan-bridge` | 8026 | MCP + REST |
| `svc-mail-gateway.yml` | `mail-gateway` | 8027 + SMTP 2525 | REST |

### simorgh-soft
| File | Service | Notes |
|---|---|---|
| `soft-mongo.yml` | `simorgh-soft-mongo` | MongoDB 7 for design data |
| `soft-app.yml` | `simorgh-soft` | React + Express electrical design app |

## How to enable / disable a feature

Edit `../docker-compose.yml` and comment / uncomment the matching `include:`
line, then redeploy:

```bash
docker compose up -d --remove-orphans
```

`--remove-orphans` cleans up containers from services you just disabled.

## Bringing up a single file standalone

Each file is self-contained (declares its own networks/volumes with fixed
`name:` so they merge cleanly when used together). To run just one:

```bash
docker compose -f compose/infra-redis.yml up -d
```

## Network and volume naming

All files share:

* network `simorgh_app_net` (Docker name)
* volumes named `simorgh_<purpose>` (e.g. `simorgh_redis_data`, `simorgh_qdrant_storage`)

This keeps them stable across the master compose and any standalone runs.

## Future structure (phases 2–10)

The current `backend` is a monolith. Subsequent phases will extract these
features into their own `compose/svc-*.yml` files; the master will just
uncomment the matching `include:` line:

```
svc-llm-gateway.yml          phase 2  — OpenAI + local LLM (.61/.62) router
svc-embeddings.yml           phase 3  — sentence-transformers
svc-auth.yml                 phase 4  — auth_v2 + oauth + email
svc-documents-rag.yml        phase 5  — upload + chunk + embed + Qdrant
svc-chat.yml                 phase 6  — chat + context + memory + summarizer
svc-project-agent.yml        phase 7  — MCP server (AI / COT)
svc-specification-agent.yml  phase 8  — MCP server (electrical specs)
svc-graph-rag.yml            phase 9  — Neo4j-based RAG
svc-payments.yml             phase 9  — NOWPayments
svc-admin.yml                phase 9  — admin endpoints
svc-tier-quota.yml           phase 9  — tier + rate limit
```

After phase 10, `core-backend.yml` is just a thin gateway/orchestrator.

## Legacy

The old monolithic compose lives at `../docker-compose.legacy.yml` for
reference and emergency rollback. It will be deleted when phase 10 lands.
