"""
Technical Knowledge Service — gateway to the tech-knowledge git repository
==========================================================================
Per the no-direct-external-access policy, this is the SOLE service that
clones / pulls / greps the corporate technical-knowledge repository at
${TECH_KB_GIT_URL} (a directory on the local network where the
technical-knowledge team commits their research and organised
experience). Every other service that wants to look something up there
calls this service over HTTP / MCP.

Capabilities:
  * Clones the repo on first startup into TECH_KB_LOCAL_PATH
    (default /app/tech_kb).
  * Pulls every TECH_KB_PULL_INTERVAL_SEC (default 600 = 10 min).
  * REST endpoints for find / git-grep / git-log / file content.
  * MCP tools for AI / COT.
  * /health (liveness — does NOT touch git remote)
  * /health/deep (probes git remote)

This is a SCAFFOLD — git operations are wrapped via subprocess. Edit
TECH_KB_GIT_URL + (optionally) TECH_KB_GIT_AUTH at deploy time.
"""
import asyncio
import logging
import os
import shlex
import subprocess
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from mcp.server.fastmcp import FastMCP

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("tech-kb-service")

TECH_KB_GIT_URL          = os.getenv("TECH_KB_GIT_URL", "")  # e.g. git@192.168.1.5:tech/tech-knowledge.git
TECH_KB_GIT_BRANCH       = os.getenv("TECH_KB_GIT_BRANCH", "main")
TECH_KB_LOCAL_PATH       = Path(os.getenv("TECH_KB_LOCAL_PATH", "/app/tech_kb"))
TECH_KB_PULL_INTERVAL    = int(os.getenv("TECH_KB_PULL_INTERVAL_SEC", "600"))
GIT_TIMEOUT_SEC          = int(os.getenv("GIT_TIMEOUT_SEC", "60"))


# ---------------------------------------------------------------------------
# git wrapper helpers
# ---------------------------------------------------------------------------
def _run(args: List[str], cwd: Optional[Path] = None, timeout: int = GIT_TIMEOUT_SEC) -> subprocess.CompletedProcess:
    return subprocess.run(
        args, cwd=str(cwd) if cwd else None,
        capture_output=True, text=True, timeout=timeout,
    )


def ensure_clone() -> Optional[str]:
    """Clone the repo if not present. Returns error message on failure, else None."""
    if not TECH_KB_GIT_URL:
        return "TECH_KB_GIT_URL not set"
    if (TECH_KB_LOCAL_PATH / ".git").exists():
        return None
    TECH_KB_LOCAL_PATH.mkdir(parents=True, exist_ok=True)
    p = _run(["git", "clone", "--branch", TECH_KB_GIT_BRANCH, TECH_KB_GIT_URL,
              str(TECH_KB_LOCAL_PATH)])
    if p.returncode != 0:
        return f"clone failed: {p.stderr.strip()[:300]}"
    return None


def git_pull() -> Dict[str, Any]:
    if not (TECH_KB_LOCAL_PATH / ".git").exists():
        err = ensure_clone()
        if err:
            return {"ok": False, "error": err}
    p = _run(["git", "fetch", "--prune"], cwd=TECH_KB_LOCAL_PATH)
    if p.returncode != 0:
        return {"ok": False, "error": f"fetch failed: {p.stderr.strip()[:300]}"}
    p = _run(["git", "reset", "--hard", f"origin/{TECH_KB_GIT_BRANCH}"], cwd=TECH_KB_LOCAL_PATH)
    if p.returncode != 0:
        return {"ok": False, "error": f"reset failed: {p.stderr.strip()[:300]}"}
    return {"ok": True}


async def _pull_loop():
    while True:
        try:
            res = git_pull()
            if res.get("ok"):
                logger.debug("tech-kb pulled")
            else:
                logger.warning("tech-kb pull: %s", res.get("error"))
        except Exception:
            logger.exception("tech-kb pull error")
        await asyncio.sleep(TECH_KB_PULL_INTERVAL)


# ---------------------------------------------------------------------------
# FastAPI lifespan
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    err = ensure_clone()
    if err:
        logger.warning("initial clone skipped: %s", err)
    task = asyncio.create_task(_pull_loop())
    logger.info("tech-kb-service ready, repo=%s path=%s", TECH_KB_GIT_URL, TECH_KB_LOCAL_PATH)
    yield
    task.cancel()


app = FastAPI(title="Simorgh Technical Knowledge Service", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ALLOW_ORIGINS", "*").split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------
@app.get("/health")
def health() -> Dict[str, Any]:
    return {
        "status": "healthy",
        "service": "tech-kb-service",
        "repo_url": TECH_KB_GIT_URL,
        "local_path": str(TECH_KB_LOCAL_PATH),
        "cloned": (TECH_KB_LOCAL_PATH / ".git").exists(),
    }


@app.get("/health/deep")
def health_deep() -> Dict[str, Any]:
    """Actually probes the git remote. Used by the project-creation precheck."""
    if not TECH_KB_GIT_URL:
        return {"status": "unhealthy", "error": "TECH_KB_GIT_URL not set"}
    if not (TECH_KB_LOCAL_PATH / ".git").exists():
        err = ensure_clone()
        if err:
            return {"status": "unhealthy", "error": err}
    p = _run(["git", "ls-remote", "--heads", "origin"], cwd=TECH_KB_LOCAL_PATH, timeout=20)
    if p.returncode != 0:
        return {"status": "unhealthy", "error": p.stderr.strip()[:300]}
    return {"status": "healthy", "remote_reachable": True}


# ---------------------------------------------------------------------------
# REST: search + content
# ---------------------------------------------------------------------------
class SearchRequest(BaseModel):
    query: str
    max_results: int = 50


@app.post("/find")
def find_files(query: str = Query(..., description="filename glob or substring")) -> Dict[str, Any]:
    """find by filename — uses POSIX `find` so callers can rely on its semantics."""
    if not TECH_KB_LOCAL_PATH.exists():
        raise HTTPException(status_code=503, detail="repo not cloned")
    p = _run(
        ["find", str(TECH_KB_LOCAL_PATH), "-iname", f"*{query}*", "-not", "-path", "*/.git/*"],
        timeout=30,
    )
    if p.returncode != 0:
        raise HTTPException(status_code=500, detail=p.stderr.strip()[:300])
    rel = []
    for line in p.stdout.splitlines():
        if line.strip():
            rel.append(line.replace(str(TECH_KB_LOCAL_PATH) + "/", "", 1))
    return {"files": rel, "count": len(rel)}


@app.post("/grep")
def git_grep(req: SearchRequest) -> Dict[str, Any]:
    """git grep -n — returns matching lines with file:line:content."""
    if not TECH_KB_LOCAL_PATH.exists():
        raise HTTPException(status_code=503, detail="repo not cloned")
    p = _run(["git", "grep", "-n", "-i", "--", req.query], cwd=TECH_KB_LOCAL_PATH, timeout=30)
    # rc=1 means "no matches"; rc=0 means matches; rc=2+ means error.
    if p.returncode > 1:
        raise HTTPException(status_code=500, detail=p.stderr.strip()[:300])
    matches = []
    for line in p.stdout.splitlines()[: req.max_results]:
        # format: path:lineno:content
        try:
            path, lineno, content = line.split(":", 2)
            matches.append({"path": path, "line": int(lineno), "content": content})
        except ValueError:
            continue
    return {"matches": matches, "count": len(matches)}


@app.get("/file")
def get_file(path: str = Query(...)) -> Dict[str, Any]:
    """Return file contents (utf-8, capped at 1 MiB)."""
    if "/.." in path or path.startswith("/") or path.startswith(".."):
        raise HTTPException(status_code=400, detail="bad path")
    target = TECH_KB_LOCAL_PATH / path
    if not target.is_file():
        raise HTTPException(status_code=404, detail="not found")
    try:
        data = target.read_bytes()[: 1 << 20]
        return {"path": path, "content": data.decode("utf-8", errors="replace"),
                "truncated": target.stat().st_size > (1 << 20)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/pull")
def manual_pull() -> Dict[str, Any]:
    """Trigger an immediate git pull (admin / debug)."""
    return git_pull()


# ---------------------------------------------------------------------------
# Snapshot-and-push: capture `main` HEAD as a tarball and POST it to
# shell-service so it lands in <project>/tech-knowledge/. Called by
# project-agent-service during per-source init when "tech_knowledge" was
# selected in the precheck dialog.
# ---------------------------------------------------------------------------
import tempfile

import httpx as _httpx

SHELL_SERVICE_URL   = os.getenv("SHELL_SERVICE_URL",   "http://192.168.1.69:8010")
SHELL_SERVICE_TOKEN = os.getenv("SHELL_SERVICE_TOKEN", "")


class SnapshotToShellRequest(BaseModel):
    project_id: str
    subdir: str = "tech-knowledge"


@app.post("/snapshot-to-shell")
def snapshot_to_shell(req: SnapshotToShellRequest) -> Dict[str, Any]:
    """
    Tar `main` HEAD of the local clone (which is always `git pull`-fresh)
    and POST the tarball to shell-service /workspace/upload-tarball so it
    lands at ~/projects/<project_id>/<subdir>/ on .69.
    """
    if not (TECH_KB_LOCAL_PATH / ".git").exists():
        err = ensure_clone()
        if err:
            raise HTTPException(status_code=503, detail=err)

    # Make sure we have the latest main before snapshotting.
    pull_res = git_pull()
    if not pull_res.get("ok"):
        raise HTTPException(status_code=502, detail=pull_res.get("error", "pull failed"))

    with tempfile.NamedTemporaryFile(delete=False, suffix=".tar") as tmp:
        tmp_path = tmp.name

    try:
        # `git archive main` → tarball stream into our tempfile.
        p = _run(
            ["git", "archive", "--format=tar", "-o", tmp_path, "main"],
            cwd=TECH_KB_LOCAL_PATH,
            timeout=GIT_TIMEOUT_SEC,
        )
        if p.returncode != 0:
            raise HTTPException(status_code=500, detail=p.stderr.strip()[:300])

        # Stream-upload to shell-service.
        headers = {"Authorization": f"Bearer {SHELL_SERVICE_TOKEN}"} if SHELL_SERVICE_TOKEN else {}
        with open(tmp_path, "rb") as fh:
            files = {"file": ("tech-knowledge.tar", fh, "application/x-tar")}
            data = {
                "project_id": req.project_id,
                "subdir": req.subdir,
                "commit_message": f"feat: snapshot tech-knowledge main HEAD",
            }
            try:
                r = _httpx.post(
                    f"{SHELL_SERVICE_URL}/workspace/upload-tarball",
                    headers=headers, files=files, data=data, timeout=300.0,
                )
            except _httpx.HTTPError as e:
                raise HTTPException(status_code=502, detail=f"shell-service unreachable: {e}")

        if r.status_code != 200:
            raise HTTPException(status_code=502,
                                detail=f"shell-service returned {r.status_code}: {r.text[:300]}")
        return {"ok": True, "shell_response": r.json()}
    finally:
        try:
            os.unlink(tmp_path)
        except FileNotFoundError:
            pass


# ---------------------------------------------------------------------------
# MCP — AI / COT tools
# ---------------------------------------------------------------------------
mcp = FastMCP(
    "tech-kb-service",
    instructions=(
        "Search the corporate technical-knowledge repository — research notes, "
        "engineering experience, panel design conventions, etc. Use this when "
        "answering questions that need internal engineering know-how rather "
        "than general LLM knowledge."
    ),
)


@mcp.tool()
async def search_tech_knowledge(query: str, max_results: int = 20) -> Dict[str, Any]:
    """Full-text search the tech-knowledge repo. Returns file:line:content matches."""
    return git_grep(SearchRequest(query=query, max_results=max_results))


@mcp.tool()
async def find_tech_files(name_query: str) -> Dict[str, Any]:
    """Search by filename in the tech-knowledge repo."""
    return find_files(query=name_query)


@mcp.tool()
async def get_tech_file(path: str) -> Dict[str, Any]:
    """Read a file from the tech-knowledge repo by path."""
    return get_file(path=path)


app.mount("/mcp", mcp.streamable_http_app())
