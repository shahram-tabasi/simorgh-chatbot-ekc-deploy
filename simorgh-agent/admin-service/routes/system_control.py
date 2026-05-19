"""
System-level controls — service health roll-up + service restart.

GET  /api/v2/admin/system/capability        what this admin host can do
GET  /api/v2/admin/system/services          docker container list
POST /api/v2/admin/system/services/{name}/restart
GET  /api/v2/admin/system/health-rollup     calls each known service's /health
"""
from __future__ import annotations

import asyncio
import os
from typing import Any, Dict, List

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request

from routes._auth import require_admin
from services import audit_service, docker_control

router = APIRouter(prefix="/api/v2/admin", tags=["System"])


# Known internal services: (name, port, container_name).
# Keep this list aligned with simorgh-agent/compose/svc-*.yml.
_SERVICES: List[Dict[str, Any]] = [
    {"name": "auth-service",          "port": 8001, "container": "auth-service"},
    {"name": "chat-service",          "port": 8000, "container": "chat-service"},
    {"name": "documents-rag-service", "port": 8002, "container": "documents-rag-service"},
    {"name": "project-agent-service", "port": 8003, "container": "project-agent-service"},
    {"name": "specification-agent-service", "port": 8004, "container": "specification-agent-service"},
    {"name": "graph-rag-service",     "port": 8005, "container": "graph-rag-service"},
    {"name": "payments-service",      "port": 8038, "container": "payments-service"},
    {"name": "tier-quota-service",    "port": 8037, "container": "tier-quota-service"},
    {"name": "embeddings-service",    "port": 8031, "container": "embeddings-service"},
    {"name": "llm-gateway",           "port": 8030, "container": "llm-gateway"},
    {"name": "hr-kb-service",         "port": 8021, "container": "hr-kb-service"},
    {"name": "org-data-service",      "port": 8022, "container": "org-data-service"},
    {"name": "eplan-sql-service",     "port": 8024, "container": "eplan-sql-service"},
    # 2026-05 enterprise migration: techserver-service, tech-kb-service and
    # project-mail-service were retired. Their replacements:
    {"name": "gitlab-mcp",            "port": 8047, "container": "gitlab-mcp"},
    {"name": "runtime-broker",        "port": 8048, "container": "runtime-broker"},
    {"name": "context-search",        "port": 8049, "container": "context-search"},
    {"name": "tpms-context-agent",    "port": 8050, "container": "tpms-context-agent"},
    {"name": "mail-bridge",           "port": 8051, "container": "mail-bridge"},
    {"name": "project-explorer",      "port": 8052, "container": "project-explorer"},
]


@router.get("/system/capability")
async def capability(_: dict = Depends(require_admin)) -> Dict[str, Any]:
    return {
        "docker_control": docker_control.is_enabled(),
        "encryption_active": not _plaintext(),
        "settings_internal_token_set": bool(os.getenv("SETTINGS_INTERNAL_TOKEN")),
    }


def _plaintext() -> bool:
    from services.secret_box import is_plaintext_mode
    return is_plaintext_mode()


@router.get("/system/services")
async def list_containers(_: dict = Depends(require_admin)) -> List[Dict[str, Any]]:
    if not docker_control.is_enabled():
        raise HTTPException(status_code=503, detail="Docker socket not mounted")
    try:
        return await docker_control.list_containers()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/system/services/{name}/restart")
async def restart_service(
    name: str, request: Request, admin: dict = Depends(require_admin),
) -> Dict[str, Any]:
    if not docker_control.is_enabled():
        raise HTTPException(status_code=503, detail="Docker socket not mounted")
    try:
        out = await docker_control.restart(name)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    await audit_service.record(
        admin, "system.restart_service",
        target_type="service", target_id=name,
        request=request,
    )
    return out


@router.get("/system/health-rollup")
async def health_rollup(_: dict = Depends(require_admin)) -> Dict[str, Any]:
    """Hit /health on every known service in parallel. ~5s timeout each."""
    async def probe(svc: Dict[str, Any]) -> Dict[str, Any]:
        url = f"http://{svc['container']}:{svc['port']}/health"
        try:
            async with httpx.AsyncClient(timeout=5.0) as c:
                r = await c.get(url)
            return {**svc, "ok": r.status_code == 200, "status": r.status_code}
        except Exception as e:
            return {**svc, "ok": False, "error": str(e)[:200]}

    results = await asyncio.gather(*(probe(s) for s in _SERVICES))
    healthy = sum(1 for r in results if r.get("ok"))
    return {
        "total":   len(results),
        "healthy": healthy,
        "services": results,
    }
