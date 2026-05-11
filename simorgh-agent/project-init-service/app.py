"""
Project Init Workflow Service (rewritten)
=========================================
NEW FLOW (post-shell-service decommission):

1. Resolve GitLab project for this oenum (or create a fresh one for an
   oenum-less project). The techserver-importer is responsible for the
   one-time bulk seed; per-init we only ensure the project EXISTS.
2. Warm the TPMS context cache via tpms-context-agent so the first CoT
   turn is fast.
3. Index project metadata into context-search so hybrid search works
   immediately.
4. Return an init_id whose status() reports per-step outcome.

What we no longer do:
  • Create per-project workspace on shell-service (.69)
  • SCP / smbclient anything to the shell host
  • Write tpms_project_data.md to a filesystem
  • Clone tech-knowledge — gitlab-mcp serves it on demand
"""
import logging
import os
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
TPMS_CONTEXT_URL      = os.getenv("TPMS_CONTEXT_URL",      "http://tpms-context-agent:8050")
CONTEXT_SEARCH_URL    = os.getenv("CONTEXT_SEARCH_URL",    "http://context-search:8049")
PROJECTS_GROUP        = os.getenv("GITLAB_PROJECTS_GROUP", "simorgh-projects")
AGENT_TOKEN           = os.getenv("AGENT_TOKEN", "")

app = FastAPI(title="project-init", version="0.2.0")
app.middleware("http")(request_id_middleware)

_init_status: dict[str, dict[str, Any]] = {}


class InitRequest(BaseModel):
    project_id: str = Field(..., description="Internal project UUID")
    oenum: str | None = Field(None, description="TPMS OENUM (legacy projects)")
    project_name: str = Field(..., min_length=1)
    owner_id: str = Field(...)


class InitResponse(BaseModel):
    init_id: str
    project_id: str
    status: str
    message: str


def _agent_headers() -> dict[str, str]:
    return {"x-agent-auth": AGENT_TOKEN} if AGENT_TOKEN else {}


async def _ensure_gitlab_project(client: httpx.AsyncClient, oenum: str | None,
                                 project_name: str) -> dict[str, Any]:
    """If oenum provided, expect <PROJECTS_GROUP>/<oenum> to exist (seeded by
    importer). If absent, create a fresh empty project under PROJECTS_GROUP
    named after the project."""
    target_path = f"{PROJECTS_GROUP}/{(oenum or project_name).lower().replace(' ', '-')}"

    # Check existence first.
    r = await client.get(f"{GITLAB_MCP_URL}/projects",
                         params={"group": PROJECTS_GROUP, "search": oenum or project_name})
    r.raise_for_status()
    for p in r.json():
        if p["path"].lower() == target_path.lower():
            return p

    # Create.
    r = await client.post(f"{GITLAB_MCP_URL}/projects",
                          json={"name": oenum or project_name,
                                "namespace": PROJECTS_GROUP,
                                "description": f"Simorgh project ({project_name})"},
                          headers=_agent_headers())
    r.raise_for_status()
    return r.json()


async def _warm_tpms_cache(client: httpx.AsyncClient, oenum: str) -> dict[str, Any]:
    r = await client.post(f"{TPMS_CONTEXT_URL}/context",
                          json={"oenum": oenum, "refresh": True})
    r.raise_for_status()
    return r.json()


async def _index_project_metadata(client: httpx.AsyncClient, req: InitRequest,
                                  gl_project: dict[str, Any]) -> None:
    body = (
        f"# {req.project_name}\n\n"
        f"Project ID: {req.project_id}\n"
        f"Owner: {req.owner_id}\n"
        f"GitLab: {gl_project.get('web_url', '')}\n"
        f"OENUM: {req.oenum or '(none)'}\n"
        f"Created: {datetime.now(timezone.utc).isoformat()}\n"
    )
    r = await client.post(f"{CONTEXT_SEARCH_URL}/index/content", json={
        "source": "project",
        "project_id": req.project_id,
        "oenum": req.oenum,
        "repo": gl_project.get("path"),
        "path": "README.md",
        "title": req.project_name,
        "body": body,
        "tags": ["project-metadata"],
        "id": f"project-meta:{req.project_id}",
    })
    r.raise_for_status()


async def _run_init(init_id: str, req: InitRequest) -> None:
    s = _init_status[init_id]
    s["status"] = "running"
    steps: list[dict[str, Any]] = []

    try:
        async with httpx.AsyncClient(timeout=120) as client:
            s["current_step"] = "ensure_gitlab_project"
            gl_project = await _ensure_gitlab_project(client, req.oenum, req.project_name)
            steps.append({"step": "ensure_gitlab_project", "status": "ok",
                          "result": gl_project})

            if req.oenum:
                s["current_step"] = "warm_tpms_cache"
                try:
                    cache = await _warm_tpms_cache(client, req.oenum)
                    steps.append({"step": "warm_tpms_cache", "status": "ok",
                                  "chars": len(cache.get("rendered", ""))})
                except httpx.HTTPError as e:
                    steps.append({"step": "warm_tpms_cache", "status": "error",
                                  "error": str(e)})

            s["current_step"] = "index_project_metadata"
            try:
                await _index_project_metadata(client, req, gl_project)
                steps.append({"step": "index_project_metadata", "status": "ok"})
            except httpx.HTTPError as e:
                steps.append({"step": "index_project_metadata", "status": "error",
                              "error": str(e)})

        s["status"] = "completed"
        s["steps"] = steps
        s["completed_at"] = datetime.now(timezone.utc).isoformat()
        log.info("init_done", project_id=req.project_id, oenum=req.oenum)

    except Exception as e:
        log.exception("init_failed", project_id=req.project_id, error=str(e))
        s["status"] = "failed"
        s["error"] = str(e)
        s["steps"] = steps


@app.get("/health")
def health():
    return {"status": "healthy", "service": "project-init", "version": "0.2.0"}


@app.post("/init", response_model=InitResponse)
async def init_project(req: InitRequest, background_tasks: BackgroundTasks):
    init_id = str(uuid.uuid4())
    _init_status[init_id] = {
        "init_id": init_id,
        "project_id": req.project_id,
        "status": "pending",
        "started_at": datetime.now(timezone.utc).isoformat(),
        "steps": [],
    }
    background_tasks.add_task(_run_init, init_id, req)
    return InitResponse(init_id=init_id, project_id=req.project_id,
                        status="started", message="initialization queued")


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
        "Initialise a project: ensure its GitLab repo exists, warm the "
        "TPMS context cache, and register the project in the search index."
    ),
)


@mcp.tool()
async def project_init(project_id: str, project_name: str, owner_id: str,
                       oenum: str = "") -> dict:
    """Initialise a new project. Synchronous (waits for completion).

    oenum: optional TPMS OENUM for legacy projects (empty string = none).
    """
    init_id = str(uuid.uuid4())
    _init_status[init_id] = {
        "init_id": init_id, "project_id": project_id,
        "status": "running",
        "started_at": datetime.now(timezone.utc).isoformat(), "steps": [],
    }
    req = InitRequest(project_id=project_id, project_name=project_name,
                      owner_id=owner_id, oenum=oenum or None)
    await _run_init(init_id, req)
    return _init_status[init_id]


app.mount("/mcp", mcp.streamable_http_app())
