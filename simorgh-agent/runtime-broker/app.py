"""
runtime-broker
==============
Per-project long-lived shell-runtime containers.

This is the replacement for both:
  • the old shell-service (per-user persistent workspace), and
  • the brief ephemeral-only runtime-broker (every /run a fresh container).

Design:
  • One named container per project (created by /sessions/{project_id}/start).
  • A docker named volume holds the project's working dir (persistent across
    container restarts — survives stop, dies only on /sessions/{pid}/delete).
  • Container is started/stopped by the CoT engine: it boots when the project
    chat needs a tool, stops when idle.
  • Image is `BROKER_SESSION_IMAGE` (Ubuntu-based with git + python + node
    pre-installed). Network = bridge by default so the container can reach
    GitLab (internal LAN), techserver SMB (192.168.1.3), and push back.
  • Exec endpoints (/sessions/{pid}/exec) run a command inside the live
    container and stream stdout/stderr; results also logged to host so
    chat-service can mirror them.

REST:
  POST   /sessions/{project_id}/start
  POST   /sessions/{project_id}/stop
  POST   /sessions/{project_id}/exec        — run a shell command, return result
  POST   /sessions/{project_id}/write_file  — put a file into working dir
  GET    /sessions/{project_id}/read_file   — read a file from working dir
  GET    /sessions/{project_id}/status
  DELETE /sessions/{project_id}             — stop + remove container + volume
  GET    /health
  GET    /images

MCP tools (called by the CoT engine):
  session_start(project_id)
  session_stop(project_id)
  session_exec(project_id, command, timeout_sec?, workdir?)
  session_write_file(project_id, path, content)
  session_read_file(project_id, path)
  session_git_commit(project_id, message, paths?)
  session_git_push(project_id, branch?)
"""
import base64
import io
import os
import shlex
import tarfile
import threading
import time
import uuid
from typing import Literal

import docker
from docker.errors import APIError, ImageNotFound, NotFound
from fastapi import Depends, FastAPI, Header, HTTPException
from mcp.server.fastmcp import FastMCP
from pydantic import BaseModel, Field

from simorgh_artifacts import (
    DocProcessorClient,
    classify,
    extracted_path_for,
)
from simorgh_logging import configure, get_logger, request_id_middleware

configure(service="runtime-broker")
log = get_logger(__name__)

BROKER_TOKEN     = os.getenv("BROKER_TOKEN", "")

# Single session image — ships with git, python3, nodejs, smbclient, openssh-client.
SESSION_IMAGE    = os.getenv("BROKER_SESSION_IMAGE", "simorgh/session-runtime:latest")
# Network: bridge so the container can reach GitLab + techserver SMB + push.
SESSION_NETWORK  = os.getenv("BROKER_SESSION_NETWORK", "bridge")

DEFAULT_TIMEOUT  = int(os.getenv("BROKER_DEFAULT_TIMEOUT", "60"))
MAX_TIMEOUT      = int(os.getenv("BROKER_MAX_TIMEOUT", "1800"))
MEM_LIMIT        = os.getenv("BROKER_MEM_LIMIT", "1g")
CPU_QUOTA        = int(os.getenv("BROKER_CPU_QUOTA", "100000"))   # of 100000 / cpu
PIDS_LIMIT       = int(os.getenv("BROKER_PIDS_LIMIT", "512"))

# Two-tier idle teardown (Phase 4):
#   - After IDLE_STOP_SEC of no activity → docker stop (container kept,
#     volume kept; restart is a docker-start, ~100ms).
#   - After IDLE_REMOVE_SEC of no activity → docker rm (volume kept;
#     restart is a docker-create + docker-start, ~1-2s plus image
#     pull only if missing). Saves ~30-80MB of stopped-container
#     metadata per project after a day of inactivity.
# IDLE_TTL_SEC is preserved as a back-compat alias for STOP.
IDLE_STOP_SEC    = int(os.getenv(
    "BROKER_IDLE_STOP_SEC",
    os.getenv("BROKER_IDLE_TTL_SEC", "900")))   # 15m
IDLE_REMOVE_SEC  = int(os.getenv("BROKER_IDLE_REMOVE_SEC", "86400"))  # 24h
IDLE_SWEEP_SEC   = int(os.getenv("BROKER_IDLE_SWEEP_SEC", "600"))    # 10m
# Back-compat: code paths and logs still reference IDLE_TTL_SEC. Keep
# the symbol pointing at the stop tier (semantics preserved from
# pre-Phase-4 behaviour for callers reading IDLE_TTL_SEC).
IDLE_TTL_SEC     = IDLE_STOP_SEC

# Concurrent-exec cap per project. Sized to the canonical 4-source
# fan-out (gitlab + techserver + tpms + uploads); raise if you see
# benign waves of 5+ session_exec calls queueing. Excess execs block
# at the semaphore — they don't 429 the agent. 0 disables capping.
MAX_CONCURRENT_EXECS_PER_PROJECT = int(
    os.getenv("BROKER_MAX_CONCURRENT_EXECS", "4"))

WORKING_DIR      = "/work"
CONTAINER_PREFIX = "simorgh-proj-"
VOLUME_PREFIX    = "simorgh-proj-vol-"

_dockerc = docker.from_env()

# Per-project last-activity wall clock (seconds since epoch). Updated by
# every exec / file IO / git op so the sweeper can decide what's idle.
_last_activity: dict[str, float] = {}


def _touch(project_id: str) -> None:
    _last_activity[project_id] = time.time()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _container_name(project_id: str) -> str:
    return f"{CONTAINER_PREFIX}{project_id}"


def _volume_name(project_id: str) -> str:
    return f"{VOLUME_PREFIX}{project_id}"


def _get_container(project_id: str):
    try:
        return _dockerc.containers.get(_container_name(project_id))
    except NotFound:
        return None


def _ensure_image(image: str) -> None:
    try:
        _dockerc.images.get(image)
    except ImageNotFound:
        log.info("pull_image", image=image)
        _dockerc.images.pull(image)


def _ensure_volume(project_id: str) -> str:
    name = _volume_name(project_id)
    try:
        _dockerc.volumes.get(name)
    except NotFound:
        _dockerc.volumes.create(name=name, labels={"simorgh.project": project_id})
    return name


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
class StartRequest(BaseModel):
    project_id: str
    image: str | None = None
    env: dict[str, str] = {}


class ExecRequest(BaseModel):
    command: str = Field(..., description="Shell command to run inside the session container")
    timeout_sec: int = Field(DEFAULT_TIMEOUT, ge=1, le=MAX_TIMEOUT)
    workdir: str | None = None
    user: str | None = None


class ExecResult(BaseModel):
    exit_code: int
    stdout: str
    stderr: str
    duration_ms: int
    timed_out: bool


class WriteFileRequest(BaseModel):
    path: str = Field(..., description="path relative to /work")
    content: str
    encoding: Literal["text", "base64"] = "text"


class SessionStatus(BaseModel):
    project_id: str
    container_name: str
    container_id: str | None
    image: str | None
    status: str    # 'absent' | 'created' | 'running' | 'exited' | 'paused' | ...
    volume: str
    working_dir: str


# ---------------------------------------------------------------------------
# FastAPI
# ---------------------------------------------------------------------------
app = FastAPI(title="runtime-broker", version="0.3.0")
app.middleware("http")(request_id_middleware)


def require_token(authorization: str | None = Header(default=None)):
    if not BROKER_TOKEN:
        return
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")
    if authorization.removeprefix("Bearer ").strip() != BROKER_TOKEN:
        raise HTTPException(status_code=403, detail="bad token")


@app.get("/health")
def health():
    return {"status": "ok", "service": "runtime-broker", "version": "0.3.0"}


@app.get("/images")
def images():
    return {"session": SESSION_IMAGE}


# ---------------------------------------------------------------------------
# Session lifecycle
# ---------------------------------------------------------------------------
def _create_and_start(project_id: str, image: str, env: dict[str, str]):
    volume = _ensure_volume(project_id)
    _ensure_image(image)
    name = _container_name(project_id)

    container = _dockerc.containers.create(
        image=image,
        # Keep the container alive; CoT execs into it as needed.
        command=["/bin/sh", "-c", "trap 'exit 0' TERM; while :; do sleep 3600 & wait $!; done"],
        name=name,
        working_dir=WORKING_DIR,
        environment=env,
        network_mode=SESSION_NETWORK,
        mem_limit=MEM_LIMIT,
        memswap_limit=MEM_LIMIT,
        cpu_period=100_000,
        cpu_quota=CPU_QUOTA,
        pids_limit=PIDS_LIMIT,
        volumes={volume: {"bind": WORKING_DIR, "mode": "rw"}},
        labels={"simorgh.project": project_id, "simorgh.role": "session"},
        cap_drop=["ALL"],
        cap_add=["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETUID", "SETGID"],
        security_opt=["no-new-privileges"],
        # tini as PID 1 (docker --init equivalent). Required for proper
        # reaping of `docker exec` orphans: without it, any grandchild
        # that outlives its exec parent becomes a zombie under the
        # `sleep` keep-alive (which doesn't reap), and the project's
        # PID table climbs against PIDS_LIMIT over days of use. See
        # github.com/krallin/tini for the canonical writeup.
        init=True,
        # Per-container log cap. Without this, a runaway loop inside
        # the container can fill the host's /var/lib/docker partition.
        # 50 files × 5 MB = 250 MB hard cap per project. Honours the
        # operator's env override.
        log_config={
            "type": os.getenv("BROKER_LOG_DRIVER", "json-file"),
            "config": {
                "max-size": os.getenv("BROKER_LOG_MAX_SIZE", "5m"),
                "max-file": os.getenv("BROKER_LOG_MAX_FILES", "5"),
            },
        },
        detach=True,
        restart_policy={"Name": "unless-stopped"},
    )
    container.start()
    return container


# --------------------------------------------------------------------------
# Per-project concurrent-exec semaphore. Caps simultaneous `docker exec`
# calls per project_id so a runaway agent burst can't pin the project's
# whole cgroup (all execs share the container's parent cgroup until we
# wire per-exec child cgroups in Phase 4). Excess execs BLOCK at the
# semaphore — they don't 429 the agent — so the request queues
# gracefully under load.
# --------------------------------------------------------------------------
_exec_sems: dict[str, threading.Semaphore] = {}
_exec_sems_lock = threading.Lock()


def _get_exec_sem(project_id: str) -> threading.Semaphore | None:
    if MAX_CONCURRENT_EXECS_PER_PROJECT <= 0:
        return None
    with _exec_sems_lock:
        s = _exec_sems.get(project_id)
        if s is None:
            s = threading.Semaphore(MAX_CONCURRENT_EXECS_PER_PROJECT)
            _exec_sems[project_id] = s
        return s


@app.post("/sessions/{project_id}/start", response_model=SessionStatus,
          dependencies=[Depends(require_token)])
def start_session(project_id: str, req: StartRequest | None = None):
    if req is None:
        req = StartRequest(project_id=project_id)
    image = req.image or SESSION_IMAGE
    env = req.env or {}

    existing = _get_container(project_id)
    if existing is not None:
        existing.reload()
        if existing.status != "running":
            try:
                existing.start()
                existing.reload()
            except APIError as e:
                raise HTTPException(status_code=502, detail=f"docker start: {e.explanation}")
        _touch(project_id)
        return SessionStatus(
            project_id=project_id, container_name=existing.name,
            container_id=existing.id, image=image,
            status=existing.status, volume=_volume_name(project_id),
            working_dir=WORKING_DIR,
        )
    try:
        container = _create_and_start(project_id, image, env)
    except APIError as e:
        raise HTTPException(status_code=502, detail=f"docker create: {e.explanation}")
    container.reload()
    _touch(project_id)
    return SessionStatus(
        project_id=project_id, container_name=container.name,
        container_id=container.id, image=image, status=container.status,
        volume=_volume_name(project_id), working_dir=WORKING_DIR,
    )


@app.post("/sessions/{project_id}/stop", response_model=SessionStatus,
          dependencies=[Depends(require_token)])
def stop_session(project_id: str, timeout: int = 10):
    c = _get_container(project_id)
    if c is None:
        raise HTTPException(status_code=404, detail="session container not found")
    try:
        c.stop(timeout=timeout)
        c.reload()
    except APIError as e:
        raise HTTPException(status_code=502, detail=f"docker stop: {e.explanation}")
    return SessionStatus(
        project_id=project_id, container_name=c.name, container_id=c.id,
        image=(c.image.tags[0] if c.image.tags else None),
        status=c.status, volume=_volume_name(project_id), working_dir=WORKING_DIR,
    )


@app.get("/sessions/{project_id}/status", response_model=SessionStatus,
         dependencies=[Depends(require_token)])
def session_status(project_id: str):
    c = _get_container(project_id)
    if c is None:
        return SessionStatus(
            project_id=project_id, container_name=_container_name(project_id),
            container_id=None, image=None, status="absent",
            volume=_volume_name(project_id), working_dir=WORKING_DIR,
        )
    c.reload()
    return SessionStatus(
        project_id=project_id, container_name=c.name, container_id=c.id,
        image=(c.image.tags[0] if c.image.tags else None),
        status=c.status, volume=_volume_name(project_id), working_dir=WORKING_DIR,
    )


@app.delete("/sessions/{project_id}", dependencies=[Depends(require_token)])
def delete_session(project_id: str, keep_volume: bool = False):
    """Stop + remove the container, and (default) destroy the named volume.
    Called when the project chat session is deleted by the user.
    """
    c = _get_container(project_id)
    removed_container = False
    if c is not None:
        try:
            c.remove(force=True)
            removed_container = True
        except APIError as e:
            raise HTTPException(status_code=502, detail=f"docker rm: {e.explanation}")

    # Drop the project's exec semaphore so we don't leak threading
    # objects across project lifetimes.
    with _exec_sems_lock:
        _exec_sems.pop(project_id, None)

    removed_volume = False
    if not keep_volume:
        try:
            v = _dockerc.volumes.get(_volume_name(project_id))
            v.remove(force=True)
            removed_volume = True
        except NotFound:
            pass
        except APIError as e:
            raise HTTPException(status_code=502, detail=f"docker volume rm: {e.explanation}")

    return {
        "project_id": project_id,
        "removed_container": removed_container,
        "removed_volume": removed_volume,
    }


# ---------------------------------------------------------------------------
# Exec / file IO
# ---------------------------------------------------------------------------
def _require_running(project_id: str):
    c = _get_container(project_id)
    if c is None:
        raise HTTPException(status_code=404, detail="session not started")
    c.reload()
    if c.status != "running":
        # Auto-start: CoT often calls exec immediately after start; tolerate a stopped one.
        try:
            c.start()
            c.reload()
        except APIError as e:
            raise HTTPException(status_code=409,
                                detail=f"session not running and could not start: {e.explanation}")
    _touch(project_id)
    return c


@app.post("/sessions/{project_id}/exec", response_model=ExecResult,
          dependencies=[Depends(require_token)])
def session_exec(project_id: str, req: ExecRequest):
    c = _require_running(project_id)
    workdir = req.workdir or WORKING_DIR
    user = req.user or "root"
    cmd = ["/bin/bash", "-lc", req.command]

    # Per-project concurrent-exec cap. Blocks (doesn't 429) so the
    # agent's parallel-tool-call fan-out queues gracefully rather than
    # erroring out under burst. None when capping is disabled.
    sem = _get_exec_sem(project_id)
    sem_held = False
    if sem is not None:
        sem.acquire()
        sem_held = True

    started = time.perf_counter()
    timed_out = False
    try:
        # docker-py exec_run doesn't support timeout directly; use the low-level API.
        exec_create = _dockerc.api.exec_create(
            c.id, cmd=cmd, stdout=True, stderr=True, workdir=workdir, user=user, tty=False,
        )
        exec_id = exec_create["Id"]
        # exec_start with stream=False blocks until completion; pair with a
        # client-side wait loop to honour timeout.
        sock = _dockerc.api.exec_start(exec_id, detach=False, stream=True, demux=True)
        stdout_chunks: list[bytes] = []
        stderr_chunks: list[bytes] = []
        deadline = started + req.timeout_sec
        for out_chunk, err_chunk in sock:
            if out_chunk:
                stdout_chunks.append(out_chunk)
            if err_chunk:
                stderr_chunks.append(err_chunk)
            if time.perf_counter() > deadline:
                timed_out = True
                break

        info = _dockerc.api.exec_inspect(exec_id)
        exit_code = int(info.get("ExitCode") or (124 if timed_out else 0))
    except APIError as e:
        raise HTTPException(status_code=502, detail=f"docker exec: {e.explanation}")
    finally:
        if sem_held:
            sem.release()

    stdout = b"".join(stdout_chunks).decode("utf-8", "replace")
    stderr = b"".join(stderr_chunks).decode("utf-8", "replace")
    MAX = 200_000
    stdout = stdout[:MAX]
    stderr = stderr[:MAX]
    duration_ms = int((time.perf_counter() - started) * 1000)
    log.info("session_exec", project_id=project_id, exit_code=exit_code,
             duration_ms=duration_ms, timed_out=timed_out)
    return ExecResult(exit_code=exit_code, stdout=stdout, stderr=stderr,
                      duration_ms=duration_ms, timed_out=timed_out)


@app.post("/sessions/{project_id}/write_file", dependencies=[Depends(require_token)])
def session_write_file(project_id: str, req: WriteFileRequest):
    c = _require_running(project_id)
    if req.path.startswith("/") or ".." in req.path.split("/"):
        raise HTTPException(status_code=400, detail="path must be relative to /work without ..")
    raw = base64.b64decode(req.content) if req.encoding == "base64" else req.content.encode("utf-8")
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tar:
        ti = tarfile.TarInfo(name=req.path)
        ti.size = len(raw)
        ti.mode = 0o644
        tar.addfile(ti, io.BytesIO(raw))
    try:
        c.put_archive(WORKING_DIR, buf.getvalue())
    except APIError as e:
        raise HTTPException(status_code=502, detail=f"docker put_archive: {e.explanation}")
    return {"path": req.path, "size": len(raw)}


@app.get("/sessions/{project_id}/read_file", dependencies=[Depends(require_token)])
def session_read_file(project_id: str, path: str):
    c = _require_running(project_id)
    if path.startswith("/") or ".." in path.split("/"):
        raise HTTPException(status_code=400, detail="path must be relative to /work without ..")
    try:
        stream, stat = c.get_archive(f"{WORKING_DIR}/{path}")
    except docker.errors.NotFound:
        raise HTTPException(status_code=404, detail="not found")
    buf = io.BytesIO(b"".join(stream))
    buf.seek(0)
    with tarfile.open(fileobj=buf, mode="r") as tar:
        for member in tar.getmembers():
            if member.isfile():
                data = tar.extractfile(member).read()
                try:
                    return {"path": path, "encoding": "utf-8",
                            "size": len(data), "content": data.decode("utf-8")}
                except UnicodeDecodeError:
                    return {"path": path, "encoding": "base64",
                            "size": len(data),
                            "content": base64.b64encode(data).decode("ascii")}
    raise HTTPException(status_code=404, detail="empty archive")


_doc_proc: DocProcessorClient | None = None


def _doc() -> DocProcessorClient:
    """Lazy doc-processor client (one per process)."""
    global _doc_proc
    if _doc_proc is None:
        _doc_proc = DocProcessorClient()
    return _doc_proc


def _read_container_bytes(c, path: str) -> bytes:
    """Pull a single file out of the container as raw bytes via get_archive."""
    if path.startswith("/") or ".." in path.split("/"):
        raise HTTPException(status_code=400, detail="path must be relative to /work without ..")
    try:
        stream, _stat = c.get_archive(f"{WORKING_DIR}/{path}")
    except docker.errors.NotFound:
        raise HTTPException(status_code=404, detail="not found")
    buf = io.BytesIO(b"".join(stream))
    buf.seek(0)
    with tarfile.open(fileobj=buf, mode="r") as tar:
        for m in tar.getmembers():
            if m.isfile():
                return tar.extractfile(m).read()
    raise HTTPException(status_code=404, detail="empty archive")


@app.get("/sessions/{project_id}/read_artifact", dependencies=[Depends(require_token)])
async def session_read_artifact(project_id: str, path: str):
    """Type-aware container read. Returns utf-8 markdown for the CoT.

    * Text files → identical to ``read_file``.
    * Non-text (PDF, Office, image, etc.) → first try the ingest-time
      cache at ``.simorgh/extracted/<path>.md``; if missing, pull the
      raw bytes from the container and run them through doc-processor.
    """
    cls = classify(path)
    if cls == "skip":
        raise HTTPException(status_code=415,
                            detail=f"unsupported artifact type for {path!r}")
    c = _require_running(project_id)

    if cls == "text":
        body = session_read_file(project_id, path=path)
        return {**body, "artifact_class": "text", "via": "raw"}

    # 1. Pre-extracted cache?
    cache_path = extracted_path_for(path)
    try:
        cached = session_read_file(project_id, path=cache_path)
        if cached.get("encoding") == "utf-8":
            return {
                "path": path, "encoding": "utf-8",
                "size": cached.get("size", 0),
                "content": cached.get("content", ""),
                "artifact_class": cls, "via": "cache",
                "cache_path": cache_path,
            }
    except HTTPException as e:
        if e.status_code != 404:
            raise

    # 2. No cache — extract on demand.
    raw = _read_container_bytes(c, path)
    filename = path.rsplit("/", 1)[-1]
    res = await _doc().process_bytes(raw, filename=filename,
                                      user_id="runtime-broker")
    if not res.get("success"):
        raise HTTPException(status_code=502,
                            detail=f"doc-processor: {res.get('error')}")
    md = res.get("content") or ""
    return {
        "path": path, "encoding": "utf-8", "size": len(md), "content": md,
        "artifact_class": cls, "via": "doc-processor",
        "doc_type": res.get("doc_type"),
    }


# ---------------------------------------------------------------------------
# Git convenience endpoints (commit locally / push to remote-tracked simorgh branch)
# ---------------------------------------------------------------------------
class CommitRequest(BaseModel):
    message: str
    paths: list[str] = []          # empty = git add -A
    author_email: str = "simorgh-agent@local"
    author_name: str = "simorgh-agent"
    workdir: str = WORKING_DIR + "/gitlab"


class PushRequest(BaseModel):
    branch: str | None = None      # None = current branch
    workdir: str = WORKING_DIR + "/gitlab"
    remote: str = "origin"


@app.post("/sessions/{project_id}/git/commit", response_model=ExecResult,
          dependencies=[Depends(require_token)])
def session_git_commit(project_id: str, req: CommitRequest):
    add_cmd = "git add -A" if not req.paths else (
        "git add " + " ".join(shlex.quote(p) for p in req.paths)
    )
    script = (
        f"set -e\n"
        f"cd {shlex.quote(req.workdir)}\n"
        f"git config user.email {shlex.quote(req.author_email)}\n"
        f"git config user.name {shlex.quote(req.author_name)}\n"
        f"{add_cmd}\n"
        f"if git diff --cached --quiet; then echo 'no changes'; exit 0; fi\n"
        f"git commit -m {shlex.quote(req.message)}\n"
    )
    return session_exec(project_id, ExecRequest(command=script, timeout_sec=60))


@app.post("/sessions/{project_id}/git/push", response_model=ExecResult,
          dependencies=[Depends(require_token)])
def session_git_push(project_id: str, req: PushRequest):
    branch_part = shlex.quote(req.branch) if req.branch else "$(git rev-parse --abbrev-ref HEAD)"
    script = (
        f"set -e\n"
        f"cd {shlex.quote(req.workdir)}\n"
        f"git push -u {shlex.quote(req.remote)} {branch_part}\n"
    )
    return session_exec(project_id, ExecRequest(command=script, timeout_sec=180))


class CommitPushRequest(BaseModel):
    """Combined commit-then-push body. Used by the CoT after any
    workspace mutation so the simorgh branch stays in sync with the
    user's GitLab repo without needing two separate tool calls."""
    message: str
    paths: list[str] = []          # empty = git add -A
    author_email: str = "simorgh-agent@local"
    author_name: str = "simorgh-agent"
    workdir: str = WORKING_DIR + "/gitlab"
    remote: str = "origin"
    branch: str | None = None       # None = current branch
    # If True, return ok even when there are no staged changes
    # (avoids spurious failures when CoT calls this defensively).
    allow_empty: bool = False


class CommitPushResult(BaseModel):
    pushed: bool
    committed: bool
    conflict: bool = False
    commit_sha: str | None = None
    branch: str | None = None
    stdout: str = ""
    stderr: str = ""
    requires_human_review: bool = False
    exit_code: int = 0


def _parse_commit_push_output(
    stdout: str, stderr: str,
) -> tuple[bool, bool, bool, str | None, str | None]:
    """Pure parser for the commit_push script's markers.

    Returns ``(committed, pushed, conflict, commit_sha, branch)``.
    Kept in module scope so it can be unit-tested without spinning
    docker.
    """
    committed = False
    pushed = False
    commit_sha: str | None = None
    branch: str | None = None
    for line in (stdout or "").splitlines():
        if line.startswith("__SIMORGH_COMMIT__:"):
            try:
                _, sha, br = line.split(":", 2)
                committed, commit_sha, branch = True, sha, br
            except ValueError:
                committed = True
        elif line == "__SIMORGH_PUSH_OK__":
            pushed = True
        elif line == "__SIMORGH_PUSH_FAIL__":
            pushed = False

    blob = ((stdout or "") + "\n" + (stderr or "")).lower()
    conflict = False
    if not pushed and committed:
        conflict = any(t in blob for t in (
            "non-fast-forward", "fetch first", "rejected",
            "tip of your current branch is behind",
        ))
    return committed, pushed, conflict, commit_sha, branch


@app.post("/sessions/{project_id}/git/commit_push",
          response_model=CommitPushResult,
          dependencies=[Depends(require_token)])
def session_git_commit_push(project_id: str, req: CommitPushRequest):
    """Stage, commit, push — atomic from the caller's point of view.

    The script captures the resulting commit SHA, then attempts to push.
    A non-fast-forward (someone else committed to this branch first)
    surfaces as ``requires_human_review=True`` rather than an exception,
    so chat-service can route it to the user without retrying blindly.
    """
    add_cmd = "git add -A" if not req.paths else (
        "git add " + " ".join(shlex.quote(p) for p in req.paths)
    )
    branch_part = (
        shlex.quote(req.branch) if req.branch
        else "$(git rev-parse --abbrev-ref HEAD)"
    )
    empty_handler = (
        "echo '__SIMORGH_NO_CHANGES__'; exit 0\n"
        if req.allow_empty
        else "echo '__SIMORGH_NO_CHANGES__'; exit 0\n"
    )
    # Bash markers (__SIMORGH_*__) let us parse the result without
    # depending on git's locale-sensitive English output.
    script = (
        f"set -e\n"
        f"cd {shlex.quote(req.workdir)}\n"
        f"git config user.email {shlex.quote(req.author_email)}\n"
        f"git config user.name  {shlex.quote(req.author_name)}\n"
        f"{add_cmd}\n"
        f"if git diff --cached --quiet; then {empty_handler}fi\n"
        f"git commit -m {shlex.quote(req.message)}\n"
        f"SHA=$(git rev-parse HEAD)\n"
        f"BRANCH={branch_part}\n"
        f"echo \"__SIMORGH_COMMIT__:$SHA:$BRANCH\"\n"
        f"if git push -u {shlex.quote(req.remote)} \"$BRANCH\" 2>&1; then\n"
        f"  echo '__SIMORGH_PUSH_OK__'\n"
        f"else\n"
        f"  echo '__SIMORGH_PUSH_FAIL__'\n"
        f"  exit 0\n"
        f"fi\n"
    )
    result = session_exec(project_id, ExecRequest(command=script, timeout_sec=240))
    stdout = result.stdout or ""
    stderr = result.stderr or ""
    committed, pushed, conflict, commit_sha, branch = _parse_commit_push_output(stdout, stderr)
    requires_human_review = committed and not pushed

    return CommitPushResult(
        pushed=pushed, committed=committed, conflict=conflict,
        commit_sha=commit_sha, branch=branch,
        stdout=stdout, stderr=stderr,
        requires_human_review=requires_human_review,
        exit_code=result.exit_code,
    )


# ---------------------------------------------------------------------------
# Idle-TTL sweeper — stop containers that have been quiet too long.
#   - stop only (delete keeps the named volume so session_start rehydrates).
#   - skipped when IDLE_TTL_SEC <= 0.
#   - swept every IDLE_SWEEP_SEC seconds.
# ---------------------------------------------------------------------------
async def _idle_sweep_loop() -> None:
    if IDLE_STOP_SEC <= 0:
        log.info("idle_sweep_disabled")
        return
    import asyncio
    log.info("idle_sweep_started",
             stop_sec=IDLE_STOP_SEC, remove_sec=IDLE_REMOVE_SEC,
             sweep_sec=IDLE_SWEEP_SEC)
    # Two-tier sweep — handles ALL containers tagged with the
    # CONTAINER_PREFIX, including those already stopped (they may be
    # eligible for the remove tier).
    while True:
        try:
            await asyncio.sleep(IDLE_SWEEP_SEC)
            now = time.time()
            for c in _dockerc.containers.list(
                    all=True, filters={"name": CONTAINER_PREFIX}):
                if not c.name.startswith(CONTAINER_PREFIX):
                    continue
                project_id = c.name[len(CONTAINER_PREFIX):]
                last = _last_activity.get(project_id)
                if last is None:
                    # First sweep after restart — treat now as activity so
                    # we don't kill containers from the previous broker.
                    _last_activity[project_id] = now
                    continue
                idle = now - last

                # Remove tier (highest precedence): container untouched
                # long enough that even the stopped metadata isn't worth
                # keeping. Volume stays — next session_start recreates
                # the container from the image and remounts /work.
                if (IDLE_REMOVE_SEC > 0
                        and idle >= IDLE_REMOVE_SEC):
                    log.info("idle_remove", project_id=project_id,
                             idle_sec=int(idle))
                    try:
                        c.remove(force=True)
                        _last_activity.pop(project_id, None)
                        with _exec_sems_lock:
                            _exec_sems.pop(project_id, None)
                    except APIError as e:
                        log.warning("idle_remove_failed",
                                    project_id=project_id, error=str(e))
                    continue

                # Stop tier: running container that's been idle long
                # enough. After stop it stays in the docker list with
                # status="exited"; next session_start docker-starts it.
                if (c.status == "running"
                        and idle >= IDLE_STOP_SEC):
                    log.info("idle_stop", project_id=project_id,
                             idle_sec=int(idle))
                    try:
                        c.stop(timeout=10)
                    except APIError as e:
                        log.warning("idle_stop_failed",
                                    project_id=project_id, error=str(e))
        except Exception as e:
            # Don't let one sweep failure kill the loop.
            log.warning("idle_sweep_iteration_failed", error=str(e))


@app.on_event("startup")
async def _start_idle_sweeper() -> None:
    import asyncio
    app.state._idle_sweep_task = asyncio.create_task(_idle_sweep_loop())


@app.on_event("shutdown")
async def _stop_idle_sweeper() -> None:
    task = getattr(app.state, "_idle_sweep_task", None)
    if task is not None and not task.done():
        task.cancel()


# ---------------------------------------------------------------------------
# MCP — tools the CoT engine calls
# ---------------------------------------------------------------------------
mcp = FastMCP(
    "runtime-broker",
    instructions=(
        "Manage the per-project session container. Each project has one "
        "long-lived shell-runtime container with a persistent /work volume. "
        "Use session_start before exec; session_stop when idle. session_exec "
        "runs a bash command and returns stdout/stderr/exit_code."
    ),
)


@mcp.tool()
async def session_start(project_id: str) -> dict:
    """Start (or resume) the project's session container."""
    return start_session(project_id, StartRequest(project_id=project_id)).model_dump()


@mcp.tool()
async def session_stop(project_id: str) -> dict:
    """Stop the project's session container (volume is preserved)."""
    return stop_session(project_id).model_dump()


@mcp.tool()
async def session_status_tool(project_id: str) -> dict:
    """Return current status of the project's session container."""
    return session_status(project_id).model_dump()


@mcp.tool()
async def session_exec_tool(project_id: str, command: str,
                            timeout_sec: int = DEFAULT_TIMEOUT,
                            workdir: str = "") -> dict:
    """Run a shell command inside the project container. Returns exit_code, stdout, stderr."""
    return session_exec(project_id,
                        ExecRequest(command=command, timeout_sec=timeout_sec,
                                    workdir=workdir or None)).model_dump()


@mcp.tool()
async def session_write_file_tool(project_id: str, path: str, content: str) -> dict:
    """Write a utf-8 file into the project container's /work directory."""
    return session_write_file(project_id, WriteFileRequest(path=path, content=content))


@mcp.tool()
async def session_read_file_tool(project_id: str, path: str) -> dict:
    """Read a file from the project container's /work directory."""
    return session_read_file(project_id, path=path)


@mcp.tool()
async def session_read_artifact_tool(project_id: str, path: str) -> dict:
    """Type-aware file read for the CoT. Prefer this over read_file.

    Always returns utf-8 markdown — text files are returned raw; PDFs,
    Office docs, and images come from the ingest-time extraction cache
    (``.simorgh/extracted/<path>.md``) if present, otherwise are
    extracted on demand via doc-processor.
    """
    return await session_read_artifact(project_id, path=path)


@mcp.tool()
async def session_git_commit_tool(project_id: str, message: str,
                                  paths: list[str] | None = None) -> dict:
    """Stage and commit changes locally inside the cloned gitlab repo."""
    return session_git_commit(project_id, CommitRequest(message=message,
                                                        paths=paths or [])).model_dump()


@mcp.tool()
async def session_git_push_tool(project_id: str, branch: str = "") -> dict:
    """Push the simorgh working branch to the user's GitLab repo."""
    return session_git_push(project_id, PushRequest(branch=branch or None)).model_dump()


@mcp.tool()
async def session_git_commit_push_tool(
    project_id: str, message: str,
    paths: list[str] | None = None, branch: str = "",
    allow_empty: bool = False,
) -> dict:
    """Stage, commit, and push the workspace in one call.

    Prefer this over the separate commit/push tools whenever CoT
    mutates the workspace — it surfaces remote conflicts as a
    structured ``requires_human_review`` flag instead of an exception,
    so the chat-service can route the divergence back to the user.
    """
    return session_git_commit_push(
        project_id,
        CommitPushRequest(
            message=message, paths=paths or [],
            branch=branch or None, allow_empty=allow_empty,
        ),
    ).model_dump()


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
