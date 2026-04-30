"""
Authentication Utilities
========================
JWT token generation, password hashing, and auth helpers.

Author: Simorgh Industrial Assistant
"""

import os
import logging
from datetime import datetime, timedelta
from typing import Optional, Dict, Any
from passlib.context import CryptContext
from jose import JWTError, jwt

logger = logging.getLogger(__name__)

# Password hashing context
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

# JWT Configuration
SECRET_KEY = os.getenv("JWT_SECRET_KEY", "your-secret-key-change-in-production-please")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = int(os.getenv("JWT_EXPIRE_MINUTES", "1440"))  # 24 hours default


def verify_password(plain_password: str, hashed_password: str) -> bool:
    """
    Verify a plain password against a hashed password using bcrypt

    Args:
        plain_password: Plain text password from user input
        hashed_password: Hashed password from database (DraftPassword column)

    Returns:
        True if passwords match, False otherwise
    """
    try:
        return pwd_context.verify(plain_password, hashed_password)
    except Exception as e:
        logger.error(f"Password verification error: {e}")
        return False


def hash_password(password: str) -> str:
    """
    Hash a password using bcrypt

    Args:
        password: Plain text password

    Returns:
        Hashed password string
    """
    return pwd_context.hash(password)


def create_access_token(data: Dict[str, Any], expires_delta: Optional[timedelta] = None) -> str:
    """
    Create a JWT access token

    Args:
        data: Dictionary to encode in the token (typically {"sub": username})
        expires_delta: Optional custom expiration time

    Returns:
        Encoded JWT token string
    """
    to_encode = data.copy()

    if expires_delta:
        expire = datetime.utcnow() + expires_delta
    else:
        expire = datetime.utcnow() + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)

    to_encode.update({"exp": expire})

    try:
        encoded_jwt = jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)
        return encoded_jwt
    except Exception as e:
        logger.error(f"Token creation error: {e}")
        raise


def decode_access_token(token: str) -> Optional[Dict[str, Any]]:
    """
    Decode and verify a JWT access token

    Args:
        token: JWT token string

    Returns:
        Decoded token payload or None if invalid
    """
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        username: str = payload.get("sub")

        if username is None:
            return None

        return payload

    except JWTError as e:
        logger.error(f"Token decode error: {e}")
        return None
    except Exception as e:
        logger.error(f"Unexpected token error: {e}")
        return None


def get_current_username_from_token(token: str) -> Optional[str]:
    """
    Extract username from JWT token

    Args:
        token: JWT token string

    Returns:
        Username or None if invalid
    """
    payload = decode_access_token(token)
    if payload:
        return payload.get("sub")
    return None


# =============================================================================
# FASTAPI DEPENDENCIES
# =============================================================================

from fastapi import Header, HTTPException


async def get_current_user(authorization: str = Header(None)) -> str:
    """
    FastAPI dependency to get current authenticated user from JWT token

    Args:
        authorization: Authorization header (Bearer token)

    Returns:
        Username of authenticated user

    Raises:
        HTTPException: If token is missing, invalid, or expired
    """
    if not authorization:
        raise HTTPException(
            status_code=401,
            detail="Missing authentication token"
        )

    if not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=401,
            detail="Invalid authentication token format"
        )

    token = authorization.replace("Bearer ", "")
    username = get_current_username_from_token(token)

    if not username:
        raise HTTPException(
            status_code=401,
            detail="Invalid or expired token"
        )

    return username


async def get_current_user_payload(authorization: str = Header(None)) -> Dict[str, Any]:
    """
    FastAPI dependency that returns the FULL decoded JWT payload, not just the
    username. Use this when you need claims such as `role_category`,
    `department`, etc. (added by auth-service legacy-login enrichment).

    Falls back to a Redis lookup of `user_profile:{user_id}` for any claim
    that isn't on the JWT (compatibility while the enrichment rolls out).

    Returns:
        Dict with at least {"sub": user_id, ...claims...}.
    """
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid token")

    token = authorization.replace("Bearer ", "")
    payload = decode_access_token(token)
    if not payload or not payload.get("sub"):
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    # Best-effort: enrich from Redis user_profile if claims are missing.
    if "role_category" not in payload:
        try:
            from services.redis_service import get_redis_service
            r = get_redis_service()
            cached = r.get(f"user_profile:{payload['sub']}") if r else None
            if cached:
                # cached may be a dict already, or a JSON string
                import json as _json
                prof = cached if isinstance(cached, dict) else _json.loads(cached)
                payload.setdefault("role_category", prof.get("role_category"))
                payload.setdefault("department",    prof.get("department"))
        except Exception:
            pass

    return payload


def require_role(*allowed: str):
    """
    Dependency factory: only allow users whose role_category is in `allowed`.
    Usage:
        @router.post("/projects",
                     dependencies=[Depends(require_role("expert_technical"))])

    Or to also receive the payload:
        async def create_project(
            data: ProjectCreate,
            user = Depends(require_role("expert_technical")),
        ): ...
    """
    allowed_set = set(allowed)

    async def _dep(payload: Dict[str, Any] = Depends(get_current_user_payload)) -> Dict[str, Any]:
        role = payload.get("role_category")
        if role not in allowed_set:
            raise HTTPException(
                status_code=403,
                detail=f"role_category '{role}' is not permitted (need one of: {sorted(allowed_set)})",
            )
        return payload

    return _dep
