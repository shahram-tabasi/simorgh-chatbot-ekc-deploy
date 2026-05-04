# project-agent-service

The **central agent** for Simorgh — owns project initialization, COT
(chain-of-thought) task chain planning + execution, and the long-running
workflows that the chatbot delegates to. Extracted from
`backend/services/project_agent.py` + `backend/routes/project_agent_routes.py`
in phase 7.

| Property | Value |
|---|---|
| Container | `project-agent-service` |
| Port (internal) | **8035** |
| Image | built from `simorgh-agent/project-agent-service/Dockerfile` |
| Compose file | `simorgh-agent/compose/svc-project-agent.yml` |
| Network | `simorgh_app_net` |
| Mounted at nginx | `/api/v2/agent/*` (REST), `/mcp` (MCP, internal only) |

---

## Two-protocol contract

Per the agreed convention (**AI / chain-of-thought clients use MCP, other
backend code uses REST**) this service exposes both:

```
                  ┌────────────────────────┐
   /api/v2/agent/ │                        │  REST
   ───────────────│  project-agent-service │ /api/v2/agent/projects, /messages, /tasks, etc.
                  │           :8035        │
                  │                        │  MCP
   /mcp ──────────│                        │ handle_input, initialize_project,
                  │                        │ get_project_status, list_tasks,
                  │                        │ list_projects, get_recent_messages
                  └────────────────────────┘
```

Both surfaces sit on top of the same `ProjectManagerAgent` + `ProjectMemoryService`
instances, so behaviour is identical regardless of which protocol the caller used.

---

## REST endpoints (`/api/v2/agent/*`)

The router provides full CRUD for projects, tasks, and messaging:

| Method | Path | Purpose |
|---|---|---|
| `POST`   | `/api/v2/agent/projects` | Create project |
| `GET`    | `/api/v2/agent/projects` | List user's projects |
| `GET`    | `/api/v2/agent/projects/{project_id}` | Get one project |
| `PATCH`  | `/api/v2/agent/projects/{project_id}` | Update fields |
| `DELETE` | `/api/v2/agent/projects/{project_id}` | Delete |
| `POST`   | `/api/v2/agent/projects/{project_id}/message` | Send free-text input → handled by agent |
| `POST`   | `/api/v2/agent/projects/{project_id}/message/stream` | Same, SSE stream |
| `GET`    | `/api/v2/agent/projects/{project_id}/messages` | Recent messages |
| `GET`    | `/api/v2/agent/projects/{project_id}/tasks` | Tasks for project |
| `PATCH`  | `/api/v2/agent/projects/{project_id}/tasks/{task_id}` | Update a task (e.g. mark done) |
| (more) | (instructions, documents, project init, email webhook) | see route file |

---

## MCP tools (`/mcp`)

Each tool maps to a real public method on `ProjectManagerAgent` or
`ProjectMemoryService` — **no fabricated method names**. (My phase 7 first pass
had several invented method names; those have all been corrected against
the actual class signatures.)

| Tool | Wraps | Returns |
|---|---|---|
| `handle_input(project_id, user_input, channel="chat", ...)` | `ProjectManagerAgent.handle_input` | `{response, tasks_created, execution_results}` |
| `initialize_project(project_id, name, owner_id, tpms_oenum?, is_legacy?)` | `ProjectManagerAgent.initialize_project` | git/TPMS/dir setup result |
| `get_project_status(project_id)` | `ProjectManagerAgent.get_status` | `AgentState` as dict |
| `list_tasks(project_id, status?, limit=100)` | `ProjectMemoryService.get_tasks` | list of task dicts |
| `list_projects(owner_id)` | `ProjectMemoryService.list_projects` | list of project dicts |
| `get_recent_messages(project_id, limit=10)` | `ProjectMemoryService.get_recent_context` | list of message dicts |

The `handle_input` tool is the most powerful — give it any user-style
text and it plans a COT chain, dispatches each step (LLM, shell, web
search, TPMS fetch, file export, etc.), and returns the synthesised result.

`channel` accepts string values that map to `MessageChannel` enum:
`"chat"`, `"email"`, `"document"`, etc.

---

## Startup wiring

The service replicates backend's startup sequence in a FastAPI
`lifespan` handler:

```python
llm_service = get_llm_service()
redis       = get_redis_service()
pg_db       = get_db()
qdrant      = QdrantService(llm_service=llm_service)

agent = get_project_agent()
agent.initialize(llm_service=..., redis=..., postgres=..., qdrant=...)
await agent.connect_mcp()   # discovers tools on the other MCP microservices
```

The MCP connect step pulls the tool catalogues from search-service,
tpms-fetcher, project-init, project-analysis, command-gen, file-export,
and eplan-bridge (URLs in env). If any are unreachable, the service still
boots — it just degrades the COT engine's available toolset.

---

## What it talks to

```
                                    ┌──────────────────┐
                              MCP   │  search-service  │
                              ───── │  tpms-fetcher    │
                                    │  project-init    │
                                    │  project-analysis│
   /api/v2/agent/* (REST)           │  command-gen     │
   /mcp (MCP)         ┌──────────┐  │  file-export     │
   ──────────────────▶│ project- │──│  eplan-bridge    │
                      │  agent-  │  └──────────────────┘
                      │  service │
                      │   :8035  │   HTTP   runtime-broker:8048 (ephemeral docker exec)
                      │          │ ───────▶
                      │          │   HTTP   gitlab-mcp:8047 (project files, technical-knowledge)
                      │          │ ───────▶
                      │          │   Redis  redis:6379 (state, task cache, working memory)
                      │          │ ───────▶
                      │          │ asyncpg postgres_auth:5432 (projects, tasks, messages,
                      │          │ ───────▶ instructions, documents, git_commits)
                      │          │
                      │          │   gRPC  qdrant:6333 (semantic search over project files)
                      │          │ ───────▶
                      │          │
                      │          │   HTTP  llm-gateway:8030 (after phase C)
                      │          │ ───────▶ or in-process llm_service.py (today)
                      │          │
                      │          │   SMTP  mail-gateway:8027 (project emails out)
                      │          │ ───────▶
                      └──────────┘
```

---

## Environment variables

| Var | Purpose |
|---|---|
| `REDIS_URL`, `REDIS_AGENT_DB` | Redis + the agent-specific DB index |
| `QDRANT_URL` | Vector store |
| `POSTGRES_AUTH_*` | `projects`, `project_tasks`, `project_messages`, `project_instructions` tables |
| `OPENAI_API_KEY`, `OPENAI_MODEL`, `LOCAL_LLM_URL`, `DEFAULT_LLM_MODE` | LLM mode for COT planning |
| `LLM_GATEWAY_URL` | Replaces local LLM after phase C |
| `RUNTIME_BROKER_URL`, `BROKER_TOKEN` | Ephemeral docker sandbox for code exec |
| `GITLAB_MCP_URL`, `GITLAB_PROJECTS_GROUP`, `AGENT_TOKEN` | Project files + technical-knowledge via GitLab |
| `TPMS_CONTEXT_URL` | On-demand TPMS context for CoT |
| `CONTEXT_SEARCH_URL` | Hybrid (BM25 + kNN) search backing the LLM context block |
| `MAIL_BRIDGE_URL` | Mailcow bridge for in/out project email |
| `PROJECT_EMAIL_DOMAIN` | e.g. `simorghai.electrokavir.com` |
| `*_MCP_URL` | Per-microservice MCP endpoints to discover tools from |
| `MYSQL_*` | TPMS lookup for legacy projects |
| `JWT_SECRET_KEY` | Local JWT verification on REST endpoints |
| `EKC_KNOWLEDGE_PATH` | `/app/ekc-knowledge` — read-only mount |

---

## How `backend/main.py` collaborates with it

### Today (phase B)

backend still holds the canonical `project_agent` singleton. The standalone
container also runs one but isn't receiving traffic until the nginx fix.
The MCP `/mcp` endpoint is reachable container-internally on
`http://project-agent-service:8035/mcp` and could be added to other
services' `*_MCP_URL` env list (chat-service in particular).

### After phase C

backend stops including `project_agent_routes` and stops constructing the
singleton. It calls the agent service over HTTP:

```python
# backend/services/agent_client.py (after phase C)
import httpx, os
URL = os.getenv("PROJECT_AGENT_URL", "http://project-agent-service:8035")
async def send(project_id, text, jwt):
    async with httpx.AsyncClient(timeout=600) as c:
        r = await c.post(
            f"{URL}/api/v2/agent/projects/{project_id}/message",
            json={"message": text},
            headers={"Authorization": f"Bearer {jwt}"})
        r.raise_for_status()
        return r.json()
```

For chat-service that needs the agent to plan a turn, the MCP client
inside chat-service registers `project-agent-service:/mcp` as an upstream
tool provider and lets the COT engine call `handle_input` as a tool.

---

## Local development

```bash
cd simorgh-agent
docker compose -f compose/infra-redis.yml \
               -f compose/infra-postgres-auth.yml \
               -f compose/infra-qdrant.yml \
               -f compose/svc-llm-gateway.yml \
               -f compose/svc-project-agent.yml \
               up --build
```

Smoke:
```bash
curl http://localhost:8035/health
```

For real-world testing you also need `runtime-broker` and `gitlab-mcp`
reachable on `simorgh_app_net`. The legacy `shell-service` on .69 is gone
as of the 2026-05 enterprise migration.

---

## Roadmap / known gaps

* **Drop the bulk-copied `services/` modules that aren't agent-related** —
  the dir was bulk-copied in phase 7 and contains auth, payments, document
  classifier, etc. that this service doesn't need. Phase C / future cleanup.
* **Replace in-process LLM with HTTP to llm-gateway** — same pattern as
  every other extracted service.
* **Add /metrics** — `prometheus_fastapi_instrumentator` for visibility into
  agent loop timings.
* **Make `connect_mcp()` retry** — currently runs once at startup; if a
  microservice is slow to come up its tools are missing for the lifetime
  of the container.
* **The COT engine is the next big thing to extract** — it currently lives
  inside this service via `cot_engine.py`. If the agent grows, splitting
  COT into its own service might be worth it.
