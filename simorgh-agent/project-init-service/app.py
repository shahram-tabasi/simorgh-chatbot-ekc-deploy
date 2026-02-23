"""
Project Init Workflow Service
===============================
Orchestrates the full initialization of a new project:
1. Fetch TPMS data via tpms-fetcher-service
2. Convert to text file
3. Store in project workspace via shell-service
4. Init git repo
5. Return initialization report

Endpoints:
  POST /init         - Initialize a project
  GET  /status/{id}  - Get init status
  GET  /health       - Health check
"""

import logging
import os
import uuid
from datetime import datetime
from typing import Optional, Dict, Any

import httpx
from fastapi import FastAPI, HTTPException, BackgroundTasks
from pydantic import BaseModel, Field

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Project Init Workflow Service", version="1.0.0")

TPMS_FETCHER_URL = os.getenv("TPMS_FETCHER_URL", "http://tpms-fetcher:8021")
SHELL_SERVICE_URL = os.getenv("SHELL_SERVICE_URL", "http://192.168.1.69:8010")
SHELL_SERVICE_TOKEN = os.getenv("SHELL_SERVICE_TOKEN", "")

# Track initialization status
_init_status: Dict[str, Dict] = {}


class InitRequest(BaseModel):
    project_id: str = Field(..., description="Unique project ID (UUID)")
    oenum: Optional[str] = Field(None, description="TPMS OENUM (for legacy projects)")
    project_name: str = Field(..., min_length=1)
    owner_id: str = Field(...)


class InitResponse(BaseModel):
    init_id: str
    project_id: str
    status: str
    message: str
    steps_completed: list = []


def _shell_headers():
    h = {}
    if SHELL_SERVICE_TOKEN:
        h["Authorization"] = f"Bearer {SHELL_SERVICE_TOKEN}"
    return h


async def _run_init(init_id: str, req: InitRequest):
    """Background task: full project initialization."""
    status = _init_status[init_id]
    status["status"] = "running"
    steps = []

    try:
        async with httpx.AsyncClient(timeout=60) as client:
            # Step 1: Init git workspace
            status["current_step"] = "git_init"
            resp = await client.post(
                f"{SHELL_SERVICE_URL}/git/init",
                json={"project_id": req.project_id},
                headers=_shell_headers(),
            )
            resp.raise_for_status()
            steps.append({"step": "git_init", "status": "ok", "result": resp.json()})

            # Step 2: Create project README
            readme = f"# {req.project_name}\n\nProject ID: {req.project_id}\n"
            readme += f"Owner: {req.owner_id}\n"
            readme += f"Initialized: {datetime.utcnow().isoformat()}\n"
            if req.oenum:
                readme += f"TPMS OENUM: {req.oenum}\n"

            status["current_step"] = "create_readme"
            resp = await client.post(
                f"{SHELL_SERVICE_URL}/file/write",
                json={"project_id": req.project_id, "path": "README.md", "content": readme},
                headers=_shell_headers(),
            )
            resp.raise_for_status()
            steps.append({"step": "create_readme", "status": "ok"})

            # Step 3: Create directory structure
            status["current_step"] = "create_dirs"
            for dirname in ["documents", "exports", "analysis", "drawings"]:
                resp = await client.post(
                    f"{SHELL_SERVICE_URL}/file/write",
                    json={
                        "project_id": req.project_id,
                        "path": f"{dirname}/.gitkeep",
                        "content": "",
                    },
                    headers=_shell_headers(),
                )
            steps.append({"step": "create_dirs", "status": "ok"})

            # Step 4: Fetch TPMS data (if oenum provided)
            tpms_text = None
            if req.oenum:
                status["current_step"] = "fetch_tpms"
                try:
                    resp = await client.post(f"{TPMS_FETCHER_URL}/fetch/{req.oenum}")
                    resp.raise_for_status()
                    steps.append({"step": "fetch_tpms", "status": "ok"})

                    # Get text version
                    resp = await client.get(f"{TPMS_FETCHER_URL}/project/{req.oenum}/text")
                    resp.raise_for_status()
                    tpms_text = resp.json().get("text", "")
                    steps.append({"step": "tpms_text", "status": "ok", "chars": len(tpms_text)})
                except Exception as e:
                    steps.append({"step": "fetch_tpms", "status": "error", "error": str(e)})

            # Step 5: Save TPMS data as project context file
            if tpms_text:
                status["current_step"] = "save_tpms_context"
                resp = await client.post(
                    f"{SHELL_SERVICE_URL}/file/write",
                    json={
                        "project_id": req.project_id,
                        "path": "documents/tpms_project_data.md",
                        "content": tpms_text,
                    },
                    headers=_shell_headers(),
                )
                resp.raise_for_status()
                steps.append({"step": "save_tpms_context", "status": "ok"})

            # Step 6: Initial commit
            status["current_step"] = "initial_commit"
            resp = await client.post(
                f"{SHELL_SERVICE_URL}/git/commit",
                json={
                    "project_id": req.project_id,
                    "message": f"Project initialized: {req.project_name}",
                },
                headers=_shell_headers(),
            )
            resp.raise_for_status()
            steps.append({"step": "initial_commit", "status": "ok", "result": resp.json()})

        status["status"] = "completed"
        status["steps"] = steps
        status["completed_at"] = datetime.utcnow().isoformat()
        logger.info(f"Project init completed: {req.project_id}")

    except Exception as e:
        logger.error(f"Project init failed: {e}", exc_info=True)
        status["status"] = "failed"
        status["error"] = str(e)
        status["steps"] = steps


@app.get("/health")
async def health():
    return {"status": "healthy", "service": "project-init"}


@app.post("/init", response_model=InitResponse)
async def init_project(req: InitRequest, background_tasks: BackgroundTasks):
    """Initialize a new project workspace with all systems."""
    init_id = str(uuid.uuid4())
    _init_status[init_id] = {
        "init_id": init_id,
        "project_id": req.project_id,
        "status": "pending",
        "started_at": datetime.utcnow().isoformat(),
        "steps": [],
    }

    background_tasks.add_task(_run_init, init_id, req)

    return InitResponse(
        init_id=init_id,
        project_id=req.project_id,
        status="started",
        message="Project initialization started in background",
    )


@app.get("/status/{init_id}")
async def get_status(init_id: str):
    """Get initialization status."""
    if init_id not in _init_status:
        raise HTTPException(status_code=404, detail="Init ID not found")
    return _init_status[init_id]


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8022)
