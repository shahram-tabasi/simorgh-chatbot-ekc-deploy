"""
Local auth dependency for admin-service routes. Mirrors the contract of
`auth-service/routes/auth_v2.py:get_current_user` but only does what
admin-service actually needs (decode JWT, load user from postgres_auth).

Replaces the broken `from routes.auth_v2 import get_current_user` import
in routes/admin.py — that module does not exist in this service.
"""
from __future__ import annotations

from typing import Optional
from uuid import UUID

from fastapi import Cookie, Depends, Header, HTTPException, Request

from services.postgres_auth_service import (
    PostgresAuthService,
    get_postgres_auth_service,
)


async def get_current_user(
    request: Request,
    authorization: Optional[str] = Header(None),
    access_token: Optional[str] = Cookie(None),
    auth_service: PostgresAuthService = Depends(get_postgres_auth_service),
) -> dict:
    token = None
    if authorization and authorization.startswith("Bearer "):
        token = authorization[len("Bearer "):]
    elif access_token:
        token = access_token
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")

    payload = auth_service.decode_token(token)
    if not payload:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    sub = payload.get("sub")
    if not sub:
        raise HTTPException(status_code=401, detail="Invalid token payload")

    user = await auth_service.get_user_by_id(UUID(sub))
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    if not user.get("is_active", True):
        raise HTTPException(status_code=401, detail="Account is not active")
    return user


async def require_admin(current_user: dict = Depends(get_current_user)) -> dict:
    role = (current_user.get("user_role") or "").lower()
    if role != "admin" and not current_user.get("is_superuser"):
        raise HTTPException(status_code=403, detail="Admin access required")
    return current_user
