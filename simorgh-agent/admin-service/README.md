# admin-service

Standalone microservice for **admin operations** — bootstrap the first admin,
list/inspect users, change user roles + active flags, manage tier definitions,
view system stats. Extracted from `backend/routes/admin.py` in phase 9.

| Property | Value |
|---|---|
| Container | `admin-service` |
| Port (internal) | **8039** |
| Image | built from `simorgh-agent/admin-service/Dockerfile` |
| Compose file | `simorgh-agent/compose/svc-admin.yml` |
| Mounted at nginx | `/api/v2/admin/*` |

---

## Endpoints

The router has prefix `/api/v2/admin`; the phase-9 first pass mistakenly
used `/api/admin`. Now mounted without an extra prefix.

| Method | Path | Body / params | Auth | Notes |
|---|---|---|---|---|
| `POST` | `/api/v2/admin/setup` | `{secret, email}` | shared secret | One-shot — promotes a user to admin using `ADMIN_SETUP_SECRET`. Disabled after the first admin exists. |
| `GET`  | `/api/v2/admin/users` | `?limit=&offset=&search=` | admin | List users |
| `GET`  | `/api/v2/admin/users/{user_id}` | — | admin | Single user |
| `PATCH`| `/api/v2/admin/users/{user_id}/role` | `{role}` | admin | `user`/`admin`/`superadmin` |
| `PATCH`| `/api/v2/admin/users/{user_id}/active` | `{active}` | admin | Suspend/unsuspend |
| `GET`  | `/api/v2/admin/tiers` | — | admin | Tier definitions |
| `PATCH`| `/api/v2/admin/tiers/{tier_name}` | `{quota_chats?, quota_documents?, ...}` | admin | Tune quotas |
| `GET`  | `/api/v2/admin/stats` | — | admin | Aggregated counts |

### Auth model

* **`/setup`** uses a shared secret (`ADMIN_SETUP_SECRET`) — one-shot,
  intended for the very first admin promotion. Should remain blank in env
  after first use, or rotated.
* All other endpoints require a valid JWT **and** `role >= admin` — both
  are checked locally via `services/auth_utils.py` reading the JWT claim.

### Status codes

| Code | When |
|---|---|
| `200` | Success |
| `400` | Bad role/tier/value |
| `401` | Missing/invalid JWT |
| `403` | Not an admin OR setup secret mismatch OR setup already done |
| `404` | User/tier not found |

---

## Environment variables

| Var | Required | Notes |
|---|---|---|
| `ADMIN_SETUP_SECRET` | yes (one-shot) | Shared secret for `/setup`. Rotate or blank after first admin |
| `JWT_SECRET_KEY` | yes | Local JWT verification |
| `POSTGRES_AUTH_*` | yes | Reads/writes `users`, `user_tiers` |
| `MYSQL_*` | for legacy stats | Optional — reads TPMS counts for the `/stats` endpoint |
| `REDIS_URL` | | Used for stats caching |
| `CORS_ALLOW_ORIGINS` | | Restrict in prod |

---

## How `backend/main.py` collaborates with it

### Today (phase B)

backend still has `app.include_router(admin_router)`. After the nginx
fix, traffic to `/api/v2/admin/*` goes here directly.

### After phase C

backend drops `admin_router`. The frontend admin panel hits this service
through nginx. No internal service calls this — it's a leaf, used only by
human admins via the UI.

---

## Local dev

```bash
docker compose -f simorgh-agent/compose/infra-postgres-auth.yml \
               -f simorgh-agent/compose/svc-admin.yml \
               up --build
```

Bootstrap the first admin (one-shot):

```bash
curl -X POST http://localhost:8039/api/v2/admin/setup \
  -H "Content-Type: application/json" \
  -d '{"secret": "your-ADMIN_SETUP_SECRET", "email": "you@example.com"}'
```

Then any of the admin endpoints with `Authorization: Bearer <jwt>`:

```bash
curl http://localhost:8039/api/v2/admin/users -H "Authorization: Bearer $JWT"
```

---

## Roadmap / known gaps

* **Audit log** — admin role changes / suspensions should be persisted.
  Currently only logged.
* **Bulk operations** — no bulk-suspend or bulk-tier-change.
* **`/setup` lock-out** — currently relies on "no admin exists yet" check;
  add a feature flag so the endpoint can be permanently disabled after
  bootstrap.
* **Drop bulk-copied `services/`** — only needs `postgres_auth_service`,
  `user_tier_service`, `auth_utils`. Prune.
