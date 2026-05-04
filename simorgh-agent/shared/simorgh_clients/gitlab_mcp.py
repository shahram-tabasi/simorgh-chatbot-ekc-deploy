"""Async client for gitlab-mcp REST API."""
from __future__ import annotations

import os
from typing import Any

import httpx

GITLAB_MCP_URL   = os.getenv("GITLAB_MCP_URL",   "http://gitlab-mcp:8047")
AGENT_TOKEN      = os.getenv("AGENT_TOKEN",      "")
GITLAB_MCP_TMOUT = int(os.getenv("GITLAB_MCP_TIMEOUT", "60"))
PROJECTS_GROUP   = os.getenv("GITLAB_PROJECTS_GROUP", "simorgh-projects")
DEFAULT_REF      = os.getenv("GITLAB_DEFAULT_REF", "main")


class GitlabMCPClient:
    def __init__(self, base_url: str | None = None, agent_token: str | None = None):
        self.base_url = (base_url or GITLAB_MCP_URL).rstrip("/")
        self.token    = agent_token or AGENT_TOKEN
        self.write_headers = {"x-agent-auth": self.token} if self.token else {}

    async def _get(self, path: str, **params) -> Any:
        async with httpx.AsyncClient(timeout=GITLAB_MCP_TMOUT) as c:
            r = await c.get(f"{self.base_url}{path}", params=params)
            r.raise_for_status()
            return r.json()

    async def _post(self, path: str, body: dict | None = None, write: bool = False) -> Any:
        h = self.write_headers if write else {}
        async with httpx.AsyncClient(timeout=GITLAB_MCP_TMOUT) as c:
            r = await c.post(f"{self.base_url}{path}", json=body or {}, headers=h)
            r.raise_for_status()
            return r.json()

    async def health(self) -> dict:
        return await self._get("/health")

    # --- read --------------------------------------------------------------
    async def list_projects(self, group: str | None = None,
                            search: str | None = None) -> list[dict]:
        return await self._get("/projects", group=group or "",
                               search=search or "")

    async def get_tree(self, project: str, ref: str = DEFAULT_REF,
                       path: str = "", recursive: bool = True) -> dict:
        return await self._get("/tree", project=project, ref=ref,
                               path=path, recursive=recursive)

    async def read_file(self, project: str, path: str,
                        ref: str = DEFAULT_REF) -> dict:
        return await self._get("/file", project=project, path=path, ref=ref)

    async def search(self, query: str, project: str | None = None,
                     group: str | None = None, scope: str = "blobs") -> Any:
        return await self._get("/search", query=query,
                               project=project or "", group=group or "",
                               scope=scope)

    # --- write -------------------------------------------------------------
    async def ensure_project(self, name: str, namespace: str | None = None,
                             description: str = "") -> dict:
        try:
            existing = await self.list_projects(group=namespace or PROJECTS_GROUP,
                                                search=name)
            for p in existing:
                if p["path"].rsplit("/", 1)[-1].lower() == name.lower():
                    return p
        except Exception:
            pass
        return await self._post("/projects",
                                {"name": name,
                                 "namespace": namespace or PROJECTS_GROUP,
                                 "description": description},
                                write=True)

    async def create_branch(self, project: str, branch: str,
                            ref: str = DEFAULT_REF) -> dict:
        return await self._post("/branches",
                                {"project": project, "branch": branch, "ref": ref},
                                write=True)

    async def commit_file(self, *, project: str, branch: str, path: str,
                          content: str, message: str,
                          encoding: str = "text",
                          author_email: str | None = None,
                          author_name: str | None = None) -> dict:
        body: dict[str, Any] = {
            "project": project, "branch": branch, "path": path,
            "content": content, "message": message, "encoding": encoding,
        }
        if author_email: body["author_email"] = author_email
        if author_name:  body["author_name"]  = author_name
        return await self._post("/commit-file", body, write=True)

    async def open_mr(self, *, project: str, source_branch: str,
                      target_branch: str = DEFAULT_REF,
                      title: str, description: str = "") -> dict:
        return await self._post("/merge-requests",
                                {"project": project,
                                 "source_branch": source_branch,
                                 "target_branch": target_branch,
                                 "title": title, "description": description},
                                write=True)


_singleton: GitlabMCPClient | None = None


def get_gitlab_mcp() -> GitlabMCPClient:
    global _singleton
    if _singleton is None:
        _singleton = GitlabMCPClient()
    return _singleton
