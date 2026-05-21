"""
container_mirror
================
Write-through mirror of project chat messages into the project's session
container under /work/.simorgh/messages.jsonl. Postgres remains the source
of truth (durable, queryable); the container copy lets the running shell
runtime see the conversation locally for git-style auditing and so any
in-container tooling can read it directly.

On project-session deletion the container + its volume are destroyed via
runtime-broker, which automatically wipes the mirrored copy.

This file is intentionally self-contained — chat-service builds from its
own directory and does not have the shared simorgh_clients package
available. The canonical implementation lives in
simorgh_clients.container_mirror (used by project-agent-service); keep
the two in sync if either changes.
"""
from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from typing import Any

import httpx

logger = logging.getLogger(__name__)

RUNTIME_BROKER_URL = os.getenv("RUNTIME_BROKER_URL", "http://runtime-broker:8048")
BROKER_TOKEN       = os.getenv("BROKER_TOKEN", "")
MIRROR_PATH        = ".simorgh/messages.jsonl"


def _headers() -> dict[str, str]:
    return {"authorization": f"Bearer {BROKER_TOKEN}"} if BROKER_TOKEN else {}


async def mirror_message(project_id: str, role: str, content: str,
                         session_token: str | None = None,
                         metadata: dict[str, Any] | None = None) -> bool:
    """Append a single message to the container's mirror file.

    Returns True if mirrored. Failures are logged but never raised —
    Postgres remains the source of truth and chat must keep working if
    the container is offline.
    """
    line = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "role": role,
        "content": content,
        "session_token": session_token,
        "metadata": metadata or {},
    }
    script = (
        f"mkdir -p /work/.simorgh && "
        f"printf '%s\\n' {json.dumps(json.dumps(line))} >> /work/{MIRROR_PATH}"
    )
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.post(
                f"{RUNTIME_BROKER_URL}/sessions/{project_id}/exec",
                json={"command": script, "timeout_sec": 5},
                headers=_headers(),
            )
            r.raise_for_status()
            return True
    except httpx.HTTPError as e:
        logger.warning("container_mirror failed project_id=%s err=%s", project_id, e)
        return False


async def destroy_session_container(project_id: str) -> dict[str, Any]:
    """Stop + remove the project's session container and its named volume.
    Called on cascade delete of a project chat session."""
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.delete(
                f"{RUNTIME_BROKER_URL}/sessions/{project_id}",
                headers=_headers(),
            )
            r.raise_for_status()
            return r.json()
    except httpx.HTTPError as e:
        logger.error("destroy_session_container failed project_id=%s err=%s",
                     project_id, e)
        return {"project_id": project_id, "removed_container": False,
                "removed_volume": False, "error": str(e)}
