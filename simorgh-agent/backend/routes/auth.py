"""
Authentication Routes
=====================
Login, logout, and permission check endpoints.

Author: Simorgh Industrial Assistant
"""

from fastapi import APIRouter, HTTPException, Depends, Header
from pydantic import BaseModel
from typing import Optional
import logging
from services.tpms_auth_service import get_tpms_auth_service, TPMSAuthService
from services.auth_utils import create_access_token, get_current_username_from_token

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["Authentication"])


# =============================================================================
# PYDANTIC MODELS
# =============================================================================

class LoginRequest(BaseModel):
    """Login request"""
    username: str
    password: str


class LoginResponse(BaseModel):
    """Login response"""
    access_token: str
    token_type: str = "bearer"
    user: dict


class PermissionCheckRequest(BaseModel):
    """Project permission check request"""
    project_id: str


class PermissionCheckResponse(BaseModel):
    """Project permission check response"""
    has_access: bool
    project_id: str
    username: str
    message: Optional[str] = None


# =============================================================================
# AUTHENTICATION ENDPOINTS
# =============================================================================

@router.post("/login", response_model=LoginResponse)
async def login(
    request: LoginRequest,
    tpms_auth: TPMSAuthService = Depends(get_tpms_auth_service)
):
    """
    Authenticate user and return JWT token

    **Process:**
    1. Verify username and password against technical_user table
    2. Password is hashed with bcrypt - compared using bcrypt
    3. Return JWT token + user info if successful

    **Example Request:**
    ```json
    {
        "username": "ali.rezaei",
        "password": "mypassword123"
    }
    ```

    **Example Response:**
    ```json
    {
        "access_token": "eyJhbGciOiJIUzI1NiIs...",
        "token_type": "bearer",
        "user": {
            "ID": 123,
            "EMPUSERNAME": "ali.rezaei",
            "USER_UID": "AR001"
        }
    }
    ```
    """
    # Authenticate user
    user = tpms_auth.authenticate_user(request.username, request.password)

    if not user:
        raise HTTPException(
            status_code=401,
            detail="Invalid username or password"
        )

    # Create JWT token
    access_token = create_access_token(data={"sub": user["EMPUSERNAME"]})

    logger.info(f"✅ User logged in: {user['EMPUSERNAME']}")

    return LoginResponse(
        access_token=access_token,
        user=user
    )


@router.get("/me")
async def get_current_user(
    authorization: str = Header(None),
    tpms_auth: TPMSAuthService = Depends(get_tpms_auth_service)
):
    """
    Get current user info from JWT token

    **Headers:**
    - Authorization: Bearer <token>

    **Example Response:**
    ```json
    {
        "ID": 123,
        "EMPUSERNAME": "ali.rezaei",
        "USER_UID": "AR001"
    }
    ```
    """
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid authorization header")

    token = authorization.replace("Bearer ", "")
    username = get_current_username_from_token(token)

    if not username:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    user = tpms_auth.get_user_by_username(username)

    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    return user


# =============================================================================
# AUTHORIZATION ENDPOINTS
# =============================================================================

@router.post("/check-permission", response_model=PermissionCheckResponse)
async def check_project_permission(
    request: PermissionCheckRequest,
    authorization: str = Header(None),
    tpms_auth: TPMSAuthService = Depends(get_tpms_auth_service)
):
    """
    Check if current user has access to a project

    **Process:**
    1. Extract username from JWT token
    2. Check draft.permission table for (project_ID, user) match
    3. Return access result

    **Headers:**
    - Authorization: Bearer <token>

    **Example Request:**
    ```json
    {
        "project_id": "11849"
    }
    ```

    **Example Response (Access Granted):**
    ```json
    {
        "has_access": true,
        "project_id": "11849",
        "username": "ali.rezaei",
        "message": "Access granted"
    }
    ```

    **Example Response (Access Denied):**
    ```json
    {
        "has_access": false,
        "project_id": "11849",
        "username": "ali.rezaei",
        "message": "You don't have access to this Project"
    }
    ```
    """
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid authorization header")

    token = authorization.replace("Bearer ", "")
    username = get_current_username_from_token(token)

    if not username:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    # Check permission
    has_access = tpms_auth.check_project_permission(username, request.project_id)

    return PermissionCheckResponse(
        has_access=has_access,
        project_id=request.project_id,
        username=username,
        message="Access granted" if has_access else "You don't have access to this Project"
    )


@router.get("/my-projects")
async def get_my_projects(
    authorization: str = Header(None),
    tpms_auth: TPMSAuthService = Depends(get_tpms_auth_service)
):
    """
    Get list of projects the current user has access to

    **Headers:**
    - Authorization: Bearer <token>

    **Example Response:**
    ```json
    {
        "username": "ali.rezaei",
        "projects": ["11849", "11850", "12001"]
    }
    ```
    """
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid authorization header")

    token = authorization.replace("Bearer ", "")
    username = get_current_username_from_token(token)

    if not username:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    projects = tpms_auth.get_user_projects(username)

    return {
        "username": username,
        "projects": projects
    }
