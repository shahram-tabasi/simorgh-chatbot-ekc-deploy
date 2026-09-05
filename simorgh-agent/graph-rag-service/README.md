# graph-rag-service

Standalone microservice for **Neo4j-backed graph RAG**. Wraps two real
classes from the original backend:

* `GraphRAG` (async) — natural-language query → entity extraction →
  subgraph retrieval → LLM-formatted context.
* `GraphRAGService` (sync) — structured read queries against the graph
  (project summary, document specs, etc.).

| Property | Value |
|---|---|
| Container | `graph-rag-service` |
| Port (internal) | **8037** |
| Image | built from `simorgh-agent/graph-rag-service/Dockerfile` |
| Compose file | `simorgh-agent/compose/svc-graph-rag.yml` |
| Network | `simorgh_app_net` |
| Mounted at nginx | `/api/v2/graph-rag/*` |
| Storage | Neo4j (required — bring up with `compose/infra-neo4j.yml`) |

> ⚠️ **Requires Neo4j.** If `NEO4J_URI` is not set or the container
> can't reach Neo4j, every endpoint returns **503**. The service still
> starts (so `/health` works) but the underlying clients are `None`.

---

## Endpoints

The phase-9 first pass exposed two endpoints (`/answer`, `/entities`) that
called methods that don't exist on the real classes (`answer_with_graph`,
`entity_linking`). Replaced with the genuine surface:

### Async — `GraphRAG`

| Method | Path | Body | Notes |
|---|---|---|---|
| `POST` | `/api/v2/graph-rag/query` | `QueryRequest` | Full flow: extract entities → retrieve subgraph (BFS) → format for LLM |
| `POST` | `/api/v2/graph-rag/hybrid-search` | `HybridSearchRequest` | Same as `/query` but combines optional Qdrant vector results with the graph context |
| `POST` | `/api/v2/graph-rag/entities` | `EntitiesRequest` | Just the entity extraction step (LLM only, no graph traversal) |

### Sync — `GraphRAGService`

| Method | Path | Body / params | Notes |
|---|---|---|---|
| `POST` | `/api/v2/graph-rag/search` | `SearchByQueryRequest` | Keyword-style search over graph nodes |
| `GET` | `/api/v2/graph-rag/projects/{project_oenum}/summary` | — | Aggregated summary of a project's graph |
| `GET` | `/api/v2/graph-rag/documents/{document_id}/specifications` | — | All specs attached to a document |

### Service health

| Method | Path | Returns |
|---|---|---|
| `GET` | `/health` | `{status, neo4j_connected}` — `neo4j_connected: false` means deps are down |

### Status codes

| Code | When |
|---|---|
| `200` | Success |
| `503` | Neo4j unreachable (driver `None`) |

---

## Request / response shapes

### `POST /api/v2/graph-rag/query`

```json
{
  "project_oenum": "OE12345",
  "user_query": "What's the rating of T1 transformer?",
  "project_context": "Substation in Tabriz",
  "max_hops": 2,
  "use_llm_formatting": true
}
```

Returns:

```json
{
  "success": true,
  "context": "T1 transformer (110/20 kV, 40 MVA) ...",
  "subgraph": { "items": [...], "entities": [...], "categories": [...] },
  "entities": { "equipment": ["T1"], ... },
  "stats": {"items_found": 3, "entities_found": 1, "categories": 2, "hops": 2}
}
```

---

## Startup wiring

```python
from neo4j import GraphDatabase

driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
graph_rag         = GraphRAG(driver=driver, openai_api_key=OPENAI_API_KEY)
graph_rag_service = GraphRAGService(driver=driver)
```

`GraphRAG` uses OpenAI for LLM-driven entity extraction; if
`OPENAI_API_KEY` isn't set it falls back to `_simple_entity_extraction`
(regex-based). After phase C this becomes a call to llm-gateway.

---

## Environment variables

| Var | Required | Default | Notes |
|---|---|---|---|
| `NEO4J_URI` | yes | — | e.g. `bolt://neo4j:7687` |
| `NEO4J_USER` | | `neo4j` | |
| `NEO4J_PASSWORD` | | placeholder | |
| `OPENAI_API_KEY` | for LLM entity extraction | — | Falls back to regex if missing |
| `LLM_GATEWAY_URL` | | `http://llm-gateway:8030` | Replaces in-process LLM after phase C |
| `QDRANT_URL` | | `http://qdrant:6333` | Used by hybrid search if present |
| `JWT_SECRET_KEY` | | placeholder | Local JWT verification |

---

## Talking to other services

```
   /api/v2/graph-rag/*
   ──────────────────▶ ┌────────────────────────┐
                       │                        │   bolt
                       │  graph-rag-service     ├──────▶  neo4j:7687
                       │           :8037        │
                       │                        │   HTTPS
                       │                        ├──────▶  api.openai.com (entity extraction)
                       │                        │
                       │                        │   gRPC (optional, hybrid)
                       │                        ├──────▶  qdrant:6333
                       └────────────────────────┘
```

Stateless apart from Neo4j. The neo4j driver is connection-pooled.

---

## How `backend/main.py` collaborates with it

### Today (phase B)

backend doesn't expose graph-RAG endpoints externally; the original code
constructed `GraphRAG` in-process inside chat-service / documents-rag flows.

### After phase C

Other services (chat-service, documents-rag-service, project-agent-service)
that need graph context call this service:

```python
import httpx, os
GRAPH_RAG_URL = os.getenv("GRAPH_RAG_URL", "http://graph-rag-service:8037")

async def graph_query(project_oenum, user_query):
    async with httpx.AsyncClient(timeout=120) as c:
        r = await c.post(f"{GRAPH_RAG_URL}/api/v2/graph-rag/query",
                         json={"project_oenum": project_oenum,
                               "user_query": user_query})
        r.raise_for_status()
        return r.json()
```

For the AI/COT agent (`project-agent-service`), a `GRAPH_RAG_MCP_URL`
isn't available yet — this service is REST-only by design (see "Roadmap").

---

## Local development

```bash
cd simorgh-agent
docker compose -f compose/infra-neo4j.yml \
               -f compose/svc-llm-gateway.yml \
               -f compose/svc-graph-rag.yml \
               up --build
```

Smoke:

```bash
curl http://localhost:8037/health

# Entity extraction (no graph hit; just LLM)
curl -s -X POST http://localhost:8037/api/v2/graph-rag/entities \
  -H 'Content-Type: application/json' \
  -d '{"query": "What is the impedance of T1?"}'

# Full flow (requires a project graph already built — see
# documents-rag-service /api/projects/{oenum}/init-graph)
curl -s -X POST http://localhost:8037/api/v2/graph-rag/query \
  -H 'Content-Type: application/json' \
  -d '{"project_oenum": "OE12345", "user_query": "T1 specs"}'
```

---

## Roadmap / known gaps

* **Add an MCP surface** — currently REST-only; the AI agent can't
  discover tools here. Wrap the same methods in `FastMCP`.
* **Replace OpenAI direct calls with httpx → llm-gateway** — same pattern
  as every other extracted service.
* **Cache subgraph lookups** — repeat queries on the same project hit
  Neo4j every time. Redis-cache the subgraph keyed by
  `sha256(project_oenum + user_query + max_hops)`.
* **Graph schema docs** — there's no formal schema doc for what
  nodes/edges should look like. Reverse-engineering it from
  `services/graph_builder.py` (in documents-rag-service) is needed before
  any external team can use this service.
* **Connection retry on Neo4j restart** — currently the driver is created
  at startup and never re-created. If Neo4j restarts, this service fails
  forever until restarted. Add a reconnect.
