# Simorgh compose layout

Every service has its own file. The master `../docker-compose.yml` just
`include:`s them. Comment a line in the master to disable a service.

## Hardware topology

| Server | Role | Compose file |
|---|---|---|
| **192.168.1.68** | Single-host deployment — backend, frontend, datastores, microservices, GitLab CE, ELK, Mailcow (sibling), host nginx (SSL) | `simorgh-agent/docker-compose.yml` (this) |
| **192.168.1.61** | Local LLM endpoint #1 (GPU) | `llms/docker-compose.yml` |
| **192.168.1.62** | Local LLM endpoint #2 (GPU) | `llms/docker-compose.yml` |

SSL terminates at the **host nginx on .68**. The container nginx serves
plain HTTP on port 85.

The 2026-05 enterprise migration (`MIGRATION_2026_05.md`) consolidated
everything onto .68. The `.69` shell host is gone.

## Files

### Infrastructure
| File | Service | On by default | Notes |
|---|---|---|---|
| `infra-redis.yml` | `redis` | ✅ | cache + sessions + chat history + agent DB |
| `infra-qdrant.yml` | `qdrant` | ✅ | vector DB (RAG) |
| `infra-postgres-auth.yml` | `postgres_auth` | ✅ | auth + projects + tasks + messages |
| `infra-gitlab.yml` | `gitlab` | ✅ | GitLab CE — source of truth for project repos + technical-knowledge |
| `infra-elastic.yml` | `elasticsearch`, `logstash`, `kibana`, `filebeat` | ✅ | logs + hybrid search + admin/observability UI |
| `infra-mailcow.yml` | `mailcow-probe` | ❌ | Mailcow runs as sibling stack — see file header for bring-up |
| `infra-neo4j.yml` | `neo4j` | ❌ | knowledge graph (legacy GraphRAG) |
| `infra-cocoindex-db.yml` | `cocoindex_db` | ❌ | pgvector DB for CocoIndex |
| `infra-cocoindex.yml` | `cocoindex` | ❌ | CocoIndex pipeline (needs cocoindex-db) |
| `infra-rabbitmq.yml` | `rabbitmq` | ❌ | Message broker — OPT-IN. See file header for "when to enable"; try Redis Streams / pg LISTEN/NOTIFY first |

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
| `svc-docling.yml` | `docling-serve` | 5001 | REST (internal) — opt-in offline PDF→MD via IBM Docling |
| `svc-whisper.yml` | `whisper-server` | 8000 | REST (internal) — opt-in offline Persian STT (faster-whisper) |
| `svc-openedai-speech.yml` | `openedai-speech` | 8000 | REST (internal) — opt-in offline Persian TTS (Piper) |
| `svc-tei.yml` | `tei` | 80 | REST (internal) — opt-in HuggingFace Text Embeddings Inference |
| `svc-litellm.yml` | `litellm` | 4000 | REST (internal) — opt-in OpenAI-compat LLM gateway via LiteLLM |
| `svc-searxng.yml` | `searxng` | 8080 | REST (internal) — opt-in privacy metasearch (NOT offline) |
| `svc-stt.yml` | `stt-service` | 8001 | REST |
| `svc-tts.yml` | `tts-service` | 8002 | REST |
| `svc-search.yml` | `search-service` | 8020 | MCP + REST |
| `svc-tpms-fetcher.yml` | `tpms-fetcher` | 8021 | MCP + REST |
| `svc-project-init.yml` | `project-init` | 8022 | MCP + REST |
| `svc-project-analysis.yml` | `project-analysis` | 8023 | MCP + REST |
| `svc-command-gen.yml` | `command-gen` | 8024 | MCP + REST |
| `svc-file-export.yml` | `file-export` | 8025 | MCP + REST |
| `svc-eplan-bridge.yml` | `eplan-bridge` | 8026 | MCP + REST |
| `svc-eplan-sql.yml` | `eplan-sql` | 8044 | MCP + REST |
| `svc-hr-kb.yml` | `hr-kb` | 8041 | MCP + REST |
| `svc-org-data.yml` | `org-data` | 8042 | MCP + REST |

### Enterprise migration services (2026-05)
| File | Service | Port | Replaces |
|---|---|---|---|
| `svc-gitlab-mcp.yml` | `gitlab-mcp` | 8047 | `tech-kb-service`, `techserver-service` (SMB) |
| `svc-runtime-broker.yml` | `runtime-broker` | 8048 | `shell-service` (.69) |
| `svc-context-search.yml` | `context-search` | 8049 | (new) hybrid BM25+kNN over ES |
| `svc-tpms-context-agent.yml` | `tpms-context-agent` | 8050 | shell-copy of TPMS markdown |
| `svc-mail-bridge.yml` | `mail-bridge` | 8051 | `mail-gateway-service`, `project-mail-service` |

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

## Extracted from backend monolith (Phases 2–9, all landed)

Each runs as its own container. Comment a line in `../docker-compose.yml`
to disable; nginx then falls through to the legacy `backend` upstream
via the catch-all `/api/` block (so the app keeps working).

| File | Service | Port | Path |
|---|---|---|---|
| `svc-llm-gateway.yml` | `llm-gateway` | 8030 | `/api/llm-gateway/*` |
| `svc-embeddings.yml` | `embeddings-service` | 8031 | `/api/embeddings/*` |
| `svc-auth.yml` | `auth-service` | 8032 | `/api/v2/auth/*` |
| `svc-documents-rag.yml` | `documents-rag-service` | 8033 | `/api/v2/documents/*` |
| `svc-chat.yml` | `chat-service` | 8034 | `/api/v2/chat/*`, `/api/v2/projects/*/sessions` |
| `svc-project-agent.yml` | `project-agent-service` | 8035 | `/api/v2/agent/*`, `/mcp` |
| `svc-specification-agent.yml` | `specification-agent-service` | 8036 | `/api/v2/specs/*`, `/mcp` |
| `svc-graph-rag.yml` | `graph-rag-service` | 8037 | `/api/v2/graph-rag/*` |
| `svc-payments.yml` | `payments-service` | 8038 | `/api/payments/*` |
| `svc-admin.yml` | `admin-service` | 8039 | `/api/admin/*` |
| `svc-tier-quota.yml` | `tier-quota-service` | 8040 | `/api/quota/*` |

## How phase 10 routes traffic

`nginx_configs/includes/locations.inc` puts the specific `/api/*` blocks
**before** the catch-all `/api/` block. Longest-prefix-match wins, so
external requests for migrated paths hit the standalone services
directly — backend never sees them. Anything not migrated falls through
to backend as before.

To roll back a single service:
1. Comment the matching `include:` line in `../docker-compose.yml`
2. Comment the matching `location` block in `../nginx_configs/includes/locations.inc`
3. `docker compose up -d --remove-orphans` and `docker exec nginx nginx -s reload`
