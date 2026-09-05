# auth-service

Standalone REST microservice for **all authentication flows** — email + password,
Google OAuth 2.0, JWT access/refresh tokens, email verification, password
reset, and the legacy TPMS / SQL Server fallback login that exists for
internal users.

Extracted from `backend/routes/auth_v2.py` plus four backend service modules
in phase 4.

| Property | Value |
|---|---|
| Container | `auth-service` |
| Port (internal) | **8032** |
| Image | built from `simorgh-agent/auth-service/Dockerfile` |
| Compose file | `simorgh-agent/compose/svc-auth.yml` |
| Network | `simorgh_app_net` |
| Mounted at nginx | `/api/auth/v2/*` |
| Storage | `postgres_auth` (modern), MySQL TPMS @ 192.168.1.148 (legacy) |

---

## What it does

* **Modern auth** (PostgreSQL `users` table):
  - register with email + password (bcrypt-hashed)
  - login → access JWT (15 min) + refresh token (30 days, hashed in DB)
  - refresh / rotation
  - logout (revoke single refresh token) and logout-all (revoke every session)
  - email verification (token sent via SMTP or Resend)
  - password reset (token via email)
  - `me` endpoints for the user profile + per-user preferences
  - link/unlink OAuth providers
* **Google OAuth 2.0**:
  - `/google/url` returns an auth URL the frontend redirects to
  - Google redirects back to the frontend with a code
  - frontend POSTs the code to `/google/callback`
  - if the email is new → user is created and OAuth account linked
  - returns the same login response shape as password login
* **Legacy fallback** (`/legacy/login`): looks up a user in the MySQL TPMS
  database (read-only). Used by users not yet migrated to the modern
  PostgreSQL auth.

---

## Endpoints

The router has prefix `/auth/v2`; this service mounts it under `/api`, giving
external paths of `/api/auth/v2/*`.

### Account

| Method | Path | Body / Query | Auth |
|---|---|---|---|
| `POST` | `/api/auth/v2/register` | `{email, password, full_name?}` | none |
| `POST` | `/api/auth/v2/verify-email` | `{token}` | none |
| `POST` | `/api/auth/v2/resend-verification` | `{email}` | none |
| `POST` | `/api/auth/v2/forgot-password` | `{email}` | none |
| `POST` | `/api/auth/v2/reset-password` | `{token, new_password}` | none |
| `POST` | `/api/auth/v2/change-password` | `{current_password, new_password}` | bearer |

### Session

| Method | Path | Body / Query | Auth |
|---|---|---|---|
| `POST` | `/api/auth/v2/login` | `{email, password}` | none |
| `POST` | `/api/auth/v2/refresh` | `{refresh_token}` *or* HttpOnly cookie | none |
| `POST` | `/api/auth/v2/logout` | `{refresh_token}` *or* cookie | bearer |
| `POST` | `/api/auth/v2/logout-all` | — | bearer |
| `POST` | `/api/auth/v2/legacy/login` | `{username, password}` | none — TPMS lookup |

### Google OAuth

| Method | Path | Body / Query | Auth |
|---|---|---|---|
| `GET`  | `/api/auth/v2/google` | — | none, returns redirect |
| `GET`  | `/api/auth/v2/google/url` | — | none, returns `{url}` |
| `POST` | `/api/auth/v2/google/callback` | `{code, state?}` | none |

### Self-service

| Method | Path | Body / Query | Auth |
|---|---|---|---|
| `GET`  | `/api/auth/v2/me` | — | bearer |
| `PATCH`| `/api/auth/v2/me` | `{full_name?, avatar_url?, ...}` | bearer |
| `GET`  | `/api/auth/v2/me/preferences` | — | bearer |
| `PATCH`| `/api/auth/v2/me/preferences` | `{theme?, language?, llm_mode?, ...}` | bearer |
| `GET`  | `/api/auth/v2/me/oauth-providers` | — | bearer |
| `DELETE` | `/api/auth/v2/me/oauth-providers/{provider}` | — | bearer |

### Service health

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness — does NOT touch DB |
| `GET` | `/api/auth/v2/health` | Sub-router's own health if you want DB-aware probe |

### Status codes (typical)

| Code | When |
|---|---|
| `200` | Success |
| `400` | Validation failed (e.g. password too weak) |
| `401` | Invalid credentials / bad token / token expired |
| `403` | Email not verified / account suspended |
| `404` | User not found |
| `409` | Email already in use |
| `429` | Rate-limit / too many attempts |

---

## Token & cookie model

* **Access JWT** — 15 min lifetime, signed with `JWT_SECRET_KEY` (HS256).
  Returned in the JSON body of `/login` and `/refresh`. Frontend stores it in
  memory and sends it as `Authorization: Bearer <token>` on every request to
  the rest of the API.

* **Refresh token** — 30 day lifetime, sent as both:
  - JSON body field `refresh_token` (so non-browser clients can store it),
  - **HttpOnly cookie** named `refresh_token` (so browsers can refresh
    without exposing the token to JavaScript).
  Stored hashed (`sha256`) in `refresh_tokens` table. Rotated on every
  `/refresh` (old token destroyed, new one issued).

* `SECURE_COOKIES=true` makes the cookie HTTPS-only. `COOKIE_DOMAIN`
  controls cross-subdomain reuse — set to `.electrokavir.com` if you want
  the cookie to work for `simorghai.electrokavir.com` *and*
  `gitlab.electrokavir.com`. Leave blank for single-domain.

---

## PostgreSQL schema (auto-applied)

The first start of `postgres_auth` runs migrations from
`backend/database/migrations/` mounted at
`/docker-entrypoint-initdb.d/`:

| Migration | Tables created |
|---|---|
| `001_create_auth_tables.sql` | `users`, `oauth_accounts`, `refresh_tokens`, `user_sessions`, `email_verification_tokens`, `password_reset_tokens`, `user_preferences` |
| `003_project_agent_system.sql` | (consumed by other services, not auth) |

Note `002_add_user_tiers.sql` is intentionally not auto-applied — apply it
manually if you want user tiers (it adds a `tier` column to `users`).

---

## Environment variables

| Var | Required | Default | Notes |
|---|---|---|---|
| `JWT_SECRET_KEY` | **yes** | placeholder | Rotating this invalidates all sessions |
| `POSTGRES_AUTH_HOST` | yes | `postgres_auth` | |
| `POSTGRES_AUTH_PORT` | | `5432` | |
| `POSTGRES_AUTH_DATABASE` | | `simorgh_auth` | |
| `POSTGRES_AUTH_USER` | yes | `simorgh` | |
| `POSTGRES_AUTH_PASSWORD` | yes | placeholder | |
| `GOOGLE_CLIENT_ID` | for OAuth | — | |
| `GOOGLE_CLIENT_SECRET` | for OAuth | — | |
| `GOOGLE_REDIRECT_URI` | | `https://simorghai.electrokavir.com/chatbot/auth/google/callback` | |
| `EMAIL_PROVIDER` | | `smtp` | `smtp` or `resend` |
| `SMTP_HOST` | for SMTP | `smtp.gmail.com` | |
| `SMTP_PORT` | | `587` | |
| `SMTP_USER` | for SMTP | — | |
| `SMTP_PASSWORD` | for SMTP | — | |
| `SMTP_USE_TLS` | | `true` | |
| `RESEND_API_KEY` | for Resend | — | |
| `FROM_EMAIL` | | `noreply@simorgh.ai` | Must be domain-verified in Resend |
| `FROM_NAME` | | `Simorgh AI` | |
| `AUTO_VERIFY_EMAIL` | | `false` | Set to `true` for dev — skips verification flow |
| `FRONTEND_URL` | | `https://simorghai.electrokavir.com/chatbot` | Used in verification + reset email links |
| `SECURE_COOKIES` | | `true` | Set `false` only for HTTP local dev |
| `COOKIE_DOMAIN` | | (empty) | e.g. `.electrokavir.com` |
| `MYSQL_HOST` | for legacy | `192.168.1.148` | TPMS database |
| `MYSQL_USER`/`PASSWORD`/`DATABASE` | for legacy | from secrets | |
| `CORS_ALLOW_ORIGINS` | | `*` | Restrict in prod |
| `LOG_LEVEL` | | `INFO` | |

---

## Talking to other services

```
            ┌───────────────────┐         ┌──────────────────┐
   POST     │                   │         │                  │
   /api/    │                   │  asyncpg│                  │
   auth/v2/ │   auth-service    ├────────▶│  postgres_auth   │
   login    │     :8032         │         │   (users, ...)   │
   ────────▶│                   │         └──────────────────┘
            │                   │
            │                   │  pymysql
            │                   ├────────▶  192.168.1.148 (TPMS, RO, legacy login)
            │                   │
            │                   │  SMTP / Resend HTTPS
            │                   ├────────▶  email provider
            │                   │
            │                   │  HTTPS
            │                   ├────────▶  accounts.google.com (OAuth code exchange)
            └───────────────────┘
```

The service is **stateless apart from PostgreSQL**. JWT verification is
local — no session store lookup is needed for normal API calls. Refresh
tokens require a DB roundtrip, which is why every other request uses the
cheap access JWT.

---

## How `backend/main.py` collaborates with it

### Today (phase B)

`backend/main.py` still has `app.include_router(auth_v2_router)`. The
auth-service container also runs the same router and serves the same paths,
but **nginx isn't routing to it yet** — the upcoming nginx fix will switch
`/api/auth/v2/*` to the auth-service container, after which the backend's
copy of the router becomes dead code (deleted in phase C).

### After phase C (slim backend)

backend stops including `auth_v2_router`. Other backend code that needs to
identify the calling user does it locally with `services/auth_utils.py`,
which **just verifies the JWT signature** using `JWT_SECRET_KEY`. It does
NOT need to call auth-service for every request:

```python
# backend/services/auth_utils.py (still in backend after phase C)
from jose import jwt
def get_current_user(token: str = Depends(oauth2_scheme)):
    payload = jwt.decode(token, JWT_SECRET_KEY, algorithms=["HS256"])
    return payload  # contains user_id, email, tier
```

This is fine because:
- the JWT is signed by auth-service with `JWT_SECRET_KEY`,
- backend has the same key (env var),
- so backend can validate any JWT issued by auth-service without a network call.

For operations that need fresh user data (e.g. checking if a user was
suspended after the JWT was issued), backend calls auth-service:

```python
# backend/services/auth_client.py (after phase C)
import httpx, os
AUTH_URL = os.getenv("AUTH_SERVICE_URL", "http://auth-service:8032")
async def get_user(access_token: str) -> dict:
    async with httpx.AsyncClient() as c:
        r = await c.get(f"{AUTH_URL}/api/auth/v2/me",
                        headers={"Authorization": f"Bearer {access_token}"})
        r.raise_for_status()
        return r.json()
```

**Token rotation:** when `JWT_SECRET_KEY` is rotated, every backend service +
auth-service must restart with the new key, and every active user's session
is invalidated. Plan accordingly.

---

## Local development

### Run alone (with its DB)

```bash
cd simorgh-agent
docker compose -f compose/infra-postgres-auth.yml -f compose/svc-auth.yml up --build
```

To poke at it directly, expose the port:

```bash
docker compose -f compose/svc-auth.yml -f - up <<'EOF'
services:
  auth-service:
    ports:
      - "8032:8032"
EOF
```

### Without Docker (host)

```bash
cd simorgh-agent/auth-service
pip install -r requirements.txt
JWT_SECRET_KEY=dev-key \
POSTGRES_AUTH_HOST=localhost \
POSTGRES_AUTH_USER=simorgh \
POSTGRES_AUTH_PASSWORD=simorgh_secure_2024 \
SECURE_COOKIES=false \
AUTO_VERIFY_EMAIL=true \
uvicorn main:app --host 0.0.0.0 --port 8032 --reload
```

You'll need a local PostgreSQL with `simorgh_auth` DB and the migrations
applied.

### Smoke tests

```bash
curl -s http://localhost:8032/health

# Register
curl -s -X POST http://localhost:8032/api/auth/v2/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"a@b.com","password":"StrongPass123!","full_name":"Test User"}'

# Login
curl -s -X POST http://localhost:8032/api/auth/v2/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"a@b.com","password":"StrongPass123!"}' | jq

# Use the access_token
ACCESS=$(... | jq -r .access_token)
curl -s http://localhost:8032/api/auth/v2/me -H "Authorization: Bearer $ACCESS"
```

---

## Files

| Path | Purpose |
|---|---|
| `main.py` | FastAPI app + CORS + router include |
| `routes/auth_v2.py` | All endpoints (1 file ~840 LOC) |
| `services/postgres_auth_service.py` | Async user DAO using asyncpg |
| `services/oauth_service.py` | Google OAuth 2.0 code exchange + user info |
| `services/email_service.py` | SMTP + Resend abstraction with template rendering |
| `services/auth_utils.py` | JWT encode/decode, password hashing helpers |
| `services/tpms_auth_service.py` | Legacy MySQL TPMS lookup |
| `services/hash_detector.py` | Detects hash format (bcrypt vs legacy MD5/SHA1) for migration |
| `models/auth_models.py` | Pydantic request/response schemas |
| `models/tier_models.py` | User-tier enums |
| `database/postgres_connection.py` | asyncpg pool + sync psycopg2 connection helpers |
| `Dockerfile` | python:3.11-slim, libpq-dev, port 8032 |

---

## Roadmap / known gaps

* **Rate limiting** — there is no per-IP throttle on `/login` or
  `/forgot-password` yet. Add a Redis-backed sliding window.
* **2FA / TOTP** — not implemented. Add `pyotp` + a `user_totp_secrets`
  table.
* **Session listing UI** — `/me/sessions` doesn't exist; users can't see
  active devices. Easy add.
* **Audit log** — successful + failed login attempts should be persisted
  for security review. Currently only logged.
* **OAuth providers beyond Google** — GitHub / GitLab / Microsoft would
  reuse `oauth_service.py` with minimal changes.
* **JWT key rotation** — when `JWT_SECRET_KEY` is rotated, every active
  session is killed. Implement a `JWT_PREVIOUS_SECRET_KEY` envelope so
  rotations are graceful.
