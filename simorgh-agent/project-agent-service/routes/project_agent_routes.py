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

    # Create document record
    doc_record = await memory.create_document_record(
        project_id=project_id,
        filename=file.filename,
        original_filename=file.filename,
        file_type=file.content_type,
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
                # Chunk content into segments (~500 chars each with overlap)
                chunk_dicts = []
                chunk_size = 500
                overlap = 50
                text = indexable_content.strip()
                i = 0
                chunk_idx = 0
                while i < len(text):
                    end = min(i + chunk_size, len(text))
                    chunk_text = text[i:end]
                    if chunk_text.strip():
                        chunk_dicts.append({
                            "text": chunk_text.strip(),
                            "section_title": file.filename,
                            "chunk_index": chunk_idx,
                            "metadata": {"filename": file.filename, "document_id": doc_id_str},
                        })
                        chunk_idx += 1
                    i += chunk_size - overlap

                if chunk_dicts:
                    # Use OENUM for collection name to match search queries
                    oenum = project.get("tpms_oenum") or project_id
                    success = qdrant.add_document_chunks(
                        user_id="system",
                        document_id=doc_id_str,
                        chunks=chunk_dicts,
                        project_oenum=oenum,
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

    # Update document record
    try:
        await memory.update_document(
            doc_id_str,
            processing_status="completed",
            chunk_count=chunks_stored,
            content_summary=content_summary,
        )
    except Exception:
        pass

    return {
        "document_id": doc_id_str,
        "filename": file.filename,
        "status": "completed",
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
    """Get the LLM mode for a project. Modern users always get 'online'."""
    memory = get_project_memory_service()
    project = await memory.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    is_legacy = _is_legacy_user(current_user)
    if not is_legacy:
        return {"mode": "online", "locked": True, "reason": "Modern users use online AI only"}

    return {
        "mode": project.get("agent_model", "gpt-4o"),
        "locked": False,
        "options": ["gpt-4o", "local"],
    }


@router.patch("/projects/{project_id}/llm/mode")
async def set_llm_mode(
    project_id: str,
    mode: str = Form(...),
    current_user: str = Depends(get_current_user),
):
    """Set the LLM mode for a project. Only legacy users can switch."""
    is_legacy = _is_legacy_user(current_user)
    if not is_legacy:
        raise HTTPException(
            status_code=403,
            detail="Modern users cannot change LLM mode. Online AI is always used."
        )

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
# ROUTE REGISTRATION
# =============================================================================

def include_project_agent_routes(app):
    """Include project agent routes in FastAPI app."""
    app.include_router(router)
    logger.info("Included project agent routes (/api/v2/agent/*)")
