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
