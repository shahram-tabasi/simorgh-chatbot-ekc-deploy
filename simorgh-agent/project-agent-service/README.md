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

## How CoT integrates with the project data sources

The CoT engine doesn't talk to GitLab, TPMS, or Elasticsearch directly.
It calls **MCP tools** exposed by peer services, registered at startup
by `services/mcp_manager.py`. Three data sources, three (or four)
collaborating services:

### GitLab — project repos AND technical-knowledge

| Tool (MCP) | Lives in | Reads from | Use when |
|---|---|---|---|
| `gitlab_mcp.list_projects_mcp(group, search_term)` | gitlab-mcp:8047 | `simorgh-projects/` group on GitLab | Resolve a project name → repo path |
| `gitlab_mcp.get_project_tree(project, ref, path)` | gitlab-mcp:8047 | The repo | Discover files in the project |
| `gitlab_mcp.read_file_mcp(project, path, ref)` | gitlab-mcp:8047 | The repo | Pull one file's contents into reasoning |
| `gitlab_mcp.search_blobs(query, project?, group?)` | gitlab-mcp:8047 | GitLab blob search | Find files matching keywords |
| `gitlab_mcp.search_technical_knowledge(query)` | gitlab-mcp:8047 | `simorgh-knowledge/technical-knowledge` repo | Cross-cutting standards, wiring guides, regulations |

Where the data lives:
```
GitLab CE @ :8929
├── simorgh-projects/
│   ├── OE-2024-0457/        ← per-project repo (PDFs, schematics, BOM, notes)
│   ├── OE-2024-0458/
│   └── ...
└── simorgh-knowledge/
    └── technical-knowledge/  ← shared standards, wiring rules, glossaries
```

Note: The CoT engine never writes to GitLab directly — only **reads**.
File writes go via `runtime-broker` (ephemeral docker exec) for code
generation, and through `gitlab-mcp.commit_file` for repo updates
(REST, not MCP).

### TPMS — structured project metadata + per-project records

Two services collaborate:

| Service | MCP tools | Returns | Use when |
|---|---|---|---|
| `tpms-fetcher` (:8021) | `fetch_project(oenum)`, `get_project_text(oenum)` | Raw JSON of TPMS rows (panels, feeders, equipment); or denormalized text dump | You need the underlying data, or a one-shot text snippet to drop into context |
| `tpms-context-agent` (:8050) | `get_project_context(oenum, sections=[...])` | Markdown blocks rendering selected slices (panels / feeders / customer specs / scopes) | You want **only the sections needed** for the current question — keeps context window small |

The TPMS DB stays read-only; both services query it but never write back.

Auxiliary index: `tpms-fetcher` also upserts **structured project metadata**
into `simorgh-projects` in Elasticsearch after every fetch (see
`context-search` integration below). That gives the CoT engine a third
shape — searchable + aggregable metadata — alongside the raw rows and
the rendered context.

### Elasticsearch (via context-search) — the analytics + recall surface

The agent's most powerful peer for analytical reasoning:

| Tool | Reads from | Use when |
|---|---|---|
| `context_search.search_context(q, project_id?, oenum?)` | `simorgh-content` (hybrid BM25+kNN over all indexed docs) | Narrative facts before generation |
| `context_search.search_projects_mcp(q)` | `simorgh-projects` (structured TPMS index) | Resolve a loose user reference to an oenum |
| `context_search.search_past_cot(q, project_id?)` | `simorgh-cot-YYYY.MM` | "Have I solved this before?" — procedural memory |
| `context_search.search_logs_mcp(q)` | `simorgh-logs-*` | Runtime evidence (did service X fail?) |
| `context_search.aggregate_field(index, group_by, metric, ...)` | All four indices | Counts, averages, p95s, distributions |
| `context_search.time_series_query(...)` | All four indices | Trends |
| `context_search.index_cot_trace(trace)` | `simorgh-cot-*` write | Persist the current reasoning (also done automatically at end of `analyze()`) |

See `context-search-service/README.md` for the full surface and example
patterns.

### The canonical "answer everything I know about project X" CoT pattern

```
USER: "Customer wants to switch ABC plant's 6.6 kV section to 3.3 kV.
       What's the blast radius?"

Step 1 — Resolve the project from loose reference (structured search):
  context_search.search_projects_mcp(query="ABC plant 6.6 kV")
  → oenum = "OE-2024-0457"

Step 2 — Procedural memory: have I tackled voltage-class changes before?
  context_search.search_past_cot(query="mid-project voltage change motor")
  → past trace shows the canonical checklist (cross-sections, breakers,
     EPLAN, SLD, customer notification)

Step 3 — Render TPMS context for the current project (only sections we need):
  tpms_context_agent.get_project_context(
    oenum="OE-2024-0457",
    sections=["panels", "feeders", "customer_specs"]
  )
  → markdown blocks ready to drop into the prompt

Step 4 — Read the per-project GitLab repo for engineering artefacts:
  gitlab_mcp.get_project_tree(project="simorgh-projects/OE-2024-0457",
                              path="schematics", recursive=true)
  gitlab_mcp.read_file_mcp(project="simorgh-projects/OE-2024-0457",
                            path="schematics/SLD-main.json")

Step 5 — Cross-reference standards in technical-knowledge:
  gitlab_mcp.search_technical_knowledge(query="6kV to 3.3kV conversion checklist")

Step 6 — Quantify the change with an aggregation (TPMS data, structured):
  context_search.aggregate_field(
    index="projects", group_by="motor_type",
    filter_query="oenum:OE-2024-0457"
  )
  → "2 induction, 1 synchronous" — concrete blast radius

Step 7 — Reflect, synthesize a complete answer with citations.

# At the end of analyze(), the engine auto-ships this whole reasoning
# trace to context-search via /index/cot, so the NEXT time someone
# asks a similar question Step 2 returns more relevant past traces.
```

### Picking the right tool at each step

| If you need… | Use this tool | Why |
|---|---|---|
| "What project does the user mean?" | `context_search.search_projects_mcp` | Hybrid search over structured + name + customer + tags |
| "Give me the project's spec data" | `tpms_context_agent.get_project_context` | Rendered for prompt, picks only the sections you ask |
| "Read the engineering artefacts" | `gitlab_mcp.read_file_mcp` / `get_project_tree` | Repo content |
| "Find similar past work" | `context_search.search_past_cot` | Procedural memory |
| "Reference cross-cutting standards" | `gitlab_mcp.search_technical_knowledge` | Tech-kb repo |
| "How many / average / p95 / top N" | `context_search.aggregate_field` | One ES round-trip instead of N retrievals |
| "Trend over time" | `context_search.time_series_query` | Date histogram |
| "Diagnose a service failure" | `context_search.search_logs_mcp` | Runtime evidence |

### What gets registered at startup

`services/mcp_manager.py` registers ~17 MCP peers on startup. The four
that matter most for project data:

- `gitlab_mcp` — `GITLAB_MCP_URL_MCP` (default `http://gitlab-mcp:8047/mcp`)
- `tpms_fetcher` — `TPMS_FETCHER_MCP_URL`
- `tpms_context_agent` — `TPMS_CONTEXT_MCP_URL`
- `context_search` — `CONTEXT_SEARCH_MCP_URL`

If any are unreachable the manager logs a warning and continues — those
specific tools just won't appear in the LLM's tool list for that boot.
The agent gracefully reasons with whatever subset is available.

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
