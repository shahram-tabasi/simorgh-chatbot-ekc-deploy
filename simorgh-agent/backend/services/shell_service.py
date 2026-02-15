"""
Shell Service Client
=====================
Client for the sandboxed shell service running on 192.168.1.69.
Provides command execution and git operations for project workspaces.
"""

import logging
import os
from typing import Optional, List, Dict, Any

import httpx

from models.project_models import (
    ShellCommandRequest, ShellCommandResponse,
    GitCommitRequest, GitCommitResponse, GitLogResponse,
)

logger = logging.getLogger(__name__)

SHELL_SERVICE_URL = os.getenv("SHELL_SERVICE_URL", "http://shell-service:8010")
SHELL_SERVICE_TOKEN = os.getenv("SHELL_SERVICE_TOKEN", "")
SHELL_SERVICE_TIMEOUT = int(os.getenv("SHELL_SERVICE_TIMEOUT", "60"))


class ShellServiceClient:
    """Client for the shell service REST API."""

    def __init__(self, base_url: str = None, token: str = None):
        self.base_url = (base_url or SHELL_SERVICE_URL).rstrip("/")
        self.token = token or SHELL_SERVICE_TOKEN
        self.headers = {}
        if self.token:
            self.headers["Authorization"] = f"Bearer {self.token}"

    async def _request(self, method: str, path: str, json_data: dict = None) -> dict:
        """Make a request to the shell service."""
        url = f"{self.base_url}{path}"
        try:
            async with httpx.AsyncClient(timeout=SHELL_SERVICE_TIMEOUT) as client:
                response = await client.request(
                    method, url, json=json_data, headers=self.headers
                )
                response.raise_for_status()
                return response.json()
        except httpx.TimeoutException:
            logger.error(f"Shell service timeout: {method} {path}")
            raise TimeoutError(f"Shell service timed out: {path}")
        except httpx.HTTPStatusError as e:
            detail = ""
            try:
                detail = e.response.json().get("detail", "")
            except Exception:
                pass
            logger.error(f"Shell service error {e.response.status_code}: {detail}")
            raise RuntimeError(f"Shell service error: {detail or e.response.status_code}")
        except httpx.ConnectError:
            logger.error(f"Shell service unreachable at {self.base_url}")
            raise ConnectionError(f"Shell service unreachable at {self.base_url}")

    async def health(self) -> dict:
        """Check shell service health."""
        return await self._request("GET", "/health")

    async def exec_command(
        self,
        project_id: str,
        command: str,
        working_dir: str = None,
        timeout: int = 30,
        environment: Dict[str, str] = None,
    ) -> ShellCommandResponse:
        """Execute a shell command in project workspace."""
        data = {
            "project_id": project_id,
            "command": command,
            "timeout": timeout,
        }
        if working_dir:
            data["working_dir"] = working_dir
        if environment:
            data["environment"] = environment

        result = await self._request("POST", "/exec", data)
        return ShellCommandResponse(**result)

    async def git_init(self, project_id: str) -> dict:
        """Initialize git repo for a project."""
        return await self._request("POST", "/git/init", {"project_id": project_id})

    async def git_commit(
        self, project_id: str, message: str, files: List[str] = None
    ) -> dict:
        """Create a git commit."""
        data = {"project_id": project_id, "message": message}
        if files:
            data["files"] = files
        return await self._request("POST", "/git/commit", data)

    async def git_log(self, project_id: str, limit: int = 20) -> dict:
        """Get git log."""
        return await self._request(
            "POST", "/git/log", {"project_id": project_id, "limit": limit}
        )

    async def git_diff(self, project_id: str) -> dict:
        """Get git diff."""
        return await self._request(
            "POST", "/git/diff", {"project_id": project_id}
        )

    async def file_write(
        self, project_id: str, path: str, content: str
    ) -> dict:
        """Write a file in project workspace."""
        return await self._request("POST", "/file/write", {
            "project_id": project_id,
            "path": path,
            "content": content,
        })

    async def file_read(self, project_id: str, path: str) -> dict:
        """Read a file from project workspace."""
        return await self._request("POST", "/file/read", {
            "project_id": project_id,
            "path": path,
        })

    async def file_list(
        self, project_id: str, path: str = ".", recursive: bool = False
    ) -> dict:
        """List files in project workspace."""
        return await self._request("POST", "/file/list", {
            "project_id": project_id,
            "path": path,
            "recursive": recursive,
        })

    async def delete_workspace(self, project_id: str) -> dict:
        """Delete a project workspace."""
        return await self._request("DELETE", f"/project/{project_id}")


# Singleton
_shell_client: Optional[ShellServiceClient] = None


def get_shell_service() -> ShellServiceClient:
    global _shell_client
    if _shell_client is None:
        _shell_client = ShellServiceClient()
    return _shell_client
