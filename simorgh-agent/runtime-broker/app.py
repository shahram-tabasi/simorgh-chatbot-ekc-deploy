"""
runtime-broker
==============
Replaces shell-service. Spawns a fresh, ephemeral docker container per
request from one of three stock images (python / node / shell), runs the
caller-supplied script inside it under hard cgroup limits, captures
stdout/stderr/exit_code, then destroys the container.

Design:
  • No persistent /workspace per project (the old shell-service model).
    Callers either (a) pass `inputs` as in-memory files, or (b) ask the
    broker to mount a read-only checkout of a GitLab repo (via the sidecar
    `prefetch` flow).
  • Network defaults to `none` — task containers cannot reach the LAN. Set
    `network: "bridge"` per-request only when truly needed.
  • Docker socket is mounted from the host. No privileged containers.
  • Limits enforced: mem, cpu_quota, pids_limit, tmpfs root, no caps,
    seccomp default, read-only rootfs.

REST:
  POST /run            — execute a script, get result back
  POST /run/python     — convenience: language=python
  POST /run/shell      — convenience: language=shell
  POST /run/node       — convenience: language=node
  GET  /health
  GET  /images         — what stock images are configured

MCP tools:
  run_python(script, inputs?, timeout?)
  run_shell(script, inputs?, timeout?)
  run_node(script, inputs?, timeout?)
"""
from __future__ import annotations

import io
import os
import tarfile
import time
import uuid
from typing import Literal

import docker
from docker.errors import ContainerError, ImageNotFound, APIError
from fastapi import Depends, FastAPI, Header, HTTPException
from mcp.server.fastmcp import FastMCP
from pydantic import BaseModel, Field

from simorgh_logging import configure, get_logger, request_id_middleware

configure(service="runtime-broker")
log = get_logger(__name__)

BROKER_TOKEN     = os.getenv("BROKER_TOKEN", "")
NETWORK          = os.getenv("BROKER_NETWORK", "none")
PYTHON_IMAGE     = os.getenv("BROKER_PYTHON_IMAGE", "python:3.12-slim")
NODE_IMAGE       = os.getenv("BROKER_NODE_IMAGE", "node:20-alpine")
SHELL_IMAGE      = os.getenv("BROKER_SHELL_IMAGE", "ubuntu:22.04")
DEFAULT_TIMEOUT  = int(os.getenv("BROKER_DEFAULT_TIMEOUT", "30"))
MAX_TIMEOUT      = int(os.getenv("BROKER_MAX_TIMEOUT", "300"))
MEM_LIMIT        = os.getenv("BROKER_MEM_LIMIT", "512m")
CPU_QUOTA        = int(os.getenv("BROKER_CPU_QUOTA", "50000"))   # of 100000 / cpu
PIDS_LIMIT       = int(os.getenv("BROKER_PIDS_LIMIT", "128"))
TMPFS_SIZE       = os.getenv("BROKER_TMPFS_SIZE", "128m")

_dockerc = docker.from_env()


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
Lang = Literal["python", "shell", "node"]


class FileInput(BaseModel):
    path: str = Field(..., description="path inside /work, e.g. data.json")
    content: str = Field(..., description="utf-8 text contents")


class RunRequest(BaseModel):
    language: Lang
    script: str = Field(..., min_length=1, max_length=200_000)
    inputs: list[FileInput] = []
    timeout_sec: int = Field(DEFAULT_TIMEOUT, ge=1, le=MAX_TIMEOUT)
    network: Literal["none", "bridge"] | None = None
    env: dict[str, str] = {}


class RunResult(BaseModel):
    exit_code: int
    stdout: str
    stderr: str
    duration_ms: int
    container_id: str
    image: str
    timed_out: bool


# ---------------------------------------------------------------------------
# FastAPI
# ---------------------------------------------------------------------------
app = FastAPI(title="runtime-broker", version="0.1.0")
app.middleware("http")(request_id_middleware)


def require_token(authorization: str | None = Header(default=None)):
    if not BROKER_TOKEN:
        return
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")
    if authorization.removeprefix("Bearer ").strip() != BROKER_TOKEN:
        raise HTTPException(status_code=403, detail="bad token")


def _image_for(lang: Lang) -> str:
    return {"python": PYTHON_IMAGE, "node": NODE_IMAGE, "shell": SHELL_IMAGE}[lang]


def _entrypoint(lang: Lang) -> list[str]:
    """Run the user script as $WORK/main.* with the appropriate interpreter."""
    if lang == "python":
        return ["python", "/work/main.py"]
    if lang == "node":
        return ["node", "/work/main.js"]
    return ["/bin/bash", "/work/main.sh"]


def _script_filename(lang: Lang) -> str:
    return {"python": "main.py", "node": "main.js", "shell": "main.sh"}[lang]


def _build_input_tar(req: RunRequest) -> bytes:
    """Pack the user script + inputs into an in-memory tar to upload via put_archive."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tar:
        def _add(path: str, data: bytes, mode: int = 0o644):
            ti = tarfile.TarInfo(name=path)
            ti.size = len(data)
            ti.mode = mode
            tar.addfile(ti, io.BytesIO(data))
        _add(_script_filename(req.language), req.script.encode("utf-8"), 0o755)
        for f in req.inputs:
            # Reject path traversal — files must land under /work directly.
            if "/" in f.path or f.path.startswith(".."):
                raise HTTPException(status_code=400, detail=f"invalid input path {f.path!r}")
            _add(f.path, f.content.encode("utf-8"))
    return buf.getvalue()


def _run(req: RunRequest) -> RunResult:
    image     = _image_for(req.language)
    entry     = _entrypoint(req.language)
    container = None
    name      = f"sim-task-{uuid.uuid4().hex[:12]}"
    network   = req.network or NETWORK
    started   = time.perf_counter()
    timed_out = False

    try:
        # Pre-pull image if missing — fail fast with a clear error.
        try:
            _dockerc.images.get(image)
        except ImageNotFound:
            log.info("pull_image", image=image)
            _dockerc.images.pull(image)

        container = _dockerc.containers.create(
            image=image,
            command=entry,
            name=name,
            working_dir="/work",
            environment=req.env,
            network_mode=network,
            mem_limit=MEM_LIMIT,
            memswap_limit=MEM_LIMIT,             # disable swap
            cpu_period=100_000,
            cpu_quota=CPU_QUOTA,
            pids_limit=PIDS_LIMIT,
            read_only=True,
            tmpfs={"/work": f"rw,size={TMPFS_SIZE},mode=1777",
                   "/tmp":  f"rw,size={TMPFS_SIZE},mode=1777"},
            cap_drop=["ALL"],
            security_opt=["no-new-privileges"],
            user="65534:65534",                   # nobody:nogroup
            detach=True,
        )

        # Upload script + inputs into /work BEFORE start.
        tar_bytes = _build_input_tar(req)
        container.put_archive("/work", tar_bytes)

        container.start()
        try:
            result = container.wait(timeout=req.timeout_sec)
            exit_code = int(result.get("StatusCode", -1))
        except Exception:
            timed_out = True
            try: container.kill()
            except Exception: pass
            exit_code = 124   # GNU timeout convention

        stdout = container.logs(stdout=True, stderr=False).decode("utf-8", "replace")
        stderr = container.logs(stdout=False, stderr=True).decode("utf-8", "replace")

        # Truncate to keep responses bounded.
        MAX = 100_000
        stdout = stdout[:MAX]
        stderr = stderr[:MAX]

        duration_ms = int((time.perf_counter() - started) * 1000)
        log.info("run", lang=req.language, image=image, exit_code=exit_code,
                 duration_ms=duration_ms, timed_out=timed_out, container=name)

        return RunResult(
            exit_code=exit_code, stdout=stdout, stderr=stderr,
            duration_ms=duration_ms, container_id=container.id, image=image,
            timed_out=timed_out,
        )
    except APIError as e:
        raise HTTPException(status_code=502, detail=f"docker error: {e.explanation}")
    finally:
        if container is not None:
            try: container.remove(force=True)
            except Exception: pass


@app.get("/health")
def health():
    return {"status": "ok", "service": "runtime-broker"}


@app.get("/images")
def images():
    return {"python": PYTHON_IMAGE, "node": NODE_IMAGE, "shell": SHELL_IMAGE}


@app.post("/run", response_model=RunResult, dependencies=[Depends(require_token)])
def run(req: RunRequest):
    return _run(req)


# ---------------------------------------------------------------------------
# MCP — tools the agent calls instead of shell-service.
# ---------------------------------------------------------------------------
mcp = FastMCP(
    "runtime-broker",
    instructions=(
        "Run code in a fresh, sandboxed container. Use run_python for "
        "Python, run_node for JS, run_shell for bash. No persistent state."
    ),
)


@mcp.tool()
async def run_python(script: str, timeout_sec: int = DEFAULT_TIMEOUT) -> dict:
    """Run a Python 3 script in an ephemeral container. Returns exit_code + stdout + stderr."""
    return _run(RunRequest(language="python", script=script, timeout_sec=timeout_sec)).model_dump()


@mcp.tool()
async def run_node(script: str, timeout_sec: int = DEFAULT_TIMEOUT) -> dict:
    """Run a Node.js script in an ephemeral container."""
    return _run(RunRequest(language="node", script=script, timeout_sec=timeout_sec)).model_dump()


@mcp.tool()
async def run_shell(script: str, timeout_sec: int = DEFAULT_TIMEOUT) -> dict:
    """Run a bash script in an ephemeral Ubuntu container."""
    return _run(RunRequest(language="shell", script=script, timeout_sec=timeout_sec)).model_dump()


app.mount("/mcp", mcp.streamable_http_app())
