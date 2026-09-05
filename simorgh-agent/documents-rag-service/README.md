# documents-rag-service

Standalone microservice for **document upload + RAG indexing + semantic
search**, plus several legacy endpoints that the original backend grouped
under the same FastAPI router. Extracted from `backend/routes/documents_rag.py`
in phase 5.

| Property | Value |
|---|---|
| Container | `documents-rag-service` |
| Port (internal) | **8033** |
| Image | built from `simorgh-agent/documents-rag-service/Dockerfile` |
| Compose file | `simorgh-agent/compose/svc-documents-rag.yml` |
| Network | `simorgh_app_net` |
| Storage | Qdrant (vectors), PostgreSQL (metadata), Redis (cache + task state), optional Neo4j |

> ⚠️ **Naming caveat.** The router file was named `documents_rag.py` in
> the monolith but actually contains a grab-bag of endpoints — document
> upload, chat (general + project-scoped), session management, and project
> graph init. They were not separated cleanly. This service inherits that
> grab-bag. Renaming it to something like `kb-service` is on the roadmap
> (after phase C), once the chat-vs-documents separation is settled.

---

## Endpoints

The router has prefix `/api`. External paths:

| Method | Path | Purpose |
|---|---|---|
| `POST`   | `/api/documents/upload` | Multipart upload — accepts PDF/Excel/Word, dispatches doc-processor, chunks, embeds, upserts into Qdrant. Returns `{document_id, task_id}`. |
| `POST`   | `/api/chat/general` | Open-domain chat (general LLM call, optional Qdrant retrieval). **Legacy** — the modern flow uses `chat-service:/api/v2/chat`. |
| `POST`   | `/api/chat/project` | Project-scoped chat using a project's documents as RAG context. Also legacy — supersedes by `chat-service:/api/v2/chat` once that handles project context. |
| `DELETE` | `/api/sessions/{session_id}` | Delete a chat session. |
| `DELETE` | `/api/projects/{project_oenum}/session` | Delete the active project session. |
| `GET`    | `/api/users/{user_id}/sessions` | List a user's chat sessions. |
| `POST`   | `/api/projects/{oenum}/init-graph` | Build the project's knowledge graph (Qdrant + optional Neo4j entities). Long-running; returns `{task_id}` to poll. |
| `GET`    | `/api/projects/{oenum}/graph-status` | Polling endpoint for the above. |

### Service health

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness — does NOT touch any backing store |

### Status codes

| Code | When |
|---|---|
| `200` | Success |
| `400` | Validation failed (file type, missing fields) |
| `401`/`403` | JWT missing / invalid (auth verified locally via `auth_utils`) |
| `404` | Document / project / session not found |
| `413` | File too large |
| `500` | Backing store error |

---

## Document upload pipeline

```
   1. POST /api/documents/upload (multipart)
        │
        ▼
   2. Save bytes to /app/uploads (volume)
        │
        ▼
   3. Call doc-processor:8000/convert → returns Markdown
        │
        ▼
   4. document_chunker.py — semantic chunks (overlap, header-aware)
        │
        ▼
   5. embedding:
       - if LLM_GATEWAY_URL set: POST /embeddings (text-embedding-3-large)
       - else: POST embeddings-service:8031/embeddings (MiniLM)
        │
        ▼
   6. Qdrant upsert  (collection per project, points per chunk)
        │
        ▼
   7. (optional) graph_builder.py — extract entities, push to Neo4j
        │
        ▼
   8. Update Redis task tracker → "completed"
        │
        ▼
   9. Response: {document_id, task_id, chunks_count}
```

The pipeline is **synchronous within the request** by default. For large
documents (50+ MB), the request can hang for ~60s. Use `task_id` polling
to track progress and add a `BackgroundTasks` queue if you want async
return — currently a known gap.

---

## Environment variables

| Var | Default | Notes |
|---|---|---|
| `REDIS_URL` | `redis://redis:6379/0` | Cache + task tracker |
| `QDRANT_URL` | `http://qdrant:6333` | Vector store |
| `NEO4J_URI` | (empty) | If unset, graph features no-op |
| `NEO4J_USER` / `NEO4J_PASSWORD` | (empty) | |
| `POSTGRES_AUTH_*` | postgres_auth defaults | For document metadata + project ownership |
| `OPENAI_API_KEY` | — | If using LLM-based embeddings |
| `OPENAI_MODEL` | `gpt-4o` | For spec extraction prompts |
| `LOCAL_LLM_URL` | `http://nginx/api/llm` | Fallback for offline mode |
| `LLM_GATEWAY_URL` | `http://llm-gateway:8030` | Preferred — see below |
| `EMBEDDINGS_URL` | `http://embeddings-service:8031` | sentence-transformers fallback |
| `DOC_PROCESSOR_URL` | `http://doc-processor:8000` | Document → Markdown |
| `JWT_SECRET_KEY` | placeholder | Used to verify Authorization header |
| `LOG_LEVEL` | `INFO` | |

The HF caches (`huggingface_cache`, `sentence_transformers_cache`) are
mounted as named volumes shared with backend, so models are downloaded
once.

The `../uploads:/app/uploads` bind mount is shared with backend so
uploaded files are visible from both during the transition.

---

## Talking to other services

```
   POST /api/documents/upload
            │
            ▼
   ┌──────────────────────────┐         ┌────────────────┐
   │                          │         │ doc-processor  │
   │  documents-rag-service   ├────────▶│      :8000     │
   │           :8033          │  HTTP   └────────────────┘
   │                          │
   │                          │   HTTP  ┌────────────────┐
   │                          ├────────▶│ llm-gateway    │
   │                          │         │     :8030      │
   │                          │
   │                          │   HTTP  ┌────────────────┐
   │                          ├────────▶│ embeddings-svc │
   │                          │         │     :8031      │
   │                          │
   │                          │  gRPC/  ┌────────────────┐
   │                          ├────────▶│    qdrant      │
   │                          │  HTTP   │     :6333      │
   │                          │
   │                          │  bolt   ┌────────────────┐
   │                          ├────────▶│     neo4j      │
   │                          │         │     :7687      │
   │                          │         └────────────────┘
   │                          │   asyncpg
   │                          ├────────▶  postgres_auth:5432 (metadata)
   │                          │
   │                          │   Redis
   │                          ├────────▶  redis:6379 (task state)
   └──────────────────────────┘
```

---

## How `backend/main.py` collaborates with it

### Today (phase B)

`backend/main.py` still has `app.include_router(documents_rag_router)` and
backend's container nginx still routes `/api/documents/*`, `/api/chat/*`,
`/api/sessions/*` to backend. The documents-rag-service container also
listens for those paths but isn't receiving any traffic yet.

### After phase C

Backend stops including the router. Container nginx routes the matching
paths directly to documents-rag-service. Backend code that wants to
upload programmatically (it doesn't, currently) would call:

```python
# backend/services/documents_client.py (after phase C)
import httpx, os
BASE = os.getenv("DOCUMENTS_RAG_URL", "http://documents-rag-service:8033")
async def upload(file_bytes, filename, project_id, jwt):
    async with httpx.AsyncClient() as c:
        r = await c.post(f"{BASE}/api/documents/upload",
                         files={"file": (filename, file_bytes)},
                         data={"project_id": project_id},
                         headers={"Authorization": f"Bearer {jwt}"})
        r.raise_for_status()
        return r.json()
```

Other services that need RAG retrieval (chat, graph-rag) currently call
into the in-process `services/qdrant_service.py`. After phase C they'll
either:
- talk directly to Qdrant (cheaper, no HTTP hop), or
- call documents-rag-service's `/api/projects/{oenum}/graph-status` style
  endpoints if they need orchestrated logic (not just raw vector search).

The cleaner direction is **direct Qdrant access** for read paths,
documents-rag-service only for write paths (upload + index). The current
README leaves both options open; pick before phase C.

---

## Local development

### Run alone (with deps)

```bash
cd simorgh-agent
docker compose -f compose/infra-redis.yml \
               -f compose/infra-qdrant.yml \
               -f compose/infra-postgres-auth.yml \
               -f compose/svc-doc-processor.yml \
               -f compose/svc-embeddings.yml \
               -f compose/svc-documents-rag.yml \
               up --build
```

That brings up the minimum stack to upload + search.

### Smoke tests

```bash
curl -s http://localhost:8033/health

# Upload (after exposing port via override or running on host)
curl -s -X POST http://localhost:8033/api/documents/upload \
  -H "Authorization: Bearer $JWT" \
  -F "file=@./Simoprime A4-Design 11.pdf" \
  -F "project_id=demo"
```

---

## Files

| Path | Purpose |
|---|---|
| `main.py` | FastAPI app + CORS + router include |
| `routes/documents_rag.py` | Upload, chat, sessions, graph init endpoints |
| `services/qdrant_service.py` | Qdrant client + embedding pipeline |
| `services/document_chunker.py` | Semantic chunking |
| `services/document_classifier.py` | Equipment-type classifier |
| `services/document_overview_service.py` | Page-level summaries |
| `services/section_retriever.py` | Hybrid (vector + keyword) retrieval |
| `services/graph_builder.py` | Entity extraction → Neo4j |
| `services/graph_rag.py`, `graph_rag_service.py` | Graph-augmented retrieval |
| `services/vector_rag.py` | Pure vector retrieval |
| `services/spec_extractor.py`, `enhanced_spec_extractor.py` | Pull electrical specs from chunks |
| `services/grounded_response_service.py` | Format final answer with citations |
| `services/llm_service.py`, `llm_async_client.py` | LLM client (will be replaced by HTTP to llm-gateway in phase C) |
| `services/redis_service.py` | Caching, session storage |
| `services/auth_utils.py` | Local JWT verification (no roundtrip to auth-service) |
| `services/cancellation_service.py` | Cooperative request cancellation |
| `services/doc_processor_client.py` | HTTP client to doc-processor:8000 |
| `services/document_processing_integration.py` | Orchestrates upload → chunk → embed → index |
| `database/postgres_connection.py` | Async + sync Postgres pools |
| `Dockerfile` | python:3.11-slim + tesseract + poppler + libgl, port 8033 |

The `services/` dir was bulk-copied from backend in phase 5 and contains
much more than this service strictly needs. Phase C / future cleanup will
prune the unused modules — see roadmap.

---

## Roadmap / known gaps

* **Big — split this service.** The grab-bag router has both upload (write)
  and chat (read) responsibilities. They have different scaling, latency,
  and dependency profiles. Split into `documents-service` (upload + index)
  and `kb-search-service` (read-only retrieval).
* **Async upload** — large PDFs hang the request. Move chunking + embedding
  to a background task with status polling.
* **Replace in-process LLM with HTTP to llm-gateway** — the `LLMService`
  copy here re-implements what llm-gateway already does. After phase C,
  delete this copy and use `httpx` to call `llm-gateway:8030`.
* **Replace in-process embedding model with HTTP to embeddings-service** —
  same idea, the `SentenceTransformer` lives in `qdrant_service.py`.
* **Per-tenant Qdrant collections** — currently keyed by project oenum;
  add user/tenant isolation if you ever multi-tenant this.
* **Prune the bulk-copied `services/` dir** — many modules in there
  (e.g. `payment_service.py`, `oauth_service.py`, `email_service.py`)
  belong to other extracted services and aren't used here.
