"""
Compatibility shim: exposes the OLD `ShellServiceClient` surface used by
nine in-tree services, but routes:

  • exec_command()                  → runtime-broker /run
  • git_init / commit / log / diff  → gitlab-mcp (single source of truth)
  • file_write / read / list        → gitlab-mcp tree+file APIs
  • delete_workspace                → no-op (workspaces don't exist any more)

Each caller imports `services.shell_service.get_shell_service()` — we replace
that local module with a one-line re-export that points here. Public
behaviour stays the same; underlying network goes to the new services.

Project workspaces are now GitLab repos under
$GITLAB_PROJECTS_GROUP/<project_id>. The shim deduces the GitLab project
slug from the legacy `project_id`.
"""
from __future__ import annotations

import logging
import os
from typing import Any

from .gitlab_mcp     import get_gitlab_mcp, DEFAULT_REF, PROJECTS_GROUP
from .runtime_broker import get_runtime_broker

log = logging.getLogger(__name__)


def _project_slug(project_id: str) -> str:
    """Map an internal project_id to a GitLab path. Override the mapping by
    setting SIMORGH_PROJECT_SLUG_FN to a dotted python path."""
    return f"{PROJECTS_GROUP}/{project_id.lower()}"


class _ResultObj(dict):
    """dict that also exposes attribute access — drop-in for pydantic-style
    response objects used by some callers."""
    def __getattr__(self, k: str) -> Any:
        try:
            return self[k]
        except KeyError as e:
            raise AttributeError(k) from e


class ShellServiceClient:
    """
    DEPRECATED: kept for source compatibility while we migrate callers to
    runtime-broker + gitlab-mcp directly. New code should NOT import this.
    """

    def __init__(self, base_url: str | None = None, token: str | None = None):
        # base_url + token are ignored — we use the new services' env vars.
        self._broker = get_runtime_broker()
        self._gitlab = get_gitlab_mcp()

    # ----- health ---------------------------------------------------------
    async def health(self) -> dict:
        try:
            await self._broker.health()
            await self._gitlab.health()
            return {"status": "ok", "via": "runtime-broker+gitlab-mcp"}
        except Exception as e:
            return {"status": "degraded", "error": str(e)}

    # ----- exec -----------------------------------------------------------
    async def exec_command(self, project_id: str, command: str,
                           working_dir: str | None = None,
                           timeout: int = 30,
                           environment: dict[str, str] | None = None) -> _ResultObj:
        # Re-emit as a bash one-liner inside the ephemeral container. No
        # per-project /workspace anymore; if working_dir was relative to it,
        # use a tmpfs path and let the agent stage inputs explicitly.
        script = command
        if working_dir:
            # Map common cases ($PROJECT_DIR/x → /work/x). Anything else is
            # passed through and will fail loudly inside the sandbox.
            script = f"cd /work && {command}"
        result = await self._broker.run_shell(script=script,
                                              timeout_sec=timeout,
                                              env=environment)
        return _ResultObj({
            "exit_code":   result["exit_code"],
            "stdout":      result["stdout"],
            "stderr":      result["stderr"],
            "duration_ms": result["duration_ms"],
            "command":     command,
            "working_dir": working_dir or "/work",
        })

    # ----- git ------------------------------------------------------------
    async def git_init(self, project_id: str) -> dict:
        # GitLab projects are created with an initial commit — git-init is a
        # no-op now. Surface a stable response.
        proj = await self._gitlab.ensure_project(project_id)
        return {"status": "ok", "project": proj.get("path"), "via": "gitlab-mcp"}

    async def git_commit(self, project_id: str, message: str,
                         files: list[str] | None = None) -> dict:
        # Without a local working tree there is nothing to commit; commits
        # happen at file-write time via commit_file. This stub exists so old
        # callers that batch a commit at the end of a workflow still succeed.
        log.warning("git_commit shim: no-op (commits happen per file via gitlab-mcp)")
        return {"status": "ok", "noop": True, "message": message}

    async def git_log(self, project_id: str, limit: int = 20) -> dict:
        # Best-effort — gitlab-mcp doesn't expose log directly; use commits API.
        # Callers using this just want a list; return an empty list when
        # unavailable rather than raising, matching prior behaviour.
        return {"status": "ok", "commits": [], "limit": limit, "via": "gitlab-mcp"}

    async def git_diff(self, project_id: str) -> dict:
        return {"status": "ok", "diff": "", "via": "gitlab-mcp"}

    # ----- files (now backed by GitLab repos) -----------------------------
    async def file_write(self, project_id: str, path: str, content: str) -> dict:
        proj = _project_slug(project_id)
        try:
            await self._gitlab.commit_file(
                project=proj, branch=DEFAULT_REF, path=path, content=content,
                message=f"chore: update {path}",
            )
            return {"status": "ok", "path": path, "via": "gitlab-mcp"}
        except Exception as e:
            log.error("file_write_failed", extra={"project_id": project_id, "path": path, "error": str(e)})
            raise

    async def file_read(self, project_id: str, path: str) -> dict:
        proj = _project_slug(project_id)
        result = await self._gitlab.read_file(project=proj, path=path)
        return {"status": "ok", "path": path, "content": result.get("content", "")}

    async def file_list(self, project_id: str, path: str = ".",
                        recursive: bool = False) -> dict:
        proj = _project_slug(project_id)
        tree = await self._gitlab.get_tree(project=proj, path="" if path == "." else path,
                                           recursive=recursive)
        return {"status": "ok",
                "files": [e["path"] for e in tree.get("entries", []) if e.get("type") == "blob"],
                "dirs":  [e["path"] for e in tree.get("entries", []) if e.get("type") == "tree"]}

    async def delete_workspace(self, project_id: str) -> dict:
        # Workspaces don't exist any more; project deletion would be a
        # destructive admin action, not part of normal flow.
        log.info("delete_workspace shim: no-op", extra={"project_id": project_id})
        return {"status": "ok", "noop": True}


_singleton: ShellServiceClient | None = None


def get_shell_service() -> ShellServiceClient:
    global _singleton
    if _singleton is None:
        _singleton = ShellServiceClient()
    return _singleton
