# 2026-05 Enterprise Migration

A clean-cut migration of the simorgh-agent stack to use off-the-shelf
enterprise components, reducing custom code and improving observability.

## What changed

| Old | New | Why |
| --- | --- | --- |
| `shell-service` (custom 700-LOC sandbox on 192.168.1.69) | `runtime-broker` (ephemeral docker exec on .68) | Real isolation (cgroups + seccomp + tmpfs root + caps drop), no persistent workspaces, single-host. |
| `techserver-service` (smbclient → tar → upload to shell) | `gitlab-mcp` over a local **GitLab CE** instance, seeded once by `tools/techserver-importer` | Source-of-truth becomes git; experts work directly with GitLab in future. No more SMB copy at chat-create time. |
| `tech-kb-service` (git clone of technical-knowledge into shell) | `gitlab-mcp.search_blobs(...)` against the GitLab `technical-knowledge` repo | On-demand reads; no local clone; CoT pulls only what it needs. |
| TPMS markdown copied into shell workspace | `tpms-context-agent` MCP tool | On-demand rendered context, Redis-cached. No filesystem write. |
| `mail-gateway-service` (custom aiosmtpd) + `project-mail-service` (scaffold IMAP) | **Mailcow** + `mail-bridge` (IMAP IDLE → webhook, SMTP submission) | Real mail server, real auth, real anti-spam, much less custom code. |
| `logging.basicConfig` in every service | `simorgh_logging` (structlog JSON) → Filebeat / TCP → **Logstash** → **Elasticsearch** → **Kibana** | Centralised structured logs, audit trail, dashboards, slow-query analysis. |
| DuckDuckGo wrapper as the only search | `context-search` (hybrid BM25 + kNN over ES) | High-quality LLM context: project docs, GitLab blobs, TPMS rows, prior CoT all searchable together. |

## What was deleted

```
simorgh-agent/shell-service/                  ← removed
simorgh-agent/mail-gateway-service/           ← removed
simorgh-agent/project-mail-service/           ← removed (replaced by mail-bridge)
simorgh-agent/techserver-service/             ← removed (replaced by gitlab + importer)
simorgh-agent/tech-kb-service/                ← removed (replaced by gitlab-mcp)
simorgh-agent/docker-compose-shell.yml        ← removed (no more .69 host)
simorgh-agent/docker-compose.legacy.yml       ← removed
simorgh-agent/compose/svc-techserver.yml      ← removed
simorgh-agent/compose/svc-tech-kb.yml         ← removed
simorgh-agent/compose/svc-mail-gateway.yml    ← removed
simorgh-agent/compose/svc-project-mail.yml    ← removed
```

## What was added

```
simorgh-agent/shared/simorgh_logging/         ← structlog + logstash shipper
simorgh-agent/shared/simorgh_clients/         ← runtime-broker + gitlab-mcp + shim

simorgh-agent/gitlab-mcp-service/             ← REST + MCP wrapper around python-gitlab
simorgh-agent/runtime-broker/                 ← ephemeral docker-run sandbox + MCP
simorgh-agent/context-search-service/         ← hybrid (BM25 + kNN) ES search + MCP
simorgh-agent/tpms-context-agent/             ← on-demand TPMS context for CoT + MCP
simorgh-agent/mail-bridge/                    ← Mailcow IMAP IDLE bridge + SMTP send

simorgh-agent/tools/techserver-importer/      ← one-time SMB → GitLab importer

simorgh-agent/elk/logstash/                   ← pipeline + config
simorgh-agent/elk/filebeat/                   ← container log shipper config

simorgh-agent/compose/infra-gitlab.yml        ← GitLab CE
simorgh-agent/compose/infra-elastic.yml       ← Elasticsearch + Logstash + Kibana + Filebeat
simorgh-agent/compose/infra-mailcow.yml       ← Mailcow probe (mailcow itself runs as a sibling stack)
simorgh-agent/compose/svc-gitlab-mcp.yml
simorgh-agent/compose/svc-runtime-broker.yml
simorgh-agent/compose/svc-context-search.yml
simorgh-agent/compose/svc-tpms-context-agent.yml
simorgh-agent/compose/svc-mail-bridge.yml
```

## How to bring it up on 192.168.1.68

1. Copy `.env.example` → `.env` and fill in the new secrets:
   - `GITLAB_ROOT_PASSWORD`
   - `GITLAB_API_TOKEN` (generate after step 3)
   - `BROKER_TOKEN`
   - `AGENT_TOKEN`
   - `MAILBOX_PASSWORD`
   - `ELASTIC_PASSWORD` (only if you flip `ELASTIC_SECURITY_ENABLED=true`)

2. Bring up infra first:
   ```bash
   cd simorgh-agent
   docker compose -f compose/infra-redis.yml \
                   -f compose/infra-postgres-auth.yml \
                   -f compose/infra-qdrant.yml \
                   -f compose/infra-gitlab.yml \
                   -f compose/infra-elastic.yml up -d
   ```
   GitLab takes 5+ minutes to fully come up the first time.

3. Generate a GitLab API token:
   - Open `http://gitlab.simorgh.local`, log in as `root` with `GITLAB_ROOT_PASSWORD`.
   - User Settings → Access Tokens → create with scope `api`.
   - Put it in `.env` as `GITLAB_API_TOKEN`.
   - Create the groups: `simorgh-projects`, `simorgh-knowledge`.

4. Bring up Mailcow as a sibling stack:
   ```bash
   git clone https://github.com/mailcow/mailcow-dockerized.git /opt/mailcow-dockerized
   cd /opt/mailcow-dockerized
   ./generate_config.sh   # set MAILCOW_HOSTNAME=mail.simorgh.local
   docker compose up -d
   docker network connect simorgh_app_net postfix-mailcow
   docker network connect simorgh_app_net dovecot-mailcow
   ```
   Then create the `simorghai@electrokavir.com` mailbox via Mailcow's UI.

5. Bring up the rest of the stack:
   ```bash
   cd simorgh-agent
   docker compose up -d
   ```

6. Run the one-time techserver → GitLab importer:
   ```bash
   docker build -t simorgh-techserver-importer:local \
       -f tools/techserver-importer/Dockerfile .
   docker run --rm --network simorgh_app_net \
       -e TECHSERVER_IP=192.168.1.3 \
       -e TECHSERVER_USER='EKC\tech' \
       -e TECHSERVER_PASSWORD='...' \
       -e GITLAB_URL=http://gitlab \
       -e GITLAB_TOKEN="$GITLAB_API_TOKEN" \
       -e PROJECTS_GROUP=simorgh-projects \
       simorgh-techserver-importer:local \
         import-all --share tech
   ```
   Idempotent — re-run any time to pick up new oenums or refresh content.

7. Verify:
   - `http://gitlab.simorgh.local` — projects per oenum exist
   - `http://kibana.simorgh.local` — `simorgh-logs-*` index has entries
   - `curl http://gitlab-mcp:8047/health` — gitlab-mcp reachable
   - `curl http://runtime-broker:8048/health` — broker reachable
   - `curl http://context-search:8049/health` — search reachable

## Code-level breaking changes

- `services/shell_service.py` in nine in-tree services has been replaced
  with a self-contained shim (~170 LOC) that preserves the
  `ShellServiceClient` import surface but routes everything to
  runtime-broker + gitlab-mcp. Callers don't need updates.
- `project-init-service` was rewritten — it no longer talks to
  shell-service or tpms-fetcher directly. It calls `gitlab-mcp` to ensure
  the project repo exists, `tpms-context-agent` to warm cache, and
  `context-search` to index project metadata.
- The legacy `~/projects/<id>/{techserver,tpms,tech-knowledge,...}`
  directory layout no longer exists. Code that read those paths via
  shell-service `/file/read` will now read from GitLab repos at the
  matching paths in `<group>/<oenum>`.

## Configuration (`simorgh.config.yaml` — TODO)

The user-facing flexibility goal is still pending: today's config is
spread across `.env`. A follow-up should add a single
`simorgh.config.yaml` with sections for `runtime`, `mail`, `search`, and
`gitlab`, parsed at service startup. The compose env-var pattern remains
the source of truth for now.

## Capacity targets (office-scale)

Defaults are sized for ~50–200 concurrent users on a single .68 host with
~32 GB RAM and ~8 vCPU. All knobs are env-tunable in `.env`:

| Component | Heap / cache | RAM limit | Notes |
| --- | --- | --- | --- |
| GitLab CE (puma + sidekiq + bundled pg/redis) | 4 puma workers, 25 sidekiq, pg shared_buffers=1G | 12 GB | `GITLAB_PUMA_WORKERS`, `GITLAB_SIDEKIQ_CONCURRENCY`, `GITLAB_PG_*`, `GITLAB_MEM_LIMIT` |
| Elasticsearch | 4 GB heap | 6 GB | `ELASTIC_HEAP`, `ELASTIC_MEM_LIMIT` |
| Logstash | 1 GB heap, 4 pipeline workers | 1.5 GB | `LOGSTASH_HEAP`, `LOGSTASH_PIPELINE_WORKERS` |
| Kibana | 1.5 GB node heap | 2 GB | `KIBANA_NODE_HEAP_MB`, `KIBANA_MEM_LIMIT` |
| Postgres (auth) | shared_buffers=1G, max_connections=300 | 3 GB | `POSTGRES_AUTH_*` |
| Redis | maxmemory=2GB, 4 IO threads | 2.5 GB | `REDIS_MAXMEMORY`, `REDIS_IO_THREADS` |
| Qdrant | auto workers | 3 GB | `QDRANT_MEM_LIMIT` |
| runtime-broker | 4 uvicorn workers, 32 concurrent tasks | 1 GB + 1 GB / task | `BROKER_WORKERS`, `BROKER_MAX_CONCURRENT`, `BROKER_MEM_LIMIT` |
| gitlab-mcp | 4 uvicorn workers | 512 MB | `GITLAB_MCP_WORKERS` |
| context-search | 4 uvicorn workers | 1 GB | `CONTEXT_SEARCH_WORKERS` |

**Total static footprint (everything from the table above):** ~32 GB.
Scale `*_MEM_LIMIT` and `*_HEAP` down on smaller hosts.

## Web UIs (host-exposed ports)

| Component | URL | Default port | env var |
| --- | --- | --- | --- |
| **GitLab CE** | http://`<host>`:8929/ | 8929 | `GITLAB_HTTP_PORT` |
| GitLab SSH (git push/pull) | ssh://git@`<host>`:2222 | 2222 | `GITLAB_SSH_PORT` |
| **Kibana** (admin / observability) | http://`<host>`:5601/ | 5601 | `KIBANA_HTTP_PORT` |
| Elasticsearch (admin / debug) | http://`<host>`:9200/ | 9200 | `ELASTIC_HTTP_PORT` |
| Qdrant dashboard | http://`<host>`:6333/dashboard | 6333 | `QDRANT_HTTP_PORT` |
| Postgres (psql / pgAdmin) | tcp://`<host>`:5433 | 5433 | `POSTGRES_AUTH_HTTP_PORT` |
| Redis (redis-cli / RedisInsight) | tcp://`<host>`:6380 | 6380 | `REDIS_HTTP_PORT` |
| gitlab-mcp REST | http://`<host>`:8047/ | 8047 | `GITLAB_MCP_HTTP_PORT` |
| context-search REST | http://`<host>`:8049/ | 8049 | `CONTEXT_SEARCH_HTTP_PORT` |

> The simorgh frontend / backend / admin UI are still served via the host
> nginx as before (no change). The ports above are for **operations** —
> generating the GitLab API token, viewing logs in Kibana, debugging
> indices in ES, etc.

## How to get a GitLab API token (the one missing from .env)

1. Open `http://<host>:8929/` (or `http://gitlab.simorgh.local:8929/` if
   you've added that name to DNS / hosts).
2. Sign in: username `root`, password = `${GITLAB_ROOT_PASSWORD}`.
3. Top-right avatar → **Edit profile** → **Access Tokens**.
4. Name: `simorgh-agent`, scopes: `api`, expires: empty (or far future).
5. Copy the `glpat-…` value.
6. Put it in `.env`:
   ```
   GITLAB_API_TOKEN=glpat-xxxxxxxxxxxxxxxxxxxx
   ```
7. Create the two groups via the UI (`+` → **New group**):
   `simorgh-projects`, `simorgh-knowledge`.
8. `docker compose up -d gitlab-mcp` (or `up -d` for the rest).
