"""Async client for runtime-broker (ephemeral docker exec sandbox)."""
from __future__ import annotations

import os
from typing import Any

import httpx

RUNTIME_BROKER_URL    = os.getenv("RUNTIME_BROKER_URL",    "http://runtime-broker:8048")
RUNTIME_BROKER_TOKEN  = os.getenv("BROKER_TOKEN",          "")
RUNTIME_BROKER_TMOUT  = int(os.getenv("RUNTIME_BROKER_TIMEOUT", "120"))


class RuntimeBrokerClient:
    def __init__(self, base_url: str | None = None, token: str | None = None):
        self.base_url = (base_url or RUNTIME_BROKER_URL).rstrip("/")
        self.token    = token or RUNTIME_BROKER_TOKEN
        self.headers  = {"authorization": f"Bearer {self.token}"} if self.token else {}

    async def _post(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=RUNTIME_BROKER_TMOUT) as c:
            r = await c.post(f"{self.base_url}{path}", json=body, headers=self.headers)
            r.raise_for_status()
            return r.json()

    async def health(self) -> dict:
        async with httpx.AsyncClient(timeout=10) as c:
            r = await c.get(f"{self.base_url}/health")
            r.raise_for_status()
            return r.json()

    async def run(self, *, language: str, script: str,
                  inputs: list[dict[str, str]] | None = None,
                  timeout_sec: int = 30,
                  network: str | None = None,
                  env: dict[str, str] | None = None) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "language": language,
            "script":   script,
            "timeout_sec": timeout_sec,
            "inputs":   inputs or [],
        }
        if network: payload["network"] = network
        if env:     payload["env"]     = env
        return await self._post("/run", payload)

    async def run_python(self, script: str, **kw) -> dict[str, Any]:
        return await self.run(language="python", script=script, **kw)

    async def run_shell(self, script: str, **kw) -> dict[str, Any]:
        return await self.run(language="shell", script=script, **kw)

    async def run_node(self, script: str, **kw) -> dict[str, Any]:
        return await self.run(language="node", script=script, **kw)


_singleton: RuntimeBrokerClient | None = None


def get_runtime_broker() -> RuntimeBrokerClient:
    global _singleton
    if _singleton is None:
        _singleton = RuntimeBrokerClient()
    return _singleton
