#!/usr/bin/env bash
# =============================================================================
# Staged deploy for the 2026-05 project-chat overhaul.
#
# Order: lightest, most-depended-on services first; heavy services and the
# things that consume them last. Each tier waits for healthchecks before
# the next tier starts.
#
# Usage:
#   cd /path/to/simorgh-chatbot-ekc-deploy/simorgh-agent
#   ./scripts/deploy-2026-05-project-chat.sh [--no-pull] [--skip-migration]
#
# Re-runnable. Each tier is idempotent.
# =============================================================================
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${PROJECT_ROOT}"

COMPOSE="docker compose -f docker-compose.yml"

NO_PULL=0
SKIP_MIGRATION=0
for arg in "$@"; do
    case "$arg" in
        --no-pull)        NO_PULL=1 ;;
        --skip-migration) SKIP_MIGRATION=1 ;;
        *) echo "unknown arg: $arg" >&2; exit 2 ;;
    esac
done

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

wait_healthy() {
    local svc="$1"
    local tries=30
    log "waiting for ${svc} to become healthy"
    while (( tries-- > 0 )); do
        local status
        status=$(${COMPOSE} ps --format json "${svc}" 2>/dev/null \
                 | grep -o '"Health":"[^"]*"' | head -1 \
                 | cut -d'"' -f4 || true)
        if [[ "${status}" == "healthy" ]]; then
            echo "  ${svc}: healthy"
            return 0
        fi
        # No healthcheck configured → just check it's running.
        local state
        state=$(${COMPOSE} ps --format json "${svc}" 2>/dev/null \
                | grep -o '"State":"[^"]*"' | head -1 \
                | cut -d'"' -f4 || true)
        if [[ -z "${status}" && "${state}" == "running" ]]; then
            echo "  ${svc}: running (no healthcheck)"
            return 0
        fi
        sleep 2
    done
    die "${svc} did not reach healthy state"
}

up_tier() {
    local label="$1"; shift
    log "tier: ${label} — ${*}"
    ${COMPOSE} up -d --build "$@"
    for svc in "$@"; do wait_healthy "${svc}"; done
}

# -----------------------------------------------------------------------------
# 0. Pre-flight
# -----------------------------------------------------------------------------
log "pre-flight: git status"
git -C "${PROJECT_ROOT}/.." status --short || true
git -C "${PROJECT_ROOT}/.." log --oneline -5 || true

if [[ "${NO_PULL}" == "0" ]]; then
    log "pre-flight: pulling latest from origin"
    git -C "${PROJECT_ROOT}/.." pull --ff-only origin "$(git -C "${PROJECT_ROOT}/.." rev-parse --abbrev-ref HEAD)"
fi

# Build the session-runtime image first — runtime-broker uses it to spawn
# per-project containers. Without this image, runtime-broker /sessions/start
# will fail with ImageNotFound.
log "pre-flight: building simorgh/session-runtime:latest"
docker build \
    -f runtime-broker/Dockerfile.session-runtime \
    -t simorgh/session-runtime:latest \
    runtime-broker/

# Migration 004 — must run before chat-service or project-agent-service
# touch the new project_chat_sessions / project_containers / project_exploration
# tables. The runner is idempotent (tracks applied filenames).
if [[ "${SKIP_MIGRATION}" == "0" ]]; then
    log "pre-flight: applying migration 004"
    # Run inside a one-shot container so we don't need psql/python on the host.
    ${COMPOSE} run --rm \
        -e POSTGRES_AUTH_PASSWORD \
        -e POSTGRES_AUTH_HOST=postgres_auth \
        -e POSTGRES_AUTH_DATABASE=simorgh_auth \
        -e POSTGRES_AUTH_USER=simorgh \
        --entrypoint python \
        chat-service \
        /app/database/migrations/run_migrations.py
fi

# -----------------------------------------------------------------------------
# TIER 1 — LIGHT: small images, no upstream deps, lots of consumers.
# Bring these up first so the heavy tiers find them ready.
# -----------------------------------------------------------------------------
up_tier "1 / light, no upstream deps" \
    gitlab-mcp \
    tpms-fetcher \
    tpms-context-agent \
    project-explorer

# -----------------------------------------------------------------------------
# TIER 2 — MEDIUM: orchestrators + lightweight stateful services.
# They depend on the tier-1 set being healthy.
# -----------------------------------------------------------------------------
up_tier "2 / medium orchestrators" \
    project-init \
    project-analysis \
    admin-service

# -----------------------------------------------------------------------------
# TIER 3 — HEAVY: runtime-broker (manages session containers), chat-service
# (new routes + container mirror), project-agent (CoT engine — consumes
# every MCP from tier 1+2), and the SPA + reverse proxy.
# -----------------------------------------------------------------------------
up_tier "3 / heavy core" \
    runtime-broker \
    chat-service \
    project-agent-service

up_tier "3 / SPA + nginx" \
    frontend \
    nginx

# -----------------------------------------------------------------------------
# Post-deploy verification
# -----------------------------------------------------------------------------
log "post-deploy: probing new endpoints"

probe() {
    local label="$1" url="$2" expect="$3"
    local code
    code=$(curl -ksS -o /dev/null -w '%{http_code}' "${url}" || echo "000")
    if [[ "${code}" == "${expect}" ]]; then
        printf '  \033[32m✓\033[0m %s [%s] %s\n' "${label}" "${code}" "${url}"
    else
        printf '  \033[31m✗\033[0m %s [%s, expected %s] %s\n' "${label}" "${code}" "${expect}" "${url}"
    fi
}

probe "gitlab-mcp /health"         "http://127.0.0.1:8047/health"                       200
probe "runtime-broker /health"     "http://127.0.0.1:8048/health"                       200
probe "project-explorer /health"   "http://127.0.0.1:8052/health"                       200
probe "project-init /health"       "http://127.0.0.1:8022/health"                       200
probe "tpms-context /health"       "http://127.0.0.1:8050/health"                       200
probe "tpms-fetcher /health"       "http://127.0.0.1:8021/health"                       200
probe "chat-service /health"       "http://127.0.0.1:8034/health"                       200
probe "project-agent /health"      "http://127.0.0.1:8035/health"                       200
# New end-user surfaces through nginx — wizard reach + auth gates.
# /api/gitlab/user-projects is auth-required at the gitlab-mcp layer
# (needs a user PAT header) → expect 401 from the bare GET.
probe "wizard /api/gitlab/user-projects (auth required)" \
      "http://127.0.0.1/api/gitlab/user-projects"                                       401
# /api/v2/chatbot/project/sessions is JWT-gated by chat-service → 401.
probe "wizard /api/v2/chatbot/project/sessions (auth required)" \
      "http://127.0.0.1/api/v2/chatbot/project/sessions"                                401
# /api/gitlab/access-instructions is public guide text → 200.
probe "wizard /api/gitlab/access-instructions" \
      "http://127.0.0.1/api/gitlab/access-instructions"                                 200

log "deploy complete"
