"""
Extended user controls beyond basic role/active toggles already in admin.py.

POST   /api/v2/admin/users                 manual create
DELETE /api/v2/admin/users/{user_id}       hard or soft delete
POST   /api/v2/admin/users/{user_id}/force-password-reset   issue one-time token
POST   /api/v2/admin/users/{user_id}/set-password           bypass: admin sets a password directly
GET    /api/v2/admin/users/{user_id}/audit                  per-user audit slice
"""
from __future__ import annotations

import hashlib
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, EmailStr, Field

from routes._auth import require_admin
from services import audit_service
from services.auth_utils import hash_password
from services.postgres_auth_service import get_postgres_auth_service

router = APIRouter(prefix="/api/v2/admin", tags=["Users"])


class UserCreate(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8)
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    user_role: str = Field(default="free", pattern="^(free|pro|max|admin)$")


class SetPasswordRequest(BaseModel):
    new_password: str = Field(min_length=8)


class DeleteRequest(BaseModel):
    hard: bool = False  # hard=True actually deletes the row; default is soft (is_active=False)


@router.post("/users")
async def create_user(
    body: UserCreate, request: Request, admin: dict = Depends(require_admin),
) -> Dict[str, Any]:
    auth = get_postgres_auth_service()
    db = auth.db
    existing = await db.execute_one_async(
        "SELECT id FROM users WHERE email = $1", body.email,
    )
    if existing:
        raise HTTPException(status_code=400, detail="Email already in use")

    pw_hash = hash_password(body.password)
    row = await db.execute_one_async(
        """
        INSERT INTO users (email, password_hash, first_name, last_name,
                           user_role, email_verified, is_active)
        VALUES ($1, $2, $3, $4, $5, TRUE, TRUE)
        RETURNING id, email, first_name, last_name, user_role, is_active, created_at
        """,
        body.email, pw_hash, body.first_name, body.last_name, body.user_role,
    )
    out = dict(row)
    out["id"] = str(out["id"])
    out["created_at"] = out["created_at"].isoformat() if out.get("created_at") else None
    await audit_service.record(
        admin, "user.create",
        target_type="user", target_id=out["id"],
        after={k: v for k, v in out.items() if k != "password_hash"},
        request=request,
    )
    return out


@router.delete("/users/{user_id}")
async def delete_user(
    user_id: UUID, body: DeleteRequest, request: Request,
    admin: dict = Depends(require_admin),
) -> Dict[str, Any]:
    if str(user_id) == str(admin["id"]):
        raise HTTPException(status_code=400, detail="Cannot delete yourself")
    auth = get_postgres_auth_service()
    user = await auth.get_user_by_id(user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if body.hard:
        await auth.db.execute_async("DELETE FROM users WHERE id = $1", user_id)
        action = "user.delete_hard"
    else:
        await auth.db.execute_async(
            "UPDATE users SET is_active = FALSE, updated_at = NOW() WHERE id = $1",
            user_id,
        )
        action = "user.delete_soft"
    await audit_service.record(
        admin, action,
        target_type="user", target_id=str(user_id),
        before={k: v for k, v in user.items() if k != "password_hash"},
        request=request,
    )
    return {"deleted": True, "hard": body.hard, "user_id": str(user_id)}


@router.post("/users/{user_id}/force-password-reset")
async def force_password_reset(
    user_id: UUID, request: Request,
    ttl_hours: int = Query(24, ge=1, le=168),
    admin: dict = Depends(require_admin),
) -> Dict[str, Any]:
    """
    Generate a one-time reset token. The plaintext token is returned ONCE
    so the admin can deliver it (email, IM, paper) to the user. The DB
    only stores its sha256 hash.
    """
    auth = get_postgres_auth_service()
    user = await auth.get_user_by_id(user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    plaintext = secrets.token_urlsafe(32)
    digest = hashlib.sha256(plaintext.encode("utf-8")).hexdigest()
    expires = datetime.now(tz=timezone.utc) + timedelta(hours=ttl_hours)
    await auth.db.execute_async(
        """
        INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, issued_by)
        VALUES ($1, $2, $3, $4)
        """,
        user_id, digest, expires, admin["id"],
    )
    await audit_service.record(
        admin, "user.force_reset_issued",
        target_type="user", target_id=str(user_id),
        metadata={"ttl_hours": ttl_hours, "expires_at": expires.isoformat()},
        request=request,
    )
    return {
        "user_id":   str(user_id),
        "token":     plaintext,            # show ONCE — copy now
        "expires_at": expires.isoformat(),
        "ttl_hours": ttl_hours,
    }


@router.post("/users/{user_id}/set-password")
async def set_password_directly(
    user_id: UUID, body: SetPasswordRequest, request: Request,
    admin: dict = Depends(require_admin),
) -> Dict[str, Any]:
    """Admin override: set a user's password directly. Audited."""
    auth = get_postgres_auth_service()
    user = await auth.get_user_by_id(user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    new_hash = hash_password(body.new_password)
    await auth.db.execute_async(
        "UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2",
        new_hash, user_id,
    )
    await audit_service.record(
        admin, "user.password_set_by_admin",
        target_type="user", target_id=str(user_id),
        request=request,
    )
    return {"updated": True, "user_id": str(user_id)}


@router.get("/users/{user_id}/audit")
async def per_user_audit(
    user_id: UUID, limit: int = Query(50, ge=1, le=500),
    _: dict = Depends(require_admin),
) -> Dict[str, Any]:
    rows = await audit_service.list_entries(
        target_type="user", target_id=str(user_id), limit=limit,
    )
    return {"user_id": str(user_id), "entries": rows}
