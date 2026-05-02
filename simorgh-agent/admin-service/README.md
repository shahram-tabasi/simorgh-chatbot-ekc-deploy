# admin-service

Runtime control plane for the whole simorgh stack. Beyond the original
user/tier/stats surface, this service now hosts:

* **`system_settings`** — every `.env`-style value editable at runtime
* **`feature_flags`** — global on/off + per-user overrides
* **`admin_audit_log`** — every PATCH/POST/DELETE goes here
* **Single-page UI** at `/api/v2/admin/ui/` (vanilla JS, Tailwind via CDN)
* **Service-to-service `/internal/settings/scope/...`** so other services
  hot-reload values without redeploying

| Property | Value |
|---|---|
| Container | `admin-service` |
| Port (internal) | **8039** |
| Image | built from `simorgh-agent/admin-service/Dockerfile` |
| Compose | `simorgh-agent/compose/svc-admin.yml` |
| Mounted at nginx | `/api/v2/admin/*` |
| UI URL | `https://<host>/api/v2/admin/ui/` |

---

## Endpoints

All routers carry the `/api/v2/admin` prefix; each block below is the
**suffix** under that prefix.

### Original (still here)
| Method | Path | Auth |
|---|---|---|
| `POST` | `/setup`                  | shared secret (`ADMIN_SETUP_SECRET`) |
| `GET`  | `/users`                  | admin |
| `GET`  | `/users/{id}`             | admin |
| `PATCH`| `/users/{id}/role`        | admin |
| `PATCH`| `/users/{id}/active`      | admin |
| `GET`  | `/tiers`                  | admin |
| `PATCH`| `/tiers/{tier}`           | admin |
| `GET`  | `/stats`                  | admin |

### Extended user controls (`routes/users_extended.py`)
| Method | Path | Notes |
|---|---|---|
| `POST`   | `/users`                              | manual create |
| `DELETE` | `/users/{id}`                         | `{hard:bool}` — soft = `is_active=false` |
| `POST`   | `/users/{id}/force-password-reset`    | issues a one-time token (returned ONCE) |
| `POST`   | `/users/{id}/set-password`            | admin override |
| `GET`    | `/users/{id}/audit`                   | per-user slice of audit log |

### Settings (`routes/settings.py`)
| Method | Path | Notes |
|---|---|---|
| `GET`    | `/settings`                          | `?category=&scope=&reveal=0/1` |
| `GET`    | `/settings/categories`               | sidebar counts |
| `GET`    | `/settings/{key}`                    | `?scope=&reveal=` |
| `POST`   | `/settings`                          | upsert |
| `PATCH`  | `/settings/{key}`                    | `?scope=` |
| `DELETE` | `/settings/{key}`                    | `?scope=` |
| `GET`    | `/internal/settings/scope/{scope}`   | service-side, requires `X-Internal-Token` |

### Feature flags (`routes/features.py`)
| Method | Path | Notes |
|---|---|---|
| `GET`    | `/features`                                | `?category=` |
| `POST`   | `/features`                                | upsert |
| `PATCH`  | `/features/{name}`                         | partial update |
| `DELETE` | `/features/{name}`                         | |
| `GET`    | `/users/{id}/features`                     | per-user overrides |
| `POST`   | `/users/{id}/features`                     | upsert override |
| `DELETE` | `/users/{id}/features/{feature_name}`      | clear override |
| `GET`    | `/users/{id}/features/resolved`            | effective state per feature |

### Audit (`routes/audit.py`)
| Method | Path |
|---|---|
| `GET` | `/audit?actor_id=&action=&target_type=&target_id=&since=&limit=&offset=` |

### System (`routes/system_control.py`)
| Method | Path | Notes |
|---|---|---|
| `GET`  | `/system/capability`               | what this admin host can do (docker socket? encryption?) |
| `GET`  | `/system/services`                 | docker `ps` (all containers) |
| `POST` | `/system/services/{name}/restart`  | bounce a container by name |
| `GET`  | `/system/health-rollup`            | parallel `/health` probe across all known services |

---

## Encryption at rest

Secrets stored in `system_settings` (rows with `is_secret=TRUE`) are
encrypted with **Fernet** (AES-128-CBC + HMAC-SHA256) keyed on
`MASTER_ENCRYPTION_KEY`. Generate once:

```bash
python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())'
```

Drop the result into the `.env` of the admin-service host and any other
service that needs to decrypt the same rows (typically just admin-service).

If `MASTER_ENCRYPTION_KEY` is unset the box runs in **plaintext mode**
and logs a warning — fine for local dev, dangerous in production. The
`/system/capability` endpoint reports which mode is active.

UI behaviour:
* secret values render as `ab••••••cd` until the admin clicks the
  "Reveal secrets" toggle, which sets `?reveal=1` on subsequent reads
* a few super-sensitive keys (`JWT_SECRET_KEY`, `MASTER_ENCRYPTION_KEY`,
  `ADMIN_SETUP_SECRET`) are *always* masked even with reveal=1 unless the
  request comes through the internal endpoint.

---

## Live-settings — how other services hot-reload

`simorgh-agent/llm-gateway/live_settings.py` is the reference client.
Each call resolves a key by:

1. fetching `/api/v2/admin/internal/settings/scope/<service>` and merging
   global rows (`scope=''`) with service-specific rows (`scope='<service>'`);
2. caching the result in-process for `LIVE_SETTINGS_REFRESH_SEC` (30 s);
3. falling back to `os.getenv(KEY)` if admin-service is unreachable.

To wire up a new service, copy `live_settings.py` and set:
```
ADMIN_SERVICE_URL=http://admin-service:8039
LIVE_SETTINGS_SCOPE=<service-name>
SETTINGS_INTERNAL_TOKEN=<same as admin-service>
```
Then call `await live_settings.refresh()` once at startup, or use the
background `start_refresher()` task.

`requires_restart=TRUE` rows are **advisory only** — the live-settings
client doesn't know which keys are hot-reloadable; it's up to the
service to decide. The admin UI displays a red badge as a hint.

---

## Audit log

Every PATCH/POST/DELETE on this service writes an `admin_audit_log` row
with `actor_id`, `action`, `target_type/id`, `before_state`, `after_state`,
IP, user-agent. Reads through `/audit` are paginated (`limit≤500`).

Examples of `action` strings:
* `user.create`, `user.role_change`, `user.delete_soft`, `user.delete_hard`
* `user.force_reset_issued`, `user.password_set_by_admin`
* `setting.upsert`, `setting.update`, `setting.delete`
* `feature.upsert`, `feature.update`, `feature.delete`
* `feature.user_override`, `feature.user_override_delete`
* `system.restart_service`

---

## Single-page UI

`static/admin/{index.html, app.js, style.css}` — served at
`/api/v2/admin/ui/` by the in-process `StaticFiles` mount. Vanilla JS,
Tailwind via CDN, no build step.

Tabs:
* **Dashboard** — counts + service health roll-up
* **Users** — search, filter, edit role, force reset, per-user feature
  overrides, soft/hard delete
* **Tiers** — quota editor for `free / pro / max / admin`
* **AI Config** — quick form over `category=ai` settings
  (DEFAULT_LLM_MODE, OPENAI_API_KEY, model overrides, etc.)
* **Features** — global flags + min-role per feature
* **All Settings** — every `system_settings` row with category / scope
  filters; secrets masked unless "Reveal" is ticked
* **Audit** — paginated audit log with diff viewer
* **System** — container list + Restart button (when docker socket mounted)

Login uses the existing `/api/auth/v2/login` endpoint and stores the JWT
in `localStorage` (`simorgh.admin.jwt`). Non-admin accounts are bounced
back to the login screen.

---

## Environment variables

| Var | Required | Notes |
|---|---|---|
| `MASTER_ENCRYPTION_KEY` | strongly recommended | Fernet key for at-rest secret encryption |
| `SETTINGS_INTERNAL_TOKEN` | recommended | Gates the service-to-service `/internal/settings/...` endpoint |
| `ADMIN_SETUP_SECRET` | one-shot | First-admin promotion via `/setup` |
| `JWT_SECRET_KEY` | yes | Local JWT verification |
| `POSTGRES_AUTH_*` | yes | Reads/writes the auth+control schema |
| `MYSQL_*` | optional | Legacy `/stats` over TPMS |
| `REDIS_URL` | optional | stats caching |
| `CORS_ALLOW_ORIGINS` | | restrict in prod |
| `DOCKER_HOST` | optional | Defaults to `/var/run/docker.sock`. Set to a TCP URL to talk to a remote daemon. |

---

## Migration

The new tables come from `database/migrations/004_admin_control_panel.sql`.
Run it against the auth Postgres along with the existing 001-003:

```bash
psql -h $POSTGRES_AUTH_HOST -U $POSTGRES_AUTH_USER -d $POSTGRES_AUTH_DATABASE \
  -f database/migrations/004_admin_control_panel.sql
```

The migration seeds a starter set of feature flags + every system setting
the stack currently consumes. Existing rows are not overwritten thanks to
`ON CONFLICT … DO NOTHING`.

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
  -d '{"email": "you@example.com", "password": "...", "admin_secret": "..."}'
```

Then open `http://localhost:8039/api/v2/admin/ui/` in a browser and
sign in. Or hit the API directly:
```bash
curl http://localhost:8039/api/v2/admin/users -H "Authorization: Bearer $JWT"
```
