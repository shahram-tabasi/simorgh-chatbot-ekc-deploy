# chat-service

Modern chat + project workspace endpoints, extracted from
`backend/routes/chatbot_v2.py` and `backend/routes/project_session.py` in
phase 6.

| Property | Value |
|---|---|
| Container | `chat-service` |
| Port (internal) | **8034** |
| Image | built from `simorgh-agent/chat-service/Dockerfile` |
| Compose file | `simorgh-agent/compose/svc-chat.yml` |
| Network | `simorgh_app_net` |
| Storage | Redis (sessions, history), PostgreSQL (`message_store`), Qdrant (RAG), MySQL TPMS read-only |

---

## Endpoints

The service mounts two routers, each with its own prefix.

### Chat (`chatbot_v2_router`, prefix `/api/v2/chat`)

| Method | Path | Body | Purpose |
|---|---|---|---|
| `POST` | `/api/v2/chat/create` | `{title?, project_oenum?, ...}` | Create a new chat session |
| `POST` | `/api/v2/chat/{chat_id}/message` | `{message, mode?, stream?, ...}` | Send a message; streams SSE if `stream=true` |
| `POST` | `/api/v2/chat/{chat_id}/document` | multipart | Attach a document mid-chat |
| `PUT`  | `/api/v2/chat/{chat_id}/stage` | `{stage}` | Update agent COT stage |
| `GET`  | `/api/v2/chat/{chat_id}` | — | Chat metadata |
| `GET`  | `/api/v2/chat/{chat_id}/history` | `?limit=` | Past messages |
| `DELETE` | `/api/v2/chat/{chat_id}` | — | Delete a chat |
| `GET`  | `/api/v2/chat/tools/available` | — | Tools the user has access to |
| `GET`  | `/api/v2/chat/stats` | — | Per-user stats |
| `GET`  | `/api/v2/chat/health` | — | Sub-router health (DB-aware) |

### Project workspace (`project_session_router`, prefix `/api/v2/project`)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/v2/project/select` | Make a project active for the user |
| `POST` | `/api/v2/project/sync/{oenum}` | Trigger TPMS data sync |
| `GET`  | `/api/v2/project/sync/progress/{oenum}` | Poll sync progress |
| `GET`  | `/api/v2/project/sync/status/{oenum}` | Latest sync state |
| `GET`  | `/api/v2/project/missing-data/{oenum}` | Find missing fields |
| `POST` | `/api/v2/project/missing-data/{oenum}/resolve` | Mark resolved |
| `GET`  | `/api/v2/project/data/{oenum}/summary` | Project-wide summary |
| `GET`  | `/api/v2/project/data/{oenum}/panel/{panel_id}` | Per-panel detail |
| `GET`  | `/api/v2/project/list` | Projects the user can see |
| `GET`  | `/api/v2/project/tpms/tables` | TPMS catalog (admin/debug) |

> Note: the path is `/api/v2/project/*` (singular). Phase 10 nginx had it
> as `/api/v2/projects/*/sessions` — that was wrong and is fixed.

### Service liveness

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness — does NOT touch any backing store |

---

## Streaming model

Chat completions stream as **SSE** when `stream: true` is set. Each event
is a JSON object — `{"chunk": "..."}` for text, `{"meta": {...}}` for
tool call / stage updates, `{"done": true}` to terminate, `{"error": "..."}`
on failure. The client must parse each `data:` line as JSON.

The actual streaming is implemented in `services/llm_service.py` (extracted
from backend) which talks to the local LLM cluster via
`llm_async_client.py`. After phase C this becomes a thin proxy to
`llm-gateway:8030/generate/stream`.

---

## Environment variables

Copies the same env vars as backend (most heavyweight):

| Var | Default | Notes |
|---|---|---|
| `REDIS_URL` | `redis://redis:6379/0` | |
| `REDIS_CHAT_DB` | `1` | |
| `REDIS_CACHE_DB` | `2` | |
| `QDRANT_URL` | `http://qdrant:6333` | |
| `NEO4J_URI`/`USER`/`PASSWORD` | optional | |
| `POSTGRES_AUTH_*` | from compose | Stores `message_store` table |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | required for online | |
| `LOCAL_LLM_URL` | `http://nginx/api/llm` | |
| `DEFAULT_LLM_MODE` | `online` | |
| `LLM_GATEWAY_URL` | `http://llm-gateway:8030` | Used after phase C |
| `DOCUMENTS_RAG_URL` | `http://documents-rag-service:8033` | RAG retrieval after phase C |
| `SHELL_SERVICE_URL` | `http://192.168.1.69:8010` | For commands the agent runs |
| `*_MCP_URL` | one per microservice | AI/COT tool registry |
| `JWT_SECRET_KEY` | placeholder | Local JWT verification |

---

## How `backend/main.py` collaborates with it

### Today (phase B)

backend still has `app.include_router(chatbot_v2_router)` and
`app.include_router(project_session_router)`. Container nginx still routes
to backend for `/api/v2/chat/*` and `/api/v2/project/*`. The chat-service
container runs but isn't receiving traffic yet.

### After phase C

backend stops including these routers. Container nginx forwards directly:

```
/api/v2/chat/*    → chat-service:8034
/api/v2/project/* → chat-service:8034
```

Chat-service becomes the only place with chat business logic. The bulk-
copied `services/` directory will be pruned to keep only what chat needs:
- `chat_context_service.py`, `context_window_manager.py`
- `conversation_memory.py`, `conversation_summarizer.py`, `unified_memory_service.py`
- `session_manager.py`, `session_id_service.py`
- `message_persistence.py`
- `llm_service.py` (or replaced by httpx → llm-gateway)
- `redis_service.py`
- `auth_utils.py`
- `mcp_manager.py` (chat-service is also an MCP client)
- `microservice_clients.py`

The rest (auth_v2, payments, oauth, document chunker, etc.) get deleted.

---

## Local development

```bash
cd simorgh-agent
docker compose -f compose/infra-redis.yml \
               -f compose/infra-postgres-auth.yml \
               -f compose/infra-qdrant.yml \
               -f compose/svc-chat.yml \
               up --build
```

Smoke:
```bash
curl http://localhost:8034/health
```

(Real chat smoke tests need a valid JWT and at least an existing chat row.)

---

## Roadmap / known gaps

* **Replace in-process LLM with httpx to llm-gateway** — biggest follow-up.
* **Replace in-process Qdrant retrieval** with calls to a future
  `kb-search-service` (split out of documents-rag-service).
* **Async message store writes** — currently synchronous on each message;
  hot path can be backgrounded.
* **Per-user concurrency limit** — re-use the AsyncLLMClient's per-user
  tracker, currently only enforced inside LLMService.
* **Prune bulk-copied services/** — see "after phase C" list above.
