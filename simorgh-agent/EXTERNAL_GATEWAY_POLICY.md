# External-resource gateway policy

**Rule.** No service in the simorgh stack may connect directly to any
external system (database, file share, third-party API, mail server,
LLM, etc.). For every external system there is exactly one **gateway
service** that owns the connection and exposes a clean HTTP / MCP
contract over the internal `simorgh_app_net`. All other services call
the gateway over HTTP, never the external system.

## Why

* **Blast radius.** A leaked password / SQL-injection bug / runaway
  query is contained in one container.
* **Credentials.** External credentials live in *one* env var set, not
  scattered across every consumer.
* **Schema changes.** When the external schema or API shape moves, only
  the gateway has to change.
* **Caching.** Adding a Redis cache, retry, or rate-limit happens in
  one place.
* **Observability.** Every external call is on one container's log
  pipeline; one place to add metrics / tracing / audit.
* **Replaceability.** If the external system is ever swapped, the
  gateway is the only thing that has to know.

## The canonical gateway map

| External system | Gateway service | Port | Protocol(s) |
|---|---|---|---|
| MySQL TPMS @ 192.168.1.148 — **project tables** | `tpms-fetcher` | 8021 | REST + MCP |
| MySQL TPMS @ 192.168.1.148 — **HR / org tables** | `org-data-service` | 8042 | MCP |
| MSSQL `Eplan_n2` @ 192.168.1.39 | `eplan-sql-service` | 8044 | REST + MCP |
| Techserver SMB share @ 192.168.1.3 | `techserver-service` | 8043 | REST + MCP |
| HR / org documents (filesystem) | `hr-kb-service` | 8041 | REST + MCP |
| OpenAI API + local LLM @ 192.168.1.61/.62 | `llm-gateway` | 8030 | REST |
| Sentence-Transformers embeddings | `embeddings-service` | 8031 | REST |
| Outbound SMTP / Resend mail | `mail-gateway` | 8027 | REST (extension pending — see TODO) |
| Inbound mail (SMTP listener) | `mail-gateway` | 2525 | SMTP |
| NOWPayments crypto API | `payments-service` | 8038 | REST |
| Google OAuth 2.0 | `auth-service` | 8032 | REST |
| Document conversion (pdfplumber / unstructured / OCR) | `doc-processor` | 8000 | REST |
| Whisper STT | `stt-service` | 8001 | REST + WS |
| Edge-TTS | `tts-service` | 8002 | REST |
| Web search (DuckDuckGo) | `search-service` | 8020 | REST + MCP |
| EPLAN over TCP | `eplan-bridge` | 8026 | REST + MCP |

If a service needs something not on this list, **add a new gateway**
before adding the dependency.

## What "direct" means — concretely forbidden

Inside any service container that is not the listed gateway:

| Pattern | Forbidden |
|---|---|
| `import pymysql` and connect to 192.168.1.148 | yes |
| `import pymssql` / `import pyodbc` and connect to 192.168.1.39 | yes |
| `subprocess.run(["smbclient", ...])` | yes |
| `import openai` configured against api.openai.com | yes |
| `requests.post("http://192.168.1.61/...")` | yes |
| `from sentence_transformers import SentenceTransformer` and load a model in-process | yes |
| `smtplib.SMTP("smtp.gmail.com", 587)` | yes |
| Mounting `${TECHSERVER}` as a volume | yes |

Allowed:

| Pattern | Allowed |
|---|---|
| `httpx.post("http://eplan-sql-service:8044/parts", json=...)` | yes |
| `httpx.post("http://llm-gateway:8030/generate", json=...)` | yes |
| `mcp.client.connect("http://org-data-service:8042/mcp")` | yes |

## Current violations to migrate

The pre-decomposition backend was a monolith and many of the bulk-copied
service modules in extracted services still contain direct external
calls. Each is a follow-up clean-up and is tracked in the corresponding
service's README "roadmap":

* `auth-service` — `services/tpms_auth_service.py` connects directly to
  MySQL TPMS for legacy login. Migration: route through `org-data-service`
  or add a thin `lookup_login_user` MCP tool there.
* `auth-service` — `services/sql_auth_service.py` connects to MSSQL
  directly. Migration: replace with a call to `eplan-sql-service`.
* `auth-service` — `services/email_service.py` opens `smtplib` directly
  for outbound. Migration: extend `mail-gateway` with `POST /send` and
  use it; remove `smtplib` from auth-service.
* `chat-service`, `documents-rag-service`, `graph-rag-service`,
  `project-agent-service`, `specification-agent-service` — all carry a
  bulk-copied `services/llm_service.py` that talks to OpenAI and the
  local LLM cluster directly. Migration: replace each with a thin
  client to `llm-gateway:8030`.
* `documents-rag-service`, `chat-service`, etc. — bulk-copied
  `services/qdrant_service.py` instantiates a local
  `SentenceTransformer`. Migration: call `embeddings-service:8031`.
* `simorgh-soft` — hard-coded SQL Server creds
  (`SQL_USER`/`SQL_PASSWORD`/`SQL_SERVER`) and direct `pymssql`
  connections to .39. Migration: route through `eplan-sql-service`.
* `backend`, `project-agent-service`, `shell-service` — `TECHSERVER_*`
  envs and direct SMB calls. Migration: route through `techserver-service`.

These are real code changes inside existing services, not just compose
changes — they're tracked in each service's README rather than this
policy doc.

## How to add a new gateway

1. Pick a port in the 80xx range that isn't taken (see compose/).
2. `mkdir simorgh-agent/<name>-service` with:
   ```
   <name>-service/
     main.py          (FastAPI + MCP if AI/COT will use it)
     requirements.txt (the driver lib for the external system + fastapi/uvicorn/mcp)
     Dockerfile       (install whatever native binaries the driver needs)
   ```
3. Add `simorgh-agent/compose/svc-<name>.yml` and include it in the
   master `docker-compose.yml`.
4. Add the service to the `.github/workflows/simorgh-deploy.yml` matrix
   for defensive image publishing.
5. Add a row to the gateway-map table above.
6. Add the env vars consumers will use to point at the gateway:
   `<NAME>_URL=http://<name>-service:80xx`.
7. In each consumer service, replace the direct external call with an
   `httpx`/MCP call to the gateway. Remove the now-unused driver lib
   from `requirements.txt` (so a future contributor can't accidentally
   re-add the violation).

## Enforcement

There's no static check yet. Add one in CI when ready: lint each
service's `requirements.txt` against an allow-list — only the named
gateway service may declare drivers like `pymysql`, `pymssql`,
`smbprotocol`, `openai`, `sentence-transformers`, `smtplib` peers.
Everyone else must use `httpx` + `mcp`.
