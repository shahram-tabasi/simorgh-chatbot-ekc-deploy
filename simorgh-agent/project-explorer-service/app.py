"""
project-explorer-service
========================
Two-phase project exploration agent, modelled loosely on Claude Code's
project-onboarding pass. Result is stored in Redis (hot path for the CoT
engine) and mirrored to Postgres via chat-service when phase-2 completes.

Phase 1 — remote, fast (~seconds)
    Uses gitlab-mcp /tree + /file to fetch:
      - top-level file/dir listing
      - README.md + package.json / pyproject.toml / requirements.txt /
        Cargo.toml / pom.xml / go.mod / docker-compose.yml / Makefile
        (whichever exist)
    Produces a one-page summary written to redis key
        project:{id}:exploration  (phase=remote)
    so the CoT can start answering basic "what is this repo?" questions
    immediately after project creation.

Phase 2 — container, deep
    Execs inside the project's runtime-broker session container:
      - `git ls-files | head -N` for the indexed file list
      - language statistics (counts by extension)
      - entry-point heuristics (main.py / index.js / cmd/*/main.go ...)
      - directory tree (capped depth)
    Overwrites the redis key with phase=container and persists the full
    structured index.
"""
import json
import os
from collections import Counter
from datetime import datetime, timezone
from typing import Any

import httpx
import redis.asyncio as aioredis
from fastapi import BackgroundTasks, FastAPI, HTTPException
from mcp.server.fastmcp import FastMCP
from pydantic import BaseModel, Field

from simorgh_logging import configure, get_logger, request_id_middleware

configure(service="project-explorer")
log = get_logger(__name__)

GITLAB_MCP_URL     = os.getenv("GITLAB_MCP_URL",     "http://gitlab-mcp:8047")
RUNTIME_BROKER_URL = os.getenv("RUNTIME_BROKER_URL", "http://runtime-broker:8048")
REDIS_URL          = os.getenv("REDIS_URL",          "redis://redis:6379/5")
BROKER_TOKEN       = os.getenv("BROKER_TOKEN",       "")

# Files we always try to read in the remote phase (in priority order).
REMOTE_PROBE_FILES = [
    "README.md", "README.rst", "README",
    "package.json", "pyproject.toml", "requirements.txt", "setup.py",
    "Cargo.toml", "go.mod", "pom.xml", "build.gradle",
    "docker-compose.yml", "docker-compose.yaml",
    "Makefile", "Dockerfile",
    ".gitlab-ci.yml", ".github/workflows/ci.yml",
]
REMOTE_PROBE_BYTES = 8 * 1024     # cap each remote read at 8 KiB for summary

app = FastAPI(title="project-explorer", version="0.1.0")
app.middleware("http")(request_id_middleware)

_redis: aioredis.Redis | None = None


async def _r() -> aioredis.Redis:
    global _redis
    if _redis is None:
        _redis = aioredis.from_url(REDIS_URL, decode_responses=True)
    return _redis


def _broker_headers() -> dict[str, str]:
    return {"authorization": f"Bearer {BROKER_TOKEN}"} if BROKER_TOKEN else {}


class ExploreRequest(BaseModel):
    project_id: str
    gitlab_repo_path: str | None = None     # 'group/repo'
    gitlab_base_branch: str | None = None
    simorgh_branch: str | None = None
    use_container: bool = True


class ExploreState(BaseModel):
    project_id: str
    phase: str = "pending"
    remote_summary: str | None = None
    container_summary: str | None = None
    file_index: list[str] = Field(default_factory=list)
    language_stats: dict[str, int] = Field(default_factory=dict)
    entry_points: list[str] = Field(default_factory=list)
    error: str | None = None
    updated_at: str | None = None


async def _save(state: ExploreState) -> None:
    state.updated_at = datetime.now(timezone.utc).isoformat()
    r = await _r()
    await r.set(
        f"project:{state.project_id}:exploration",
        state.model_dump_json(),
        ex=60 * 60 * 24 * 30,   # 30d
    )


# ---------------------------------------------------------------------------
# Phase 1: remote via gitlab-mcp
# ---------------------------------------------------------------------------
async def _phase_remote(state: ExploreState, repo_path: str,
                        ref: str | None) -> None:
    async with httpx.AsyncClient(timeout=60) as client:
        # Tree at root.
        try:
            tr = await client.get(f"{GITLAB_MCP_URL}/tree",
                                  params={"project": repo_path,
                                          "ref": ref or "main",
                                          "recursive": "false",
                                          "per_page": 200})
            tr.raise_for_status()
            entries = tr.json().get("entries", [])
        except httpx.HTTPError as e:
            state.error = f"tree failed: {e}"
            state.phase = "failed"
            await _save(state)
            return

        names = [e.get("name") for e in entries if e.get("name")]
        top_summary_lines = [f"# Project remote summary",
                             f"Repo: `{repo_path}`",
                             f"Ref: `{ref or 'main'}`",
                             "",
                             f"## Top-level entries ({len(entries)})"]
        top_summary_lines.extend(f"- {n}" for n in sorted(names)[:80])

        # Probe known files.
        probes: list[str] = []
        for path in REMOTE_PROBE_FILES:
            if path.split("/")[0] not in names and "/" not in path:
                continue
            try:
                fr = await client.get(f"{GITLAB_MCP_URL}/file",
                                      params={"project": repo_path,
                                              "path": path,
                                              "ref": ref or "main"})
                if fr.status_code != 200:
                    continue
                body = fr.json()
                if body.get("encoding") != "utf-8":
                    continue
                content = (body.get("content") or "")[:REMOTE_PROBE_BYTES]
                probes.append(f"\n## `{path}`\n```\n{content}\n```\n")
            except httpx.HTTPError:
                continue

        summary = "\n".join(top_summary_lines) + "\n" + "".join(probes)
        state.remote_summary = summary
        state.phase = "remote"
        await _save(state)


# ---------------------------------------------------------------------------
# Phase 2: container deep walk
# ---------------------------------------------------------------------------
async def _phase_container(state: ExploreState) -> None:
    async with httpx.AsyncClient(timeout=300) as client:
        async def _exec(cmd: str, timeout: int = 60) -> dict[str, Any]:
            r = await client.post(
                f"{RUNTIME_BROKER_URL}/sessions/{state.project_id}/exec",
                json={"command": cmd, "timeout_sec": timeout},
                headers=_broker_headers(),
            )
            r.raise_for_status()
            return r.json()

        try:
            # Determine which working subdir holds the user repo. Fall back
            # to /work if gitlab/ isn't present (upload-only or ekc-only).
            res = await _exec(
                "for d in /work/gitlab /work; do "
                "  if [ -d \"$d/.git\" ] || [ -d \"$d\" ]; then echo \"$d\"; exit 0; fi; "
                "done"
            )
            base = (res.get("stdout") or "/work").splitlines()[0].strip() or "/work"

            # File index (capped).
            res = await _exec(
                f"cd {base} && "
                f"( git ls-files 2>/dev/null | head -2000 || "
                f"  find . -type f -not -path '*/.git/*' | head -2000 )"
            )
            files = [f for f in (res.get("stdout") or "").splitlines() if f]
            state.file_index = files[:2000]

            # Language stats by extension.
            ext_counts: Counter[str] = Counter()
            for f in state.file_index:
                if "." in f.rsplit("/", 1)[-1]:
                    ext_counts[f.rsplit(".", 1)[-1].lower()] += 1
            state.language_stats = dict(ext_counts.most_common(20))

            # Entry-point heuristics.
            candidates = [
                "main.py", "app.py", "manage.py", "wsgi.py", "asgi.py",
                "index.js", "index.ts", "server.js", "server.ts",
                "main.go", "main.rs", "Main.java", "Program.cs",
            ]
            state.entry_points = [f for f in state.file_index
                                   if f.split("/")[-1] in candidates][:20]

            # Top-level dir summary.
            res = await _exec(
                f"cd {base} && (tree -L 2 -I '.git|node_modules|__pycache__|.venv' "
                f"|| ls -la)"
            )
            tree_text = (res.get("stdout") or "")[:8000]

            state.container_summary = (
                f"# Project deep summary\n"
                f"Workdir: `{base}`\n"
                f"Files indexed: {len(state.file_index)}\n\n"
                f"## Language distribution\n"
                + "\n".join(f"- .{k}: {v}" for k, v in state.language_stats.items())
                + f"\n\n## Entry points\n"
                + "\n".join(f"- {p}" for p in state.entry_points)
                + f"\n\n## Tree\n```\n{tree_text}\n```\n"
            )
            state.phase = "done"
        except httpx.HTTPError as e:
            state.error = f"container phase failed: {e}"
            state.phase = "failed"
        await _save(state)


# ---------------------------------------------------------------------------
# REST surface
# ---------------------------------------------------------------------------
@app.get("/health")
def health():
    return {"status": "ok", "service": "project-explorer", "version": "0.1.0"}


@app.post("/explore")
async def explore(req: ExploreRequest, background_tasks: BackgroundTasks):
    state = ExploreState(project_id=req.project_id, phase="pending")
    await _save(state)

    if req.gitlab_repo_path:
        await _phase_remote(state, req.gitlab_repo_path, req.gitlab_base_branch)
    else:
        # Nothing to probe remotely; jump straight to container.
        state.remote_summary = "(no gitlab repo selected — skipping remote phase)"
        state.phase = "remote"
        await _save(state)

    if req.use_container:
        background_tasks.add_task(_phase_container, state)

    return {"project_id": req.project_id, "phase": state.phase}


@app.get("/state/{project_id}")
async def get_state(project_id: str):
    r = await _r()
    raw = await r.get(f"project:{project_id}:exploration")
    if not raw:
        raise HTTPException(status_code=404, detail="no exploration state")
    return json.loads(raw)


# ---------------------------------------------------------------------------
# MCP
# ---------------------------------------------------------------------------
mcp = FastMCP(
    "project-explorer",
    instructions=(
        "Inspect a freshly initialised project. Two-phase: phase-1 reads "
        "the GitLab repo remotely for a fast summary; phase-2 walks the "
        "container's working dir for a deep index. The CoT engine reads "
        "the result from Redis key `project:{id}:exploration`."
    ),
)


@mcp.tool()
async def explore_tool(project_id: str,
                       gitlab_repo_path: str = "",
                       gitlab_base_branch: str = "",
                       use_container: bool = True) -> dict:
    """Trigger exploration. Returns state once phase-1 has completed."""
    req = ExploreRequest(
        project_id=project_id,
        gitlab_repo_path=gitlab_repo_path or None,
        gitlab_base_branch=gitlab_base_branch or None,
        use_container=use_container,
    )
    state = ExploreState(project_id=project_id, phase="pending")
    await _save(state)
    if req.gitlab_repo_path:
        await _phase_remote(state, req.gitlab_repo_path, req.gitlab_base_branch)
    if use_container:
        await _phase_container(state)
    return state.model_dump()


@mcp.tool()
async def get_exploration(project_id: str) -> dict:
    """Read the latest exploration state for a project from Redis."""
    r = await _r()
    raw = await r.get(f"project:{project_id}:exploration")
    return json.loads(raw) if raw else {"project_id": project_id, "phase": "absent"}


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
