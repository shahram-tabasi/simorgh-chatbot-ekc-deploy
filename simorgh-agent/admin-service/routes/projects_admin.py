"""
Admin Projects — cross-user project management surface.

GET    /api/v2/admin/projects                       list all projects (every owner)
GET    /api/v2/admin/projects/{id}                  single project + counts
DELETE /api/v2/admin/projects/{id}                  cascade-delete (sessions, container)
POST   /api/v2/admin/projects                       create on behalf of a user
POST   /api/v2/admin/projects/{id}/container/start  start session container via runtime-broker
POST   /api/v2/admin/projects/{id}/container/stop   stop session container
GET    /api/v2/admin/projects/{id}/container/status fetch runtime-broker status

All write actions are audit-logged.
"""
from __future__ import annotations

import logging
import os
from typing import Any, Dict, List, Optional

import asyncpg
import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from routes._auth import require_admin
from services import audit_service
from services.postgres_auth_service import get_postgres_auth_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v2/admin", tags=["Projects"])


# The projects table lives in the chat-service Postgres database, not the
# auth DB the admin-service already has a pool for. We open a small dedicated
# pool here on first use; admin volumes are low so a small pool is fine.
_CHAT_POSTGRES_URL = os.getenv(
    "POSTGRES_AUTH_URL",
    "postgresql://simorgh:simorgh_secure_2024@postgres_auth:5432/simorgh_auth",
)
_chat_pool: Optional[asyncpg.Pool] = None

RUNTIME_BROKER_URL = os.getenv("RUNTIME_BROKER_URL", "http://runtime-broker:8048")
BROKER_TOKEN = os.getenv("BROKER_TOKEN", "")


async def _pool() -> asyncpg.Pool:
    global _chat_pool
    if _chat_pool is None:
        _chat_pool = await asyncpg.create_pool(_CHAT_POSTGRES_URL, min_size=1, max_size=4)
    return _chat_pool


def _broker_headers() -> Dict[str, str]:
    return {"authorization": f"Bearer {BROKER_TOKEN}"} if BROKER_TOKEN else {}


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
class CreateProjectRequest(BaseModel):
    owner_id: str             # user UUID or EMPUSERNAME
    name: str
    description: Optional[str] = None
    tpms_oenum: Optional[str] = None
    agent_model: str = "gpt-4o"


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@router.get("/projects")
async def list_all_projects(
    limit: int = 200,
    offset: int = 0,
    status: Optional[str] = None,
    owner_id: Optional[str] = None,
    search: Optional[str] = None,
    _: dict = Depends(require_admin),
) -> Dict[str, Any]:
    pool = await _pool()
    where, params, idx = [], [], 1
    if status:
        where.append(f"p.status = ${idx}"); params.append(status); idx += 1
    if owner_id:
        where.append(f"p.owner_id = ${idx}"); params.append(owner_id); idx += 1
    if search:
        where.append(f"(p.name ILIKE ${idx} OR p.description ILIKE ${idx})")
        params.append(f"%{search}%"); idx += 1
    where_sql = (" WHERE " + " AND ".join(where)) if where else ""

    rows = await pool.fetch(
        f"""
        SELECT p.id, p.owner_id, p.name, p.description, p.status,
               p.tpms_oenum, p.agent_model, p.git_repo_initialized,
               p.git_repo_path, p.created_at, p.updated_at,
               (SELECT COUNT(*) FROM project_chat_sessions s
                  WHERE s.project_id = p.id) AS session_count,
               (SELECT COUNT(*) FROM project_messages m
                  WHERE m.project_id = p.id) AS message_count
        FROM projects p
        {where_sql}
        ORDER BY p.created_at DESC
        LIMIT ${idx} OFFSET ${idx + 1}
        """,
        *params, limit, offset,
    )
    total = await pool.fetchval(
        f"SELECT COUNT(*) FROM projects p {where_sql}", *params,
    )

    # Best-effort owner email enrichment (resolve UUID -> email via users table).
    owner_ids = {r["owner_id"] for r in rows}
    emails: Dict[str, str] = {}
    if owner_ids:
        try:
            erows = await pool.fetch(
                "SELECT id::text AS id, email FROM users WHERE id::text = ANY($1::text[])",
                list(owner_ids),
            )
            emails = {er["id"]: er["email"] for er in erows}
        except Exception:
            pass  # legacy EMPUSERNAME owners have no users row

    return {
        "total": total,
        "limit": limit,
        "offset": offset,
        "projects": [
            {
                "id": str(r["id"]),
                "owner_id": r["owner_id"],
                "owner_email": emails.get(r["owner_id"]),
                "name": r["name"],
                "description": r["description"],
                "status": r["status"],
                "tpms_oenum": r["tpms_oenum"],
                "agent_model": r["agent_model"],
                "git_repo_initialized": r["git_repo_initialized"],
                "git_repo_path": r["git_repo_path"],
                "session_count": r["session_count"],
                "message_count": r["message_count"],
                "created_at": r["created_at"].isoformat(),
                "updated_at": r["updated_at"].isoformat(),
            }
            for r in rows
        ],
    }


@router.get("/projects/{project_id}")
async def get_project(project_id: str, _: dict = Depends(require_admin)) -> Dict[str, Any]:
    pool = await _pool()
    row = await pool.fetchrow(
        "SELECT * FROM projects WHERE id = $1::uuid", project_id,
    )
    if row is None:
        raise HTTPException(status_code=404, detail="project not found")
    sessions = await pool.fetch(
        "SELECT id, session_token, title, stage, is_active, archived_at, "
        "       created_at, last_activity_at "
        "FROM project_chat_sessions WHERE project_id = $1::uuid "
        "ORDER BY last_activity_at DESC",
        project_id,
    )
    message_count = await pool.fetchval(
        "SELECT COUNT(*) FROM project_messages WHERE project_id = $1::uuid", project_id,
    )
    return {
        "id": str(row["id"]),
        "owner_id": row["owner_id"],
        "name": row["name"],
        "description": row["description"],
        "status": row["status"],
        "tpms_oenum": row["tpms_oenum"],
        "agent_model": row["agent_model"],
        "git_repo_initialized": row["git_repo_initialized"],
        "git_repo_path": row["git_repo_path"],
        "metadata": row.get("metadata"),
        "created_at": row["created_at"].isoformat(),
        "updated_at": row["updated_at"].isoformat(),
        "message_count": message_count,
        "sessions": [
            {
                "id": str(s["id"]),
                "session_token": s["session_token"],
                "title": s["title"],
                "stage": s["stage"],
                "is_active": s["is_active"],
                "archived": s["archived_at"] is not None,
                "created_at": s["created_at"].isoformat(),
                "last_activity_at": s["last_activity_at"].isoformat(),
            }
            for s in sessions
        ],
    }


@router.post("/projects")
async def create_project_on_behalf(
    req: CreateProjectRequest, request: Request,
    admin: dict = Depends(require_admin),
) -> Dict[str, Any]:
    pool = await _pool()
    try:
        row = await pool.fetchrow(
            """
            INSERT INTO projects (owner_id, name, description, tpms_oenum, agent_model)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id, owner_id, name, created_at
            """,
            req.owner_id, req.name, req.description, req.tpms_oenum, req.agent_model,
        )
    except asyncpg.exceptions.UniqueViolationError:
        raise HTTPException(status_code=409, detail="owner already has a project with that name")
    await audit_service.record(
        admin, "project.create_on_behalf",
        target_type="project", target_id=str(row["id"]),
        request=request,
        after={"owner_id": req.owner_id, "name": req.name},
    )
    return {
        "id": str(row["id"]),
        "owner_id": row["owner_id"],
        "name": row["name"],
        "created_at": row["created_at"].isoformat(),
    }


@router.delete("/projects/{project_id}")
async def delete_project(
    project_id: str, request: Request, admin: dict = Depends(require_admin),
) -> Dict[str, Any]:
    pool = await _pool()
    row = await pool.fetchrow(
        "SELECT id, owner_id, name FROM projects WHERE id = $1::uuid", project_id,
    )
    if row is None:
        raise HTTPException(status_code=404, detail="project not found")

    # Tear down the session container (best-effort).
    container_result: Dict[str, Any] = {"removed_container": False}
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.delete(
                f"{RUNTIME_BROKER_URL}/sessions/{project_id}",
                headers=_broker_headers(),
            )
            r.raise_for_status()
            container_result = r.json()
    except Exception as e:
        container_result["error"] = str(e)[:200]

    # Cascade-delete via FK ON DELETE CASCADE on project_messages/sessions/etc.
    await pool.execute("DELETE FROM projects WHERE id = $1::uuid", project_id)
    await audit_service.record(
        admin, "project.delete",
        target_type="project", target_id=project_id,
        request=request,
        before={"owner_id": row["owner_id"], "name": row["name"]},
    )
    return {"deleted": True, "project_id": project_id, "container": container_result}


@router.post("/projects/{project_id}/container/start")
async def start_project_container(
    project_id: str, request: Request, admin: dict = Depends(require_admin),
) -> Dict[str, Any]:
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            r = await client.post(
                f"{RUNTIME_BROKER_URL}/sessions/{project_id}/start",
                headers=_broker_headers(),
            )
            r.raise_for_status()
            data = r.json()
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"runtime-broker: {e}")
    await audit_service.record(
        admin, "project.container_start",
        target_type="project", target_id=project_id, request=request,
    )
    return data


@router.post("/projects/{project_id}/container/stop")
async def stop_project_container(
    project_id: str, request: Request, admin: dict = Depends(require_admin),
) -> Dict[str, Any]:
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            r = await client.post(
                f"{RUNTIME_BROKER_URL}/sessions/{project_id}/stop",
                headers=_broker_headers(),
            )
            r.raise_for_status()
            data = r.json()
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"runtime-broker: {e}")
    await audit_service.record(
        admin, "project.container_stop",
        target_type="project", target_id=project_id, request=request,
    )
    return data


@router.get("/projects/{project_id}/container/status")
async def project_container_status(
    project_id: str, _: dict = Depends(require_admin),
) -> Dict[str, Any]:
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.get(
                f"{RUNTIME_BROKER_URL}/sessions/{project_id}/status",
                headers=_broker_headers(),
            )
            r.raise_for_status()
            return r.json()
    except httpx.HTTPError as e:
        return {"project_id": project_id, "state": "unknown", "error": str(e)[:200]}
