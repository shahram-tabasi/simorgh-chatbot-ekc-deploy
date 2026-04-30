# tier-quota-service

Standalone microservice for **per-user quotas + tier introspection** —
how many chats, documents, tokens etc. the calling user has left this
period. Extracted from `backend/routes/quota.py` in phase 9.

| Property | Value |
|---|---|
| Container | `tier-quota-service` |
| Port (internal) | **8040** |
| Image | built from `simorgh-agent/tier-quota-service/Dockerfile` |
| Compose file | `simorgh-agent/compose/svc-tier-quota.yml` |
| Mounted at nginx | `/api/v2/quota/*` |
| Storage | PostgreSQL (`postgres_auth` — tier + usage tables), Redis (rate-limit counters) |

---

## Endpoints

The router has prefix `/api/v2/quota`. The phase-9 first pass used
`/api/quota` which is wrong; now included without extra prefix.

| Method | Path | Auth | Returns |
|---|---|---|---|
| `GET` | `/api/v2/quota/me` | bearer | The caller's current tier + remaining quota |
| `GET` | `/api/v2/quota/tiers` | none | Public list of tier definitions |
| `GET` | `/health` | none | Liveness |

### `GET /api/v2/quota/me` response shape

```json
{
  "tier": "premium",
  "limits": {
    "chats_per_day": 100,
    "documents_per_month": 50,
    "tokens_per_month": 1000000
  },
  "used": {
    "chats_today": 7,
    "documents_this_month": 3,
    "tokens_this_month": 24513
  },
  "remaining": {
    "chats_today": 93,
    "documents_this_month": 47,
    "tokens_this_month": 975487
  },
  "resets_at": {
    "chats": "2026-04-29T00:00:00Z",
    "documents": "2026-05-01T00:00:00Z",
    "tokens": "2026-05-01T00:00:00Z"
  }
}
```

### Status codes

| Code | When |
|---|---|
| `200` | Success |
| `401` | Missing/invalid JWT (for `/me`) |

---

## Environment variables

| Var | Required | Notes |
|---|---|---|
| `JWT_SECRET_KEY` | yes | Local JWT verification |
| `POSTGRES_AUTH_*` | yes | Reads `users`, `user_tiers`, `usage_counters` |
| `REDIS_URL` | yes | Per-user counters with TTL |

---

## How `backend/main.py` collaborates with it

### Today (phase B)

backend still includes `quota_router`. The standalone container also runs
the same code.

### After phase C

Many other services (chat, documents-rag, llm-gateway, project-agent) want
to **enforce** quotas before doing expensive work. They call:

```python
import httpx, os
QUOTA_URL = os.getenv("TIER_QUOTA_URL", "http://tier-quota-service:8040")

async def check(jwt) -> dict:
    async with httpx.AsyncClient(timeout=5) as c:
        r = await c.get(f"{QUOTA_URL}/api/v2/quota/me",
                        headers={"Authorization": f"Bearer {jwt}"})
        r.raise_for_status()
        return r.json()
```

For hot paths (chat send), prefer reading the `tier` claim from the JWT
locally and only calling this service when actually decrementing usage —
but that decrement-on-finish flow doesn't exist yet (see Roadmap).

---

## Local dev

```bash
docker compose -f simorgh-agent/compose/infra-postgres-auth.yml \
               -f simorgh-agent/compose/infra-redis.yml \
               -f simorgh-agent/compose/svc-tier-quota.yml \
               up --build
```

Smoke:

```bash
curl http://localhost:8040/health
curl http://localhost:8040/api/v2/quota/tiers
curl http://localhost:8040/api/v2/quota/me -H "Authorization: Bearer $JWT"
```

---

## Roadmap / known gaps

* **`/me/decrement` endpoint** — services currently check quota but don't
  atomically decrement on success. Add a `POST /api/v2/quota/me/consume`
  with `{kind: "chats"|"documents"|"tokens", amount: N}` to record usage.
* **Hard limit vs soft limit** — currently only "remaining" reporting; no
  enforcement at the service. Each calling service has to enforce locally.
  Move enforcement into a middleware here so callers just pass the JWT.
* **Daily/monthly window calculation** — currently UTC-based. Use the
  user's timezone (already on `users.time_zone`).
* **Drop bulk-copied `services/`** — only needs `user_tier_service`,
  `postgres_auth_service` (read), `redis_service`, `auth_utils`. Prune.
