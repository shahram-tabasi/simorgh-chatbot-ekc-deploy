"""
Thin Docker-socket client used by the admin panel to bounce a service
when an env-style setting marked `requires_restart=TRUE` was changed.

Talks to /var/run/docker.sock over a UNIX-domain HTTP socket. No
external library — just httpx with a UDS transport. If the socket
isn't mounted (most safe deploys), every call returns a clear error
and the UI shows the restart button greyed-out via the /capability
endpoint.

This is intentionally tiny: list containers, restart by name. Anything
heavier (compose orchestration, image rebuilds) belongs in CI.
"""
from __future__ import annotations

import logging
import os
from typing import Any, Dict, List, Optional

import httpx

logger = logging.getLogger("docker-control")

_DOCKER_SOCK = os.getenv("DOCKER_HOST", "/var/run/docker.sock")
_ENABLED = os.path.exists(_DOCKER_SOCK) if _DOCKER_SOCK.startswith("/") else True


def is_enabled() -> bool:
    """True if the docker socket is reachable from this container."""
    return _ENABLED


def _client(timeout: float = 30.0) -> httpx.AsyncClient:
    if _DOCKER_SOCK.startswith("/"):
        transport = httpx.AsyncHTTPTransport(uds=_DOCKER_SOCK)
        return httpx.AsyncClient(transport=transport, base_url="http://docker", timeout=timeout)
    return httpx.AsyncClient(base_url=_DOCKER_SOCK.rstrip("/"), timeout=timeout)


async def list_containers() -> List[Dict[str, Any]]:
    """All containers (running + stopped) on this host."""
    if not _ENABLED:
        raise RuntimeError("Docker socket not available")
    async with _client() as c:
        r = await c.get("/containers/json", params={"all": "true"})
    r.raise_for_status()
    raw = r.json()
    out = []
    for c in raw:
        name = (c.get("Names") or ["?"])[0].lstrip("/")
        out.append({
            "id": c.get("Id", "")[:12],
            "name": name,
            "image": c.get("Image"),
            "state": c.get("State"),
            "status": c.get("Status"),
        })
    return out


async def restart(name: str, timeout_sec: int = 10) -> Dict[str, Any]:
    """POST /containers/{name}/restart?t=<seconds>."""
    if not _ENABLED:
        raise RuntimeError("Docker socket not available")
    async with _client(timeout=timeout_sec + 30) as c:
        r = await c.post(f"/containers/{name}/restart", params={"t": str(timeout_sec)})
    if r.status_code not in (204, 304):
        raise RuntimeError(f"docker restart {name}: {r.status_code} {r.text[:200]}")
    return {"restarted": name, "status": r.status_code}
