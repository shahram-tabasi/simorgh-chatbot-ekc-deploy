"""
simorgh_soft_client.py — thin HTTP client for simorgh-soft's Express API.

simorgh-soft runs at http://simorgh-soft:3001 on the docker network
(soft-app.yml: PORT=3001). The create endpoint is open: POST /api/projects
takes any JSON, returns {_id, ...} (server.js:152-160). Deep-link to a
specific project: <host>/simorgh-design-suite/?projectId=<_id> — the
frontend reads the query param on mount.
"""
from __future__ import annotations

import logging
import os
from typing import Any, Dict

import httpx

logger = logging.getLogger(__name__)

SOFT_BASE = os.getenv("SIMORGH_SOFT_BASE_URL", "http://simorgh-soft:3001")
# Public host path the user is redirected to (served by host nginx).
SOFT_PUBLIC_PATH = os.getenv("SIMORGH_SOFT_PUBLIC_PATH", "/simorgh-design-suite/")


async def create_project(payload: Dict[str, Any], timeout: float = 15.0
                         ) -> Dict[str, Any]:
    """POST /api/projects. Returns the inserted document (including _id)."""
    async with httpx.AsyncClient(timeout=timeout) as c:
        r = await c.post(f"{SOFT_BASE}/api/projects", json=payload)
        r.raise_for_status()
        return r.json()


async def update_project(project_id: str, payload: Dict[str, Any],
                         timeout: float = 15.0) -> Dict[str, Any]:
    """PUT /api/projects/:id. simorgh-soft deep-merges the partial body
    with MongoDB `$set` (server.js:162) and stamps changedOn — so we can
    push ONLY the fields we want to add/update (e.g. just `templates`,
    `deviceLibrary`, `equipments`) without clobbering the rest of the
    existing project. Returns the updated full document."""
    async with httpx.AsyncClient(timeout=timeout) as c:
        r = await c.put(f"{SOFT_BASE}/api/projects/{project_id}",
                        json=payload)
        r.raise_for_status()
        return r.json()


async def get_project(project_id: str, timeout: float = 10.0
                      ) -> Dict[str, Any]:
    """GET /api/projects/:id. Returns the full document (incl _id)."""
    async with httpx.AsyncClient(timeout=timeout) as c:
        r = await c.get(f"{SOFT_BASE}/api/projects/{project_id}")
        r.raise_for_status()
        return r.json()


def deep_link(project_id: str) -> str:
    """Browser URL the chat returns to redirect the user into the project."""
    base = SOFT_PUBLIC_PATH if SOFT_PUBLIC_PATH.endswith("/") else SOFT_PUBLIC_PATH + "/"
    return f"{base}?projectId={project_id}"


async def health(timeout: float = 5.0) -> bool:
    try:
        async with httpx.AsyncClient(timeout=timeout) as c:
            r = await c.get(f"{SOFT_BASE}/api/health")
            return r.status_code == 200
    except Exception as e:
        logger.warning("simorgh-soft health probe failed: %s", e)
        return False
