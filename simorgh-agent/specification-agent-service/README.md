# specification-agent-service

Standalone microservice for **electrical-spec extraction** + **document
classification** of indexed project files.

| Property | Value |
|---|---|
| Container | `specification-agent-service` |
| Port (internal) | **8036** |
| Image | built from `simorgh-agent/specification-agent-service/Dockerfile` |
| Compose file | `simorgh-agent/compose/svc-specification-agent.yml` |
| Network | `simorgh_app_net` |
| Mounted at nginx | `/api/v2/specs/*` (REST), `/mcp` (MCP, internal) |

---

## What it does

* **`DocumentClassifier`** — given a filename (and optionally the document's
  text), returns a `(category, doc_type, confidence)` tuple. Categories are
  `Client`, `EKC`, `Drawing`, `Identity`, `Unknown`. Heuristic + filename
  pattern matching, no LLM call. Cheap, deterministic.

* **`EnhancedSpecExtractor`** — two-stage RAG extraction over an indexed
  project document:
  1. for each spec field (e.g. "rated voltage", "transformer rating"),
     consult the per-field extraction guide
  2. semantic-search Qdrant for the top N relevant chunks
  3. ask the LLM to extract the specific value with the guide's
     instructions + the retrieved chunks
  Returns `{category: {field: value, ...}, ...}`.

The chat-style multi-turn `SpecificationAgent` is **intentionally not
exposed** — it depends on a CocoIndex graph adapter that isn't bundled in
this service. See "Roadmap".

---

## Endpoints

### REST (`/api/v2/specs/*`)

| Method | Path | Body | Returns |
|---|---|---|---|
| `POST` | `/api/v2/specs/classify` | `{filename, content?}` | `{category, doc_type, confidence}` |
| `POST` | `/api/v2/specs/extract` | `{project_number, document_id, llm_mode?, search_limit?}` | `{specs: {...}}` |
| `GET` | `/health` | — | `{status, classifier_ready, extractor_ready}` |

### MCP (`/mcp`)

| Tool | Args | Notes |
|---|---|---|
| `classify_document(filename, content?)` | str, str? | Cheap, no LLM |
| `extract_specifications(project_number, document_id, llm_mode='online', search_limit=5)` | | Document must already be indexed in Qdrant; calls LLM many times (one per field) |

The phase-7 first-pass tools I wrote (`extract_specifications(text, equipment_hint?)`, `extract_specs_from_document(document_id, scope?)`) called methods that don't exist on the real classes. Replaced with the genuine signatures.

### Status codes

| Code | When |
|---|---|
| `200` | Success |
| `503` | Service didn't initialise (Qdrant down at startup, or classifier failed) |

---

## Startup wiring

```
DocumentClassifier()                       # no deps
EnhancedSpecExtractor(
    llm_service=get_llm_service(),         # LLM gateway
    qdrant_service=QdrantService(...),     # vector store
    graph_initializer=ProjectGraphInitializer(neo4j_driver),  # optional
)
```

If Qdrant is unreachable on startup, the extractor stays `None` and `/extract`
returns 503. The classifier always works (no external deps). If Neo4j is
unconfigured (no `NEO4J_URI`), graph-aware extraction is silently disabled.

---

## Environment variables

| Var | Required | Default | Notes |
|---|---|---|---|
| `OPENAI_API_KEY` | for online | — | Most extraction calls go to OpenAI |
| `OPENAI_MODEL` | | `gpt-4o` | |
| `LOCAL_LLM_URL` | | `http://nginx/api/llm` | offline fallback |
| `DEFAULT_LLM_MODE` | | `online` | |
| `LLM_GATEWAY_URL` | | `http://llm-gateway:8030` | After phase C, replaces in-process LLM |
| `QDRANT_URL` | yes | `http://qdrant:6333` | |
| `NEO4J_URI` | | (empty) | If unset, graph-aware extraction off |
| `NEO4J_USER` / `NEO4J_PASSWORD` | with NEO4J_URI | — | |
| `JWT_SECRET_KEY` | | placeholder | Local JWT verification |

---

## Talking to other services

```
   /api/v2/specs/*         ┌────────────────────────────┐
   /mcp                    │                            │
   ───────────────────────▶│ specification-agent-service│
                           │           :8036            │
                           │                            │   HTTP
                           │                            ├──────▶ llm-gateway:8030
                           │                            │   gRPC
                           │                            ├──────▶ qdrant:6333
                           │                            │   bolt
                           │                            ├──────▶ neo4j:7687 (optional)
                           └────────────────────────────┘
```

---

## How `backend/main.py` collaborates with it

### Today (phase B)

backend doesn't expose any HTTP endpoint for spec extraction; the original
flow was: chat-service or documents-rag-service constructs an
`EnhancedSpecExtractor` in-process and calls it directly.

### After phase C

Other services that need spec extraction call this service:

```python
# documents-rag-service or chat-service after phase C
import httpx, os
SPEC_URL = os.getenv("SPEC_URL", "http://specification-agent-service:8036")

async def extract(project_number, document_id):
    async with httpx.AsyncClient(timeout=600) as c:  # multi-field extraction is slow
        r = await c.post(f"{SPEC_URL}/api/v2/specs/extract",
                         json={"project_number": project_number,
                               "document_id": document_id})
        r.raise_for_status()
        return r.json()["specs"]
```

For AI/COT planning (project-agent-service's COT engine), the MCP tool
catalogue auto-discovers `classify_document` and `extract_specifications`
once `SPECIFICATION_AGENT_MCP_URL=http://specification-agent-service:8036/mcp`
is in the agent's env. After that the agent can plan steps like
"first classify, then extract specs" without backend wiring.

---

## Local development

```bash
cd simorgh-agent
docker compose -f compose/infra-qdrant.yml \
               -f compose/svc-llm-gateway.yml \
               -f compose/svc-specification-agent.yml \
               up --build
```

Smoke:

```bash
curl http://localhost:8036/health

curl -s -X POST http://localhost:8036/api/v2/specs/classify \
  -H 'Content-Type: application/json' \
  -d '{"filename": "Simoprime A4-Design 11.pdf"}'

# extract requires a project + document ALREADY indexed in Qdrant
curl -s -X POST http://localhost:8036/api/v2/specs/extract \
  -H 'Content-Type: application/json' \
  -d '{"project_number": "OE12345", "document_id": "doc-xyz", "llm_mode": "online"}'
```

---

## Roadmap / known gaps

* **Expose `SpecificationAgent`** — the multi-turn chat agent for
  spec-extraction sessions. Needs a `cocoindex_adapter` instance, which
  in turn needs the CocoIndex stack running. Bring up
  `compose/infra-cocoindex.yml` first, then add another tool.
* **Replace in-process LLM with httpx → llm-gateway** — same pattern as
  every other extracted service.
* **Streaming extract** — `extract_specifications_enhanced` is sequential
  per field and can take 30+ seconds. Add an SSE variant that yields
  per-field results.
* **Cache extracted specs in Qdrant payload** — re-running is wasteful;
  store the result on the document's points so a second call is free.
* **Field guide hot-reload** — the extraction guides are imported from
  `services/extraction_guides_data.py`; reload without container restart
  if you tune them.
