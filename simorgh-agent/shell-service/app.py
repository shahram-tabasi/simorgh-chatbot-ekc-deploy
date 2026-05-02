"""
Shell Service - Sandboxed Command Execution with Git
=====================================================
REST API for executing shell commands and git operations
in isolated project workspaces.

Deployed on 192.168.1.69, accessed by central server (1.68).
"""

import asyncio
import logging
import os
import shutil
import tarfile
import tempfile
import time
from datetime import datetime
from pathlib import Path
from typing import Optional, List, Dict, Any

from fastapi import FastAPI, HTTPException, Header, Depends, UploadFile, File, Form
from pydantic import BaseModel, Field

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Simorgh Shell Service", version="1.0.0")

# Configuration
WORKSPACE_ROOT = Path(os.getenv("WORKSPACE_ROOT", "/workspace"))
AUTH_TOKEN = os.getenv("SHELL_SERVICE_TOKEN", "")
MAX_OUTPUT_SIZE = int(os.getenv("MAX_OUTPUT_SIZE", "100000"))  # 100KB
DEFAULT_TIMEOUT = int(os.getenv("DEFAULT_TIMEOUT", "30"))

# Command denylist for safety
DENIED_COMMANDS = [
    "rm -rf /", "rm -rf /*", "mkfs", "dd if=", ":(){", "fork bomb",
    "shutdown", "reboot", "halt", "poweroff", "init 0", "init 6",
    "chmod -R 777 /", "chown -R",
]


# =============================================================================
# AUTH
# =============================================================================

async def verify_token(authorization: Optional[str] = Header(None)):
    """Verify API token."""
    if not AUTH_TOKEN:
        return  # No auth configured (development mode)
    if not authorization:
        raise HTTPException(status_code=401, detail="Missing authorization header")
    token = authorization.replace("Bearer ", "")
    if token != AUTH_TOKEN:
        raise HTTPException(status_code=403, detail="Invalid token")


# =============================================================================
# MODELS
# =============================================================================

class ExecRequest(BaseModel):
    project_id: str
    command: str = Field(..., min_length=1, max_length=5000)
    working_dir: Optional[str] = None
    timeout: int = Field(DEFAULT_TIMEOUT, ge=1, le=300)
    environment: Optional[Dict[str, str]] = None


class ExecResponse(BaseModel):
    exit_code: int
    stdout: str
    stderr: str
    duration_ms: int
    command: str
    working_dir: str


class GitInitRequest(BaseModel):
    project_id: str


class GitCommitRequest(BaseModel):
    project_id: str
    message: str = Field(..., min_length=1, max_length=500)
    files: Optional[List[str]] = None


class GitLogRequest(BaseModel):
    project_id: str
    limit: int = Field(20, ge=1, le=100)


class FileWriteRequest(BaseModel):
    project_id: str
    path: str = Field(..., min_length=1)
    content: str
    create_dirs: bool = True


class FileReadRequest(BaseModel):
    project_id: str
    path: str = Field(..., min_length=1)


class FileListRequest(BaseModel):
    project_id: str
    path: str = "."
    recursive: bool = False


# =============================================================================
# HELPERS
# =============================================================================

def get_project_dir(project_id: str) -> Path:
    """Get the workspace directory for a project."""
    # Sanitize project_id to prevent path traversal
    safe_id = "".join(c for c in project_id if c.isalnum() or c in "-_")
    if not safe_id:
        raise HTTPException(status_code=400, detail="Invalid project_id")
    return WORKSPACE_ROOT / safe_id


# Project workspace standard layout — every project on this machine has
# these subdirs created at init time. Some are populated only when their
# corresponding source was selected during project-creation precheck.
PROJECT_SUBDIRS = (
    "techserver",       # clone of \\techserver\<oenum> (source-gated)
    "tpms",             # JSON dump of TPMS tables for this oenum (source-gated)
    "tech-knowledge",   # snapshot of tech-knowledge git main HEAD (source-gated)
    "uploads",          # user-uploaded files
    "instructions",     # per-project instructions + restrictions
    "emails",           # archived inbound + outbound .eml files
    "logs",             # agent / cot / task execution logs
    "notes",            # deviations, conflict resolutions
)

# Where soft-archived projects go on DELETE.
ARCHIVE_ROOT = Path(os.getenv("ARCHIVE_ROOT", str(WORKSPACE_ROOT.parent / "projects-archived")))


def _safe_subdir(project_dir: Path, subdir: str) -> Path:
    """Resolve a subdir path inside the project, blocking path traversal."""
    if not subdir or subdir.startswith("/") or ".." in subdir.split("/"):
        raise HTTPException(status_code=400, detail=f"Invalid subdir: {subdir!r}")
    target = (project_dir / subdir).resolve()
    if not str(target).startswith(str(project_dir.resolve())):
        raise HTTPException(status_code=400, detail="path traversal blocked")
    return target


def validate_command(command: str) -> None:
    """Check command against denylist."""
    cmd_lower = command.lower().strip()
    for denied in DENIED_COMMANDS:
        if denied in cmd_lower:
            raise HTTPException(
                status_code=403,
                detail=f"Command denied for safety: contains '{denied}'"
            )


async def run_command(
    command: str,
    cwd: Path,
    timeout: int = DEFAULT_TIMEOUT,
    env: Optional[Dict[str, str]] = None,
) -> ExecResponse:
    """Execute a command and capture output."""
    start = time.monotonic()

    # Merge environment
    full_env = os.environ.copy()
    if env:
        full_env.update(env)

    try:
        proc = await asyncio.create_subprocess_shell(
            command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(cwd),
            env=full_env,
        )

        stdout, stderr = await asyncio.wait_for(
            proc.communicate(), timeout=timeout
        )

        duration_ms = int((time.monotonic() - start) * 1000)

        # Truncate output if too large
        stdout_str = stdout.decode("utf-8", errors="replace")[:MAX_OUTPUT_SIZE]
        stderr_str = stderr.decode("utf-8", errors="replace")[:MAX_OUTPUT_SIZE]

        return ExecResponse(
            exit_code=proc.returncode or 0,
            stdout=stdout_str,
            stderr=stderr_str,
            duration_ms=duration_ms,
            command=command,
            working_dir=str(cwd),
        )

    except asyncio.TimeoutError:
        duration_ms = int((time.monotonic() - start) * 1000)
        return ExecResponse(
            exit_code=-1,
            stdout="",
            stderr=f"Command timed out after {timeout}s",
            duration_ms=duration_ms,
            command=command,
            working_dir=str(cwd),
        )


# =============================================================================
# ROUTES
# =============================================================================

@app.get("/health")
async def health():
    return {"status": "ok", "workspace": str(WORKSPACE_ROOT)}


@app.post("/exec", response_model=ExecResponse)
async def exec_command(req: ExecRequest, _=Depends(verify_token)):
    """Execute a shell command in a project workspace."""
    validate_command(req.command)

    project_dir = get_project_dir(req.project_id)
    if not project_dir.exists():
        project_dir.mkdir(parents=True, exist_ok=True)

    # Resolve working directory
    if req.working_dir:
        work_dir = project_dir / req.working_dir
        # Prevent path traversal
        if not str(work_dir.resolve()).startswith(str(project_dir.resolve())):
            raise HTTPException(status_code=403, detail="Path traversal denied")
    else:
        work_dir = project_dir

    work_dir.mkdir(parents=True, exist_ok=True)

    logger.info(f"Exec [{req.project_id}]: {req.command[:100]}")
    return await run_command(req.command, work_dir, req.timeout, req.environment)


@app.post("/git/init")
async def git_init(req: GitInitRequest, _=Depends(verify_token)):
    """Initialize a git repo for a project."""
    project_dir = get_project_dir(req.project_id)
    project_dir.mkdir(parents=True, exist_ok=True)

    git_dir = project_dir / ".git"
    if git_dir.exists():
        return {"status": "already_initialized", "path": str(project_dir)}

    result = await run_command("git init", project_dir)
    if result.exit_code != 0:
        raise HTTPException(status_code=500, detail=f"git init failed: {result.stderr}")

    # Create initial .gitignore
    gitignore = project_dir / ".gitignore"
    gitignore.write_text("__pycache__/\n*.pyc\n.env\n.DS_Store\nnode_modules/\n")

    # Initial commit
    await run_command("git add .gitignore", project_dir)
    await run_command('git commit -m "Initial project setup"', project_dir)

    return {"status": "initialized", "path": str(project_dir)}


# ---------------------------------------------------------------------------
# WORKSPACE LIFECYCLE — init / upload / archive
# Used by project-agent-service during project creation + deletion.
# ---------------------------------------------------------------------------
class WorkspaceInitRequest(BaseModel):
    project_id: str
    project_name: Optional[str] = None
    sources: List[str] = []  # informational only — used to seed README


@app.post("/workspace/init")
async def workspace_init(req: WorkspaceInitRequest, _=Depends(verify_token)):
    """
    Create the canonical project layout under ~/projects/<project_id>/:
      techserver/  tpms/  tech-knowledge/  uploads/  instructions/
      emails/      logs/  notes/

    Idempotent — re-running on an existing workspace is a no-op for
    already-present dirs. Initialises git if not present and makes a
    first commit covering the empty subdirs (each gets a .gitkeep).
    """
    project_dir = get_project_dir(req.project_id)
    project_dir.mkdir(parents=True, exist_ok=True)

    created = []
    for sub in PROJECT_SUBDIRS:
        d = project_dir / sub
        if not d.exists():
            d.mkdir(parents=True)
            (d / ".gitkeep").write_text("")
            created.append(sub)

    # README so users SCPing in see what each dir is for.
    readme = project_dir / "README.md"
    if not readme.exists():
        readme.write_text(
            f"# {req.project_name or req.project_id}\n\n"
            "Project workspace. Standard layout:\n\n"
            "* `techserver/`       — clone of \\\\techserver\\<oenum> (if source enabled)\n"
            "* `tpms/`             — JSON dump of TPMS tables (if source enabled)\n"
            "* `tech-knowledge/`   — snapshot of tech-knowledge `main` HEAD\n"
            "* `uploads/`          — user uploads via chat or email\n"
            "* `instructions/`     — per-project instructions + restrictions\n"
            "* `emails/`           — archived inbound + outbound emails\n"
            "* `logs/`             — agent / cot / task execution logs\n"
            "* `notes/`            — deviations, conflict resolutions\n\n"
            f"Sources enabled at creation: {', '.join(req.sources) or '(none)'}\n"
        )

    # Init git if needed.
    if not (project_dir / ".git").exists():
        await run_command("git init", project_dir)
        (project_dir / ".gitignore").write_text(
            "__pycache__/\n*.pyc\n.env\n.DS_Store\nnode_modules/\n"
        )
        # Configure a local identity so commits work even if no global
        # git config is set in the container.
        await run_command('git config user.email "agent@simorgh.local"', project_dir)
        await run_command('git config user.name  "Simorgh Project Agent"', project_dir)
        await run_command("git add -A", project_dir)
        await run_command(
            'git commit -m "chore: init project workspace"', project_dir,
        )

    return {
        "status": "ok",
        "path": str(project_dir),
        "subdirs_created": created,
        "subdirs_present": list(PROJECT_SUBDIRS),
    }


class WorkspaceWriteRequest(BaseModel):
    project_id: str
    path: str           # path inside the project, e.g. "tpms/projects.json"
    content: str        # text content (utf-8)
    commit_message: Optional[str] = None  # if set, git-commit after write


@app.post("/workspace/write")
async def workspace_write(req: WorkspaceWriteRequest, _=Depends(verify_token)):
    """
    Write a single text file inside the project workspace. For binary or
    large content use /workspace/upload-tarball instead.
    """
    project_dir = get_project_dir(req.project_id)
    if not project_dir.exists():
        raise HTTPException(status_code=404, detail="project workspace not found")
    target = _safe_subdir(project_dir, req.path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(req.content, encoding="utf-8")

    if req.commit_message and (project_dir / ".git").exists():
        # Quote the message safely.
        safe_msg = req.commit_message.replace('"', "'")
        await run_command(f"git add {req.path}", project_dir)
        await run_command(f'git commit -m "{safe_msg}"', project_dir)

    return {"status": "ok", "path": str(target), "bytes": len(req.content)}


@app.post("/workspace/upload-tarball")
async def workspace_upload_tarball(
    project_id: str = Form(...),
    subdir: str = Form(...),
    commit_message: Optional[str] = Form(None),
    file: UploadFile = File(...),
    _=Depends(verify_token),
):
    """
    Receive a tar/tar.gz archive and untar it into <project>/<subdir>/.
    Used by the techserver-service /clone-to-shell flow and by the
    tech-kb-service snapshot import.

    The subdir is wiped first (clean install). Outside the tarball, the
    rest of the workspace is left alone.
    """
    project_dir = get_project_dir(project_id)
    if not project_dir.exists():
        raise HTTPException(status_code=404, detail="project workspace not found")

    target = _safe_subdir(project_dir, subdir)

    # Save tarball to a temp file so tarfile can stream from disk.
    with tempfile.NamedTemporaryFile(delete=False, suffix=".tar") as tmp:
        try:
            while True:
                chunk = await file.read(1 << 20)  # 1 MiB
                if not chunk:
                    break
                tmp.write(chunk)
            tmp_path = Path(tmp.name)
        except Exception:
            tmp.close()
            os.unlink(tmp.name)
            raise

    # Wipe the existing subdir so this is a clean install.
    if target.exists():
        shutil.rmtree(target)
    target.mkdir(parents=True)

    try:
        with tarfile.open(tmp_path, "r:*") as tf:
            # Defensive extraction: refuse absolute paths or .. in members.
            for m in tf.getmembers():
                if m.name.startswith("/") or ".." in m.name.split("/"):
                    raise HTTPException(status_code=400,
                                        detail=f"unsafe tarball entry: {m.name!r}")
            tf.extractall(target)
    finally:
        os.unlink(tmp_path)

    if commit_message and (project_dir / ".git").exists():
        await run_command(f"git add {subdir}", project_dir)
        await run_command(f'git commit -m "{commit_message}"', project_dir)

    return {"status": "ok", "path": str(target)}


class WorkspaceArchiveRequest(BaseModel):
    project_id: str


@app.post("/workspace/archive")
async def workspace_archive(req: WorkspaceArchiveRequest, _=Depends(verify_token)):
    """
    Soft-archive the project workspace by moving it to ARCHIVE_ROOT.
    Called by project-agent-service on DELETE /projects/{id}.
    Workspace can be restored manually by `mv` back if needed.
    """
    project_dir = get_project_dir(req.project_id)
    if not project_dir.exists():
        return {"status": "noop", "reason": "workspace did not exist"}

    ARCHIVE_ROOT.mkdir(parents=True, exist_ok=True)
    safe_id = "".join(c for c in req.project_id if c.isalnum() or c in "-_")
    timestamp = datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
    dest = ARCHIVE_ROOT / f"{safe_id}.{timestamp}"
    shutil.move(str(project_dir), str(dest))
    return {"status": "archived", "from": str(project_dir), "to": str(dest)}


@app.post("/git/commit")
async def git_commit(req: GitCommitRequest, _=Depends(verify_token)):
    """Create a git commit in project workspace."""
    project_dir = get_project_dir(req.project_id)
    if not (project_dir / ".git").exists():
        raise HTTPException(status_code=400, detail="Git not initialized. Call /git/init first.")

    # Stage files
    if req.files:
        for f in req.files:
            result = await run_command(f"git add {f}", project_dir)
            if result.exit_code != 0:
                logger.warning(f"git add {f} failed: {result.stderr}")
    else:
        await run_command("git add -A", project_dir)

    # Check if there are changes to commit
    status = await run_command("git status --porcelain", project_dir)
    if not status.stdout.strip():
        return {"status": "nothing_to_commit", "commit_hash": None}

    # Commit
    safe_msg = req.message.replace('"', '\\"')
    result = await run_command(f'git commit -m "{safe_msg}"', project_dir)
    if result.exit_code != 0:
        raise HTTPException(status_code=500, detail=f"git commit failed: {result.stderr}")

    # Get commit hash
    hash_result = await run_command("git rev-parse HEAD", project_dir)
    commit_hash = hash_result.stdout.strip()

    # Get changed files
    diff_result = await run_command("git diff-tree --no-commit-id --name-only -r HEAD", project_dir)
    files_changed = [f for f in diff_result.stdout.strip().split("\n") if f]

    return {
        "status": "committed",
        "commit_hash": commit_hash,
        "message": req.message,
        "files_changed": files_changed,
        "timestamp": datetime.utcnow().isoformat(),
    }


@app.post("/git/log")
async def git_log(req: GitLogRequest, _=Depends(verify_token)):
    """Get git log for a project."""
    project_dir = get_project_dir(req.project_id)
    if not (project_dir / ".git").exists():
        raise HTTPException(status_code=400, detail="Git not initialized")

    result = await run_command(
        f'git log --format="%H|%s|%ai|%an" -n {req.limit}',
        project_dir,
    )

    commits = []
    for line in result.stdout.strip().split("\n"):
        if "|" in line:
            parts = line.split("|", 3)
            if len(parts) >= 3:
                commits.append({
                    "hash": parts[0],
                    "message": parts[1],
                    "date": parts[2],
                    "author": parts[3] if len(parts) > 3 else "agent",
                })

    return {"commits": commits, "total": len(commits)}


@app.post("/git/diff")
async def git_diff(req: GitInitRequest, _=Depends(verify_token)):
    """Get git diff for a project."""
    project_dir = get_project_dir(req.project_id)
    if not (project_dir / ".git").exists():
        raise HTTPException(status_code=400, detail="Git not initialized")

    result = await run_command("git diff", project_dir)
    staged = await run_command("git diff --cached", project_dir)

    return {
        "unstaged": result.stdout,
        "staged": staged.stdout,
    }


@app.post("/file/write")
async def file_write(req: FileWriteRequest, _=Depends(verify_token)):
    """Write a file in project workspace."""
    project_dir = get_project_dir(req.project_id)
    file_path = project_dir / req.path

    # Prevent path traversal
    if not str(file_path.resolve()).startswith(str(project_dir.resolve())):
        raise HTTPException(status_code=403, detail="Path traversal denied")

    if req.create_dirs:
        file_path.parent.mkdir(parents=True, exist_ok=True)

    file_path.write_text(req.content, encoding="utf-8")
    return {"status": "written", "path": req.path, "size": len(req.content)}


@app.post("/file/read")
async def file_read(req: FileReadRequest, _=Depends(verify_token)):
    """Read a file from project workspace."""
    project_dir = get_project_dir(req.project_id)
    file_path = project_dir / req.path

    if not str(file_path.resolve()).startswith(str(project_dir.resolve())):
        raise HTTPException(status_code=403, detail="Path traversal denied")

    if not file_path.exists():
        raise HTTPException(status_code=404, detail=f"File not found: {req.path}")

    content = file_path.read_text(encoding="utf-8", errors="replace")
    if len(content) > MAX_OUTPUT_SIZE:
        content = content[:MAX_OUTPUT_SIZE] + "\n... (truncated)"

    return {"path": req.path, "content": content, "size": file_path.stat().st_size}


@app.post("/file/list")
async def file_list(req: FileListRequest, _=Depends(verify_token)):
    """List files in project workspace."""
    project_dir = get_project_dir(req.project_id)
    target = project_dir / req.path

    if not str(target.resolve()).startswith(str(project_dir.resolve())):
        raise HTTPException(status_code=403, detail="Path traversal denied")

    if not target.exists():
        raise HTTPException(status_code=404, detail=f"Path not found: {req.path}")

    files = []
    if req.recursive:
        for p in sorted(target.rglob("*")):
            if ".git" in p.parts:
                continue
            rel = p.relative_to(project_dir)
            files.append({
                "path": str(rel),
                "is_dir": p.is_dir(),
                "size": p.stat().st_size if p.is_file() else 0,
            })
    else:
        for p in sorted(target.iterdir()):
            if p.name == ".git":
                continue
            rel = p.relative_to(project_dir)
            files.append({
                "path": str(rel),
                "is_dir": p.is_dir(),
                "size": p.stat().st_size if p.is_file() else 0,
            })

    return {"path": req.path, "files": files, "total": len(files)}


@app.delete("/project/{project_id}")
async def delete_project(project_id: str, _=Depends(verify_token)):
    """Delete a project workspace."""
    project_dir = get_project_dir(project_id)
    if project_dir.exists():
        shutil.rmtree(project_dir)
        return {"status": "deleted", "project_id": project_id}
    return {"status": "not_found", "project_id": project_id}
