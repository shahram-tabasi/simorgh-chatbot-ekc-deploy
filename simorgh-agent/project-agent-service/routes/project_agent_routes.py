"""
Project Agent Routes
=====================
API routes for the Project Manager Agent system.
Handles project CRUD, COT-driven messaging, tasks, instructions,
documents, git operations, and email gateway.

Modern users create projects by name only (no TPMS data).
Legacy users can optionally link TPMS OENUM.
"""

import json
import logging
import uuid
from datetime import datetime
from typing import Optional, List, Dict, Any

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
import asyncio

from models.project_models import (
    ProjectCreate, ProjectUpdate, ProjectResponse, ProjectListResponse,
    InstructionCreate, InstructionUpdate, InstructionResponse,
    TaskCreate, TaskUpdate, TaskResponse, TaskListResponse,
    COTRequest, COTExecutionProgress,
    ProjectMessageCreate, ProjectMessageResponse,
    ShellCommandRequest, ShellCommandResponse,
    GitCommitRequest, AgentState,
    ProjectStatus, TaskStatus, MessageChannel, TaskTrigger,
    ContainerStatus, BranchStatus, RuntimeStatus,
)
import os
import httpx

# External-source gateway URLs (per EXTERNAL_GATEWAY_POLICY.md). The agent
# never connects to the underlying systems directly — it goes through these.
# The 2026-05 enterprise migration consolidated the old techserver-service,
# tech-kb-service and 192.168.1.69 shell-service into:
#   • gitlab-mcp        — all GitLab repo I/O (incl. EKC technical-knowledge)
#   • runtime-broker    — per-project shell-runtime containers
#   • project-init      — orchestrator of the create-project flow
#   • tpms-fetcher      — sole MySQL gateway to TPMS
TPMS_FETCHER_URL    = os.getenv("TPMS_FETCHER_URL",    "http://tpms-fetcher:8021")
PROJECT_INIT_URL    = os.getenv("PROJECT_INIT_URL",    "http://project-init:8022")
MAIL_BRIDGE_URL     = os.getenv("MAIL_BRIDGE_URL",     "http://mail-bridge:8051")
RUNTIME_BROKER_URL  = os.getenv("RUNTIME_BROKER_URL",  "http://runtime-broker:8048")
BROKER_TOKEN        = os.getenv("BROKER_TOKEN",        "")

# Restrictions file (admin-managed). Read on every turn (mtime-cached
# inside the agent) and prepended to the system prompt as hard
# constraints on the final response.
RESTRICTIONS_PATH = os.getenv("RESTRICTIONS_PATH", "/app/restrictions/system.txt")
from services.auth_utils import get_current_user, require_role
from services.project_agent import get_project_agent, ProjectManagerAgent
from services.project_memory_service import get_project_memory_service, ProjectMemoryService
from services.shell_service import get_shell_service, ShellServiceClient
from services.email_gateway import get_email_gateway, InboundEmail
from services.doc_processor_client import DocProcessorClient
from services.redis_service import get_redis_service

# Role gate for project creation. Configurable via env so adding more roles
# (e.g. manager_technical) doesn't require a code change.
PROJECT_CREATE_ALLOWED_ROLES = tuple(
    r.strip() for r in os.getenv(
        "PROJECT_CREATE_ALLOWED_ROLES",
        "expert_technical",
    ).split(",") if r.strip()
)

# Where to post outbound email replies (when channel=email). project-mail
# was retired in 2026-05; mail-bridge fronts Mailcow's SMTP submission.


logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v2/agent", tags=["Project Agent"])


# ---------------------------------------------------------------------------
# Source precheck used to live here, hitting techserver-service /
# tech-kb-service / shell-service. All three were retired in 2026-05.
# The new wizard validates per-source inline (gitlab via gitlab-mcp,
# tpms/techserver via tpms-fetcher /projects/{oenum}/check-access, ekc
# via gitlab-mcp on the technical-knowledge repo, upload always-on).
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Init-status precheck — block /message until project-init finishes.
# ---------------------------------------------------------------------------
# Phase 3 of the auto-exploration rollout. project-init runs the clone,
# artifact extraction, search-index, TPMS pull, etc. in the background
# after POST /projects returns; until the indexer step finishes the
# planner's search_context tool can't actually find anything in this
# project, so any answer it produces is at best a live-GitLab guess and
# at worst the silent "I don't know what's in your project" we saw
# during Phase 1 development. Block chat until the init reports
# completed/failed; surface the live progress so the UI can show what
# step is in flight rather than just spinning.
# ---------------------------------------------------------------------------
INIT_BLOCKING_STATES = {"pending", "running"}


async def _check_init_ready(project_id: str) -> Optional[Dict[str, Any]]:
    """Return None if the project is ready for chat (init completed,
    failed, or no record at all — fail-open for legacy projects that
    were inited before this code shipped); return the live status dict
    otherwise. The dict has the same shape /status/by_project returns:
    {init_id, project_id, status, started_at, current_step, steps, ...}.
    """
    try:
        async with httpx.AsyncClient(timeout=5.0) as c:
            r = await c.get(
                f"{PROJECT_INIT_URL}/status/by_project/{project_id}"
            )
    except httpx.HTTPError as e:
        # project-init unreachable: don't gate chat on it, just log.
        # Better to risk an empty-index answer than to lock the user
        # out when the auxiliary service is down.
        logger.warning("init-status lookup failed for %s: %s", project_id, e)
        return None

    if r.status_code == 404:
        # No init record — assume an earlier successful run that the
        # in-memory _init_status doesn't remember (project-init was
        # restarted). Don't block.
        return None
    if r.status_code != 200:
        logger.warning("init-status returned %d for %s", r.status_code, project_id)
        return None

    status = r.json()
    if (status.get("status") or "").lower() in INIT_BLOCKING_STATES:
        return status
    return None


def _init_progress_payload(status: Dict[str, Any]) -> Dict[str, Any]:
    """Compact, UI-friendly shape derived from the project-init status.

    The full status payload includes per-step records and timestamps the
    UI doesn't need on every poll. Keep this lightweight; the wizard /
    chat overlay only needs to render "<current step> (<n>/<total>
    completed)" and a list of completed step names for the progress bar.
    """
    steps = status.get("steps") or []
    completed = [s for s in steps if (s.get("status") or "").lower() == "ok"]
    failed    = [s for s in steps if (s.get("status") or "").lower() == "error"]
    # The orchestrator's step order is fixed (start_container,
    # clone_user_repo, extract_artifacts, index_for_search, pull_tpms,
    # pull_techserver, clone_ekc, ensure_uploads_dir, kick_explorer).
    # Some are conditional but the expected count for the typical
    # gitlab-backed flow is 9; fall back to the running count if the
    # caller picked a non-standard source mix.
    total_expected = max(len(steps), 5)
    return {
        "status": status.get("status"),
        "current_step": status.get("current_step"),
        "completed_steps": [s.get("step") for s in completed],
        "failed_steps": [
            {"step": s.get("step"), "error": s.get("error")}
            for s in failed
        ],
        "completed_count": len(completed),
        "total_expected": total_expected,
        "init_id": status.get("init_id"),
        "started_at": status.get("started_at"),
    }


@router.get("/projects/{project_id}/init-status")
async def get_project_init_status(
    project_id: str,
    current_user: str = Depends(get_current_user),
):
    """Proxy the project-init status so the chat UI can poll without
    needing a direct route to project-init (which isn't authed for
    end users). Returns the compact progress shape used by the 425
    response below, plus a `ready: bool` so the UI knows when to
    stop polling and re-enable the input.
    """
    memory = get_project_memory_service()
    project = await memory.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if project["owner_id"] != current_user:
        raise HTTPException(status_code=403, detail="Access denied")

    status = await _check_init_ready(project_id)
    if status is None:
        return {"ready": True}
    return {"ready": False, "progress": _init_progress_payload(status)}


# ---------------------------------------------------------------------------
# Restrictions file — admin / dev free-text instructions that the agent
# treats as hard constraints on every final response. Mounted as a
# host-managed volume; same role gate as project creation for now.
# ---------------------------------------------------------------------------
@router.get("/restrictions")
async def get_restrictions(
    auth_user: dict = Depends(require_role(*PROJECT_CREATE_ALLOWED_ROLES)),
) -> Dict[str, Any]:
    try:
        with open(RESTRICTIONS_PATH, "r", encoding="utf-8") as f:
            content = f.read()
        return {"path": RESTRICTIONS_PATH, "content": content}
    except FileNotFoundError:
        return {"path": RESTRICTIONS_PATH, "content": ""}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/restrictions")
async def put_restrictions(
    body: Dict[str, str],
    auth_user: dict = Depends(require_role(*PROJECT_CREATE_ALLOWED_ROLES)),
) -> Dict[str, Any]:
    """Replace the restrictions file. Body: {"content": "..."}."""
    content = body.get("content", "")
    try:
        os.makedirs(os.path.dirname(RESTRICTIONS_PATH), exist_ok=True)
        with open(RESTRICTIONS_PATH, "w", encoding="utf-8") as f:
            f.write(content)
        return {"ok": True, "bytes": len(content)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# =============================================================================
# DEPENDENCY HELPERS
# =============================================================================

def _is_legacy_user(user_id: str) -> bool:
    """Check if user is legacy (non-UUID) or modern (UUID)."""
    try:
        uuid.UUID(user_id)
        return False  # Modern user
    except (ValueError, AttributeError):
        return True  # Legacy user


# =============================================================================
# PROJECT CRUD
# =============================================================================

@router.post("/projects", response_model=ProjectResponse)
async def create_project(
    data: ProjectCreate,
    auth_user: dict = Depends(require_role(*PROJECT_CREATE_ALLOWED_ROLES)),
):
    """
    Unified project creation endpoint.

    Authorization: only users whose `role_category` JWT claim (or Redis
    `user_profile:{id}` value) is in PROJECT_CREATE_ALLOWED_ROLES can
    create projects. By default, that's `expert_technical` only.

    Legacy users (organize members):
      - Must provide tpms_oenum for TPMS authentication
      - TPMS data is fetched and stored in project workspace
      - Files are copied from \\\\techserver
      - Can choose online or offline LLM

    Modern users:
      - Just provide a project name
      - No TPMS integration
      - Uses online AI only
    """
    current_user = auth_user.get("sub")
    memory = get_project_memory_service()
    agent = get_project_agent()

    is_legacy = _is_legacy_user(current_user)

    # Modern users cannot link TPMS
    if not is_legacy and data.tpms_oenum:
        raise HTTPException(
            status_code=400,
            detail="Modern users cannot link TPMS projects. Create a project by name."
        )

    # The 2026-05 per-project container flow allows legacy users to create
    # projects without a TPMS oenum (they can pick a GitLab repo or use the
    # upload-only fallback). TPMS oenum is only required if the wizard
    # explicitly ticked the tpms/techserver sources — that's enforced below
    # against `sources_enabled` rather than as a blanket precondition.

    # Resolve sources to the canonical SourcesEnabled form. The wizard
    # always sends one directly; clients that still send a bare list of
    # strings are coerced to the new shape.
    from models.project_models import SourcesEnabled
    if isinstance(data.sources, SourcesEnabled):
        sources_enabled = data.sources.model_dump()
    else:
        legacy_list = list(data.sources or [])
        sources_enabled = {
            "gitlab": bool(data.gitlab_repo_path),
            "tpms": "tpms" in legacy_list,
            "techserver": "techserver" in legacy_list,
            "techserver_oenum": data.tpms_oenum,
            "ekc": "tech_knowledge" in legacy_list,
            "upload": True,
        }

    # If tpms/techserver are enabled, an OE number is required.
    if sources_enabled.get("tpms") or sources_enabled.get("techserver"):
        if not (sources_enabled.get("techserver_oenum") or data.tpms_oenum):
            raise HTTPException(
                status_code=400,
                detail="TPMS / techserver sources need an OE number.",
            )

    # Enforce LLM mode: modern users always use online AI
    agent_model = data.agent_model or "gpt-4o"
    if not is_legacy:
        agent_model = "gpt-4o"  # Modern users: online only

    try:
        # Create in PostgreSQL
        project = await memory.create_project(
            owner_id=current_user,
            name=data.name,
            description=data.description,
            tpms_oenum=(data.tpms_oenum
                        or sources_enabled.get("techserver_oenum")) if is_legacy else None,
            agent_model=agent_model,
            metadata={**(data.metadata or {}), "is_legacy": is_legacy},
            gitlab_repo_path=data.gitlab_repo_path,
            gitlab_repo_url=data.gitlab_repo_url,
            gitlab_base_branch=data.gitlab_base_branch,
            sources_enabled=sources_enabled,
        )

        if not project:
            raise HTTPException(status_code=500, detail="Failed to create project")

        project_id = str(project["id"])
        init_result: Dict[str, Any] = {}

        # Step 1 — agent-side bookkeeping (TPMS slice sync, project linking
        # in the in-memory agent state). Filesystem work that used to live
        # here moved to project-init-service in 2026-05.
        try:
            agent_init = await agent.initialize_project(
                project_id, data.name, current_user,
                tpms_oenum=data.tpms_oenum if is_legacy else None,
                is_legacy=is_legacy,
            )
            init_result["agent"] = agent_init
            logger.info("agent.initialize_project: %s, results: %s",
                        project_id, agent_init)
        except Exception as e:
            logger.exception("agent.initialize_project failed (continuing): %s", e)
            init_result["agent"] = {"ok": False, "error": str(e)[:300]}

        # Step 2 — kick off project-init-service. This is the sole
        # orchestrator now: start session container, optional gitlab repo
        # clone + simorgh/<hex> branch, optional TPMS pull, optional
        # techserver SMB copy, optional EKC clone, uploads/ dir, then the
        # two-phase explorer. Runs in background; status is pollable via
        # GET {PROJECT_INIT_URL}/status/{init_id}.
        init_payload: Dict[str, Any] = {
            "project_id":         project_id,
            "project_name":       data.name,
            "owner_id":           current_user,
            "gitlab_repo_path":   data.gitlab_repo_path,
            "gitlab_repo_url":    data.gitlab_repo_url,
            "gitlab_base_branch": data.gitlab_base_branch,
            "sources":            sources_enabled,
            "oenum":              (data.tpms_oenum
                                   or sources_enabled.get("techserver_oenum")),
        }
        # Forward TPMS credentials only when a TPMS-backed source is
        # ticked. The wizard only collects them in that case.
        if data.tpms_auth and (
            sources_enabled.get("tpms") or sources_enabled.get("techserver")
        ):
            init_payload["tpms_auth"] = {
                "user": data.tpms_auth.user,
                "pass": data.tpms_auth.password,
            }
        try:
            async with httpx.AsyncClient(timeout=30.0) as c:
                r = await c.post(f"{PROJECT_INIT_URL}/init", json=init_payload)
                init_result["project_init"] = (
                    r.json() if r.status_code == 200
                    else {"ok": False, "error": r.text[:300]}
                )
        except httpx.HTTPError as e:
            logger.warning("project-init unreachable: %s", e)
            init_result["project_init"] = {"ok": False, "error": str(e)[:200]}

        # project-init generates the simorgh/<oenum>/<hex> working branch
        # name and returns it in the /init response, but the orchestrator
        # never persisted it. Without this, every project row stays at
        # simorgh_branch=NULL, and the sidebar's branch-status dot, the
        # commit_push flow, and the dispatcher's ref-defaulting all
        # silently fall back to gitlab_base_branch.
        try:
            sb = (init_result.get("project_init") or {}).get("simorgh_branch")
            if sb:
                await memory.update_project(project_id, simorgh_branch=sb)
                logger.info(
                    "Persisted simorgh_branch=%s for project %s", sb, project_id,
                )
        except Exception as e:
            logger.warning(
                "Failed to persist simorgh_branch for %s: %s", project_id, e,
            )

        logger.info("Project %s init queued: %s", project_id, init_result)

        return ProjectResponse(
            id=project["id"],
            owner_id=project["owner_id"],
            name=project["name"],
            description=project.get("description"),
            tpms_oenum=project.get("tpms_oenum"),
            status=ProjectStatus(project.get("status", "active")),
            agent_enabled=project.get("agent_enabled", True),
            agent_model=project.get("agent_model", "gpt-4o"),
            git_repo_initialized=True,
            metadata=json.loads(project["metadata"]) if isinstance(project.get("metadata"), str) else project.get("metadata", {}),
            created_at=project["created_at"],
            updated_at=project["updated_at"],
        )

    except HTTPException:
        raise
    except Exception as e:
        # Unique-name collision (per migration 003's idx_projects_owner_name)
        # — surface as 409 with a friendly message so the wizard can prompt
        # the user to rename instead of showing a stack trace.
        msg = str(e)
        if "idx_projects_owner_name" in msg or "duplicate key" in msg.lower():
            existing_name = data.name
            raise HTTPException(
                status_code=409,
                detail=(
                    f"You already have a project named '{existing_name}'. "
                    "Pick a different name or open the existing project."
                ),
            )
        logger.error(f"Project creation failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to create project: {str(e)}")


# =============================================================================
# Runtime status (sidebar dot) — derived from runtime-broker + project meta.
# =============================================================================
# Maps docker container state (running / paused / exited / created / absent)
# onto the higher-level ContainerStatus enum the frontend renders.
_DOCKER_STATE_TO_CONTAINER: dict[str, ContainerStatus] = {
    "running":    ContainerStatus.RUNNING,
    "paused":     ContainerStatus.PAUSED,
    "exited":     ContainerStatus.STOPPED,
    "created":    ContainerStatus.STOPPED,
    "restarting": ContainerStatus.RUNNING,
    "removing":   ContainerStatus.STOPPED,
    "dead":       ContainerStatus.ERROR,
    "absent":     ContainerStatus.ABSENT,
}


async def _compute_runtime_status(
    project_id: str, project_meta: dict[str, Any],
    active_task_count: int = 0,
) -> RuntimeStatus:
    """Best-effort: ask the broker for container state, blend with project
    metadata to produce the single ``RuntimeStatus`` the sidebar renders.

    Never raises — a broker outage shouldn't blank-out the project list.
    """
    simorgh_branch = (
        project_meta.get("simorgh_branch")
        or (project_meta.get("metadata") or {}).get("simorgh_branch")
    )
    pending_sha   = (project_meta.get("metadata") or {}).get("pending_commit_sha")
    push_conflict = bool((project_meta.get("metadata") or {}).get("push_conflict"))
    branch_pushed = bool((project_meta.get("metadata") or {}).get("branch_pushed"))

    # ----- branch_status ---------------------------------------------------
    if push_conflict:
        branch_status = BranchStatus.CONFLICT
    elif simorgh_branch and branch_pushed:
        branch_status = BranchStatus.PUSHED
    elif simorgh_branch:
        branch_status = BranchStatus.CREATED
    else:
        branch_status = BranchStatus.NONE

    # ----- container_status ------------------------------------------------
    container_status = ContainerStatus.ABSENT
    try:
        headers = {"authorization": f"Bearer {BROKER_TOKEN}"} if BROKER_TOKEN else {}
        async with httpx.AsyncClient(timeout=3.0) as c:
            r = await c.get(
                f"{RUNTIME_BROKER_URL}/sessions/{project_id}/status",
                headers=headers,
            )
            if r.status_code == 200:
                docker_state = (r.json().get("status") or "absent").lower()
                container_status = _DOCKER_STATE_TO_CONTAINER.get(
                    docker_state, ContainerStatus.ABSENT,
                )
    except Exception as e:
        logger.debug("runtime_status broker probe failed for %s: %s",
                     project_id, e)

    # Refine: an in-progress task while the container is running = BUSY.
    if container_status == ContainerStatus.RUNNING and active_task_count > 0:
        container_status = ContainerStatus.BUSY
    elif container_status == ContainerStatus.STOPPED and active_task_count > 0:
        # Container exited while a task was still in-flight — the user
        # killed work mid-CoT. This is the orange dot in Claude Code.
        container_status = ContainerStatus.STOPPED_INCOMPLETE

    return RuntimeStatus(
        container=container_status,
        branch=branch_status,
        simorgh_branch=simorgh_branch,
        pending_commit_sha=pending_sha if push_conflict else None,
    )


@router.get("/projects", response_model=ProjectListResponse)
async def list_projects(
    current_user: str = Depends(get_current_user),
):
    """List all projects for the current user."""
    memory = get_project_memory_service()

    try:
        projects = await memory.list_projects(current_user)
        # Run all broker probes concurrently — the worst case (broker
        # down) caps at ~3s once thanks to per-probe timeout, not Nx3s.
        status_tasks = [
            _compute_runtime_status(
                str(p["id"]), p, active_task_count=p.get("active_task_count", 0),
            )
            for p in projects
        ]
        runtime_statuses = await asyncio.gather(*status_tasks, return_exceptions=False)

        responses = []
        for p, rs in zip(projects, runtime_statuses):
            responses.append(ProjectResponse(
                id=p["id"],
                owner_id=p["owner_id"],
                name=p["name"],
                description=p.get("description"),
                tpms_oenum=p.get("tpms_oenum"),
                status=ProjectStatus(p.get("status", "active")),
                agent_enabled=p.get("agent_enabled", True),
                agent_model=p.get("agent_model", "gpt-4o"),
                git_repo_initialized=p.get("git_repo_initialized", False),
                metadata=json.loads(p["metadata"]) if isinstance(p.get("metadata"), str) else p.get("metadata", {}),
                created_at=p["created_at"],
                updated_at=p["updated_at"],
                task_count=p.get("task_count", 0),
                active_task_count=p.get("active_task_count", 0),
                message_count=p.get("message_count", 0),
                document_count=p.get("document_count", 0),
                runtime_status=rs,
            ))

        return ProjectListResponse(projects=responses, total=len(responses))

    except Exception as e:
        logger.error(f"Failed to list projects: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/projects/{project_id}/runtime", response_model=RuntimeStatus)
async def get_project_runtime_status(
    project_id: str,
    current_user: str = Depends(get_current_user),
):
    """Lightweight polling endpoint: just the sidebar dot, no joins.

    Used by the frontend to refresh status every ~10s on expanded
    projects without re-fetching the whole list.
    """
    memory = get_project_memory_service()
    project = await memory.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if project["owner_id"] != current_user:
        raise HTTPException(status_code=403, detail="Access denied")
    return await _compute_runtime_status(
        project_id, project,
        active_task_count=project.get("active_task_count", 0),
    )


@router.get("/projects/runtime/batch")
async def batch_project_runtime_status(
    current_user: str = Depends(get_current_user),
):
    """Batch sidebar-dot probe. Returns ``{project_id: RuntimeStatus}``.

    The sidebar uses two unrelated project lists (legacy
    ``/users/{id}/project-chats`` for project_number-keyed rows, and the
    agent's ``/projects`` for UUID-keyed rows). This route gives the
    frontend a single source of truth for the dot regardless of which
    list it's rendering — caller picks projects by id and the merge is
    trivial.
    """
    memory = get_project_memory_service()
    try:
        projects = await memory.list_projects(current_user)
    except Exception as e:
        logger.warning("batch_runtime list_projects failed: %s", e)
        return {}

    if not projects:
        return {}

    tasks = [
        _compute_runtime_status(
            str(p["id"]), p, active_task_count=p.get("active_task_count", 0),
        )
        for p in projects
    ]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    out: dict[str, dict] = {}
    for p, r in zip(projects, results):
        if isinstance(r, Exception):
            logger.debug("runtime probe failed for %s: %s", p.get("id"), r)
            continue
        # Index by both UUID and tpms_oenum so the legacy sidebar (keyed
        # by oenum) can look the project up without an extra translation.
        out[str(p["id"])] = r.model_dump()
        oenum = p.get("tpms_oenum")
        if oenum:
            out[str(oenum)] = r.model_dump()
    return out


class GitDiffStats(BaseModel):
    base_branch: Optional[str] = None
    working_branch: Optional[str] = None
    files_changed: int = 0
    insertions: int = 0
    deletions: int = 0
    ahead: int = 0       # commits on working branch not in base
    behind: int = 0      # commits on base not in working branch
    error: Optional[str] = None


@router.get("/projects/{project_id}/git/diffstat", response_model=GitDiffStats)
async def get_project_diff_stats(
    project_id: str,
    current_user: str = Depends(get_current_user),
):
    """``git diff --shortstat`` against the project's base branch.

    Powers the +/- numbers in the chat-input header (the user's
    sidebar mockup shows ``+10,698 -14,326``). Runs ``git`` inside the
    project's runtime-broker container so the working tree is the live
    workspace, not a stale clone.
    """
    memory = get_project_memory_service()
    project = await memory.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if project["owner_id"] != current_user:
        raise HTTPException(status_code=403, detail="Access denied")

    meta = project.get("metadata") or {}
    if isinstance(meta, str):
        try:
            meta = json.loads(meta)
        except Exception:
            meta = {}

    base   = meta.get("gitlab_base_branch") or project.get("base_branch") or "main"
    branch = (
        meta.get("simorgh_branch")
        or project.get("simorgh_branch")
        or "HEAD"
    )

    script = (
        "set -e\n"
        "cd /work/gitlab 2>/dev/null || { echo '__NO_REPO__'; exit 0; }\n"
        "git fetch origin --quiet 2>/dev/null || true\n"
        f"BASE={base!r}\n"
        f"BRANCH={branch!r}\n"
        # shortstat gives "N files changed, X insertions(+), Y deletions(-)"
        "git diff --shortstat \"origin/$BASE...HEAD\" 2>/dev/null || "
        "  git diff --shortstat HEAD~1 2>/dev/null || echo ''\n"
        "echo '---REV-LIST---'\n"
        "git rev-list --left-right --count \"origin/$BASE...HEAD\" 2>/dev/null || echo '0\t0'\n"
    )

    try:
        headers = {"authorization": f"Bearer {BROKER_TOKEN}"} if BROKER_TOKEN else {}
        async with httpx.AsyncClient(timeout=10.0) as c:
            r = await c.post(
                f"{RUNTIME_BROKER_URL}/sessions/{project_id}/exec",
                json={"command": script, "timeout_sec": 8},
                headers=headers,
            )
        if r.status_code != 200:
            return GitDiffStats(base_branch=base, working_branch=branch,
                                error=f"broker {r.status_code}")
        out = (r.json().get("stdout") or "").strip()
        if "__NO_REPO__" in out:
            return GitDiffStats(base_branch=base, working_branch=branch,
                                error="no repo cloned in this session")
    except Exception as e:
        return GitDiffStats(base_branch=base, working_branch=branch,
                            error=f"{type(e).__name__}: {e}")

    # Parse ``N files changed, X insertions(+), Y deletions(-)``.
    import re as _re
    shortstat, _, rev = out.partition("---REV-LIST---")
    files_changed = insertions = deletions = 0
    m = _re.search(r"(\d[\d,]*)\s+files? changed", shortstat)
    if m: files_changed = int(m.group(1).replace(",", ""))
    m = _re.search(r"(\d[\d,]*)\s+insertions?", shortstat)
    if m: insertions = int(m.group(1).replace(",", ""))
    m = _re.search(r"(\d[\d,]*)\s+deletions?", shortstat)
    if m: deletions = int(m.group(1).replace(",", ""))

    behind = ahead = 0
    parts = rev.strip().split()
    if len(parts) == 2:
        try:
            behind = int(parts[0]); ahead = int(parts[1])
        except ValueError:
            pass

    return GitDiffStats(
        base_branch=base, working_branch=branch,
        files_changed=files_changed,
        insertions=insertions, deletions=deletions,
        ahead=ahead, behind=behind,
    )


@router.get("/projects/{project_id}", response_model=ProjectResponse)
async def get_project(
    project_id: str,
    current_user: str = Depends(get_current_user),
):
    """Get a project by ID."""
    memory = get_project_memory_service()
    project = await memory.get_project(project_id)

    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if project["owner_id"] != current_user:
        raise HTTPException(status_code=403, detail="Access denied")

    return ProjectResponse(
        id=project["id"],
        owner_id=project["owner_id"],
        name=project["name"],
        description=project.get("description"),
        tpms_oenum=project.get("tpms_oenum"),
        status=ProjectStatus(project.get("status", "active")),
        agent_enabled=project.get("agent_enabled", True),
        agent_model=project.get("agent_model", "gpt-4o"),
        git_repo_initialized=project.get("git_repo_initialized", False),
        metadata=json.loads(project["metadata"]) if isinstance(project.get("metadata"), str) else project.get("metadata", {}),
        created_at=project["created_at"],
        updated_at=project["updated_at"],
    )


@router.patch("/projects/{project_id}", response_model=ProjectResponse)
async def update_project(
    project_id: str,
    data: ProjectUpdate,
    current_user: str = Depends(get_current_user),
):
    """Update a project."""
    memory = get_project_memory_service()

    # Verify ownership
    project = await memory.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if project["owner_id"] != current_user:
        raise HTTPException(status_code=403, detail="Access denied")

    update_fields = {}
    if data.name is not None:
        update_fields["name"] = data.name
    if data.description is not None:
        update_fields["description"] = data.description
    if data.status is not None:
        update_fields["status"] = data.status.value
    if data.agent_enabled is not None:
        update_fields["agent_enabled"] = data.agent_enabled
    if data.agent_model is not None:
        update_fields["agent_model"] = data.agent_model
    if data.metadata is not None:
        update_fields["metadata"] = data.metadata

    updated = await memory.update_project(project_id, **update_fields)
    if not updated:
        raise HTTPException(status_code=500, detail="Failed to update project")

    return ProjectResponse(
        id=updated["id"],
        owner_id=updated["owner_id"],
        name=updated["name"],
        description=updated.get("description"),
        tpms_oenum=updated.get("tpms_oenum"),
        status=ProjectStatus(updated.get("status", "active")),
        agent_enabled=updated.get("agent_enabled", True),
        agent_model=updated.get("agent_model", "gpt-4o"),
        git_repo_initialized=updated.get("git_repo_initialized", False),
        metadata=json.loads(updated["metadata"]) if isinstance(updated.get("metadata"), str) else updated.get("metadata", {}),
        created_at=updated["created_at"],
        updated_at=updated["updated_at"],
    )


@router.delete("/projects/{project_id}")
async def delete_project(
    project_id: str,
    confirm: bool = Query(False),
    current_user: str = Depends(get_current_user),
):
    """Delete a project and all its data across all memory layers."""
    if not confirm:
        raise HTTPException(status_code=400, detail="Set confirm=true to delete")

    memory = get_project_memory_service()
    project = await memory.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if project["owner_id"] != current_user:
        raise HTTPException(status_code=403, detail="Access denied")

    # Clean up all layers (PostgreSQL slice, Qdrant, Redis, etc.).
    # Container teardown is handled by the chat-service cascade-delete
    # route when the user removes a project chat session — see
    # routes/project_chat_session.py.
    results = await memory.cleanup_project(project_id)

    return {"status": "deleted", "project_id": project_id, "details": results}


# =============================================================================
# AGENT MESSAGING (Main entry point - COT-driven)
# =============================================================================

@router.post("/projects/{project_id}/message")
async def send_message(
    project_id: str,
    data: ProjectMessageCreate,
    current_user: str = Depends(get_current_user),
):
    """
    Send a message to the project agent.
    Triggers COT analysis -> task creation -> execution -> response.
    """
    memory = get_project_memory_service()
    agent = get_project_agent()

    # Verify ownership
    project = await memory.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if project["owner_id"] != current_user:
        raise HTTPException(status_code=403, detail="Access denied")

    # Block chat while project-init is still indexing — see
    # _check_init_ready comment block above for the rationale.
    init_status = await _check_init_ready(project_id)
    if init_status is not None:
        raise HTTPException(
            status_code=425,  # Too Early
            detail={
                "code": "init_in_progress",
                "message": "Project initialization is still in progress. "
                           "Please wait for indexing to complete.",
                "progress": _init_progress_payload(init_status),
            },
        )

    try:
        result = await agent.handle_input(
            project_id=project_id,
            user_input=data.content,
            channel=data.channel,
            chat_id=data.chat_id,
            user_id=current_user,
            document_id=str(data.document_id) if data.document_id else None,
            document_filename=data.document_filename,
            email_from=data.email_from,
            email_subject=data.email_subject,
            auto_execute=True,
        )

        # If the trigger was an email, dispatch the agent's reply back to
        # the sender via project-mail-service so the conversation continues
        # on the same channel (resumable session, item 1 of the spec).
        if (
            data.channel == MessageChannel.EMAIL
            and data.email_from
            and result.get("response")
        ):
            try:
                async with httpx.AsyncClient(timeout=30.0) as c:
                    payload: Dict[str, Any] = {
                        "to":         [data.email_from],
                        "subject":    f"Re: {data.email_subject or 'Simorgh project update'}",
                        "body_text":  result["response"],
                    }
                    msg_id = getattr(data, "email_message_id", None)
                    if msg_id:
                        payload["in_reply_to"] = msg_id
                        payload["references"]  = [msg_id]
                    payload["extra_headers"] = {
                        "X-Simorgh-Project": project_id,
                        "X-Simorgh-Chat":    data.chat_id or "",
                    }
                    await c.post(f"{MAIL_BRIDGE_URL}/send", json=payload)
            except Exception:
                # Don't fail the agent turn if the outbound mail fails;
                # the response is already persisted in chat history and
                # the user can retrieve it via the chat channel.
                logger.exception("mail-bridge /send failed; reply not delivered by email")

        return {
            "response": result["response"],
            "chain_id": result["chain_id"],
            "reasoning": result["reasoning"],
            "tasks_created": result["tasks_created"],
            "tasks": result["tasks"],
            "commit": result.get("commit"),
        }

    except Exception as e:
        logger.error(f"Agent message failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Agent error: {str(e)}")


@router.post("/projects/{project_id}/message/stream")
async def send_message_stream(
    project_id: str,
    data: ProjectMessageCreate,
    current_user: str = Depends(get_current_user),
):
    """
    Send a message to the project agent with SSE streaming.
    Returns Server-Sent Events with progress updates and final response.
    """
    memory = get_project_memory_service()
    agent = get_project_agent()

    # Verify ownership
    project = await memory.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if project["owner_id"] != current_user:
        raise HTTPException(status_code=403, detail="Access denied")

    # Block stream while project-init is still indexing (Phase 3).
    init_status = await _check_init_ready(project_id)
    if init_status is not None:
        raise HTTPException(
            status_code=425,
            detail={
                "code": "init_in_progress",
                "message": "Project initialization is still in progress. "
                           "Please wait for indexing to complete.",
                "progress": _init_progress_payload(init_status),
            },
        )

    async def event_generator():
        progress_queue = asyncio.Queue()

        async def progress_callback(event_data):
            await progress_queue.put(event_data)

        # Register callback for streaming progress
        agent.register_progress_callback(project_id, progress_callback)

        # Start agent processing in background
        result_holder = {"result": None, "error": None}

        async def run_agent():
            try:
                result_holder["result"] = await agent.handle_input(
                    project_id=project_id,
                    user_input=data.content,
                    channel=data.channel,
                    chat_id=data.chat_id,
                    user_id=current_user,
                    document_id=str(data.document_id) if data.document_id else None,
                    document_filename=data.document_filename,
                    email_from=data.email_from,
                    email_subject=data.email_subject,
                    auto_execute=True,
                    # Per-request mode from SettingsPanel. Defaults to
                    # "offline" via the Pydantic model so any old client
                    # that doesn't send the field still gets local AI.
                    llm_mode=data.llm_mode,
                )
            except Exception as e:
                # The SSE consumer only sees str(e); log the full traceback
                # here so operators can pinpoint the source. The user still
                # sees just the message via the event:error stream.
                logger.exception(
                    "handle_input failed for project_id=%s chat_id=%s: %s",
                    project_id, data.chat_id, e,
                )
                result_holder["error"] = str(e)
            finally:
                # Signal completion
                await progress_queue.put({"event": "_done", "data": {}})

        agent_task = asyncio.create_task(run_agent())

        try:
            while True:
                try:
                    event = await asyncio.wait_for(progress_queue.get(), timeout=120)
                except asyncio.TimeoutError:
                    yield f"event: ping\ndata: {{}}\n\n"
                    continue

                event_name = event.get("event", "progress")
                event_data = event.get("data", {})

                if event_name == "_done":
                    # Send final result
                    if result_holder["result"]:
                        result = result_holder["result"]
                        final_data = json.dumps({
                            "response": result["response"],
                            "chain_id": result["chain_id"],
                            "reasoning": result["reasoning"],
                            "tasks_created": result["tasks_created"],
                            "tasks": result["tasks"],
                            "commit": result.get("commit"),
                        })
                        yield f"event: complete\ndata: {final_data}\n\n"
                    elif result_holder["error"]:
                        yield f"event: error\ndata: {json.dumps({'error': result_holder['error']})}\n\n"
                    break
                else:
                    yield f"event: {event_name}\ndata: {json.dumps(event_data, default=str)}\n\n"
        finally:
            agent.unregister_progress_callback(project_id)
            if not agent_task.done():
                await agent_task

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/projects/{project_id}/messages")
async def get_messages(
    project_id: str,
    channel: Optional[str] = None,
    chat_id: Optional[str] = None,
    limit: int = Query(50, ge=1, le=200),
    current_user: str = Depends(get_current_user),
):
    """Get project messages."""
    memory = get_project_memory_service()
    project = await memory.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if project["owner_id"] != current_user:
        raise HTTPException(status_code=403, detail="Access denied")

    messages = await memory.get_messages(project_id, channel=channel,
                                          chat_id=chat_id, limit=limit)
    return {"messages": messages, "total": len(messages)}


# =============================================================================
# TASKS
# =============================================================================

@router.get("/projects/{project_id}/tasks", response_model=TaskListResponse)
async def list_tasks(
    project_id: str,
    status: Optional[str] = None,
    chain_id: Optional[str] = None,
    limit: int = Query(50, ge=1, le=200),
    current_user: str = Depends(get_current_user),
):
    """List tasks for a project."""
    memory = get_project_memory_service()
    project = await memory.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if project["owner_id"] != current_user:
        raise HTTPException(status_code=403, detail="Access denied")

    tasks = await memory.get_tasks(project_id, status=status,
                                    cot_chain_id=chain_id, limit=limit)

    task_responses = []
    for t in tasks:
        task_responses.append(TaskResponse(
            id=t["id"],
            project_id=t["project_id"],
            instruction_id=t.get("instruction_id"),
            parent_task_id=t.get("parent_task_id"),
            cot_chain_id=t.get("cot_chain_id"),
            title=t["title"],
            description=t.get("description"),
            task_type=t.get("task_type", "action"),
            status=t.get("status", "pending"),
            priority=t.get("priority", 5),
            tool_used=t.get("tool_used"),
            tool_input=json.loads(t["tool_input"]) if isinstance(t.get("tool_input"), str) else t.get("tool_input"),
            result=t.get("result"),
            result_metadata=json.loads(t["result_metadata"]) if isinstance(t.get("result_metadata"), str) else t.get("result_metadata", {}),
            error_message=t.get("error_message"),
            sort_order=t.get("sort_order", 0),
            triggered_by=t.get("triggered_by", "user"),
            started_at=t.get("started_at"),
            completed_at=t.get("completed_at"),
            created_at=t["created_at"],
            updated_at=t["updated_at"],
        ))

    return TaskListResponse(
        tasks=task_responses,
        total=len(task_responses),
        pending=sum(1 for t in tasks if t.get("status") == "pending"),
        in_progress=sum(1 for t in tasks if t.get("status") == "in_progress"),
        completed=sum(1 for t in tasks if t.get("status") == "completed"),
        failed=sum(1 for t in tasks if t.get("status") == "failed"),
    )


@router.patch("/projects/{project_id}/tasks/{task_id}")
async def update_task(
    project_id: str,
    task_id: str,
    data: TaskUpdate,
    current_user: str = Depends(get_current_user),
):
    """Update a task (e.g., approve, cancel)."""
    memory = get_project_memory_service()
    project = await memory.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if project["owner_id"] != current_user:
        raise HTTPException(status_code=403, detail="Access denied")

    update_fields = {}
    if data.status:
        update_fields["status"] = data.status.value
    if data.result:
        update_fields["result"] = data.result
    if data.error_message:
        update_fields["error_message"] = data.error_message

    updated = await memory.update_task(task_id, project_id, **update_fields)
    if not updated:
        raise HTTPException(status_code=404, detail="Task not found")

    return {"status": "updated", "task": updated}


# =============================================================================
# INSTRUCTIONS
# =============================================================================

@router.post("/projects/{project_id}/instructions")
async def add_instruction(
    project_id: str,
    data: InstructionCreate,
    current_user: str = Depends(get_current_user),
):
    """Add an instruction step to a project."""
    memory = get_project_memory_service()
    project = await memory.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if project["owner_id"] != current_user:
        raise HTTPException(status_code=403, detail="Access denied")

    instruction = await memory.create_instruction(project_id, data.model_dump())
    return {"status": "created", "instruction": instruction}


@router.get("/projects/{project_id}/instructions")
async def list_instructions(
    project_id: str,
    current_user: str = Depends(get_current_user),
):
    """List all instructions for a project."""
    memory = get_project_memory_service()
    project = await memory.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if project["owner_id"] != current_user:
        raise HTTPException(status_code=403, detail="Access denied")

    instructions = await memory.get_instructions(project_id)
    return {"instructions": instructions, "total": len(instructions)}


# =============================================================================
# AGENT STATUS
# =============================================================================

@router.get("/projects/{project_id}/agent/status")
async def get_agent_status(
    project_id: str,
    current_user: str = Depends(get_current_user),
):
    """Get current agent status for a project."""
    memory = get_project_memory_service()
    project = await memory.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if project["owner_id"] != current_user:
        raise HTTPException(status_code=403, detail="Access denied")

    agent = get_project_agent()
    status = await agent.get_status(project_id)
    return status.model_dump(mode='json')


# =============================================================================
# SHELL / GIT OPERATIONS
# =============================================================================

@router.post("/projects/{project_id}/shell/exec")
async def exec_shell_command(
    project_id: str,
    command: str = Form(...),
    timeout: int = Form(30),
    current_user: str = Depends(get_current_user),
):
    """Execute a shell command in the project workspace."""
    memory = get_project_memory_service()
    project = await memory.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if project["owner_id"] != current_user:
        raise HTTPException(status_code=403, detail="Access denied")

    shell = get_shell_service()
    try:
        result = await shell.exec_command(
            project_id=project_id,
            command=command,
            timeout=timeout,
        )
        return result.model_dump()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/projects/{project_id}/git/log")
async def get_git_log(
    project_id: str,
    limit: int = Query(20, ge=1, le=100),
    current_user: str = Depends(get_current_user),
):
    """Get git log for a project."""
    memory = get_project_memory_service()
    project = await memory.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if project["owner_id"] != current_user:
        raise HTTPException(status_code=403, detail="Access denied")

    shell = get_shell_service()
    try:
        result = await shell.git_log(project_id, limit)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/projects/{project_id}/git/diff")
async def get_git_diff(
    project_id: str,
    current_user: str = Depends(get_current_user),
):
    """Get git diff for a project."""
    memory = get_project_memory_service()
    project = await memory.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if project["owner_id"] != current_user:
        raise HTTPException(status_code=403, detail="Access denied")

    shell = get_shell_service()
    try:
        result = await shell.git_diff(project_id)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/projects/{project_id}/files")
async def list_files(
    project_id: str,
    path: str = ".",
    recursive: bool = False,
    current_user: str = Depends(get_current_user),
):
    """List files in the project workspace."""
    memory = get_project_memory_service()
    project = await memory.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if project["owner_id"] != current_user:
        raise HTTPException(status_code=403, detail="Access denied")

    shell = get_shell_service()
    try:
        result = await shell.file_list(project_id, path, recursive)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# =============================================================================
# EMAIL GATEWAY WEBHOOK
# =============================================================================

@router.post("/email/inbound")
async def receive_inbound_email(
    data: dict,
):
    """
    Webhook endpoint for receiving inbound emails.
    Called by email provider (SendGrid Inbound Parse, Mailgun, etc.)
    """
    gateway = get_email_gateway()

    try:
        email_data = InboundEmail.from_webhook(data)
        result = await gateway.process_inbound_email(email_data)
        return result
    except Exception as e:
        logger.error(f"Inbound email processing failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/projects/{project_id}/email/generate")
async def generate_project_email(
    project_id: str,
    current_user: str = Depends(get_current_user),
):
    """Generate a unique email address for a project."""
    memory = get_project_memory_service()
    project = await memory.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if project["owner_id"] != current_user:
        raise HTTPException(status_code=403, detail="Access denied")

    gateway = get_email_gateway()
    email_addr = await gateway.generate_project_email(project_id)
    return {"email": email_addr, "project_id": project_id}


@router.post("/email-webhook")
async def mail_gateway_webhook(data: dict):
    """
    Webhook endpoint called by the mail-gateway service when a new email
    is received for a project. Stores the email in the project workspace
    on 1.69, commits it, and triggers COT analysis of the incoming email.
    """
    project_id = data.get("project_id")
    if not project_id:
        raise HTTPException(status_code=400, detail="project_id required")

    email_from = data.get("from", "unknown")
    subject = data.get("subject", "(no subject)")
    body_preview = data.get("body_preview", "")
    email_id = data.get("email_id", "unknown")
    received_at = data.get("received_at", "")
    has_attachments = data.get("has_attachments", False)
    attachment_count = data.get("attachment_count", 0)

    agent = get_project_agent()
    shell = get_shell_service()

    # 1. Store email content in project workspace on 1.69
    try:
        import json as _json
        email_record = _json.dumps({
            "id": email_id,
            "from": email_from,
            "subject": subject,
            "body_preview": body_preview,
            "received_at": received_at,
            "has_attachments": has_attachments,
            "attachment_count": attachment_count,
        }, indent=2)
        safe_subject = "".join(
            c if c.isalnum() or c in (' ', '-', '_') else '_'
            for c in subject[:50]
        ).strip().replace(' ', '_')
        email_filename = f"emails/{received_at[:10]}_{safe_subject}_{email_id[:8]}.json"

        await shell.exec_command(
            project_id=project_id,
            command="mkdir -p emails",
            timeout=10,
        )
        await shell.file_write(
            project_id=project_id,
            path=email_filename,
            content=email_record,
        )
        # Commit the email to git
        await shell.git_commit(
            project_id,
            f"Store incoming email: '{subject}' from {email_from}",
        )
    except Exception as e:
        logger.warning(f"Failed to store email in workspace: {e}")

    # 2. Trigger COT analysis via agent's handle_input
    try:
        email_input = (
            f"New email received for this project.\n"
            f"From: {email_from}\n"
            f"Subject: {subject}\n"
            f"Received: {received_at}\n"
            f"Attachments: {attachment_count}\n\n"
            f"Content preview:\n{body_preview}"
        )
        result = await agent.handle_input(
            project_id=project_id,
            user_input=email_input,
            channel=MessageChannel.EMAIL,
            email_from=email_from,
            email_subject=subject,
            auto_execute=True,
        )
        return {
            "status": "processed",
            "project_id": project_id,
            "email_id": email_id,
            "cot_chain_id": result.get("chain_id"),
            "tasks_created": result.get("tasks_created", 0),
        }
    except Exception as e:
        logger.error(f"Email webhook COT trigger failed: {e}", exc_info=True)
        return {
            "status": "stored_only",
            "project_id": project_id,
            "email_id": email_id,
            "error": str(e),
        }


# =============================================================================
# DOCUMENT UPLOAD
# =============================================================================

@router.post("/projects/{project_id}/documents")
async def upload_document(
    project_id: str,
    file: UploadFile = File(...),
    current_user: str = Depends(get_current_user),
):
    """Upload a document to a project."""
    memory = get_project_memory_service()

    project = await memory.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if project["owner_id"] != current_user:
        raise HTTPException(status_code=403, detail="Access denied")

    # Create document record. file_type stores the MIME content-type, but
    # the column is bounded (VARCHAR(255) after migration 005; older DBs
    # may still be VARCHAR(50) until the ALTER runs). Office MIME types run
    # 65-73 chars and used to overflow VARCHAR(50) → StringDataRightTruncation
    # → 500, so the upload silently failed and nothing reached Qdrant. Cap
    # defensively here so the insert can never crash regardless of the
    # column width actually deployed; prefer the short extension form when
    # the raw MIME is too long to keep the stored value meaningful.
    _ctype = file.content_type or ""
    if len(_ctype) > 50:
        _ext = (file.filename or "").rsplit(".", 1)[-1].lower() if file.filename and "." in file.filename else ""
        _ctype = (f"application/{_ext}" if _ext else _ctype)[:50]
    doc_record = await memory.create_document_record(
        project_id=project_id,
        filename=file.filename,
        original_filename=file.filename,
        file_type=_ctype,
        file_size=file.size,
        uploaded_by=current_user,
    )

    # Read raw file bytes
    raw_content = await file.read()
    doc_id_str = str(doc_record["id"])

    # Determine if the file is binary (PDF, docx, etc.) or plain text
    BINARY_TYPES = {
        'application/pdf', 'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-excel', 'application/octet-stream',
        'image/jpeg', 'image/png', 'image/bmp', 'image/tiff',
    }
    is_binary = (file.content_type or '').lower() in BINARY_TYPES or (
        file.filename and file.filename.lower().endswith(('.pdf', '.docx', '.doc', '.xlsx', '.xls'))
    )

    # For binary files, use doc-processor to convert to markdown
    # For text files, decode directly
    markdown_content = ""
    content_text = ""

    # Stash raw bytes of IMAGE uploads so a later chat turn can route them
    # to the vision model. doc-processor below converts binaries to
    # markdown and we only persist that markdown — fine for PDFs/Office
    # (real text layer) but raster diagrams (SLDs, photos, screenshots)
    # have no text, so the bytes would be lost and the VLM could never
    # see them. Keep them in Redis (base64, 24h TTL) keyed by document_id.
    _img_ct = (file.content_type or "").lower()
    _is_image = _img_ct.startswith("image/") or (
        file.filename and file.filename.lower().endswith(
            (".png", ".jpg", ".jpeg", ".bmp", ".tiff", ".gif", ".webp")
        )
    )
    if _is_image:
        try:
            import base64 as _b64
            ext = (file.filename or "img.png").rsplit(".", 1)[-1].lower()
            mime = _img_ct if _img_ct.startswith("image/") else {
                "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
                "bmp": "image/bmp", "tiff": "image/tiff", "gif": "image/gif",
                "webp": "image/webp",
            }.get(ext, "image/png")
            get_redis_service().set_uploaded_image(
                document_id=doc_id_str,
                b64=_b64.b64encode(raw_content).decode("ascii"),
                mime_type=mime,
                filename=file.filename or "image.png",
            )
            logger.info(
                "Stashed image bytes for VLM: doc_id=%s (%d bytes, %s)",
                doc_id_str, len(raw_content), mime,
            )
        except Exception as e:
            logger.warning(f"Failed to stash image bytes for {file.filename}: {e}")

    # PDFs: stash raw bytes too so the VLM verifier (services/vlm_verifier
    # → Qwen2.5-VL on .62) can render any page on demand to cross-check
    # extracted values against the source page. doc-processor returns
    # markdown only; without this stash the verifier path would have no
    # way to see drawings, single-line diagrams, or merged-cell tables.
    _is_pdf = (
        (_img_ct == "application/pdf") or
        (file.filename and file.filename.lower().endswith(".pdf"))
    )
    if _is_pdf:
        try:
            import base64 as _b64
            get_redis_service().set_uploaded_pdf(
                document_id=doc_id_str,
                b64=_b64.b64encode(raw_content).decode("ascii"),
                filename=file.filename or "document.pdf",
            )
            logger.info(
                "Stashed PDF bytes for VLM verifier: doc_id=%s (%d bytes)",
                doc_id_str, len(raw_content),
            )
        except Exception as e:
            logger.warning(f"Failed to stash PDF bytes for {file.filename}: {e}")

    if is_binary:
        try:
            doc_client = DocProcessorClient()
            proc_result = await doc_client.process_bytes(
                file_bytes=raw_content,
                filename=file.filename,
                user_id=current_user,
            )
            if proc_result.get("success") and proc_result.get("content"):
                markdown_content = proc_result["content"]
                content_text = markdown_content
                logger.info(f"Doc-processor converted {file.filename} to markdown ({len(markdown_content)} chars)")
            else:
                logger.warning(f"Doc-processor failed for {file.filename}: {proc_result.get('error')}")
                content_text = f"[Binary file: {file.filename} - {file.content_type}]"
        except Exception as e:
            logger.warning(f"Doc-processor unavailable for {file.filename}: {e}")
            content_text = f"[Binary file: {file.filename} - {file.content_type}]"
    else:
        content_text = raw_content.decode("utf-8", errors="replace").replace('\x00', '')
        markdown_content = content_text

    # Save document content to shell-service workspace for version control
    shell = get_shell_service()
    try:
        # Create documents directory first
        await shell.exec_command(project_id=project_id, command="mkdir -p documents", timeout=10)
        # Write text/markdown content using file_write API
        write_content = markdown_content or content_text
        await shell.file_write(
            project_id=project_id,
            path=f"documents/{file.filename}",
            content=write_content[:50000],  # Limit size for text transport
        )
        # Also save as .md if we have markdown from doc-processor
        if markdown_content and is_binary:
            md_filename = file.filename.rsplit('.', 1)[0] + '.md'
            await shell.file_write(
                project_id=project_id,
                path=f"documents/{md_filename}",
                content=markdown_content[:50000],
            )
        logger.info(f"Saved document to shell workspace: {file.filename}")
    except Exception as e:
        logger.warning(f"Failed to save document to shell workspace: {e}")

    # -----------------------------------------------------------------
    # Direct document processing (no COT/agent - reliable and fast)
    # -----------------------------------------------------------------
    processing_results = {
        "convert_markdown": "skipped",
        "save_workspace": "skipped",
        "semantic_index": "skipped",
        "git_commit": "skipped",
    }

    # Step 1: Markdown conversion already done above
    processing_results["convert_markdown"] = "completed" if markdown_content else "no_content"

    # Step 2: Workspace save already done above
    processing_results["save_workspace"] = "completed"

    # Step 3: Index content in Qdrant for semantic search
    indexable_content = markdown_content or content_text
    chunks_stored = 0
    if indexable_content and len(indexable_content) > 10:
        try:
            qdrant = memory.qdrant
            if qdrant:
                # Phase 0/1: heading-aware chunker. Replaces the previous
                # 500-char sliding window that
                #   (a) hardcoded section_title=filename, destroying any
                #       real heading metadata
                #   (b) cut through tables and answer spans at arbitrary
                #       byte offsets
                # New behaviour: split the markdown by H1..H6 headings
                # (and numbered "1.2.3 Title" sections) so each chunk
                # respects document structure. heading_path is the full
                # breadcrumb (e.g. "/1. Scope/1.2. Special features").
                # When a section is too large (> 1500 chars) we fall back
                # to paragraph-aware sub-splitting INSIDE that section so
                # heading metadata is preserved on every sub-chunk.
                import re as _re
                chunk_dicts = []
                chunk_idx = 0
                _HEAD_RE = _re.compile(
                    r"^(?:(#{1,6})\s+(.+)"
                    r"|(\d+(?:\.\d+)*)\.?\s+([A-Z][^\n]{1,200}))$",
                    _re.MULTILINE,
                )
                MAX_CHUNK = 1500
                lines = indexable_content.strip().splitlines()
                # Section list of (heading_level, title, body_lines)
                sections: list = []
                cur_level = 1
                cur_title = "Introduction"
                cur_body: list = []
                for line in lines:
                    m = _HEAD_RE.match(line.strip())
                    if m:
                        # flush previous
                        if cur_body or cur_title != "Introduction":
                            sections.append((cur_level, cur_title, cur_body))
                        if m.group(1):  # markdown heading
                            cur_level = len(m.group(1))
                            cur_title = m.group(2).strip()
                        else:           # numbered heading
                            num = m.group(3) or ""
                            cur_level = len(num.split(".")) + 1
                            cur_title = f"{num}. {(m.group(4) or '').strip()}"
                        cur_body = []
                    else:
                        cur_body.append(line)
                if cur_body or cur_title != "Introduction":
                    sections.append((cur_level, cur_title, cur_body))

                # Build breadcrumb heading_path per section using a stack.
                breadcrumb: list = []
                for (level, title, body) in sections:
                    while breadcrumb and breadcrumb[-1][0] >= level:
                        breadcrumb.pop()
                    breadcrumb.append((level, title))
                    heading_path = "/" + "/".join(t for _, t in breadcrumb)
                    body_text = "\n".join(body).strip()
                    if not body_text:
                        continue
                    # Sub-split oversized sections by paragraph; keep
                    # heading_path stable across sub-chunks.
                    if len(body_text) <= MAX_CHUNK:
                        parts = [body_text]
                    else:
                        parts = []
                        buf = ""
                        for para in body_text.split("\n\n"):
                            if len(buf) + len(para) + 2 > MAX_CHUNK and buf:
                                parts.append(buf)
                                buf = para
                            else:
                                buf = (buf + "\n\n" + para) if buf else para
                        if buf:
                            parts.append(buf)
                    for part in parts:
                        chunk_dicts.append({
                            "text": part.strip(),
                            "filename": file.filename,
                            "section_title": title,
                            "heading_path": heading_path,
                            "chunk_index": chunk_idx,
                            "metadata": {
                                "filename": file.filename,
                                "document_id": doc_id_str,
                                "heading_path": heading_path,
                                "heading_level": level,
                            },
                        })
                        chunk_idx += 1

                if chunk_dicts:
                    # Tenant key = chatbot project UUID, ALWAYS. Using
                    # tpms_oenum here was the multi-tenancy bug — multiple
                    # chatbot projects sharing OE 12065 wrote into the same
                    # tenant and contaminated each other's document set.
                    # The OE is still available as payload metadata for
                    # any TPMS-keyed queries.
                    success = qdrant.add_document_chunks(
                        user_id="system",
                        document_id=doc_id_str,
                        chunks=chunk_dicts,
                        project_oenum=project_id,
                    )
                    chunks_stored = len(chunk_dicts) if success else 0
                    processing_results["semantic_index"] = f"completed ({chunks_stored} chunks)"
                    logger.info(f"Indexed {chunks_stored} chunks for {file.filename}")
                else:
                    processing_results["semantic_index"] = "no_chunks"
            else:
                processing_results["semantic_index"] = "qdrant_unavailable"
        except Exception as e:
            logger.warning(f"Semantic indexing failed for {file.filename}: {e}")
            processing_results["semantic_index"] = f"error: {str(e)[:100]}"

    # Step 4: Git commit (init if needed)
    try:
        try:
            commit_result = await shell.git_commit(
                project_id, f"Add document: {file.filename}"
            )
        except Exception as init_err:
            if "not initialized" in str(init_err).lower():
                await shell.git_init(project_id)
                commit_result = await shell.git_commit(
                    project_id, f"Add document: {file.filename}"
                )
            else:
                raise
        if commit_result.get("status") == "committed":
            processing_results["git_commit"] = "completed"
        else:
            processing_results["git_commit"] = commit_result.get("status", "unknown")
    except Exception as e:
        logger.warning(f"Git commit failed for {file.filename}: {e}")
        processing_results["git_commit"] = f"error: {str(e)[:100]}"

    # Store a document message in project history (no agent/COT trigger)
    content_summary = indexable_content[:500] if indexable_content else file.filename
    await memory.store_message(
        project_id=project_id,
        role="user",
        content=f"Document uploaded: {file.filename}",
        channel="document",
        document_id=doc_id_str,
        document_filename=file.filename,
    )
    await memory.store_message(
        project_id=project_id,
        role="assistant",
        content=(
            f"Document **{file.filename}** has been processed:\n\n"
            f"- Converted to markdown ({len(markdown_content)} chars)\n"
            f"- Saved to workspace\n"
            f"- Indexed {chunks_stored} chunks for semantic search\n"
            f"- Git: {processing_results['git_commit']}\n\n"
            f"You can now ask questions about this document."
        ),
        channel="document",
        document_id=doc_id_str,
        document_filename=file.filename,
    )

    # Update document record. Mark 'completed' only when chunks actually
    # landed in the vector store; otherwise 'index_failed' so the failure
    # is visible instead of a silent 200 with an unsearchable document.
    final_status = "completed" if chunks_stored > 0 else "index_failed"
    try:
        await memory.update_document(
            doc_id_str,
            processing_status=final_status,
            chunk_count=chunks_stored,
            content_summary=content_summary,
        )
    except Exception:
        pass

    # Flip the project-level has_documents flag so the router keeps the
    # project upload-aware on later (text-only) turns — uploaded files stay
    # retrievable across the whole conversation, not just the attach turn.
    if chunks_stored > 0:
        try:
            await memory.update_project(project_id, has_documents=True)
        except Exception as e:
            logger.warning("could not set has_documents for %s: %s", project_id, e)
        # Background slot-collector: a new document changed the spec sources.
        try:
            from services.soft_collector import schedule_refresh
            schedule_refresh(project_id)
        except Exception as e:
            logger.debug("soft_collector schedule_refresh failed: %s", e)

    return {
        "document_id": doc_id_str,
        "filename": file.filename,
        "status": final_status,
        "markdown_length": len(markdown_content),
        "chunks_indexed": chunks_stored,
        "processing": processing_results,
    }


# =============================================================================
# SLD (SINGLE LINE DIAGRAM) ANALYSIS
# =============================================================================

@router.post("/projects/{project_id}/sld/analyze")
async def analyze_sld(
    project_id: str,
    file: UploadFile = File(...),
    context: str = Form(""),
    current_user: str = Depends(get_current_user),
):
    """
    Analyze a Single Line Diagram (SLD) image or PDF using GPT-4o vision.

    Returns structured JSON with equipment identification:
    - Circuit breakers, feeders, transformers, busbars
    - Ratings, specifications, protection schemes
    - Engineering analysis and observations
    """
    memory = get_project_memory_service()
    agent = get_project_agent()

    project = await memory.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if project["owner_id"] != current_user:
        raise HTTPException(status_code=403, detail="Access denied")

    # Read file bytes
    image_bytes = await file.read()
    mime_type = file.content_type or "image/png"

    try:
        result = await agent.analyze_sld(
            project_id=project_id,
            image_bytes=image_bytes,
            mime_type=mime_type,
            filename=file.filename,
            additional_context=context,
        )

        # Store as a message in project history
        if result.get("success"):
            await memory.store_message(
                project_id=project_id,
                role="assistant",
                content=(
                    f"SLD Analysis for **{file.filename}** completed.\n\n"
                    f"Found: {len(result.get('circuit_breakers', []))} CBs, "
                    f"{len(result.get('feeders', []))} feeders, "
                    f"{len(result.get('transformers', []))} transformers.\n\n"
                    f"Confidence: {result.get('confidence', 'N/A')}"
                ),
                channel="document",
            )

        return result

    except Exception as e:
        logger.error(f"SLD analysis failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"SLD analysis failed: {str(e)}")


# =============================================================================
# LLM MODE MANAGEMENT
# =============================================================================

@router.get("/projects/{project_id}/llm/mode")
async def get_llm_mode(
    project_id: str,
    current_user: str = Depends(get_current_user),
):
    """Get the LLM mode for a project. Both modern and legacy users
    can choose. Default is local — set via per-request llm_mode on
    the message/stream endpoint, or via this PATCH for project-level
    default."""
    memory = get_project_memory_service()
    project = await memory.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return {
        "mode": project.get("agent_model", "local"),
        "locked": False,
        "options": ["gpt-4o", "local"],
    }


@router.patch("/projects/{project_id}/llm/mode")
async def set_llm_mode(
    project_id: str,
    mode: str = Form(...),
    current_user: str = Depends(get_current_user),
):
    """Set the LLM mode for a project. Unlocked for all users — the
    modern-only restriction predated the local Simorgh AI path being
    a first-class option."""
    memory = get_project_memory_service()
    project = await memory.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if project["owner_id"] != current_user:
        raise HTTPException(status_code=403, detail="Access denied")
    if mode not in ("gpt-4o", "local"):
        raise HTTPException(status_code=400, detail="Mode must be 'gpt-4o' or 'local'")
    await memory.update_project(project_id, agent_model=mode)
    return {"status": "updated", "mode": mode}


# =============================================================================
# SIMORGH DESIGN SUITE — create a project in simorgh-soft from chatbot sources
# Feature-flagged: only active when SOFT_BRIDGE_ENABLED=1. Endpoints:
#   POST /projects/{project_id}/soft/gather    → propose fields w/ provenance
#   POST /projects/{project_id}/soft/create    → submit confirmed spec
# =============================================================================
@router.post("/projects/{project_id}/soft/gather")
async def soft_gather_spec(project_id: str,
                           current_user: str = Depends(get_current_user)):
    """Run extractors in parallel across the project's enabled sources,
    reconcile, and return the proposed ProjectSpec + provenance + gaps.
    The chatbot UI renders this as a confirmation form."""
    if not _soft_bridge_enabled():
        raise HTTPException(status_code=404, detail="design-suite bridge disabled")
    memory = get_project_memory_service()
    project = await memory.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if project["owner_id"] != current_user:
        raise HTTPException(status_code=403, detail="Access denied")

    se = project.get("sources_enabled") or {}
    tpms_oenum = (se.get("techserver_oenum") or project.get("tpms_oenum")
                  or None) if se.get("tpms") else (project.get("tpms_oenum"))
    repo_path = project.get("gitlab_repo_path") if se.get("gitlab") else None
    ts_oenum = se.get("techserver_oenum") if se.get("techserver") else None

    try:
        recent = await memory.get_recent_context(project_id, limit=12)
    except Exception:
        recent = []

    from services.soft_extractor import gather_all
    from services.soft_reconciler import reconcile
    # Pass the live MCP manager so the techserver extractor can call
    # techserver_get_tree / techserver_read_artifact through the same
    # transport the rest of the agent uses (no duplicate auth/wiring).
    agent = get_project_agent()
    mcp = getattr(agent, "mcp_manager", None)
    bag = await gather_all(
        project_id=project_id, tpms_oenum=tpms_oenum,
        repo_path=repo_path, techserver_oenum=ts_oenum,
        recent_messages=recent, mcp_manager=mcp,
    )
    spec, prov, gaps, conflicts = reconcile(bag)
    return {
        "spec":      spec.model_dump(),
        "prov":      [p.model_dump() for p in prov],
        "gaps":      gaps,
        "conflicts": conflicts,
    }


class SoftCreateRequest(BaseModel):
    spec: Dict[str, Any]


# =============================================================================
# Category groups — frontend renders the proposals drawer as a sequence
# of collapsible sections, one per IEC / SIMARIS taxonomy category. The
# server is the single source of truth so the UI can't drift away from
# the schema. No auth required (the list is metadata, not project data).
# =============================================================================
@router.get("/soft/categories")
async def soft_categories():
    """Returns the canonical CATEGORY_GROUPS list and a `field_to_category`
    inverse map so the frontend can render proposals by category without
    duplicating the field-mapping logic."""
    from services.soft_spec import CATEGORY_GROUPS, category_for_field
    inverse = {}
    for g in CATEGORY_GROUPS:
        for f in g["fields"]:
            inverse[f] = g["id"]
    return {
        "groups": CATEGORY_GROUPS,
        "field_to_category": inverse,
        # Helper for the frontend: when a proposal arrives with a
        # field not listed in any group, it lands in the 'other'
        # bucket which is rendered last and collapsed by default.
        "fallback": "other",
    }


# =============================================================================
# HITL proposals — list + approve/edit/reject (the user is the WRITE gate).
# =============================================================================
@router.get("/projects/{project_id}/soft/proposals")
async def soft_proposals(project_id: str,
                         current_user: str = Depends(get_current_user)):
    if not _soft_bridge_enabled():
        raise HTTPException(status_code=404, detail="design-suite bridge disabled")
    memory = get_project_memory_service()
    project = await memory.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if project["owner_id"] != current_user:
        raise HTTPException(status_code=403, detail="Access denied")
    from services import soft_proposals as sp
    pending = await sp.list_pending(project_id)
    approved = await sp.list_approved(project_id)
    # Group pending by field so the UI shows one card per field with all
    # competing source proposals stacked under it.
    by_field: Dict[str, List[Dict[str, Any]]] = {}
    for p in pending:
        by_field.setdefault(p["field"], []).append(p)
    return {"pending_by_field": by_field, "approved": approved}


class ApprovalRequest(BaseModel):
    approvals: List[Dict[str, Any]]   # [{proposal_id, action, value?}]


@router.post("/projects/{project_id}/soft/approve")
async def soft_approve(project_id: str, req: ApprovalRequest,
                       current_user: str = Depends(get_current_user)):
    """User-driven write gate. Each entry:
       {"proposal_id": "...", "action": "approve"|"reject"|"edit",
        "value": <new value if edit>}
    Approved values flow through to soft_spec_state via the same reconcile
    pipeline the rest of the system uses. Rejected proposals are kept for
    audit but never written."""
    if not _soft_bridge_enabled():
        raise HTTPException(status_code=404, detail="design-suite bridge disabled")
    memory = get_project_memory_service()
    project = await memory.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if project["owner_id"] != current_user:
        raise HTTPException(status_code=403, detail="Access denied")
    from services import soft_proposals as sp
    from services import soft_spec_state as sss
    written = 0
    for a in (req.approvals or []):
        pid = a.get("proposal_id")
        action = (a.get("action") or "").lower()
        if not pid:
            continue
        if action == "approve":
            r = await sp.approve(pid)
            if r:
                written += 1
        elif action == "edit":
            r = await sp.approve(pid, approved_value=a.get("value"))
            if r:
                written += 1
        elif action == "reject":
            await sp.reject(pid)
    # Re-derive the spec from APPROVED proposals only and persist.
    await _rederive_spec_from_approved(project_id)
    state = await sss.get_state(project_id)
    return {"written": written, "state": state}


async def _rederive_spec_from_approved(project_id: str) -> None:
    """Recompute soft_spec_state.spec by reconciling ONLY the approved
    proposals. This is the single place where soft_spec_state.spec is
    populated — the extractors no longer touch it directly."""
    from services import soft_proposals as sp
    from services import soft_spec_state as sss
    from services.soft_spec import (FieldValue, CONFIRMABLE_FIELDS,
                                    REQUIRED_FIELDS)
    from services.soft_reconciler import reconcile
    approved = await sp.list_approved(project_id)
    bag: Dict[str, List[FieldValue]] = {}
    for a in approved:
        try:
            bag.setdefault(a["field"], []).append(FieldValue(
                value=a["value"],
                source=(a["source_kind"] if a["source_kind"] in
                        ("user", "tpms", "uploads", "chat", "gitlab",
                         "techserver", "default") else "default"),
                confidence=float(a.get("confidence") or 0.5),
                note=a.get("source_note"),
            ))
        except Exception:
            continue
    spec, prov, gaps, conflicts = reconcile(bag)
    spec_dump = spec.model_dump()
    # Completeness over CONFIRMABLE_FIELDS minus `comment` (optional).
    optional = {"comment"}
    counted = [f for f in CONFIRMABLE_FIELDS if f not in optional]
    filled = sum(1 for f in counted
                 if str(spec_dump.get(f) or "").strip() and f not in gaps)
    completeness = int(round(filled * 100 / max(1, len(counted))))
    existing = await sss.get_state(project_id) or {}
    await sss.upsert_state(
        project_id, spec=spec_dump,
        prov=[p.model_dump() for p in prov],
        gaps=gaps, conflicts=conflicts, completeness=completeness,
        sources_signature=existing.get("sources_signature") or "",
    )


# =============================================================================
# Legacy one-shot create endpoint (kept for back-compat with the old button)
# =============================================================================
@router.post("/projects/{project_id}/soft/create")
async def soft_create_project(project_id: str, req: SoftCreateRequest,
                              current_user: str = Depends(get_current_user)):
    """Validate the user-confirmed spec and POST it to simorgh-soft. On
    success returns the soft project _id and a deep-link URL the chat UI
    redirects to."""
    if not _soft_bridge_enabled():
        raise HTTPException(status_code=404, detail="design-suite bridge disabled")
    memory = get_project_memory_service()
    project = await memory.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if project["owner_id"] != current_user:
        raise HTTPException(status_code=403, detail="Access denied")

    from services.soft_spec import ProjectSpec, REQUIRED_FIELDS
    try:
        spec = ProjectSpec(**req.spec)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"invalid spec: {e}")
    missing = [f for f in REQUIRED_FIELDS if not str(getattr(spec, f, "") or "").strip()]
    if missing:
        raise HTTPException(status_code=400,
                            detail=f"missing required fields: {missing}")

    from services.simorgh_soft_client import create_project, deep_link
    spec_payload = spec.model_dump()

    # Phase E: docker-image-tag-style projectName so each Design Suite
    # project carries the chatbot project + user + creation timestamp
    # in its name (e.g. `mobarakeh-hsm2:shahram-20260603-1715`). The
    # LLM-extracted human-readable name is preserved in
    # projectDescription. Tagging is env-gated (SOFT_PROJECT_TAGGING=0
    # falls back to the verbatim extracted name).
    try:
        from services.project_tagger import apply_tag_to_spec
        spec_payload = apply_tag_to_spec(
            spec_payload,
            chatbot_project=project.get("name"),
            user=current_user,
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("project_tagger: tagging failed (%s) — sending verbatim name", e)

    try:
        created = await create_project(spec_payload)
    except Exception as e:
        logger.error("simorgh-soft create failed: %s", e)
        raise HTTPException(status_code=502,
                            detail=f"simorgh-soft create failed: {e}")
    soft_id = str(created.get("_id") or "")
    if not soft_id:
        raise HTTPException(status_code=502,
                            detail="simorgh-soft returned no _id")

    # Persist the mapping so a later chat turn can deep-link without re-asking.
    try:
        await memory.update_project(project_id, simorgh_soft_project_id=soft_id)
    except Exception as e:
        logger.warning("could not persist simorgh_soft_project_id: %s", e)

    return {
        "soft_project_id": soft_id,
        "deep_link":       deep_link(soft_id),
        "created":         {k: created.get(k) for k in ("projectName", "createdOn")},
    }


# =============================================================================
# Background slot-collector — state + ask_user answer endpoints
# (the ReAct loop uses the in-process pseudo-tools; these REST endpoints
# are for the chat UI: the sidebar chip polls /state, the inline form
# POSTs answers to /answer/{pending_id}.)
# =============================================================================
@router.get("/projects/{project_id}/soft/state")
async def soft_state(project_id: str,
                     refresh: bool = False,
                     current_user: str = Depends(get_current_user)):
    if not _soft_bridge_enabled():
        raise HTTPException(status_code=404, detail="design-suite bridge disabled")
    memory = get_project_memory_service()
    project = await memory.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if project["owner_id"] != current_user:
        raise HTTPException(status_code=403, detail="Access denied")
    from services import soft_spec_state as sss
    from services.soft_collector import refresh as collector_refresh
    state = await sss.get_state(project_id)
    if state is None or refresh:
        state = await collector_refresh(project_id, force=bool(refresh))
        if state is None:
            state = await sss.get_state(project_id) or {}
    # Surface still-open pending asks so a reload of the chat shows the
    # form again instead of losing it.
    pending = await sss.list_open_pending(project_id)
    return {"state": state, "pending": pending}


class SoftAnswerRequest(BaseModel):
    answers: Dict[str, Any]


@router.post("/projects/{project_id}/soft/answer/{pending_id}")
async def soft_answer(project_id: str, pending_id: str,
                      req: SoftAnswerRequest,
                      current_user: str = Depends(get_current_user)):
    """User submits answers to an ask_user form. We record them, merge them
    into the spec as user-source FieldValues (top of SOURCE_RANK), update
    the persisted state, and return the new state. The frontend can then
    auto-fire a chat message ("answers provided") so the ReAct loop on the
    next turn sees gaps=[] and proceeds to submit_soft_spec."""
    if not _soft_bridge_enabled():
        raise HTTPException(status_code=404, detail="design-suite bridge disabled")
    memory = get_project_memory_service()
    project = await memory.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if project["owner_id"] != current_user:
        raise HTTPException(status_code=403, detail="Access denied")

    from services import soft_spec_state as sss
    pending = await sss.get_pending_ask(pending_id)
    if not pending or str(pending.get("project_id")) != str(project_id):
        raise HTTPException(status_code=404, detail="pending ask not found")
    if pending.get("answered_at"):
        return {"status": "already_answered"}
    saved = await sss.answer_pending_ask(pending_id, req.answers or {})
    if not saved:
        raise HTTPException(status_code=500, detail="could not record answers")

    # Merge answers into the spec. The user's FieldValues are top-rank, so
    # they win any conflict with the auto-extracted values.
    try:
        from services.soft_spec import (FieldValue, ProjectSpec,
                                        REQUIRED_FIELDS, CONFIRMABLE_FIELDS)
        from services.soft_reconciler import reconcile
        current = await sss.get_state(project_id) or {}
        current_spec = current.get("spec") or {}
        # Re-seed bag from the current spec (each field becomes a "default"
        # source-priority entry), then overlay the user's answers as "user"
        # (which beats every other source thanks to SOURCE_RANK).
        bag: Dict[str, list] = {}
        for k, v in (current_spec or {}).items():
            if v in (None, "", [], {}):
                continue
            bag.setdefault(k, []).append(FieldValue(
                value=v, source="default", confidence=0.5,
                note="from prior state"))
        for k, v in (req.answers or {}).items():
            if v in (None, "",):
                continue
            bag.setdefault(k, []).append(FieldValue(
                value=v, source="user", confidence=0.99,
                note="user-provided via ask_user form"))
        spec, prov, gaps, conflicts = reconcile(bag)
        # CRITICAL: persist each form answer as an APPROVED user proposal
        # too. submit_soft_spec's auto-approve sweep calls
        # _rederive_spec_from_approved, which rebuilds the spec from
        # APPROVED PROPOSALS ONLY — so form answers that live only in
        # spec_state get WIPED on the next create attempt, and the agent
        # re-asks for projectName / projectDescription it already has.
        # Writing them as approved proposals makes them survive the
        # re-derive (one source of truth: the proposals table).
        try:
            from services import soft_proposals as _sp
            for k, v in (req.answers or {}).items():
                if v in (None, ""):
                    continue
                await _sp.add_user_value(
                    project_id, field=k, value=v,
                    note="user-provided via ask_user form")
        except Exception as e:
            logger.warning("soft_answer: persist answers as approved "
                           "proposals failed: %s", e)
        # Completeness inline so we don't re-run extractors here.
        n = max(1, len(CONFIRMABLE_FIELDS))
        filled = sum(1 for f in CONFIRMABLE_FIELDS
                     if str(getattr(spec, f, "") or "").strip() and f not in gaps)
        completeness = int(round(filled * 100 / n))
        await sss.upsert_state(
            project_id, spec=spec.model_dump(),
            prov=[p.model_dump() for p in prov], gaps=gaps,
            conflicts=conflicts, completeness=completeness,
            sources_signature=(current.get("sources_signature") or "") + ":user",
        )
    except Exception as e:
        logger.error("soft_answer merge failed: %s", e)
    state = await sss.get_state(project_id)
    return {"status": "ok", "state": state}


def _soft_bridge_enabled() -> bool:
    import os
    return os.getenv("SOFT_BRIDGE_ENABLED", "").lower() in ("1", "true", "yes", "on")


# =============================================================================
# ROUTE REGISTRATION
# =============================================================================

def include_project_agent_routes(app):
    """Include project agent routes in FastAPI app."""
    app.include_router(router)
    logger.info("Included project agent routes (/api/v2/agent/*)")
