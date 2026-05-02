"""
Techserver Service — SMB gateway
================================
Sole entry point in the simorgh stack to the corporate SMB share at
${TECHSERVER_IP} (default 192.168.1.3). Per the no-direct-external-access
policy, NO other service may run smbclient/pysmb/etc. directly.

Calling pattern:
  - REST   /list, /get, /put, /delete           (other services)
  - MCP    list_dir, get_file_text, find_files  (AI / COT)

The actual SMB ops use `smbclient` invoked via subprocess. We intentionally
chose smbclient over pysmb / smbprotocol because the legacy techserver
authentication has historically been simpler to negotiate from the CLI
binary than from Python libs in this environment.

Auth:
  Username + password via TECHSERVER_USER / TECHSERVER_PASSWORD envs.
  (Default user EKC\\tech is preserved.)

This service runs on the .68 stack but the binary `smbclient` must be
installed in the container — see Dockerfile.
"""
import logging
import os
import shlex
import subprocess
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException, Query, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from mcp.server.fastmcp import FastMCP

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("techserver-service")

TECHSERVER_IP       = os.getenv("TECHSERVER_IP", "192.168.1.3")
TECHSERVER_USER     = os.getenv("TECHSERVER_USER", "EKC\\tech")
TECHSERVER_PASSWORD = os.getenv("TECHSERVER_PASSWORD", "")
TECHSERVER_SHARE    = os.getenv("TECHSERVER_SHARE", "tech")  # default share name
SMB_TIMEOUT_SEC     = int(os.getenv("SMB_TIMEOUT_SEC", "30"))


def _smb_cmd(remote_path: str, command: str) -> subprocess.CompletedProcess:
    """
    Run a one-off smbclient command. `remote_path` is the path inside the
    share (no leading slash); `command` is what to pass to -c.
    """
    if not TECHSERVER_PASSWORD:
        raise HTTPException(status_code=503, detail="TECHSERVER_PASSWORD not set")
    args = [
        "smbclient",
        f"//{TECHSERVER_IP}/{TECHSERVER_SHARE}",
        "-U", TECHSERVER_USER,
        "--password", TECHSERVER_PASSWORD,
        "-c", command,
    ]
    return subprocess.run(args, capture_output=True, text=True, timeout=SMB_TIMEOUT_SEC)


# ---------------------------------------------------------------------------
# FastAPI
# ---------------------------------------------------------------------------
app = FastAPI(title="Simorgh Techserver Gateway", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ALLOW_ORIGINS", "*").split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> Dict[str, Any]:
    return {
        "status": "healthy",
        "service": "techserver-service",
        "target": f"//{TECHSERVER_IP}/{TECHSERVER_SHARE}",
    }


@app.get("/health/deep")
def health_deep() -> Dict[str, Any]:
    """Actually probes the SMB share. Costs a network round-trip."""
    try:
        p = _smb_cmd("", "ls")
        return {"status": "healthy" if p.returncode == 0 else "degraded",
                "rc": p.returncode, "stderr": p.stderr.strip()[:500]}
    except subprocess.TimeoutExpired:
        return {"status": "unhealthy", "error": "smbclient timed out"}
    except Exception as e:
        return {"status": "unhealthy", "error": str(e)}


# ---------------------------------------------------------------------------
# REST
# ---------------------------------------------------------------------------
@app.get("/list")
def list_dir(path: str = Query("", description="path inside the share")) -> Dict[str, Any]:
    """List entries at `path`. Path '' = share root."""
    cmd = f"cd \"{path}\"; ls" if path else "ls"
    p = _smb_cmd(path, cmd)
    if p.returncode != 0:
        raise HTTPException(status_code=502, detail=p.stderr.strip()[:500])
    # TODO(techserver): parse smbclient output into a structured list of
    # {name, size, mtime, kind: file|dir}. The raw output format is stable
    # but ugly; for now we return it verbatim.
    return {"raw": p.stdout, "path": path}


@app.get("/file")
def get_file(path: str = Query(..., description="full file path inside share")):
    """Download a file. Streams bytes back to the caller."""
    # Use `get` to a stable temp path then stream. Quick stub.
    # TODO(techserver): implement streaming via tempfile + StreamingResponse.
    raise HTTPException(status_code=501, detail="not yet implemented")


@app.delete("/file")
def delete_file(path: str = Query(...)) -> Dict[str, Any]:
    p = _smb_cmd(path, f"rm \"{path}\"")
    if p.returncode != 0:
        raise HTTPException(status_code=502, detail=p.stderr.strip()[:500])
    return {"deleted": path}


@app.post("/file")
async def put_file(path: str = Query(...), file: UploadFile = File(...)) -> Dict[str, Any]:
    """Upload a file to `path` on the share."""
    # TODO(techserver): stream the upload to a temp file then `put` via smbclient.
    raise HTTPException(status_code=501, detail="not yet implemented")


# ---------------------------------------------------------------------------
# Clone-to-shell: smbclient-mget the project folder for an oenum, tar it,
# POST the tarball to shell-service so it lands at
# ~/projects/<project_id>/techserver/ on .69. Called by
# project-agent-service per-source init.
# ---------------------------------------------------------------------------
import tarfile
import tempfile

import httpx as _httpx

SHELL_SERVICE_URL   = os.getenv("SHELL_SERVICE_URL",   "http://192.168.1.69:8010")
SHELL_SERVICE_TOKEN = os.getenv("SHELL_SERVICE_TOKEN", "")


class CloneToShellRequest(BaseModel):
    project_id: str
    oenum: str
    subdir: str = "techserver"


@app.post("/clone-to-shell")
def clone_to_shell(req: CloneToShellRequest) -> Dict[str, Any]:
    """
    Recursively download //techserver/<share>/<oenum>/ via smbclient,
    tar the result, and POST the tarball to shell-service's
    /workspace/upload-tarball so it lands at
    ~/projects/<project_id>/<subdir>/ on .69.
    """
    if not TECHSERVER_PASSWORD:
        raise HTTPException(status_code=503, detail="TECHSERVER_PASSWORD not set")

    # 1. Stage the SMB content into a local temp dir.
    with tempfile.TemporaryDirectory() as workdir:
        # smbclient `cd <oenum>; recurse; prompt; mget *` into workdir.
        # `prompt` turns off the per-file confirmation; `recurse` walks subdirs.
        cmd = (
            f'cd "{req.oenum}"; lcd "{workdir}"; recurse ON; prompt OFF; mget *'
        )
        p = subprocess.run(
            [
                "smbclient",
                f"//{TECHSERVER_IP}/{TECHSERVER_SHARE}",
                "-U", TECHSERVER_USER,
                "--password", TECHSERVER_PASSWORD,
                "-c", cmd,
            ],
            capture_output=True, text=True, timeout=600,
        )
        if p.returncode != 0:
            raise HTTPException(
                status_code=502,
                detail=f"smbclient failed: {p.stderr.strip()[:400]}",
            )

        # 2. Tar the local copy.
        with tempfile.NamedTemporaryFile(delete=False, suffix=".tar") as tmp:
            tar_path = tmp.name
        try:
            with tarfile.open(tar_path, "w") as tf:
                # arcname='' so members are relative to the staged dir.
                for entry in os.listdir(workdir):
                    tf.add(os.path.join(workdir, entry), arcname=entry)

            # 3. POST to shell-service.
            headers = {"Authorization": f"Bearer {SHELL_SERVICE_TOKEN}"} if SHELL_SERVICE_TOKEN else {}
            with open(tar_path, "rb") as fh:
                files = {"file": (f"techserver-{req.oenum}.tar", fh, "application/x-tar")}
                data = {
                    "project_id":     req.project_id,
                    "subdir":         req.subdir,
                    "commit_message": f"feat: import techserver//{req.oenum}",
                }
                try:
                    r = _httpx.post(
                        f"{SHELL_SERVICE_URL}/workspace/upload-tarball",
                        headers=headers, files=files, data=data, timeout=600.0,
                    )
                except _httpx.HTTPError as e:
                    raise HTTPException(
                        status_code=502, detail=f"shell-service unreachable: {e}",
                    )

            if r.status_code != 200:
                raise HTTPException(
                    status_code=502,
                    detail=f"shell-service returned {r.status_code}: {r.text[:300]}",
                )
            return {"ok": True, "oenum": req.oenum, "shell_response": r.json()}
        finally:
            try:
                os.unlink(tar_path)
            except FileNotFoundError:
                pass


# ---------------------------------------------------------------------------
# MCP — AI-facing tools
# ---------------------------------------------------------------------------
mcp = FastMCP(
    "techserver-service",
    instructions=(
        "Read access to the corporate techserver SMB share. Use these "
        "tools when a project's documents need to be located or fetched "
        "from //techserver/<share>/."
    ),
)


@mcp.tool()
async def list_dir_mcp(path: str = "") -> Dict[str, Any]:
    """List entries at the given path inside the techserver SMB share."""
    return list_dir(path=path)


@mcp.tool()
async def find_project_folder(oenum: str) -> Dict[str, Any]:
    """
    Locate a project's folder on the share by OE-number. Returns the
    SMB path if found, else {"found": False}.
    """
    # TODO(techserver): walk the share or query an index file to resolve.
    return {"found": False, "oenum": oenum}


app.mount("/mcp", mcp.streamable_http_app())
