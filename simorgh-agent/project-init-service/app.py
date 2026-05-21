"""
Project Init Workflow Service (v0.3 — per-project container era)
================================================================
NEW FLOW:

1. Create / start the project's session container (runtime-broker).
2. If user picked a GitLab repo:
     - Clone repo into /work/gitlab at the selected base branch
     - Create a new local branch `simorgh/<short-hex>`
     - Push the new branch to origin so the chatbot's later edits can be PR'd
3. If `sources_enabled.tpms`: pull TPMS data into /work/tpms (via tpms-fetcher).
4. If `sources_enabled.techserver` + techserver_oenum: smbclient pull
   `//192.168.1.3/techser/<oenum>` into /work/techserver.
5. If `sources_enabled.ekc`: clone the read-only ekc-technical-knowledge repo
   into /work/ekc-knowledge (no remote configured — it is read-only).
6. Ensure /work/uploads exists for the upload-fallback path.
7. Kick off project-explorer (two-phase: remote-fast then container-deep).
   Phase-1 results are written to Redis under `project:{id}:exploration`
   so the CoT engine can start answering questions immediately.

What is NO LONGER mandatory:
  • TPMS auth at project creation. It is now ONLY required when the user
    has ticked `tpms` or `techserver`. The wizard handles that prompt
    before posting to /init.
"""
import os
import secrets
import shlex
import uuid
from datetime import datetime, timezone
from typing import Any

import httpx
from fastapi import BackgroundTasks, FastAPI, HTTPException
from mcp.server.fastmcp import FastMCP
from pydantic import BaseModel, Field

from simorgh_logging import configure, get_logger, request_id_middleware

configure(service="project-init")
log = get_logger(__name__)

GITLAB_MCP_URL        = os.getenv("GITLAB_MCP_URL",        "http://gitlab-mcp:8047")
RUNTIME_BROKER_URL    = os.getenv("RUNTIME_BROKER_URL",    "http://runtime-broker:8048")
TPMS_CONTEXT_URL      = os.getenv("TPMS_CONTEXT_URL",      "http://tpms-context-agent:8050")
TPMS_FETCHER_URL      = os.getenv("TPMS_FETCHER_URL",      "http://tpms-fetcher:8021")
CONTEXT_SEARCH_URL    = os.getenv("CONTEXT_SEARCH_URL",    "http://context-search:8049")
PROJECT_EXPLORER_URL  = os.getenv("PROJECT_EXPLORER_URL",  "http://project-explorer:8052")
PROJECTS_GROUP        = os.getenv("GITLAB_PROJECTS_GROUP", "simorgh-projects")
EKC_KB_REPO           = os.getenv("GITLAB_TECH_KB_REPO",   "simorgh-knowledge/technical-knowledge")
EKC_KB_CLONE_URL      = os.getenv("EKC_KB_CLONE_URL", "")  # set in compose
TECHSERVER_HOST       = os.getenv("TECHSERVER_HOST",       "192.168.1.3")
TECHSERVER_SHARE      = os.getenv("TECHSERVER_SHARE",      "techser")
TECHSERVER_USER       = os.getenv("TECHSERVER_USER",       "")
TECHSERVER_PASS       = os.getenv("TECHSERVER_PASS",       "")
AGENT_TOKEN           = os.getenv("AGENT_TOKEN",           "")
BROKER_TOKEN          = os.getenv("BROKER_TOKEN",          "")

app = FastAPI(title="project-init", version="0.3.0")
app.middleware("http")(request_id_middleware)

_init_status: dict[str, dict[str, Any]] = {}


class SourcesEnabled(BaseModel):
    gitlab: bool = False
    tpms: bool = False
    techserver: bool = False
    techserver_oenum: str | None = None
    ekc: bool = False
    upload: bool = True   # default-on; this is the catch-all working dir


class TpmsAuth(BaseModel):
    user: str
    password: str = Field(..., alias="pass")

    class Config:
        populate_by_name = True


class InitRequest(BaseModel):
    project_id: str = Field(..., description="Internal project UUID")
    project_name: str = Field(..., min_length=1)
    owner_id: str = Field(...)
    # New flow inputs
    gitlab_repo_path: str | None = None       # 'group/repo' chosen by the user
    gitlab_repo_url: str | None = None        # full clone URL (https or git@)
    gitlab_base_branch: str | None = None     # branch the user wants to fork from
    sources: SourcesEnabled = Field(default_factory=SourcesEnabled)
    # Optional TPMS credentials. Required by the user only when tpms or
    # techserver sources are ticked. Falls back to TECHSERVER_USER/PASS
    # env vars on this service if not supplied.
    tpms_auth: TpmsAuth | None = None
    # Legacy field — kept for backward compat. New flow uses sources.techserver_oenum.
    oenum: str | None = None


class InitResponse(BaseModel):
    init_id: str
    project_id: str
    status: str
    message: str
    simorgh_branch: str | None = None


def _agent_headers() -> dict[str, str]:
    return {"x-agent-auth": AGENT_TOKEN} if AGENT_TOKEN else {}


def _broker_headers() -> dict[str, str]:
    return {"authorization": f"Bearer {BROKER_TOKEN}"} if BROKER_TOKEN else {}


def _simorgh_branch_name() -> str:
    """Generate a short-hex simorgh working branch: simorgh/a3f9c2."""
    return f"simorgh/{secrets.token_hex(3)}"


# ---------------------------------------------------------------------------
# Step implementations
# ---------------------------------------------------------------------------
async def _start_container(client: httpx.AsyncClient, project_id: str) -> dict:
    r = await client.post(f"{RUNTIME_BROKER_URL}/sessions/{project_id}/start",
                          json={"project_id": project_id},
                          headers=_broker_headers())
    r.raise_for_status()
    return r.json()


async def _exec(client: httpx.AsyncClient, project_id: str, command: str,
                timeout_sec: int = 300, workdir: str | None = None) -> dict:
    payload: dict[str, Any] = {"command": command, "timeout_sec": timeout_sec}
    if workdir:
        payload["workdir"] = workdir
    r = await client.post(f"{RUNTIME_BROKER_URL}/sessions/{project_id}/exec",
                          json=payload, headers=_broker_headers())
    if r.status_code >= 400:
        # Surface the response body so 422 (Pydantic validation) and
        # 502 (docker exec failures) don't appear as opaque status codes
        # in the higher-level init log.
        body = r.text[:500]
        log.error("session_exec_failed", project_id=project_id,
                  status=r.status_code, body=body,
                  command_head=command.splitlines()[0][:120] if command else "")
        raise httpx.HTTPStatusError(
            f"runtime-broker exec returned {r.status_code}: {body}",
            request=r.request, response=r,
        )
    return r.json()


async def _clone_user_repo(client: httpx.AsyncClient, project_id: str,
                           repo_url: str, base_branch: str | None,
                           simorgh_branch: str) -> dict:
    """Clone the user's repo into /work/gitlab, create simorgh/<hex> off the
    chosen base branch, and push it so origin tracks it."""
    base_part = f" --branch {base_branch}" if base_branch else ""
    script = (
        f"set -e\n"
        f"rm -rf /work/gitlab\n"
        f"git clone{base_part} {repo_url} /work/gitlab\n"
        f"cd /work/gitlab\n"
        f"git checkout -b {simorgh_branch}\n"
        f"# Best-effort push; if write isn't granted yet we keep going.\n"
        f"git push -u origin {simorgh_branch} || echo 'push deferred — deploy key not granted yet'\n"
    )
    return await _exec(client, project_id, script, timeout_sec=600)


async def _pull_tpms(client: httpx.AsyncClient, project_id: str, oenum: str,
                     tpms_auth: TpmsAuth | None = None) -> dict:
    """Fetch TPMS rendered context and write it into the container as a file
    under /work/tpms/. The hot path is still tpms-context-agent → Redis; this
    just stages a local copy the CoT can reference as a doc.

    If `tpms_auth` is supplied, the credentials are forwarded to the
    tpms-context-agent so the request runs as that user; otherwise the
    agent falls back to its service-level credentials.
    """
    payload: dict[str, Any] = {"oenum": oenum, "refresh": True}
    if tpms_auth is not None:
        payload["auth"] = {"user": tpms_auth.user, "password": tpms_auth.password}
    r = await client.post(f"{TPMS_CONTEXT_URL}/context", json=payload)
    r.raise_for_status()
    rendered = r.json().get("rendered", "")
    write = await client.post(f"{RUNTIME_BROKER_URL}/sessions/{project_id}/write_file",
                              json={"path": f"tpms/{oenum}.md", "content": rendered},
                              headers=_broker_headers())
    write.raise_for_status()
    # Make sure the directory exists first via exec (write_file uses put_archive on /work).
    await _exec(client, project_id, "mkdir -p /work/tpms")
    return {"oenum": oenum, "bytes": len(rendered)}


async def _pull_techserver(client: httpx.AsyncClient, project_id: str, oenum: str,
                           tpms_auth: TpmsAuth | None = None) -> dict:
    """SMB-copy //TECHSERVER_HOST/TECHSERVER_SHARE/<oenum> into /work/techserver/<oenum>.

    Per-user credentials from the wizard take precedence over the
    service-level TECHSERVER_USER / TECHSERVER_PASS env vars.
    """
    user = tpms_auth.user     if tpms_auth else TECHSERVER_USER
    pwd  = tpms_auth.password if tpms_auth else TECHSERVER_PASS
    if not (user and pwd):
        raise RuntimeError(
            "Techserver credentials not provided (wizard tpms_auth missing and "
            "TECHSERVER_USER / TECHSERVER_PASS not configured)."
        )
    # Run the smbclient password through an env var so it doesn't end up in
    # the container's process list. shlex.quote on the oenum keeps the
    # remote `cd` safe.
    safe_oenum = shlex.quote(oenum)
    script = (
        f"set -e\n"
        f"mkdir -p /work/techserver/{oenum}\n"
        f"cd /work/techserver/{oenum}\n"
        f"export USER={shlex.quote(user)}\n"
        f"export PASSWD={shlex.quote(pwd)}\n"
        f"smbclient //{TECHSERVER_HOST}/{TECHSERVER_SHARE} \"$PASSWD\" "
        f"  -U \"$USER\" "
        f"  -c 'prompt OFF; recurse ON; lcd /work/techserver/{oenum}; "
        f"      cd {safe_oenum}; mget *'\n"
    )
    return await _exec(client, project_id, script, timeout_sec=1200)


async def _clone_ekc(client: httpx.AsyncClient, project_id: str) -> dict:
    """Clone ekc-technical-knowledge into /work/ekc-knowledge as a read-only
    snapshot. No remote configured for write — it is consult-only."""
    url = EKC_KB_CLONE_URL or f"{os.getenv('GITLAB_URL','').rstrip('/')}/{EKC_KB_REPO}.git"
    script = (
        f"set -e\n"
        f"rm -rf /work/ekc-knowledge\n"
        f"git clone --depth 1 {url} /work/ekc-knowledge\n"
        f"cd /work/ekc-knowledge\n"
        f"# Remove origin so nothing can be pushed back accidentally.\n"
        f"git remote remove origin || true\n"
    )
    return await _exec(client, project_id, script, timeout_sec=600)


async def _ensure_uploads_dir(client: httpx.AsyncClient, project_id: str) -> dict:
    return await _exec(client, project_id, "mkdir -p /work/uploads && ls -la /work")


async def _kick_explorer(client: httpx.AsyncClient, req: InitRequest) -> dict:
    """Fire-and-poll the project-explorer. Phase-1 (remote) is fast and
    posts back to Redis; phase-2 (container) runs in background."""
    try:
        r = await client.post(f"{PROJECT_EXPLORER_URL}/explore",
                              json={
                                  "project_id": req.project_id,
                                  "gitlab_repo_path": req.gitlab_repo_path,
                                  "gitlab_base_branch": req.gitlab_base_branch,
                                  "simorgh_branch": None,    # filled in by phase-2
                                  "use_container": True,
                              })
        r.raise_for_status()
        return r.json()
    except httpx.HTTPError as e:
        # Explorer is optional — don't fail init if it isn't up.
        log.warning("explorer_unavailable", error=str(e))
        return {"skipped": True, "reason": str(e)}


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------
async def _run_init(init_id: str, req: InitRequest) -> None:
    s = _init_status[init_id]
    s["status"] = "running"
    steps: list[dict[str, Any]] = []
    simorgh_branch = _simorgh_branch_name() if req.sources.gitlab else None
    s["simorgh_branch"] = simorgh_branch

    def _record(step: str, status: str, **extra: Any) -> None:
        steps.append({"step": step, "status": status, **extra})
        s["steps"] = steps

    try:
        async with httpx.AsyncClient(timeout=1800) as client:
            # 1. Start the session container.
            s["current_step"] = "start_container"
            try:
                cont = await _start_container(client, req.project_id)
                _record("start_container", "ok", container=cont.get("container_name"))
            except httpx.HTTPError as e:
                _record("start_container", "error", error=str(e))
                raise

            # 2. Optional: user gitlab repo clone + simorgh branch.
            if req.sources.gitlab and req.gitlab_repo_url:
                s["current_step"] = "clone_user_repo"
                try:
                    res = await _clone_user_repo(
                        client, req.project_id, req.gitlab_repo_url,
                        req.gitlab_base_branch, simorgh_branch,
                    )
                    _record("clone_user_repo", "ok",
                            simorgh_branch=simorgh_branch,
                            exit_code=res.get("exit_code"))
                except httpx.HTTPError as e:
                    _record("clone_user_repo", "error", error=str(e))

            # 3. Optional: TPMS data.
            tpms_oe = req.sources.techserver_oenum or req.oenum
            if req.sources.tpms and tpms_oe:
                s["current_step"] = "pull_tpms"
                try:
                    res = await _pull_tpms(client, req.project_id, tpms_oe,
                                           tpms_auth=req.tpms_auth)
                    _record("pull_tpms", "ok", **res)
                except (httpx.HTTPError, RuntimeError) as e:
                    _record("pull_tpms", "error", error=str(e))

            # 4. Optional: techserver SMB copy.
            if req.sources.techserver and tpms_oe:
                s["current_step"] = "pull_techserver"
                try:
                    res = await _pull_techserver(client, req.project_id, tpms_oe,
                                                 tpms_auth=req.tpms_auth)
                    _record("pull_techserver", "ok", exit_code=res.get("exit_code"))
                except (httpx.HTTPError, RuntimeError) as e:
                    _record("pull_techserver", "error", error=str(e))

            # 5. Optional: EKC clone.
            if req.sources.ekc:
                s["current_step"] = "clone_ekc"
                try:
                    res = await _clone_ekc(client, req.project_id)
                    _record("clone_ekc", "ok", exit_code=res.get("exit_code"))
                except httpx.HTTPError as e:
                    _record("clone_ekc", "error", error=str(e))

            # 6. Uploads dir (always — the fallback).
            s["current_step"] = "ensure_uploads_dir"
            try:
                await _ensure_uploads_dir(client, req.project_id)
                _record("ensure_uploads_dir", "ok")
            except httpx.HTTPError as e:
                _record("ensure_uploads_dir", "error", error=str(e))

            # 7. Kick off the explorer.
            s["current_step"] = "kick_explorer"
            res = await _kick_explorer(client, req)
            _record("kick_explorer", "ok", **res)

        s["status"] = "completed"
        s["completed_at"] = datetime.now(timezone.utc).isoformat()
        log.info("init_done", project_id=req.project_id)

    except Exception as e:
        log.exception("init_failed", project_id=req.project_id, error=str(e))
        s["status"] = "failed"
        s["error"] = str(e)


@app.get("/health")
def health():
    return {"status": "healthy", "service": "project-init", "version": "0.3.0"}


@app.post("/init", response_model=InitResponse)
async def init_project(req: InitRequest, background_tasks: BackgroundTasks):
    init_id = str(uuid.uuid4())
    simorgh_branch = _simorgh_branch_name() if req.sources.gitlab else None
    _init_status[init_id] = {
        "init_id": init_id,
        "project_id": req.project_id,
        "status": "pending",
        "started_at": datetime.now(timezone.utc).isoformat(),
        "simorgh_branch": simorgh_branch,
        "steps": [],
    }
    background_tasks.add_task(_run_init, init_id, req)
    return InitResponse(init_id=init_id, project_id=req.project_id,
                        status="started", message="initialization queued",
                        simorgh_branch=simorgh_branch)


@app.get("/status/{init_id}")
def get_status(init_id: str):
    if init_id not in _init_status:
        raise HTTPException(status_code=404, detail="init_id not found")
    return _init_status[init_id]


# ---------------------------------------------------------------------------
# MCP
# ---------------------------------------------------------------------------
mcp = FastMCP(
    "project-init",
    instructions=(
        "Initialise a project: start its session container, optionally "
        "clone the user's gitlab repo + create a simorgh/<hex> branch, "
        "optionally pull TPMS data, techserver SMB content, or the "
        "ekc-technical-knowledge read-only repo, then kick off the "
        "project-explorer agent."
    ),
)


@mcp.tool()
async def project_init(project_id: str, project_name: str, owner_id: str,
                       gitlab_repo_path: str = "",
                       gitlab_repo_url: str = "",
                       gitlab_base_branch: str = "",
                       enable_gitlab: bool = False,
                       enable_tpms: bool = False,
                       enable_techserver: bool = False,
                       enable_ekc: bool = False,
                       techserver_oenum: str = "") -> dict:
    """Initialise a new project synchronously."""
    init_id = str(uuid.uuid4())
    req = InitRequest(
        project_id=project_id,
        project_name=project_name,
        owner_id=owner_id,
        gitlab_repo_path=gitlab_repo_path or None,
        gitlab_repo_url=gitlab_repo_url or None,
        gitlab_base_branch=gitlab_base_branch or None,
        sources=SourcesEnabled(
            gitlab=enable_gitlab,
            tpms=enable_tpms,
            techserver=enable_techserver,
            techserver_oenum=techserver_oenum or None,
            ekc=enable_ekc,
            upload=True,
        ),
    )
    _init_status[init_id] = {
        "init_id": init_id, "project_id": project_id, "status": "running",
        "started_at": datetime.now(timezone.utc).isoformat(), "steps": [],
    }
    await _run_init(init_id, req)
    return _init_status[init_id]


# FastMCP's streamable_http_app exposes route /mcp internally. Mount at
# "/" so its public path is /mcp (mounting at "/mcp" would produce /mcp/mcp).
# Its session_manager needs an active TaskGroup; when the inner app is
# mounted under another FastAPI, the inner lifespan never fires — start
# the session manager from the outer app's lifespan instead, otherwise
# every POST returns 500 with "Task group is not initialized".
_mcp_streamable_app = mcp.streamable_http_app()

@app.on_event("startup")
async def _mcp_session_manager_start():
    cm = mcp.session_manager.run()
    app.state._mcp_session_manager_cm = cm
    await cm.__aenter__()

@app.on_event("shutdown")
async def _mcp_session_manager_stop():
    cm = getattr(app.state, "_mcp_session_manager_cm", None)
    if cm is not None:
        await cm.__aexit__(None, None, None)

app.mount("/", _mcp_streamable_app)
