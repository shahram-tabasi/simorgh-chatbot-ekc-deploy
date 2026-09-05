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


async def start(name: str) -> Dict[str, Any]:
    """POST /containers/{name}/start. 304 means it's already running."""
    if not _ENABLED:
        raise RuntimeError("Docker socket not available")
    async with _client() as c:
        r = await c.post(f"/containers/{name}/start")
    if r.status_code not in (204, 304):
        raise RuntimeError(f"docker start {name}: {r.status_code} {r.text[:200]}")
    return {"started": name, "status": r.status_code, "already_running": r.status_code == 304}


async def stop(name: str, timeout_sec: int = 10) -> Dict[str, Any]:
    """POST /containers/{name}/stop?t=<seconds>. 304 means already stopped."""
    if not _ENABLED:
        raise RuntimeError("Docker socket not available")
    async with _client(timeout=timeout_sec + 30) as c:
        r = await c.post(f"/containers/{name}/stop", params={"t": str(timeout_sec)})
    if r.status_code not in (204, 304):
        raise RuntimeError(f"docker stop {name}: {r.status_code} {r.text[:200]}")
    return {"stopped": name, "status": r.status_code, "already_stopped": r.status_code == 304}


async def logs(name: str, tail: int = 200) -> str:
    """GET /containers/{name}/logs — last N lines, stdout+stderr combined.
    Docker sends a multiplexed stream; for simplicity we strip the 8-byte
    framing headers before returning text."""
    if not _ENABLED:
        raise RuntimeError("Docker socket not available")
    async with _client() as c:
        r = await c.get(
            f"/containers/{name}/logs",
            params={"stdout": "true", "stderr": "true", "tail": str(tail), "timestamps": "true"},
        )
    if r.status_code != 200:
        raise RuntimeError(f"docker logs {name}: {r.status_code} {r.text[:200]}")
    # De-multiplex: each frame is 8 bytes (1 stream-id + 3 padding + 4 length BE) then payload.
    data = r.content
    out = bytearray()
    i = 0
    while i + 8 <= len(data):
        # Heuristic: if the first byte isn't 1/2 (stdout/stderr), the stream
        # isn't framed (rare, e.g. TTY containers) — fall back to raw bytes.
        if data[i] not in (0, 1, 2):
            return data.decode("utf-8", "replace")
        length = int.from_bytes(data[i + 4 : i + 8], "big")
        out.extend(data[i + 8 : i + 8 + length])
        i += 8 + length
    return out.decode("utf-8", "replace")
