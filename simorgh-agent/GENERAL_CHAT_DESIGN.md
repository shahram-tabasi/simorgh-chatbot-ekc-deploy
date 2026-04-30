# General-chat session — design + implementation notes

This document describes how the **legacy-login user → general chat → answer
about HR / organization** flow works, which services collaborate, and what
still needs to be implemented inside `auth-service` and `chat-service` to
finish the feature. The two new microservices it depends on
(`hr-kb-service`, `org-data-service`) have already been scaffolded and
included in the master compose.

---

## Information sources allowed in a general session

| Source | Lives in | Accessed via |
|---|---|---|
| User profile (role, dept, manager, …) | Redis cache `user_profile:{id}` (TTL 24h) | Direct Redis read in chat-service |
| HR / organization documents | Qdrant collection `hr_general_kb` | `hr-kb-service:/mcp` tool `search_hr_kb` |
| HR / organization MySQL tables | MySQL @ 192.168.1.148 (HR schema) | `org-data-service:/mcp` tools (`get_holidays`, `get_corporate_loan_info`, …) |
| Chat history | Redis hot cache (TTL 2h) + PostgreSQL durable | Direct read in chat-service |

That's the entire COT toolset for general sessions. Other MCP servers
(search, tpms-fetcher, project-init, eplan-bridge, etc.) are **not**
connected when `session_type == "general"`.

---

## Service-by-service responsibilities

### 1. auth-service (port 8032) — needs an extension

On a successful `POST /api/auth/v2/legacy/login`, auth-service must:

1. After bcrypt / TPMS password verification succeeds, run an extra
   query against the HR tables to fetch the user's organisational role:

   ```sql
   SELECT employee_id, full_name, department, role, role_category, manager_id
     FROM hr_employees
    WHERE login_username = %s
    LIMIT 1;
   ```

   `role_category` should resolve to one of the canonical buckets:
   ```
   expert_technical | expert_offer | expert_sales | expert_warehouse
   expert_customer_service | expert_project_planning
   expert_production | expert_quality_control | expert_office
   manager_technical | manager_offer | manager_production
   manager_quality_control | manager_hr | other
   ```

2. Write the resulting profile to Redis with key `user_profile:{user_id}`
   (TTL = 86400 s = 24 h). JSON shape:

   ```json
   {
     "user_id": "1234",
     "full_name": "Ali Tabasi",
     "department": "Production",
     "role": "Production Quality Control Expert",
     "role_category": "expert_quality_control",
     "manager_id": "9876",
     "loaded_at": "2026-04-30T10:15:32Z"
   }
   ```

3. Embed the canonical `role_category` (and `department`) in the JWT as
   custom claims so any downstream service can read them without a
   Redis round-trip:

   ```python
   payload = {
       "sub": user_id,
       "email": email,
       "role_category": "expert_quality_control",
       "department": "Production",
       "exp": ...,
   }
   ```

**Where to put the code:** `auth-service/services/tpms_auth_service.py`
already does the legacy MySQL lookup. Add a new method
`enrich_profile_from_hr(user_id)` that issues the second query and write
the profile in `auth-service/routes/auth_v2.py` immediately after
successful authentication, before issuing the JWT.

### 2. chat-service (port 8034) — needs an extension

Add `session_type` to the chat-create body (default `"general"` for the
moment, since that's what most legacy users get; project sessions will
ride on top later):

```json
POST /api/v2/chat/create
{ "title": "...", "session_type": "general" }
```

In the chat-service handler:

1. **Read `user_profile`** from Redis at session creation. If missing,
   read it via `auth-service:/api/auth/v2/me` and cache it locally for
   2 h. (The 24 h cache in auth-service is the source of truth; the
   2 h cache in chat-service is a pull-through cache.)

2. **Warm chat history into Redis** at session creation. Read all prior
   messages for `(user_id, chat_id)` from `message_store` in PostgreSQL
   and write a Redis list `chat_hot:{chat_id}` with `EXPIRE 7200`. On
   every subsequent message, read from Redis first; on cache miss, fall
   back to PG.

3. **Build the system prompt** at the start of every turn:

   ```python
   system = (
     f"You are Simorgh, an internal assistant for an MV/LV electrical "
     f"panel manufacturing company. The user's role is "
     f"{profile.role} ({profile.role_category}) in the {profile.department} "
     f"department.\n\n"
     "RULES FOR THIS SESSION (general):\n"
     "- Answer ONLY questions about the company's HR policies, monthly "
     "holidays, corporate loans, hiring periods, organisation directory, "
     "and other organisation-wide information.\n"
     "- Do NOT answer questions about specific projects, clients, or "
     "technical electrical work.\n"
     "- The only information sources you may use are the tools "
     "search_hr_kb, get_holidays, get_corporate_loan_info, "
     "get_hiring_periods, get_company_directory, get_employee_attendance, "
     "lookup_employee_by_id, list_departments, plus the user profile "
     "and chat history given to you.\n"
   )
   ```

4. **Restrict the MCP tool set.** In the existing `mcp_manager.py` (now
   bulk-copied into chat-service/services/), only register these two
   upstreams when `session_type == "general"`:

   ```python
   HR_KB_MCP_URL    = "http://hr-kb-service:8041/mcp"
   ORG_DATA_MCP_URL = "http://org-data-service:8042/mcp"
   ```

   For project sessions later, register the full set including
   `project-agent-service`, `tpms-fetcher`, etc.

5. **Persist + cache every message**. Already happens via
   `unified_memory_service.py`; just make sure the Redis hot cache is
   updated alongside the PG write.

### 3. hr-kb-service (port 8041) — already scaffolded

* Watches `/app/hr_docs` (host `${HR_DOCS_HOST_PATH:-/home/ubuntu/hr-docs}`)
  for filesystem drops.
* Admin upload via `POST /upload`.
* Indexes into Qdrant collection `hr_general_kb` using the
  `embeddings-service`.
* Exposes MCP tool `search_hr_kb(query, top_k)`.
* See `hr-kb-service/main.py` for the TODO checklist that finishes the
  indexing pipeline.

### 4. org-data-service (port 8042) — already scaffolded

* Read-only MySQL queries against the HR / org schema, using a
  separate DB user (`ORG_MYSQL_USER`).
* MCP-only by design — no REST surface for normal use, only `/health`.
* Tools each contain a `# TODO(org-data)` with the SQL skeleton you need
  to fill in once you confirm the actual table / column names.

---

## Data shapes that travel between services

```
                 redis: user_profile:{user_id}     (TTL 24h, written by auth-service)
                 ┌───────────────────────────────────────────────────┐
                 │ {                                                  │
                 │   "user_id": "1234",                               │
                 │   "full_name": "Ali Tabasi",                       │
                 │   "department": "Production",                      │
                 │   "role": "Production QC Expert",                  │
                 │   "role_category": "expert_quality_control",       │
                 │   "manager_id": "9876",                            │
                 │   "loaded_at": "2026-04-30T10:15:32Z"              │
                 │ }                                                  │
                 └───────────────────────────────────────────────────┘

                 redis: chat_hot:{chat_id}         (TTL 2h, written by chat-service)
                 ┌───────────────────────────────────────────────────┐
                 │ List of {role, content, ts, meta}                  │
                 │ Newest at the head, trim past CHAT_HOT_MAX (e.g. 80)│
                 └───────────────────────────────────────────────────┘

                 qdrant collection: hr_general_kb
                 ┌───────────────────────────────────────────────────┐
                 │ point.payload = {                                  │
                 │   document_id: sha1,                               │
                 │   filename: "leave_policy_2026.pdf",               │
                 │   chunk_idx: 3,                                    │
                 │   text: "...",                                     │
                 │   uploaded_at: ts                                  │
                 │ }                                                  │
                 └───────────────────────────────────────────────────┘
```

---

## Roll-out order

1. **Implement the indexing pipeline** in `hr-kb-service/main.py`
   (`index_file`, `remove_doc`, `search_chunks`). Drop a test PDF in
   `${HR_DOCS_HOST_PATH}` and verify it lands in Qdrant.

2. **Fill in real SQL** in each `org-data-service/main.py` MCP tool
   against your actual HR schema. Validate from the host:
   ```
   docker exec -it org-data-service python -c \
     "from main import db; c=db(); cur=c.cursor(); cur.execute('SELECT 1'); print(cur.fetchone())"
   ```

3. **Extend `auth-service/services/tpms_auth_service.py`** with the
   profile-enrichment query, write to Redis, add JWT claim.

4. **Extend `chat-service`** with the `session_type` field, the system
   prompt builder, the restricted MCP wiring, and the Redis hot-cache
   warm-up at session creation.

5. **Frontend**: send `session_type: "general"` at chat creation time
   for legacy-login users (or add a UI toggle).

Project-session work (separate scope) plugs into step 4 by adding a
`session_type == "project"` branch that registers the full MCP set and
swaps the system prompt.
