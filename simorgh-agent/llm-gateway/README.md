# llm-gateway

Standalone REST microservice that fronts both the **OpenAI API** and the **local
LLM cluster** (load-balanced nginx → 192.168.1.61 / 192.168.1.62) behind one
HTTP contract.

Extracted from `backend/services/llm_service.py` in phase 2 of the monolith
decomposition.

| Property | Value |
|---|---|
| Container | `llm-gateway` |
| Port (internal) | **8030** |
| Image | built from `simorgh-agent/llm-gateway/Dockerfile` (no registry) |
| Compose file | `simorgh-agent/compose/svc-llm-gateway.yml` |
| Network | `simorgh_app_net` |
| Mounted at nginx | `/api/llm-gateway/` (host nginx) |

---

## What it does

* Picks between OpenAI (`OPENAI_API_KEY` + `OPENAI_MODEL`) and the local LLM
  cluster (via `LOCAL_LLM_URL`) based on the per-request `mode` field
  (`online` / `offline` / `auto`).
* Exposes the same surface as the old in-process `LLMService` class so callers
  can swap their imports for HTTP without behaviour changes.
* Streams responses as SSE with JSON-encoded chunks (so newlines in model
  output don't break the protocol).
* Strips reasoning / `<think>` tags from local-model output via
  `output_parser.py`.
* Continues truncated responses automatically up to 3 times
  (`_continue_truncated_response`).
* Tracks per-user concurrent requests through `llm_async_client.py` so heavy
  users can't monopolise the local cluster.

It does **not** do:

* Caching — it accepts `use_cache=true` but Redis isn't wired in here. To
  re-enable caching, inject a `RedisService` instance in `main.py:llm = LLMService(...)`.
* Knowledge-base injection — the `inject_knowledge=true` field is honoured
  syntactically but the `knowledge.electrical_anthology` module is not bundled
  in this service. The injection silently no-ops with a warning. **If a caller
  needs the electrical knowledge base in the system prompt, prepend it before
  calling `/generate`.** This is by design: knowledge ownership belongs to
  whichever service owns chat context (currently `chat-service`).

---

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/health`         | Liveness — does NOT call OpenAI. Returns `{"status": "healthy"}` if the process is up. Used by the Docker healthcheck (every 30 s). |
| `GET`  | `/health/deep`    | Readiness — actually probes OpenAI + the local LLM endpoint. Costs API calls; do **not** wire to Docker healthcheck. |
| `GET`  | `/stats`          | Cumulative request counters (`total`, `online`, `offline`, `cache_hits`, `failures`). |
| `POST` | `/generate`       | Synchronous completion. Body: `GenerateRequest`. |
| `POST` | `/generate/stream`| SSE streaming. Body: `GenerateRequest`. Each event is `data: {"chunk": "..."}\n\n`, terminated by `data: {"done": true}` or `data: {"error": "..."}`. |
| `POST` | `/generate/async` | Non-blocking version with per-`user_id` rate-tracking. Body: `AsyncGenerateRequest`. |
| `POST` | `/embeddings`     | Single text → vector. Body: `{"text": "...", "mode": "online|offline", "model": "text-embedding-3-large"}`. |

### Request body (`GenerateRequest`)

```json
{
  "messages": [
    {"role": "system", "content": "You are Simorgh, an industrial electrical assistant."},
    {"role": "user",   "content": "Specs for a 1600A MCC?"}
  ],
  "mode": "auto",
  "temperature": 0.7,
  "max_tokens": null,
  "use_cache": false,
  "inject_knowledge": false
}
```

`mode`: `"online"` forces OpenAI, `"offline"` forces local LLM, `"auto"` tries
online first and falls back to offline on any failure. Omit / null → uses
`DEFAULT_LLM_MODE` env (default `"online"`).

### Response body

```json
{
  "response": "<text>",
  "mode": "online",
  "model": "gpt-4o",
  "tokens": {"prompt": 12, "completion": 87, "total": 99},
  "finish_reason": "stop",
  "cached": false
}
```

`tokens` is `{0,0,0}` for offline calls — the local server doesn't report
token counts.

### Status codes

| Code | When |
|---|---|
| `200` | Success |
| `502` | OpenAI or local LLM unreachable |
| `504` | Upstream timeout (`LLMTimeoutError`) |
| `500` | Other LLM error |

---

## Environment variables

| Var | Default | Notes |
|---|---|---|
| `OPENAI_API_KEY` | — | Required for online mode |
| `OPENAI_MODEL` | `gpt-4o` | |
| `LOCAL_LLM_URL` | `http://nginx/api/llm` | nginx upstream that load-balances 1.61/1.62 |
| `DEFAULT_LLM_MODE` | `online` | `online` / `offline` / `auto` |
| `LOG_LEVEL` | `INFO` | |
| `PYTHONUNBUFFERED` | `1` | |

All set in `compose/svc-llm-gateway.yml`. None of the database envs are
needed — this service is stateless.

---

## Talking to other services

```
                       ┌────────────────────┐
   /api/llm-gateway/   │                    │   OPENAI_API_KEY
   ─────────────▶ nginx│   llm-gateway:8030 │ ──▶ api.openai.com
                       │                    │
                       │                    │   LOCAL_LLM_URL
                       │                    │ ──▶ nginx:80/api/llm
                       └────────────────────┘     │
                                                  ├─▶ 192.168.1.61:80
                                                  └─▶ 192.168.1.62:80
```

The gateway is **stateless** and **horizontally scalable**. It only writes
to its in-memory `stats` dict; nothing is persisted.

---

## How it collaborates with `backend/main.py`

In phase 2 the backend monolith was left untouched and still owns the same
`LLMService` class in-process. After phase C (slim backend) is complete,
`backend/main.py` imports a thin client instead:

```python
# backend/services/llm_client.py (after phase C)
import httpx, os

LLM_GATEWAY_URL = os.getenv("LLM_GATEWAY_URL", "http://llm-gateway:8030")

class LLMClient:
    def __init__(self):
        self._http = httpx.AsyncClient(base_url=LLM_GATEWAY_URL, timeout=600.0)

    async def generate(self, messages, mode=None, **kw):
        r = await self._http.post("/generate", json={"messages": messages, "mode": mode, **kw})
        r.raise_for_status()
        return r.json()

    async def stream(self, messages, mode=None, **kw):
        async with self._http.stream("POST", "/generate/stream",
                                     json={"messages": messages, "mode": mode, **kw}) as r:
            async for line in r.aiter_lines():
                if line.startswith("data: "):
                    yield json.loads(line[6:])
```

Backend code that previously did:

```python
from services.llm_service import get_llm_service
llm = get_llm_service()
result = llm.generate(messages, mode="online")
```

becomes:

```python
from services.llm_client import LLMClient
result = await LLMClient().generate(messages, mode="online")
```

**The contract — methods, request fields, return shape — is unchanged.** Only
the transport flips from in-process call to HTTP POST.

Other services that previously used `LLMService` directly (chat, documents-rag,
graph-rag, specification-agent, project-agent) all do the same flip. They get
the URL via `LLM_GATEWAY_URL` env var, already wired in their compose files.

---

## Local development

### Build & run alone

```bash
cd simorgh-agent
docker compose -f compose/svc-llm-gateway.yml up --build
# now reachable at http://localhost:8030 if you publish the port
```

To publish the port for local poking, override `expose:` with `ports:`:

```bash
docker run --rm -p 8030:8030 \
  -e OPENAI_API_KEY=$OPENAI_API_KEY \
  -e LOCAL_LLM_URL=http://192.168.1.68/api/llm \
  $(docker build -q simorgh-agent/llm-gateway)
```

### Run the FastAPI app on the host without Docker

```bash
cd simorgh-agent/llm-gateway
pip install -r requirements.txt
OPENAI_API_KEY=sk-... uvicorn main:app --host 0.0.0.0 --port 8030 --reload
```

### Smoke tests

```bash
curl -s http://localhost:8030/health
# {"status":"healthy","service":"llm-gateway"}

curl -s http://localhost:8030/health/deep
# Full upstream probe — costs an OpenAI API call.

curl -s -X POST http://localhost:8030/generate \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"hi"}],"mode":"online","max_tokens":20}'

curl -N -X POST http://localhost:8030/generate/stream \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"count to 5"}],"mode":"online"}'
```

---

## Files

| File | Purpose |
|---|---|
| `main.py` | FastAPI app — request models, route handlers, exception → HTTP mapping |
| `llm_service.py` | `LLMService` class — picks online/offline, retries, cache, embeddings (lifted from backend) |
| `llm_async_client.py` | Async HTTP client to the local LLM cluster, per-user request tracking |
| `output_parser.py` | Strips `<think>` / `<reasoning>` / chain-of-thought sections from local model output |
| `requirements.txt` | fastapi, uvicorn, openai, httpx, requests, pydantic |
| `Dockerfile` | python:3.11-slim, exposes 8030, healthcheck on `/health` |

---

## Roadmap / known gaps

* **Caching** — wire Redis back in (`use_cache=True` is currently inert here).
* **Per-tenant rate limiting** — the async path tracks per-user counts but
  doesn't reject; add a quota check.
* **Retry on local-cluster 5xx** — currently the failover only fires on
  connection errors; consider also retrying on 502/503/504 from the .61/.62
  nginx.
* **Embedding caching** — embeddings are deterministic; Redis hash by sha256
  of text would be a clean win.
* **Tracing** — no OpenTelemetry yet; add it once chat-service is also out
  of the monolith so traces span the whole request.
