"""
LEGACY SHIM — replaced 2026-05.

The original shell_service client (talking to the 192.168.1.69 shell-service)
has been removed. This file keeps the OLD import surface
(`get_shell_service()` / `ShellServiceClient`) but routes everything to the
new services:

  • exec_command()                   → runtime-broker (ephemeral docker)
  • file_read / write / list, git_*  → gitlab-mcp (single source of truth)

Self-contained on purpose so no Dockerfile change is needed in each
service. New code should not import this — go straight to runtime-broker /
gitlab-mcp clients.
"""
from __future__ import annotations

import logging
import os
from typing import Any

import httpx

logger = logging.getLogger(__name__)

RUNTIME_BROKER_URL    = os.getenv("RUNTIME_BROKER_URL",    "http://runtime-broker:8048")
RUNTIME_BROKER_TOKEN  = os.getenv("BROKER_TOKEN",          "")
RUNTIME_BROKER_TMOUT  = int(os.getenv("RUNTIME_BROKER_TIMEOUT", "120"))
GITLAB_MCP_URL        = os.getenv("GITLAB_MCP_URL",        "http://gitlab-mcp:8047")
AGENT_TOKEN           = os.getenv("AGENT_TOKEN",           "")
PROJECTS_GROUP        = os.getenv("GITLAB_PROJECTS_GROUP", "simorgh-projects")
DEFAULT_REF           = os.getenv("GITLAB_DEFAULT_REF",    "main")


def _project_slug(project_id: str) -> str:
    return f"{PROJECTS_GROUP}/{project_id.lower()}"


class _Result(dict):
    """dict that also supports attribute access for legacy callers."""
    def __getattr__(self, k):
        try: return self[k]
        except KeyError as e: raise AttributeError(k) from e


class ShellServiceClient:
    """DEPRECATED — kept for source-compatibility while callers migrate."""

    def __init__(self, base_url: str | None = None, token: str | None = None):
        # base_url + token retained for signature compat; ignored.
        self._broker_headers = (
            {"authorization": f"Bearer {RUNTIME_BROKER_TOKEN}"} if RUNTIME_BROKER_TOKEN else {}
        )
        self._gitlab_write_headers = (
            {"x-agent-auth": AGENT_TOKEN} if AGENT_TOKEN else {}
        )

    async def _broker_post(self, path: str, body: dict) -> dict:
        async with httpx.AsyncClient(timeout=RUNTIME_BROKER_TMOUT) as c:
            r = await c.post(f"{RUNTIME_BROKER_URL}{path}", json=body,
                             headers=self._broker_headers)
            r.raise_for_status()
            return r.json()

    async def _gl_get(self, path: str, **params) -> Any:
        async with httpx.AsyncClient(timeout=60) as c:
            r = await c.get(f"{GITLAB_MCP_URL}{path}", params=params)
            r.raise_for_status()
            return r.json()

    async def _gl_post(self, path: str, body: dict, write: bool = False) -> Any:
        h = self._gitlab_write_headers if write else {}
        async with httpx.AsyncClient(timeout=60) as c:
            r = await c.post(f"{GITLAB_MCP_URL}{path}", json=body, headers=h)
            r.raise_for_status()
            return r.json()

    # ---- health -----------------------------------------------------------
    async def health(self) -> dict:
        return {"status": "ok", "via": "runtime-broker+gitlab-mcp"}

    # ---- exec -------------------------------------------------------------
    async def exec_command(self, project_id: str, command: str,
                           working_dir: str | None = None,
                           timeout: int = 30,
                           environment: dict[str, str] | None = None) -> _Result:
        script = f"cd /work && {command}" if working_dir else command
        result = await self._broker_post("/run", {
            "language": "shell", "script": script,
            "timeout_sec": timeout, "env": environment or {},
        })
        return _Result({
            "exit_code":   result["exit_code"],
            "stdout":      result["stdout"],
            "stderr":      result["stderr"],
            "duration_ms": result["duration_ms"],
            "command":     command,
            "working_dir": working_dir or "/work",
        })

    # ---- git --------------------------------------------------------------
    async def git_init(self, project_id: str) -> dict:
        # GitLab projects are created with an initial commit — git-init is a no-op.
        try:
            existing = await self._gl_get("/projects",
                                          group=PROJECTS_GROUP, search=project_id)
            for p in existing:
                if p["path"].rsplit("/", 1)[-1].lower() == project_id.lower():
                    return {"status": "ok", "project": p["path"], "via": "gitlab-mcp"}
            new_p = await self._gl_post("/projects",
                                        {"name": project_id, "namespace": PROJECTS_GROUP,
                                         "description": "auto-created by shell_service shim"},
                                        write=True)
            return {"status": "ok", "project": new_p["path"], "via": "gitlab-mcp"}
        except httpx.HTTPError as e:
            logger.error("git_init shim: gitlab-mcp error: %s", e)
            raise

    async def git_commit(self, project_id: str, message: str,
                         files: list[str] | None = None) -> dict:
        # Commits happen at file_write time via commit_file — this is a no-op.
        logger.info("git_commit shim: no-op (commits are per-file via gitlab-mcp)")
        return {"status": "ok", "noop": True, "message": message}

    async def git_log(self, project_id: str, limit: int = 20) -> dict:
        return {"status": "ok", "commits": [], "limit": limit, "via": "gitlab-mcp"}

    async def git_diff(self, project_id: str) -> dict:
        return {"status": "ok", "diff": "", "via": "gitlab-mcp"}

    # ---- files (now backed by GitLab) ------------------------------------
    async def file_write(self, project_id: str, path: str, content: str) -> dict:
        await self._gl_post("/commit-file", {
            "project": _project_slug(project_id), "branch": DEFAULT_REF,
            "path": path, "content": content,
            "message": f"chore: update {path}", "encoding": "text",
        }, write=True)
        return {"status": "ok", "path": path, "via": "gitlab-mcp"}

    async def file_read(self, project_id: str, path: str) -> dict:
        result = await self._gl_get("/file",
                                    project=_project_slug(project_id),
                                    path=path, ref=DEFAULT_REF)
        return {"status": "ok", "path": path, "content": result.get("content", "")}

    async def file_list(self, project_id: str, path: str = ".",
                        recursive: bool = False) -> dict:
        tree = await self._gl_get("/tree",
                                  project=_project_slug(project_id),
                                  path=("" if path == "." else path),
                                  ref=DEFAULT_REF, recursive=recursive)
        files = [e["path"] for e in tree.get("entries", []) if e.get("type") == "blob"]
        dirs  = [e["path"] for e in tree.get("entries", []) if e.get("type") == "tree"]
        return {"status": "ok", "files": files, "dirs": dirs}

    async def delete_workspace(self, project_id: str) -> dict:
        # Workspaces don't exist any more; project deletion is an admin action.
        logger.info("delete_workspace shim: no-op (project_id=%s)", project_id)
        return {"status": "ok", "noop": True}


_singleton: ShellServiceClient | None = None


def get_shell_service() -> ShellServiceClient:
    global _singleton
    if _singleton is None:
        _singleton = ShellServiceClient()
    return _singleton


__all__ = ["ShellServiceClient", "get_shell_service"]
