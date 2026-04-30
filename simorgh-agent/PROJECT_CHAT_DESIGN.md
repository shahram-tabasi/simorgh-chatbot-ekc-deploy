# Project chat session — design + implementation notes

Companion to `GENERAL_CHAT_DESIGN.md`. Covers the four spec items the
user pinned for project-type sessions:

  1. Resumable sessions, multi-channel triggers (chat, email, future VoIP)
  2. Project creation gated to `expert_technical` role only
  3. Per-project chat-history isolation
  4. One canonical mailbox `simorghai@electrokavir.com` for all
     outbound + inbound project email — owned by `project-mail-service`

Plus the constraint just stated: **general sessions reject all uploads;
uploads are project-only**.

The new gateway service `project-mail-service` (port 8045) is scaffolded
and wired in. The other three items are extensions to existing services
and are documented below — not implemented in this commit so the user
can review the exact code-touch points first.

---

## 1. Resumable sessions with multi-channel triggers

**Design.** A project session lives in PostgreSQL (`project_messages`,
`project_tasks`, `project_instructions`) and Redis (hot history cache,
agent state). The COT engine in `project-agent-service` already handles
multi-channel input via the `MessageChannel` enum (`CHAT`, `EMAIL`,
`DOCUMENT`, ...). What was missing is the **outbound dispatch back to
the channel that triggered the turn**.

```
                          ┌─ chat (websocket / streaming)
   trigger arrives via ──►│ ── email (project-mail-service /send)
                          │ ── future: voip (placeholder)
                          ▼
                  project-agent-service
                  handle_input(channel=...)
                          │
                          ▼
                   COT plan + exec
                          │
                          ▼
            response routed back via SAME channel:
              - chat  → SSE stream to chat-service
              - email → POST project-mail-service /send
              - voip  → future
```

**What needs to change in `project-agent-service`:**

* `handle_input(channel=...)` already accepts the enum, but its return
  path doesn't dispatch — it just returns a dict. Add a small dispatcher
  at the end of the route handler in `routes/project_agent_routes.py`:

  ```python
  result = await agent.handle_input(...)

  if channel == MessageChannel.EMAIL and result.get("response"):
      async with httpx.AsyncClient(timeout=30) as c:
          await c.post(f"{PROJECT_MAIL_URL}/send", json={
              "to": email_from,                 # reply to sender
              "subject": f"Re: {email_subject or 'Simorgh project update'}",
              "body": result["response"],
              "project_id": project_id,
              "chat_id": chat_id,
              "in_reply_to": result.get("in_reply_to_message_id"),
          })
  # chat/SSE channel already streams from inside handle_input
  return result
  ```

* Add `PROJECT_MAIL_URL=http://project-mail-service:8045` env in
  `compose/svc-project-agent.yml`.

**What `project-mail-service` already does (just landed):**

* IMAP poller picks new mail at `simorghai@electrokavir.com`, resolves
  the target session via three signals (header / In-Reply-To /
  subject prefix), POSTs to project-agent-service's
  `/api/v2/agent/projects/{project_id}/message` with `channel=email`.
* `POST /send` is the outbound endpoint described above.
* `project_sent_emails` table indexes every outbound `Message-ID`
  against `(project_id, chat_id)` so the IMAP side can route replies.

---

## 2. Project creation gated to `expert_technical`

**Design.** The role check piggybacks on the `role_category` JWT claim
that `auth-service` will start emitting after the legacy-login profile
enrichment lands (see `GENERAL_CHAT_DESIGN.md`). Until then, fall back
to a Redis lookup of `user_profile:{user_id}`.

**What needs to change in `project-agent-service`:**

In `routes/project_agent_routes.py`, the existing `POST /api/v2/agent/projects`
handler currently checks `Depends(get_current_user)` only. Add a role gate:

```python
ALLOWED_PROJECT_CREATORS = {"expert_technical"}

@router.post("/projects", ...)
async def create_project(req: ProjectCreate,
                         user = Depends(get_current_user)):
    role = user.get("role_category")
    if role is None:                              # JWT didn't carry it
        from services.redis_service import get_redis_service
        prof = get_redis_service().get(f"user_profile:{user['user_id']}")
        role = (prof or {}).get("role_category")
    if role not in ALLOWED_PROJECT_CREATORS:
        raise HTTPException(status_code=403,
            detail="Only technical experts may create projects")
    return await agent.initialize_project(...)
```

The set is configurable via env:
`PROJECT_CREATE_ALLOWED_ROLES=expert_technical,manager_technical`.

---

## 3. Per-project chat-history isolation

**Already enforced in two places** but make it explicit in code review:

* `services/project_memory_service.py:get_messages(project_id, ...)` —
  every read filters by `project_id`. Good.
* `services/unified_memory_service.py:get_history(...)` — used by
  chat-service. Make sure this call site always passes either a
  `project_id` (project chat) or a sentinel `general_user:{user_id}`
  (general chat). They must not share the same key namespace.

**Audit checklist** (one-line task each, not implemented in this
commit):

- [ ] Confirm `message_store` rows have a non-null `project_id` for
  project-session messages and a distinct namespace for general
  sessions (e.g. `project_id IS NULL` AND `general_user_id NOT NULL`).
- [ ] In the chat-service Redis hot cache, key general sessions as
  `chat_hot:gen:{user_id}:{chat_id}` and project sessions as
  `chat_hot:proj:{project_id}:{chat_id}`. Different prefixes guarantee
  no cross-contamination.
- [ ] Add a constraint test in CI: a query for general history that
  returns any row with non-null project_id should be a regression.

---

## 4. The single mailbox + project-mail-service (just shipped)

**Address:** `simorghai@electrokavir.com` — one mailbox, all project email.

**Inbound routing.** `project-mail-service`'s IMAP poller fetches new
mail and tries the three signals in order to identify the destination
session:

| Signal | Where it comes from | When it works |
|---|---|---|
| `X-Simorgh-Project` + `X-Simorgh-Session` headers | We set them on every outbound | Always, when reply preserves headers (most clients do) |
| `In-Reply-To` against `project_sent_emails` | Looked up by `Message-ID` | Always, when client honours threading |
| `[Simorgh #<id>]` subject prefix | We set it on every outbound | Even if the client strips headers (rare) |

If none match → log + drop into `/unrouted` (TODO: surface as admin queue).

**Outbound.** `project-agent-service` after a turn calls
`POST project-mail-service:8045/send`:

```json
{
  "to": "client@partner.com",
  "subject": "Quote for OE12345",
  "body": "...",
  "project_id": "p_42",
  "chat_id": "c_99",
  "in_reply_to": null
}
```

The mail service stamps the X-Simorgh headers + subject prefix, sends
via SMTP, and records `Message-ID → (project_id, chat_id)` in
`project_sent_emails` so any reply lands back on the same session.

**Why a NEW service vs extending `mail-gateway`.** `mail-gateway` was
built for the older "per-project email gateway" pattern (the `2525`
SMTP listener for inbound, no IMAP, no outbound). This new design uses
**one** mailbox with header-based routing instead, and adds outbound.
Cleaner to build a focused gateway than retrofit. `mail-gateway` stays
for whatever still uses the per-project address pattern.

---

## 5. General-session upload prohibition (just-stated constraint)

**Rule.** General-session chats CANNOT upload anything. Files, images,
audio — all rejected. Uploads are exclusively a project-session feature.

**What needs to change in `chat-service`:**

* `routes/chatbot_v2.py:POST /api/v2/chat/{chat_id}/document` —
  add an early check:

  ```python
  chat = await get_chat(chat_id)
  if chat.session_type == "general":
      raise HTTPException(status_code=403,
          detail="Uploads are not permitted in general chat sessions")
  ```

* Same check in any other upload-accepting route (audio for STT,
  image for vision). Apply uniformly.

**Frontend complement (separate task):** hide the upload button when
`session_type === "general"` so the 403 is never visible to a normal
user — server is the source of truth, client just degrades gracefully.

---

## Service collaboration map for project sessions

```
                    ┌─────────────────┐
   user (chat) ────►│  chat-service   │── POST /api/v2/agent/projects/{id}/message
                    │     :8034       │      (channel=chat)
                    └─────────────────┘                ▲
                                                       │ stream response back via SSE
                                                       │
   email reply ────►┌────────────────────────┐         │
   to mailbox        │ project-mail-service   │── POST /api/v2/agent/projects/{id}/message
                    │       :8045            │       (channel=email, chat_id, ...)
                    │  IMAP poller resolves   │           │
                    │  session from headers   │           ▼
                    └────────────────────────┘    ┌──────────────────────┐
                              ▲                   │ project-agent-service│
                              │                   │       :8035          │
                              │                   │   handle_input(...)  │
                              │                   │   COT engine         │
                              │ POST /send        │                      │
                              │ (after agent      │   ┌─────── tools ────┴─────┐
                              │  produces an      │   │ search   tpms-fetcher   │
                              │  email reply)     │   │ command-gen  file-export│
                              │                   │   │ eplan-bridge            │
                              └───────────────────┘   │ techserver-service      │
                                                      │ eplan-sql-service       │
                                                      │ hr-kb-service           │
                                                      │ org-data-service        │
                                                      └─────────────────────────┘
                                                              ▲
                                                              │
                                                       llm-gateway, embeddings,
                                                       qdrant, redis, postgres
```

---

## 6. Project-creation source dialog (precheck → green/red → create)

Before a project is finalised, the user is shown a dialog with three
checkboxes — one per external source the project may pull from. Whenever
a checkbox is toggled, the frontend calls
`POST /api/v2/agent/projects/precheck-sources` with the current set; for
each source it gets back `{ok, detail}` and renders a green check or red
cross next to that row.

The user can only click **Create project** once **at least one source** is
green — and the request includes only the green-checked sources in
`ProjectCreate.sources`.

### Sources and what each one does on creation

| Source key       | Owner gateway              | Probe (precheck)                  | Action on `POST /projects` (per-source init) |
|------------------|----------------------------|-----------------------------------|----------------------------------------------|
| `techserver`     | techserver-service:8043    | `GET /health/deep` (smbclient ls) | `POST techserver-service /clone-to-shell` — clones the project folder from `//192.168.1.3` into `~/projects/{project_id}/techserver` on the .69 shell-server |
| `tpms`           | tpms-fetcher:8021          | `GET /health` + `/projects/{oenum}/exists` | `POST tpms-fetcher /projects/{oenum}/import` — imports project metadata / experts / technical info into the project's PostgreSQL slice |
| `tech_knowledge` | tech-kb-service:8046       | `GET /health/deep` (git ls-remote)| confirm reachability; per-project search happens later via MCP `search_tech_knowledge` |

### API contract for the dialog

**Step 1 — live precheck:**

```http
POST /api/v2/agent/projects/precheck-sources
Authorization: Bearer <jwt>     # role gate same as project creation
Content-Type: application/json

{
  "sources":   ["techserver", "tpms", "tech_knowledge"],
  "tpms_oenum": "OE12345"        # only required when "tpms" is in sources
}
```

```json
{
  "results": [
    {"source": "techserver",     "ok": true},
    {"source": "tpms",           "ok": false, "detail": "OE-number OE12345 not found in TPMS"},
    {"source": "tech_knowledge", "ok": true}
  ]
}
```

**Step 2 — actual creation (only after at least one source is green):**

```http
POST /api/v2/agent/projects
Authorization: Bearer <jwt>
Content-Type: application/json

{
  "name":        "Tabriz substation 11",
  "tpms_oenum":  "OE12345",                          # if tpms was green-checked
  "sources":     ["techserver", "tech_knowledge"],   # green-checked only
  "agent_model": "gpt-4o"
}
```

Response includes the per-source result of the init step:

```json
{
  "id": "...",
  "...standard ProjectResponse...",
  "sources": {
    "techserver":    {"ok": true},
    "tech_knowledge":{"ok": true}
  }
}
```

### Frontend implementation plan

Component: `<ProjectCreateDialog>` (new). Lives in `simorgh-agent/frontend/src/components/`.

State:
- `name`, `tpmsOenum`, `agentModel` — text inputs.
- `selected: Set<"techserver"|"tpms"|"tech_knowledge">` — which boxes are ticked.
- `precheck: Record<source, {ok: bool, detail?: string}>` — server response.

Behaviour:
- On any toggle of a checkbox, debounce 250 ms, then POST `/api/v2/agent/projects/precheck-sources` with the current `selected` set + `tpmsOenum` if applicable. Update `precheck`.
- For each source row render:
  - ☐ checkbox + label
  - if `selected.has(source)` and `precheck[source]` exists → show ✅ green check or ❌ red cross with the detail message on hover.
  - else show nothing (neutral).
- Submit button disabled unless at least one source is `ok: true`.
- On submit: POST `/api/v2/agent/projects` with `name`, `tpmsOenum`, `sources` filtered to green-checked only.

This dialog replaces / wraps whatever the current "create project" flow looks like. Open as a modal from the projects list.

---

## 7. Restrictions file (admin / dev hard constraints)

A free-text file editable by admins at `${RESTRICTIONS_HOST_PATH:-/home/ubuntu/simorgh-restrictions}/system.txt` on the host (mounted into project-agent-service at `/app/restrictions/system.txt`). Whatever the admin writes there is **prepended to every COT system prompt** as

```
# HARD CONSTRAINTS (admin-managed restrictions — these OVERRIDE everything else):
<file content here>

# AGENT INSTRUCTIONS:
<existing COT_SYSTEM_PROMPT>
```

so the LLM treats them as higher priority than the per-task instructions.

**Edit either way:**

- `vim /home/ubuntu/simorgh-restrictions/system.txt` directly on the .68 host, or
- `PUT /api/v2/agent/restrictions` with body `{content: "..."}`. Same role gate as project creation (default `expert_technical`; widen via `PROJECT_CREATE_ALLOWED_ROLES` if you want a separate admin role).
- `GET /api/v2/agent/restrictions` returns the current text.

Reads in the agent are **mtime-cached** — a `stat()` per turn, body re-read only when the file changed. So putting "Always answer in Persian" or "Never quote prices over 1B IRR" in the file takes effect on the next turn without a service restart.

---

## Implementation order (status as of this commit)

1. ✅ project-mail-service scaffold + compose + CI matrix (commit 2a8ec82).
2. ✅ auth-service legacy-login enrichment writes `role_category` to JWT and Redis (commit 508ccea).
3. ✅ project-agent-service — role gate on `POST /projects`; outbound dispatcher when `channel=email`; `PROJECT_MAIL_URL` env (commit 5f21596).
4. ✅ chat-service — reject uploads in general sessions (commit 4b083e2).
5. ✅ project-mail-service — IMAP poll loop body (commit fa4d2f2).
6. ✅ chat-service — Redis hot-cache namespace separation (commit d1c03de).
7. ✅ frontend — hide upload button in general chats (commit 5b716e2).
8. ✅ tech-kb-service scaffold + compose + CI matrix (commit b55f216).
9. ✅ project-agent-service — `precheck-sources`, sources field, per-source init, restrictions file (this commit).

**Open follow-ups (small, well-scoped):**
- techserver-service: implement `POST /clone-to-shell` (delegate to shell-service on .69 over REST).
- tpms-fetcher: implement `POST /projects/{oenum}/import` and `GET /projects/{oenum}/exists`.
- frontend: build the `<ProjectCreateDialog>` per the contract above.

Each can land as its own per-service commit when you're ready.
