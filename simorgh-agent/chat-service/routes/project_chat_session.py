"""
project_chat_session
====================
Routes for the new per-project chat session model introduced by migration 004.

Each project owns one or more chat sessions. Each session has a short token
exposed in URLs so users can deep-link to:

    https://<host>/chatbot/project/session_<token>

These routes handle:
  * POST   /api/v2/chatbot/project/sessions          create a session
  * GET    /api/v2/chatbot/project/sessions/{token}  fetch a session by token
  * GET    /api/v2/chatbot/project/{project_id}/sessions  list sessions for a project
  * DELETE /api/v2/chatbot/project/sessions/{token}  cascade-delete:
       drops project_messages / project_tasks / project_documents /
       project_git_commits rows for the parent project AND tears down the
       runtime-broker session container + its named volume. Remote git history
       on GitLab is preserved.

The session token is short and URL-safe (token_urlsafe(16)).
"""
import json
import logging
import os
import secrets
from datetime import datetime, timezone
from typing import Any

import asyncpg
import redis as redis_lib
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from services.auth_utils import get_current_user
from services.container_mirror import destroy_session_container

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v2/chatbot/project", tags=["Project Chat Session"])


POSTGRES_URL = os.getenv(
    "POSTGRES_AUTH_URL",
    "postgresql://simorgh:simorgh_secure_2024@postgres_auth:5432/simorgh_auth",
)
REDIS_HOST     = os.getenv("REDIS_HOST", "redis")
REDIS_PORT     = int(os.getenv("REDIS_PORT", "6379"))
REDIS_CHAT_DB  = int(os.getenv("REDIS_CHAT_DB", "1"))

_pool: asyncpg.Pool | None = None
_redis_chat: redis_lib.Redis | None = None


async def _db() -> asyncpg.Pool:
    global _pool
    if _pool is None:
        _pool = await asyncpg.create_pool(POSTGRES_URL, min_size=1, max_size=8)
    return _pool


def _redis() -> redis_lib.Redis:
    """Synchronous Redis client for the chat-metadata DB the legacy backend
    indexes for /api/users/{user}/project-chats. Sync is fine here — chat
    creation is rare and the calls are small."""
    global _redis_chat
    if _redis_chat is None:
        _redis_chat = redis_lib.Redis(host=REDIS_HOST, port=REDIS_PORT,
                                       db=REDIS_CHAT_DB, decode_responses=True)
    return _redis_chat


def _mirror_session_to_legacy_redis(row: asyncpg.Record, project: asyncpg.Record,
                                    owner_id: str) -> None:
    """Write the per-chat metadata + user-chat-index keys that the legacy
    backend's /api/users/{user}/project-chats reads. Without this the new
    wizard's session is invisible to the existing sidebar UI."""
    try:
        r = _redis()
        chat_id = row["session_token"]
        project_id = str(project["id"])
        project_number = (project.get("tpms_oenum")
                          or project.get("gitlab_repo_path")
                          or project_id)
        chat_data = {
            "chat_id": chat_id,
            "chat_name": row.get("title") or project["name"],
            "user_id": owner_id,
            "chat_type": "project",
            "project_number": project_number,
            "project_id": project_id,
            "project_name": project["name"],
            "page_name": row.get("title") or "Main",
            "created_at": row["created_at"].isoformat(),
            "message_count": 0,
            "status": "active",
            "session_token": chat_id,
            # Git context — surfaced in the sidebar so the user can see
            # the repo and working branch without opening the session.
            "repo_path": project.get("gitlab_repo_path"),
            "base_branch": project.get("gitlab_base_branch"),
            "working_branch": project.get("simorgh_branch"),
            # Soft-delete flag (false on creation; archive endpoint flips it).
            "archived": False,
        }
        r.set(f"chat:{chat_id}:metadata", json.dumps(chat_data))
        r.sadd(f"user:{owner_id}:chats:all", chat_id)
        r.sadd(f"user:{owner_id}:chats:project:{project_number}", chat_id)
        logger.info("legacy-mirror: project chat indexed user=%s chat=%s project=%s",
                    owner_id, chat_id, project_number)
    except Exception as e:
        # Mirror is best-effort: Postgres remains source of truth.
        logger.warning("legacy redis mirror failed: %s", e)


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
class CreateSessionRequest(BaseModel):
    project_id: str
    title: str | None = None
    stage: str = "general"


class SessionResponse(BaseModel):
    id: str
    project_id: str
    session_token: str
    title: str | None
    stage: str
    is_active: bool
    created_at: str
    last_activity_at: str
    deep_link: str


def _build_deep_link(session_token: str) -> str:
    """Build the canonical deep-link URL for a chat session."""
    base = os.getenv("PUBLIC_APP_BASE_URL", "https://simorghai.electrokavir.com")
    return f"{base.rstrip('/')}/chatbot/project/{session_token}"


def _row_to_response(row: asyncpg.Record) -> SessionResponse:
    return SessionResponse(
        id=str(row["id"]),
        project_id=str(row["project_id"]),
        session_token=row["session_token"],
        title=row.get("title"),
        stage=row.get("stage") or "general",
        is_active=row["is_active"],
        created_at=row["created_at"].isoformat(),
        last_activity_at=row["last_activity_at"].isoformat(),
        deep_link=_build_deep_link(row["session_token"]),
    )


def _owner_id(user: Any) -> str:
    """`get_current_user` returns either a string (legacy/JWT sub) or a dict
    with id/EMPUSERNAME. Normalise to a plain string for projects.owner_id
    comparisons."""
    if isinstance(user, str):
        return user
    if isinstance(user, dict):
        return str(user.get("id") or user.get("EMPUSERNAME") or "")
    return ""


async def _verify_project_access(pool: asyncpg.Pool, project_id: str,
                                 user: Any) -> None:
    owner_id = _owner_id(user)
    if not owner_id:
        raise HTTPException(status_code=401, detail="unauthenticated")
    row = await pool.fetchrow(
        "SELECT owner_id FROM projects WHERE id = $1::uuid", project_id,
    )
    if row is None:
        raise HTTPException(status_code=404, detail="project not found")
    if row["owner_id"] != owner_id:
        raise HTTPException(status_code=403, detail="not your project")


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@router.post("/sessions", response_model=SessionResponse)
async def create_session(req: CreateSessionRequest,
                         current_user: dict = Depends(get_current_user)):
    pool = await _db()
    await _verify_project_access(pool, req.project_id, current_user)

    token = f"session_{secrets.token_urlsafe(16)}"
    row = await pool.fetchrow(
        """
        INSERT INTO project_chat_sessions
            (project_id, session_token, title, stage, created_by)
        VALUES ($1::uuid, $2, $3, $4, $5)
        RETURNING *
        """,
        req.project_id, token, req.title, req.stage,
        _owner_id(current_user),
    )
    # Mirror to the legacy Redis chat index so the existing sidebar UI
    # (/api/users/{user}/project-chats) sees this session immediately.
    project = await pool.fetchrow(
        "SELECT id, name, tpms_oenum, gitlab_repo_path, gitlab_base_branch, "
        "       simorgh_branch "
        "FROM projects WHERE id = $1::uuid",
        req.project_id,
    )
    if project is not None:
        _mirror_session_to_legacy_redis(row, project, _owner_id(current_user))
    return _row_to_response(row)


@router.get("/sessions/{session_token}", response_model=SessionResponse)
async def get_session(session_token: str,
                      current_user: dict = Depends(get_current_user)):
    pool = await _db()
    row = await pool.fetchrow(
        "SELECT s.*, p.owner_id FROM project_chat_sessions s "
        "JOIN projects p ON p.id = s.project_id "
        "WHERE s.session_token = $1",
        session_token,
    )
    if row is None:
        raise HTTPException(status_code=404, detail="session not found")
    owner_id = _owner_id(current_user)
    if row["owner_id"] != owner_id:
        raise HTTPException(status_code=403, detail="not your session")
    return _row_to_response(row)


@router.get("/sessions/{session_token}/messages")
async def get_session_messages(session_token: str,
                               limit: int = 200,
                               current_user: dict = Depends(get_current_user)):
    """Return the historical messages for a deep-linked project chat
    session, in chronological order. Used by the frontend's
    `selectChat` to populate the chat area when revisiting an existing
    session.

    Frontend renders rows as `{id, role, content, timestamp, metadata}`,
    so the response uses those shapes directly rather than the raw
    project_messages column names.
    """
    pool = await _db()
    row = await pool.fetchrow(
        "SELECT s.project_id, p.owner_id, p.name AS project_name, "
        "       p.gitlab_repo_path, p.gitlab_base_branch, p.simorgh_branch "
        "FROM project_chat_sessions s "
        "JOIN projects p ON p.id = s.project_id "
        "WHERE s.session_token = $1", session_token,
    )
    if row is None:
        raise HTTPException(status_code=404, detail="session not found")
    owner_id = _owner_id(current_user)
    if row["owner_id"] != owner_id:
        raise HTTPException(status_code=403, detail="not your session")

    messages = await pool.fetch(
        """
        SELECT id, role, content, channel, metadata, created_at
        FROM project_messages
        WHERE project_id = $1::uuid AND chat_id = $2
        ORDER BY created_at ASC
        LIMIT $3
        """,
        str(row["project_id"]), session_token, limit,
    )

    # Files-changed count since session start — drives the "+N files" diff
    # indicator in the chat header (Claude-Code-style). Cheap aggregation:
    # union the files_changed arrays from every commit linked to this
    # project that happened after the session was created.
    session_created = await pool.fetchval(
        "SELECT created_at FROM project_chat_sessions WHERE session_token = $1",
        session_token,
    )
    files_changed_count = 0
    if session_created is not None:
        files_changed_count = await pool.fetchval(
            """
            SELECT COALESCE(COUNT(DISTINCT f), 0)
            FROM project_git_commits c, UNNEST(c.files_changed) AS f
            WHERE c.project_id = $1::uuid AND c.created_at >= $2
            """,
            str(row["project_id"]), session_created,
        ) or 0

    archived_at = await pool.fetchval(
        "SELECT archived_at FROM project_chat_sessions WHERE session_token = $1",
        session_token,
    )
    return {
        "session_token": session_token,
        "context": {
            "project_id": str(row["project_id"]),
            "project_name": row["project_name"],
            "repo_path": row["gitlab_repo_path"],
            "base_branch": row["gitlab_base_branch"],
            "working_branch": row["simorgh_branch"],
            "files_changed_count": int(files_changed_count),
            "archived": archived_at is not None,
        },
        "messages": [
            {
                "id": str(m["id"]),
                "message_id": str(m["id"]),
                "role": m["role"],
                "content": m["content"],
                "channel": m["channel"],
                "timestamp": m["created_at"].isoformat(),
                "metadata": m["metadata"] or {},
            }
            for m in messages
        ],
    }


@router.get("/{project_id}/sessions", response_model=list[SessionResponse])
async def list_sessions(project_id: str,
                        current_user: dict = Depends(get_current_user)):
    pool = await _db()
    await _verify_project_access(pool, project_id, current_user)
    rows = await pool.fetch(
        "SELECT * FROM project_chat_sessions WHERE project_id = $1::uuid "
        "ORDER BY last_activity_at DESC", project_id,
    )
    return [_row_to_response(r) for r in rows]


@router.delete("/sessions/{session_token}")
async def delete_session(session_token: str,
                         current_user: dict = Depends(get_current_user)):
    """Cascade-delete: drops session + project_messages/tasks/docs/commits
    rows for the parent project, and tears down the runtime-broker container.
    Remote git history on GitLab is preserved."""
    pool = await _db()
    row = await pool.fetchrow(
        "SELECT s.project_id, p.owner_id "
        "FROM project_chat_sessions s "
        "JOIN projects p ON p.id = s.project_id "
        "WHERE s.session_token = $1", session_token,
    )
    if row is None:
        raise HTTPException(status_code=404, detail="session not found")
    owner_id = _owner_id(current_user)
    if row["owner_id"] != owner_id:
        raise HTTPException(status_code=403, detail="not your session")

    project_id = str(row["project_id"])

    # 1. Tear down container (best-effort; we proceed even if it fails).
    container_result = await destroy_session_container(project_id)

    # 1b. Best-effort: remove the legacy Redis chat-index entries so the
    #     sidebar UI stops showing this session immediately.
    try:
        r = _redis()
        r.delete(f"chat:{session_token}:metadata")
        r.srem(f"user:{owner_id}:chats:all", session_token)
        # Remove from any per-project set too (we don't know the project_number
        # cheaply post-delete, so brute-force scan the user's project sets).
        for key in r.scan_iter(f"user:{owner_id}:chats:project:*"):
            r.srem(key, session_token)
    except Exception as e:
        logger.warning("legacy redis cleanup failed: %s", e)

    # 2. Cascade Postgres rows. project_messages/tasks/docs/commits/instructions/
    #    project_chat_sessions are all FK'd to projects with ON DELETE CASCADE,
    #    so dropping the project row wipes everything.
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute("DELETE FROM projects WHERE id = $1::uuid", project_id)

    return {
        "deleted": True,
        "session_token": session_token,
        "project_id": project_id,
        "container": container_result,
    }


async def _set_archive(session_token: str, current_user: dict, archive: bool) -> dict:
    pool = await _db()
    row = await pool.fetchrow(
        "SELECT s.id, p.owner_id "
        "FROM project_chat_sessions s "
        "JOIN projects p ON p.id = s.project_id "
        "WHERE s.session_token = $1", session_token,
    )
    if row is None:
        raise HTTPException(status_code=404, detail="session not found")
    if row["owner_id"] != _owner_id(current_user):
        raise HTTPException(status_code=403, detail="not your session")
    if archive:
        await pool.execute(
            "UPDATE project_chat_sessions "
            "SET archived_at = now(), is_active = FALSE "
            "WHERE session_token = $1", session_token,
        )
    else:
        await pool.execute(
            "UPDATE project_chat_sessions "
            "SET archived_at = NULL, is_active = TRUE "
            "WHERE session_token = $1", session_token,
        )

    # Mirror to Redis so the sidebar reflects the change on next load
    # without having to call selectChat on every row.
    try:
        r = _redis()
        key = f"chat:{session_token}:metadata"
        raw = r.get(key)
        if raw:
            data = json.loads(raw)
            data["archived"] = archive
            r.set(key, json.dumps(data))
    except Exception as e:
        logger.warning("legacy redis archive mirror failed: %s", e)

    return {"session_token": session_token, "archived": archive}


@router.post("/sessions/{session_token}/archive")
async def archive_session(session_token: str,
                          current_user: dict = Depends(get_current_user)):
    """Soft-delete: hides the session from the default sidebar view but
    keeps all messages/branches/container artefacts intact. Reversible
    via the matching unarchive endpoint."""
    return await _set_archive(session_token, current_user, archive=True)


@router.post("/sessions/{session_token}/unarchive")
async def unarchive_session(session_token: str,
                            current_user: dict = Depends(get_current_user)):
    return await _set_archive(session_token, current_user, archive=False)
