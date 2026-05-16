# Production resilience — surviving an internet outage

This document captures the rules every service in this stack must follow so
that **a full internet outage does not break the application**. The system
should keep serving local users (login, chat with the local LLM, project
inspection, RAG over local docs) even when Xray, ISP, OpenAI, or any other
external dependency is dead.

This isn't aspirational — `.68` is on a flaky VPN, OpenAI keys expire, ISPs
have bad days, and the local LLMs at `.61`/`.62` are intentionally the
primary inference path. The whole architecture is designed around that.

---

## What "internet down" looks like in this stack

| Subsystem | Internet-dependent? | What happens when internet is down |
|---|---|---|
| **Login (legacy)** | ❌ TPMS MySQL is on the LAN | Works |
| **Login (Google OAuth)** | ✅ accounts.google.com | Fails — users must use legacy login |
| **Local LLM via llm-gateway → .61/.62** | ❌ pure LAN | Works |
| **OpenAI online mode via llm-gateway** | ✅ api.openai.com | Fails fast (≤2s) and degrades to local LLM |
| **HuggingFace model fetch on cold start** | ✅ huggingface.co | Fails — caches already populated, should not hit the network |
| **Email send (SMTP / Resend)** | ✅ external SMTP | Fails — emails queue or drop based on caller |
| **NOWPayments** | ✅ nowpayments.io | Fails — disable payments UI |
| **Docker pulls** | ✅ Docker Hub / GHCR | N/A at runtime; pull through Nexus during build |
| **pip / apt during build** | ✅ but through Nexus | Works as long as Nexus has cached the artifacts |
| **GitLab, ELK, Qdrant, Postgres, Redis, all simorgh-* containers** | ❌ pure local | Works |

The acceptable outcome during an internet outage:

✅ Existing users log in
✅ Local LLM answers chat questions (gpt-oss-20b on `.61`)
✅ All MCP tools work (gitlab-mcp, tpms-fetcher, context-search, runtime-broker)
✅ COT reasoning works (using the local LLM)
✅ Document upload / RAG works (uses local embeddings + Qdrant)
✅ Kibana / ELK accessible
✅ All inter-service traffic on `simorgh_app_net` works

❌ OpenAI-routed chat unavailable (degrade, don't block)
❌ Google sign-in unavailable (legacy still works)
❌ Outbound notifications unavailable (queue them)

---

## The four rules every service MUST follow

### Rule 1: `/health` never blocks on external services

`/health` is hit every ~30-60s by Docker, every request by Kubernetes
readiness probes, and proxied through nginx for liveness. If it makes an
outbound call that hangs, the FastAPI event loop is gone and **everything
else queues up**. That was the cause of the legacy-login 504.

Patterns to use:

- **Cache** external probe results for ≥60s (TTL configurable):
  ```python
  _openai_health_cache: Dict[str, Any] = {"at": 0.0, "result": None}
  _OPENAI_HEALTH_TTL = float(os.getenv("OPENAI_HEALTH_TTL", "60"))
  ```
- **Short timeout** for the underlying probe (≤2s):
  ```python
  client = openai.OpenAI(api_key=..., timeout=2.0, max_retries=0)
  ```
- **Short-circuit known-bad values** (placeholder keys, empty strings):
  ```python
  if not key or key.startswith("sk-your-"):
      return {"status": "disabled"}
  ```
- **Two endpoints**: `/health` for liveness (cheap), `/health/deep` for
  exhaustive probing (call manually when debugging).

Reference implementation: `backend/services/llm_service.py:_check_openai_health()`.

### Rule 2: All outbound HTTP has an explicit short timeout

`httpx.AsyncClient()` defaults to **5 seconds** but `httpx.Client()`
defaults to **5 seconds**, and `requests.get()` defaults to **no timeout
at all**. A misconfigured client can hang forever.

Always pass `timeout=` explicitly:

```python
# Pattern for service-to-service (LAN, fast):
async with httpx.AsyncClient(timeout=10) as c:
    r = await c.post(url, json=body)

# Pattern for external (internet, may be slow):
async with httpx.AsyncClient(timeout=httpx.Timeout(connect=3, read=10)) as c:
    r = await c.post(url, json=body)

# Pattern for fire-and-forget shipping (must never block caller):
async with httpx.AsyncClient(timeout=5) as c:
    r = await c.post(url, json=body)
```

`shared/simorgh_clients/context_search.py` is the reference for the
"fire-and-forget, log-but-never-raise" pattern.

### Rule 3: Graceful degradation, not retry storms

When an external dependency fails, the calling code must:

1. Detect the failure within the timeout
2. Log a structured event (`event:openai_unavailable`, level=WARNING)
3. Return a useful fallback OR raise a typed exception the caller handles
4. **NOT** retry in a tight loop or use the default OpenAI/HTTP client retries

```python
# BAD — drives the retry storm we saw in the login 504 bug
try:
    return openai.chat.completions.create(...)
except Exception:
    return openai.chat.completions.create(...)  # NO

# GOOD — clear path-of-degradation
try:
    return await self._call_openai(prompt, timeout=10)
except (httpx.TimeoutException, openai.APITimeoutError):
    log.warning("openai_timeout_fallback_to_local")
    return await self._call_local_llm(prompt)
```

### Rule 4: Start-up succeeds even when externals are down

A container's startup must not block on external calls. If it does and
the external is down, the container restart-loops forever and never
takes traffic. Concrete rules:

- **No `await x.health_check()` during `lifespan` startup** for external x
- **No `openai.models.list()` during `__init__`** of a service class
- **Pre-populated caches** for ML models (HuggingFace) — set
  `HF_HUB_OFFLINE=1` and ensure the volume is warm before deploy

The COT engine's auto-shipping (`_ship_cot_trace`) and tpms-fetcher's
auto-shipping (`_ship_project_meta`) both follow this rule by using
the fire-and-forget `shared/simorgh_clients/context_search.py` helper.

---

## Tunables (all services, all defaults assume slow VPN)

```bash
# In simorgh-agent/.env
OPENAI_HEALTH_TTL=60            # cache /health's OpenAI status for 60s
OPENAI_HEALTH_TIMEOUT=2          # max wait per probe (s)

# When OpenAI is actually configured and working, you can be looser:
# OPENAI_HEALTH_TTL=300
# OPENAI_HEALTH_TIMEOUT=5

CONTEXT_SEARCH_TIMEOUT=5         # fire-and-forget CoT/project shipping
GITLAB_MCP_TIMEOUT=10            # gitlab-mcp HTTP calls
RUNTIME_BROKER_TIMEOUT=30        # ephemeral exec calls

# To explicitly disable an external entirely:
OPENAI_API_KEY=                  # disables OpenAI; routes to local LLM
GOOGLE_CLIENT_ID=                # disables Google OAuth
NOWPAYMENTS_API_KEY=             # disables payments
SMTP_HOST=                       # disables email
```

The system **prefers local LLM** when both are configured. Set
`DEFAULT_LLM_MODE=offline` to force local even if OpenAI is reachable.

---

## How to test "internet down" without actually pulling the cable

Run this on `.68`:

```bash
# Block all egress (will hurt for ~60s, then revert):
sudo iptables -I OUTPUT -d 0.0.0.0/0 ! -d 192.168.0.0/16 ! -d 127.0.0.0/8 -j DROP

# Now try the things that should still work:
curl -s https://simorghai.electrokavir.com/chatbot/                       # frontend
curl -X POST https://simorghai.electrokavir.com/chatbot/api/auth/login \
   -d '{"username":"...","password":"..."}'                                # login
# Try a chat message via the UI

# After verifying:
sudo iptables -D OUTPUT -d 0.0.0.0/0 ! -d 192.168.0.0/16 ! -d 127.0.0.0/8 -j DROP
```

What should happen:

- `/health` still returns 200 (fast) for every service
- Login works (TPMS MySQL is on the LAN)
- Chat works if `DEFAULT_LLM_MODE=offline` or OpenAI returns 503 fast and
  llm-gateway falls back to local
- `aggregate_field` over Elasticsearch still works
- CoT traces still get indexed (Elasticsearch is local)
- HuggingFace model lookups don't trigger (cache present, OFFLINE=1)

What should fail gracefully:

- OpenAI chat returns "OpenAI unavailable, retrying with local LLM" in logs
- Google OAuth shows a UI error, legacy login still offered
- Email send queues the message rather than blocking
- Payments tab shows "service unavailable" instead of hanging

---

## Audit checklist (review periodically)

Run these grep patterns against the codebase. Any new hit is a potential
breakage point during an outage:

```bash
# Outbound HTTP without timeout
grep -rn 'requests\.\(get\|post\)' simorgh-agent/ | grep -v timeout
grep -rn 'httpx\.\(Client\|AsyncClient\)' simorgh-agent/ | grep -v timeout

# OpenAI client without max_retries=0
grep -rn 'openai\.OpenAI(' simorgh-agent/ | grep -v 'max_retries'

# /health that touches external services
grep -rnA3 '@app\.get("/health"' simorgh-agent/ \
    | grep -E 'openai|google|requests\.get|httpx\.get'

# Service init that does I/O eagerly
grep -rn 'def __init__' simorgh-agent/*/services/*.py \
    | xargs -I{} grep -lE 'openai\.|requests\.|httpx\.'
```

---

## Known fixes already applied (commit references)

| Commit | Service | Fix |
|---|---|---|
| `6261dcd` | backend | Cached + short-timeout OpenAI health probe; placeholder key short-circuit |
| (this) | admin-service | Same fix applied to admin-service.LLMService |
| `2098724` | project-agent | HF cache wired so embeddings load offline |
| earlier | embeddings-service | `HF_HUB_OFFLINE=1` + cached MiniLM model |
| earlier | shared/simorgh_clients/context_search.py | Fire-and-forget — never raises |
