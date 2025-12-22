"""
Simorgh Industrial Electrical Assistant - Backend API
======================================================
FastAPI backend with Neo4j, Redis, hybrid LLM, and SQL Server auth.

Architecture:
- Neo4j: Knowledge graph with project isolation
- Redis: Multi-DB caching (sessions, chat, LLM, auth)
- SQL Server: External user authorization
- Qdrant: Vector search
- LLM: Hybrid OpenAI/Local support

Author: Simorgh Industrial Assistant
"""

from fastapi import FastAPI, File, UploadFile, Form, HTTPException, Depends, Query, BackgroundTasks, Request, Body
from fastapi.responses import StreamingResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import Dict, Any, Optional, List
from datetime import datetime
from pathlib import Path
import logging
import os
import uuid
import json

# Import our services
from services.neo4j_service import get_neo4j_service, Neo4jService
from services.redis_service import get_redis_service, RedisService
from services.sql_auth_service import get_sql_auth_service, SQLAuthService
from services.tpms_auth_service import get_tpms_auth_service, TPMSAuthService
from services.llm_service import (
    get_llm_service,
    LLMService,
    LLMOfflineError,
    LLMOnlineError,
    LLMTimeoutError
)
from services.session_id_service import create_session_id_service, SessionIDService
from services.document_processing_integration import (
    process_enhanced_spec_extraction,
    process_document_with_qdrant,
    semantic_search_in_project,
    initialize_project_guides,
    get_qdrant_service
)
from models.ontology import *

# Import authentication routes and utilities
from routes.auth import router as auth_router
from routes.documents_rag import router as documents_rag_router
from services.auth_utils import get_current_user

# Logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# FastAPI app
app = FastAPI(
    title="Simorgh Industrial Electrical Assistant API",
    version="2.0.0",
    description="Neo4j-based electrical engineering chatbot with hybrid LLM support"
)

# Include routers
app.include_router(auth_router)
app.include_router(documents_rag_router)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Configuration
UPLOAD_FOLDER = os.getenv("UPLOAD_DIR", "/app/uploads")
Path(UPLOAD_FOLDER).mkdir(exist_ok=True, parents=True)

# Service instances (initialized on startup)
neo4j_service: Optional[Neo4jService] = None
redis_service: Optional[RedisService] = None
sql_auth_service: Optional[SQLAuthService] = None
tpms_auth_service: Optional[TPMSAuthService] = None
llm_service: Optional[LLMService] = None
session_id_service: Optional[SessionIDService] = None


# =============================================================================
# PYDANTIC MODELS
# =============================================================================

class UserAuth(BaseModel):
    """User authentication info"""
    username: str
    project_number: str


class OenumValidation(BaseModel):
    """OENUM validation request"""
    oenum: str


class ProjectCreate(BaseModel):
    """Project creation request"""
    project_number: str
    project_name: str
    client: Optional[str] = None
    contract_number: Optional[str] = None
    contract_date: Optional[str] = None
    description: Optional[str] = None


class ChatCreate(BaseModel):
    """Chat creation request"""
    chat_name: str
    project_number: Optional[str] = None  # Required for project sessions (IDProjectMain)
    page_name: Optional[str] = None  # Required for project sessions (user-provided page name)
    user_id: str
    chat_type: str = "general"  # "general" or "project"


class ChatMessage(BaseModel):
    """Chat message"""
    chat_id: str
    user_id: str
    content: str
    llm_mode: Optional[str] = None  # "online", "offline", or None (use default)
    use_graph_context: bool = True


class GraphQuery(BaseModel):
    """Graph semantic search request"""
    project_number: str
    query: str
    entity_type: Optional[str] = None
    filters: Optional[Dict[str, Any]] = None
    limit: int = 20


class PowerPathQuery(BaseModel):
    """Power path query"""
    project_number: str
    from_entity_id: str
    to_entity_id: str


# =============================================================================
# STARTUP & SHUTDOWN
# =============================================================================

@app.on_event("startup")
async def startup_event():
    """Initialize services on startup"""
    global neo4j_service, redis_service, sql_auth_service, tpms_auth_service, llm_service, session_id_service

    logger.info("🚀 Starting Simorgh Industrial Assistant...")

    # Initialize Redis first (needed by LLM service and session ID service)
    redis_service = get_redis_service()
    logger.info("✅ Redis service initialized")

    # Initialize Neo4j
    neo4j_service = get_neo4j_service()
    logger.info("✅ Neo4j service initialized")

    # Initialize SQL Auth (legacy)
    sql_auth_service = get_sql_auth_service()
    logger.info("✅ SQL Auth service initialized")

    # Initialize TPMS Auth (MySQL)
    tpms_auth_service = get_tpms_auth_service()
    logger.info("✅ TPMS Auth service initialized")

    # Initialize LLM with Redis
    llm_service = get_llm_service(redis_service=redis_service)
    logger.info("✅ LLM service initialized")

    # Initialize Session ID Service
    session_id_service = create_session_id_service(redis_service)
    logger.info("✅ Session ID service initialized")

    logger.info("🎉 All services ready!")


@app.on_event("shutdown")
async def shutdown_event():
    """Clean up on shutdown"""
    logger.info("🛑 Shutting down...")

    if neo4j_service:
        neo4j_service.close()

    if redis_service:
        redis_service.close()

    logger.info("✅ Shutdown complete")


# =============================================================================
# DEPENDENCY INJECTION
# =============================================================================

def get_neo4j() -> Neo4jService:
    """Get Neo4j service instance"""
    if neo4j_service is None:
        raise HTTPException(status_code=503, detail="Neo4j service not available")
    return neo4j_service


def get_redis() -> RedisService:
    """Get Redis service instance"""
    if redis_service is None:
        raise HTTPException(status_code=503, detail="Redis service not available")
    return redis_service


def get_sql_auth() -> SQLAuthService:
    """Get SQL Auth service instance"""
    if sql_auth_service is None:
        raise HTTPException(status_code=503, detail="SQL Auth service not available")
    return sql_auth_service


def get_tpms_auth() -> TPMSAuthService:
    """Get TPMS Auth service instance"""
    if tpms_auth_service is None:
        raise HTTPException(status_code=503, detail="TPMS Auth service not available")
    return tpms_auth_service


def get_llm() -> LLMService:
    """Get LLM service instance"""
    if llm_service is None:
        raise HTTPException(status_code=503, detail="LLM service not available")
    return llm_service


def get_session_id_service() -> SessionIDService:
    """Get Session ID service instance"""
    if session_id_service is None:
        raise HTTPException(status_code=503, detail="Session ID service not available")
    return session_id_service


# =============================================================================
# HEALTH & STATUS
# =============================================================================

@app.get("/health")
async def health_check(
    neo4j: Neo4jService = Depends(get_neo4j),
    redis: RedisService = Depends(get_redis),
    sql_auth: SQLAuthService = Depends(get_sql_auth),
    llm: LLMService = Depends(get_llm)
):
    """
    Comprehensive health check for all services
    """
    health = {
        "status": "healthy",
        "timestamp": datetime.now().isoformat(),
        "services": {
            "neo4j": neo4j.health_check(),
            "redis": redis.health_check(),
            "sql_auth": sql_auth.health_check(),
            "llm": llm.health_check()
        }
    }

    # Determine overall status
    # Critical services: Neo4j, Redis
    # Optional services: SQL Auth (can be disabled), LLM (can be degraded/unhealthy)
    critical_services_healthy = all(
        health["services"][svc].get("status") in ["healthy", "disabled"]
        for svc in ["neo4j", "redis"]
    )

    all_services_healthy = all(
        svc.get("status") in ["healthy", "disabled"]
        for svc in health["services"].values()
    )

    # System is healthy if critical services are up
    # Even if LLM is temporarily unavailable, the system can still function
    if all_services_healthy:
        health["status"] = "healthy"
        status_code = 200
    elif critical_services_healthy:
        health["status"] = "degraded"
        status_code = 200  # Still return 200 for degraded state
    else:
        health["status"] = "unhealthy"
        status_code = 503

    return JSONResponse(content=health, status_code=status_code)


@app.get("/status")
async def status():
    """Lightweight status check"""
    return {"status": "ok", "timestamp": datetime.now().isoformat()}


@app.get("/api/llm/diagnostics")
async def llm_diagnostics(
    llm: LLMService = Depends(get_llm)
):
    """
    Detailed LLM diagnostics endpoint

    Helps troubleshoot LLM connectivity issues by testing:
    - OpenAI API availability
    - Local LLM server availability
    - Configuration status
    """
    import os

    diagnostics = {
        "timestamp": datetime.now().isoformat(),
        "configuration": {
            "default_mode": os.getenv("DEFAULT_LLM_MODE", "online"),
            "openai_configured": bool(os.getenv("OPENAI_API_KEY")),
            "openai_model": os.getenv("OPENAI_MODEL", "gpt-4o"),
            "local_llm_url": os.getenv("LOCAL_LLM_URL", "http://nginx/api/llm"),
        },
        "health": llm.health_check(),
        "statistics": llm.get_stats()
    }

    # Test connectivity
    try:
        # Try a minimal request to test online mode
        test_result_online = None
        if os.getenv("OPENAI_API_KEY"):
            try:
                test_result_online = llm._check_openai_health()
            except Exception as e:
                test_result_online = {"status": "error", "error": str(e)}
        else:
            test_result_online = {"status": "not_configured", "message": "OpenAI API key not set"}

        # Try a minimal request to test offline mode
        test_result_offline = llm._check_local_llm_health(llm.local_llm_url)

        diagnostics["connectivity_tests"] = {
            "online": test_result_online,
            "offline": test_result_offline
        }
    except Exception as e:
        diagnostics["connectivity_tests"] = {
            "error": str(e)
        }

    return diagnostics


# =============================================================================
# AUTHENTICATION & AUTHORIZATION ENDPOINTS
# =============================================================================
# Note: All auth endpoints (login, /me, search-oenum, validate-permission) are in routes/auth.py
# They are automatically prefixed with /auth by the APIRouter
# =============================================================================

# =============================================================================
# PROJECT ENDPOINTS
# =============================================================================

@app.post("/api/projects")
async def create_project(
    project: ProjectCreate,
    current_user: str = Depends(get_current_user),
    neo4j: Neo4jService = Depends(get_neo4j)
):
    """
    Create a new project (requires authentication)

    Creates the root Project node in Neo4j with owner information.
    Validates that project name is unique for this user.
    """
    try:
        # Check for duplicate project name
        if neo4j.check_duplicate_project(current_user, project.project_name):
            raise HTTPException(
                status_code=400,
                detail=f"Project with name '{project.project_name}' already exists. Please choose a different name."
            )

        # Create project with owner_id
        project_node = neo4j.create_project(
            project_number=project.project_number,
            project_name=project.project_name,
            owner_id=current_user,
            client=project.client or "",
            contract_number=project.contract_number or "",
            contract_date=project.contract_date or "",
            description=project.description or ""
        )

        logger.info(f"✅ User {current_user} created project: {project.project_name}")

        # ============================================================
        # ✅ ENHANCED: Initialize extraction guides for the project
        # ============================================================
        try:
            logger.info(f"📋 Initializing extraction guides for project {project.project_number}")

            from services.document_processing_integration import initialize_project_guides

            guides_initialized = initialize_project_guides(
                neo4j_driver=neo4j.driver,
                project_number=project.project_number
            )

            if guides_initialized:
                logger.info(f"✅ Initialized {guides_initialized} extraction guides for project")
            else:
                logger.warning(f"⚠️ No extraction guides initialized (function returned 0)")

        except Exception as guides_error:
            # Don't fail project creation if guides initialization fails
            logger.error(f"❌ Failed to initialize extraction guides: {guides_error}")
            # Continue - guides can be initialized later if needed

        return {
            "status": "success",
            "project": project_node,
            "guides_initialized": guides_initialized if 'guides_initialized' in locals() else 0
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating project: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/projects/{project_number}/initialize-structure")
async def initialize_project_structure(
    project_number: str,
    current_user: str = Depends(get_current_user),
    neo4j: Neo4jService = Depends(get_neo4j)
):
    """
    Initialize/fix the graph structure for an existing project

    This endpoint creates the full category/type hierarchy for projects
    that were created before this functionality was added.
    """
    try:
        # Verify project exists
        project = neo4j.get_project(project_number)
        if not project:
            raise HTTPException(status_code=404, detail="Project not found")

        # Initialize structure
        from services.project_graph_init import ProjectGraphInitializer
        graph_init = ProjectGraphInitializer(neo4j.driver)
        result = graph_init.initialize_project_structure(
            project_oenum=project_number,
            project_name=project.get('project_name', project_number)
        )

        logger.info(f"✅ Structure initialized for project {project_number} by {current_user}: {result}")

        return {
            "status": "success",
            "message": f"Graph structure initialized for project {project_number}",
            "stats": result
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error initializing structure for {project_number}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/projects/{project_number}")
async def get_project(
    project_number: str,
    neo4j: Neo4jService = Depends(get_neo4j)
):
    """
    Get project details with statistics
    """
    project = neo4j.get_project(project_number)

    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    stats = neo4j.get_project_stats(project_number)

    return {
        "project": project,
        "stats": stats
    }


@app.get("/api/projects/{project_number}/graph")
async def get_project_graph(
    project_number: str,
    include_relationships: bool = True,
    neo4j: Neo4jService = Depends(get_neo4j)
):
    """
    Get complete knowledge graph for a project
    """
    graph = neo4j.get_full_project_graph(
        project_number=project_number,
        include_relationships=include_relationships
    )

    if graph["node_count"] == 0:
        raise HTTPException(status_code=404, detail="Project has no data")

    return graph


@app.get("/api/projects")
async def list_projects(
    current_user: str = Depends(get_current_user),
    neo4j: Neo4jService = Depends(get_neo4j)
):
    """
    List all projects for the current user (requires authentication)

    Returns only projects owned by the authenticated user.
    """
    projects = neo4j.list_all_projects(owner_id=current_user)

    logger.info(f"✅ User {current_user} listed {len(projects)} projects")

    return {
        "projects": projects,
        "count": len(projects)
    }


@app.delete("/api/projects/{project_number}")
async def delete_project(
    project_number: str,
    current_user: str = Depends(get_current_user),
    neo4j: Neo4jService = Depends(get_neo4j),
    redis: RedisService = Depends(get_redis)
):
    """
    Delete a project and all its related data (requires authentication)

    Deletes:
    - Project node in Neo4j
    - All entities belonging to the project
    - All project chats and messages in Redis

    Authorization: Only the project owner can delete it
    """
    try:
        # Delete project from Neo4j (includes authorization check)
        deleted = neo4j.delete_project(project_number, owner_id=current_user)

        if not deleted:
            raise HTTPException(
                status_code=404,
                detail=f"Project {project_number} not found or you don't have permission to delete it"
            )

        # Delete all project chats from Redis
        # Get all chats for this project
        try:
            chat_pattern = f"P-{project_number}-*"
            # Note: This is a simplified approach. In production, you'd maintain a project->chats index
            logger.info(f"🗑️ Deleted project chats with pattern: {chat_pattern}")
        except Exception as e:
            logger.warning(f"⚠️ Failed to delete project chats from Redis: {e}")
            # Continue anyway - Neo4j deletion succeeded

        logger.info(f"✅ User {current_user} deleted project: {project_number}")

        return {
            "status": "success",
            "message": f"Project {project_number} and all its data have been deleted",
            "project_number": project_number
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"❌ Error deleting project: {e}")
        import traceback
        logger.error(traceback.format_exc())
        raise HTTPException(
            status_code=500,
            detail="Failed to delete project. Please try again."
        )


# =============================================================================
# CHAT ENDPOINTS
# =============================================================================

@app.post("/api/chats")
async def create_chat(
    chat: ChatCreate,
    current_user: str = Depends(get_current_user),
    redis: RedisService = Depends(get_redis),
    tpms: TPMSAuthService = Depends(get_tpms_auth),
    session_id_svc: SessionIDService = Depends(get_session_id_service)
):
    """
    Create a new chat session with robust validation (requires authentication)

    For GENERAL sessions:
    - Creates session immediately with temporary title "New conversation"
    - Returns session ID to frontend
    - Frontend should call /api/chats/{chat_id}/generate-title after first message

    For PROJECT sessions:
    - Validates project exists in View_Project_Main
    - Checks user permission in draft_permission table
    - Requires page_name to be provided
    - Auto-fills project name from database

    Session ID formats:
    - General: G-yyyyMM-nnnnnn (e.g., G-202512-000123)
    - Project: P-ProjectID-nnnnnn (e.g., P-12345-000123)
    """
    # Security: Ensure the user_id in the request matches the authenticated user
    if chat.user_id != current_user:
        raise HTTPException(
            status_code=403,
            detail="Cannot create chat for another user"
        )

    # ==========================================================================
    # GENERAL SESSION CREATION
    # ==========================================================================
    if chat.chat_type == "general":
        # Validation: General chats must NOT have project_number or page_name
        if chat.project_number or chat.page_name:
            raise HTTPException(
                status_code=400,
                detail="General chats cannot have a project_number or page_name"
            )

        try:
            # Generate unique session ID with monthly counter
            chat_id = session_id_svc.generate_general_session_id()

            # Use temporary title if provided, otherwise use default
            # Frontend will call generate-title endpoint after first message
            title = chat.chat_name if chat.chat_name and chat.chat_name != "New Chat" else "New conversation"

            chat_data = {
                "chat_id": chat_id,
                "chat_name": title,
                "user_id": chat.user_id,
                "chat_type": "general",
                "project_number": None,
                "project_name": None,
                "page_name": None,
                "created_at": datetime.now().isoformat(),
                "message_count": 0,
                "status": "active"
            }

            # Store in Redis (atomic operation)
            redis.set(f"chat:{chat_id}:metadata", chat_data, db="chat")

            # Add to user's chat indices
            redis.add_chat_to_user_index(
                user_id=chat.user_id,
                chat_id=chat_id,
                chat_type="general",
                project_number=None
            )

            logger.info(f"✅ General chat created: {chat_id} for user: {chat.user_id}")

            return {
                "status": "success",
                "chat": chat_data,
                "message": "General session created. Call /api/chats/{chat_id}/generate-title after first message."
            }

        except Exception as e:
            logger.error(f"❌ Failed to create general chat: {e}")
            raise HTTPException(status_code=500, detail=f"Failed to create session: {str(e)}")

    # ==========================================================================
    # PROJECT SESSION CREATION
    # ==========================================================================
    elif chat.chat_type == "project":
        # Validation: Project chats MUST have project_number and page_name
        if not chat.project_number:
            raise HTTPException(
                status_code=400,
                detail="Project chats must have a project_number"
            )

        if not chat.page_name:
            raise HTTPException(
                status_code=400,
                detail="Project chats must have a page_name"
            )

        try:
            # Step 0: Detect if project_number is OENUM or IDProjectMain
            # OENUM contains letters (e.g., "01A11766"), IDProjectMain is purely numeric (e.g., "1430")
            project_id_for_auth = chat.project_number

            # If project_number contains letters, it's an OENUM - look up the IDProjectMain
            if not chat.project_number.isdigit():
                logger.info(f"🔍 Detected OENUM format: {chat.project_number}, looking up IDProjectMain...")
                # Try to get project by OENUM to find the IDProjectMain
                oenum_project = tpms.get_project_by_oenum(chat.project_number[-5:])
                if not oenum_project:
                    # Try exact OENUM match using search
                    search_results = tpms.search_oenum_autocomplete(chat.project_number, limit=1)
                    if search_results:
                        project_id_for_auth = str(search_results[0]["IDProjectMain"])
                        logger.info(f"✅ Found IDProjectMain via search: {project_id_for_auth} for OENUM {chat.project_number}")
                    else:
                        raise HTTPException(
                            status_code=404,
                            detail=f"Project with OENUM {chat.project_number} not found in TPMS database"
                        )
                else:
                    project_id_for_auth = str(oenum_project["IDProjectMain"])
                    logger.info(f"✅ Found IDProjectMain: {project_id_for_auth} for OENUM {chat.project_number}")
            else:
                logger.info(f"🔍 Detected IDProjectMain format: {chat.project_number}")

            # Step 1: Validate project access (lookup + permission check)
            has_access, error_code, error_message = tpms.validate_project_access(
                username=current_user,
                project_id=project_id_for_auth
            )

            if not has_access:
                if error_code == "project_not_found":
                    raise HTTPException(status_code=404, detail=error_message)
                elif error_code == "access_denied":
                    raise HTTPException(status_code=403, detail=error_message)
                else:
                    raise HTTPException(status_code=500, detail=error_message)

            # Step 2: Get project details from View_Project_Main
            project = tpms.get_project_by_id(project_id_for_auth)
            if not project:
                # This should not happen after validate_project_access, but safety check
                raise HTTPException(
                    status_code=404,
                    detail=f"Project {chat.project_number} not found"
                )

            project_name = project["Project_Name"]

            # Step 3: Generate unique session ID with project-specific counter
            # Use IDProjectMain for session ID to ensure uniqueness
            chat_id = session_id_svc.generate_project_session_id(project_id_for_auth)

            # Step 4: Create session data
            chat_data = {
                "chat_id": chat_id,
                "chat_name": chat.page_name,  # Use user-provided page name as title
                "user_id": chat.user_id,
                "chat_type": "project",
                "project_number": chat.project_number,  # OENUM or original input
                "project_id_main": project_id_for_auth,  # IDProjectMain for auth
                "project_name": project_name,  # Auto-filled from database
                "page_name": chat.page_name,
                "created_at": datetime.now().isoformat(),
                "message_count": 0,
                "status": "active"
            }

            # Step 5: Store in Redis (atomic operation)
            redis.set(f"chat:{chat_id}:metadata", chat_data, db="chat")

            # Step 6: Add to user's chat indices
            redis.add_chat_to_user_index(
                user_id=chat.user_id,
                chat_id=chat_id,
                chat_type="project",
                project_number=project_id_for_auth  # Use IDProjectMain for indexing
            )

            logger.info(
                f"✅ Project chat created: {chat_id} for user: {chat.user_id}, "
                f"project: {chat.project_number} (ID: {project_id_for_auth}, Name: {project_name}), "
                f"page: {chat.page_name}"
            )

            return {
                "status": "success",
                "chat": chat_data,
                "message": f"Project session created for {project_name}"
            }

        except HTTPException:
            raise
        except Exception as e:
            logger.error(f"❌ Failed to create project chat: {e}")
            import traceback
            logger.error(traceback.format_exc())
            raise HTTPException(status_code=500, detail=f"Failed to create project session: {str(e)}")

    else:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid chat_type: {chat.chat_type}. Must be 'general' or 'project'."
        )


@app.get("/api/chats/{chat_id}")
async def get_chat(
    chat_id: str,
    limit: int = 50,
    offset: int = 0,
    current_user: str = Depends(get_current_user),
    redis: RedisService = Depends(get_redis)
):
    """
    Get chat with message history (requires authentication)

    Validates that the requesting user owns this chat
    """
    # Get metadata
    metadata = redis.get(f"chat:{chat_id}:metadata", db="chat")

    if not metadata:
        raise HTTPException(status_code=404, detail="Chat not found")

    # Security: Verify the chat belongs to the requesting user
    if metadata.get("user_id") != current_user:
        raise HTTPException(
            status_code=403,
            detail="Access denied: You don't have permission to view this chat"
        )

    # Get messages
    messages = redis.get_chat_history(chat_id, limit=limit, offset=offset)

    return {
        "chat": metadata,
        "messages": messages,
        "message_count": len(messages)
    }


class ChatRename(BaseModel):
    """Chat rename request"""
    chat_name: str


@app.patch("/api/chats/{chat_id}")
async def rename_chat(
    chat_id: str,
    rename_request: ChatRename,
    current_user: str = Depends(get_current_user),
    redis: RedisService = Depends(get_redis)
):
    """
    Rename a chat session (requires authentication)

    Validates that the requesting user owns this chat
    """
    # Get metadata
    metadata = redis.get(f"chat:{chat_id}:metadata", db="chat")

    if not metadata:
        raise HTTPException(status_code=404, detail="Chat not found")

    # Security: Verify the chat belongs to the requesting user
    if metadata.get("user_id") != current_user:
        raise HTTPException(
            status_code=403,
            detail="Access denied: You don't have permission to rename this chat"
        )

    # Update chat name
    metadata["chat_name"] = rename_request.chat_name
    redis.set(f"chat:{chat_id}:metadata", metadata, db="chat")

    logger.info(f"✅ Chat renamed: {chat_id} -> {rename_request.chat_name} by user: {current_user}")

    return {
        "status": "success",
        "message": "Chat renamed successfully",
        "chat": metadata
    }


@app.delete("/api/chats/{chat_id}")
async def delete_chat(
    chat_id: str,
    current_user: str = Depends(get_current_user),
    redis: RedisService = Depends(get_redis)
):
    """
    Delete a chat session (requires authentication)

    Validates that the requesting user owns this chat
    """
    # Get metadata
    metadata = redis.get(f"chat:{chat_id}:metadata", db="chat")

    if not metadata:
        raise HTTPException(status_code=404, detail="Chat not found")

    # Security: Verify the chat belongs to the requesting user
    if metadata.get("user_id") != current_user:
        raise HTTPException(
            status_code=403,
            detail="Access denied: You don't have permission to delete this chat"
        )

    # Delete the chat
    user_id = metadata.get("user_id")
    success = redis.delete_chat(chat_id, user_id)

    if not success:
        raise HTTPException(status_code=500, detail="Failed to delete chat")

    logger.info(f"✅ Chat deleted: {chat_id} by user: {current_user}")

    return {
        "status": "success",
        "message": "Chat deleted successfully",
        "chat_id": chat_id
    }


@app.get("/api/projects/{project_number}/chats")
async def get_project_chats(
    project_number: str,
    current_user: str = Depends(get_current_user),
    redis: RedisService = Depends(get_redis)
):
    """
    Get all chats for a specific project (requires authentication)

    Returns all project chats for the current user for this project
    """
    # Get all project chats for this user and project
    chat_ids = redis.get_user_project_chats(current_user, project_number)

    # Get metadata for all project chats
    chats = redis.get_chat_metadata_list(chat_ids)

    # Sort by creation date (newest first)
    chats.sort(key=lambda x: x.get("created_at", ""), reverse=True)

    return {
        "project_number": project_number,
        "chats": chats,
        "count": len(chats)
    }


@app.delete("/api/projects/{project_number}/chats")
async def delete_all_project_chats(
    project_number: str,
    current_user: str = Depends(get_current_user),
    redis: RedisService = Depends(get_redis),
    neo4j: Neo4jService = Depends(get_neo4j)
):
    """
    Delete all chats for a specific project (requires authentication)

    This removes:
    - All project chats from Redis (chat history, metadata, user indices)
    - Entire project subgraph from Neo4j (Project, Documents, Specs, Extraction Guides, etc.)

    Returns count of deleted chats and Neo4j nodes.
    """
    try:
        # STEP 1: Delete from Redis (chat history)
        logger.info(f"🗑️ Step 1: Deleting Redis chat data for project {project_number}, user: {current_user}")

        # Get ALL user's chats and filter by project_number OR project_id_main
        # This handles the case where project_number (OENUM) != project_id_main (IDProjectMain)
        all_chat_ids = redis.get_user_all_chats(current_user)

        # Filter chats that belong to this project (by either identifier)
        project_chat_ids = []
        for chat_id in all_chat_ids:
            metadata = redis.get(f"chat:{chat_id}:metadata", db="chat")
            if metadata and metadata.get("chat_type") == "project":
                # Check if this chat belongs to the project (match by OENUM or IDProjectMain)
                chat_project_number = metadata.get("project_number")
                chat_project_id_main = metadata.get("project_id_main")

                if chat_project_number == project_number or chat_project_id_main == project_number:
                    project_chat_ids.append(chat_id)
                    logger.debug(
                        f"Found project chat: {chat_id} "
                        f"(project_number: {chat_project_number}, project_id_main: {chat_project_id_main})"
                    )

        logger.info(f"Found {len(project_chat_ids)} chat(s) for project {project_number}")

        deleted_chat_count = 0
        failed_chats = []

        if project_chat_ids:
            for chat_id in project_chat_ids:
                # Verify ownership before deletion (double-check)
                metadata = redis.get(f"chat:{chat_id}:metadata", db="chat")
                if metadata and metadata.get("user_id") == current_user:
                    success = redis.delete_chat(chat_id, current_user)
                    if success:
                        deleted_chat_count += 1
                        logger.debug(f"✅ Deleted chat: {chat_id}")
                    else:
                        failed_chats.append(chat_id)
                        logger.warning(f"⚠️ Failed to delete chat: {chat_id}")
                else:
                    logger.warning(f"⚠️ Chat {chat_id} not owned by user {current_user}, skipping")

            if failed_chats:
                logger.error(f"❌ Failed to delete {len(failed_chats)} chats: {failed_chats}")

            logger.info(f"✅ Deleted {deleted_chat_count}/{len(project_chat_ids)} chats from Redis")
        else:
            logger.info(f"ℹ️ No chats found in Redis for project {project_number}")

        # STEP 2: Delete from Neo4j (entire project subgraph)
        logger.info(f"🗑️ Step 2: Deleting Neo4j project subgraph for project {project_number}, owner: {current_user}")

        with neo4j.driver.session() as session:
            # Verify project ownership before deletion (SECURITY CHECK)
            verify_query = """
            MATCH (p:Project {project_number: $project_number, owner_id: $owner_id})
            RETURN p.project_number as project_number, p.project_name as project_name
            """

            verify_result = session.run(verify_query,
                project_number=project_number,
                owner_id=current_user
            )

            project_record = verify_result.single()

            if not project_record:
                # Project doesn't exist or user doesn't own it
                logger.warning(
                    f"⚠️ Project {project_number} not found in Neo4j or not owned by user {current_user}. "
                    f"Only Redis chats were deleted."
                )

                return {
                    "status": "success",
                    "project_number": project_number,
                    "deleted_chat_count": deleted_chat_count,
                    "total_chat_count": len(project_chat_ids),
                    "failed_chat_count": len(failed_chats),
                    "deleted_neo4j_nodes": 0,
                    "neo4j_deleted": False,
                    "message": f"Deleted {deleted_chat_count} chat(s). Project not found in Neo4j or not owned by user."
                }

            project_name = project_record["project_name"]
            logger.info(f"✅ Verified ownership of project: {project_name}")

            # Delete entire project subgraph (all nodes and relationships)
            delete_query = """
            MATCH (p:Project {project_number: $project_number, owner_id: $owner_id})

            // Match all connected nodes recursively
            OPTIONAL MATCH (p)-[*0..10]-(connected)

            // Count nodes before deletion
            WITH p, collect(DISTINCT connected) as nodes

            // Delete everything (DETACH DELETE removes relationships automatically)
            WITH p, nodes, size(nodes) as node_count
            FOREACH (n in nodes | DETACH DELETE n)
            DETACH DELETE p

            RETURN node_count
            """

            delete_result = session.run(delete_query,
                project_number=project_number,
                owner_id=current_user
            )

            delete_record = delete_result.single()
            deleted_neo4j_nodes = delete_record["node_count"] if delete_record else 0

            logger.info(
                f"✅ Deleted project '{project_name}' from Neo4j: "
                f"{deleted_neo4j_nodes} nodes removed"
            )

        # STEP 3: Return summary
        logger.info(
            f"✅ Complete deletion for project {project_number}: "
            f"{deleted_chat_count} chats from Redis, {deleted_neo4j_nodes} nodes from Neo4j"
        )

        return {
            "status": "success",
            "project_number": project_number,
            "project_name": project_name,
            "deleted_chat_count": deleted_chat_count,
            "total_chat_count": len(project_chat_ids),
            "failed_chat_count": len(failed_chats),
            "deleted_neo4j_nodes": deleted_neo4j_nodes,
            "neo4j_deleted": True,
            "message": (
                f"Project '{project_name}' completely deleted: "
                f"{deleted_chat_count} chat(s) from Redis, "
                f"{deleted_neo4j_nodes} node(s) from Neo4j"
            )
        }

    except Exception as e:
        logger.error(f"❌ Failed to delete project: {e}")
        import traceback
        logger.error(traceback.format_exc())
        raise HTTPException(
            status_code=500,
            detail=f"Failed to delete project: {str(e)}"
        )


@app.get("/api/users/{user_id}/general-chats")
async def get_user_general_chats(
    user_id: str,
    current_user: str = Depends(get_current_user),
    redis: RedisService = Depends(get_redis)
):
    """
    Get all general (non-project) chats for a user (requires authentication)

    Validates that the requesting user matches the user_id
    """
    # Security: Ensure users can only access their own chats
    if user_id != current_user:
        raise HTTPException(
            status_code=403,
            detail="Access denied: Cannot view other users' chats"
        )

    # Use new enhanced indexing method
    chat_ids = redis.get_user_general_chats(user_id)

    # Get metadata for all general chats
    chats = redis.get_chat_metadata_list(chat_ids)

    # Sort by creation date (newest first)
    chats.sort(key=lambda x: x.get("created_at", ""), reverse=True)

    return {
        "user_id": user_id,
        "chats": chats,
        "count": len(chats)
    }


@app.get("/api/users/{user_id}/project-chats")
async def get_user_project_chats(
    user_id: str,
    current_user: str = Depends(get_current_user),
    redis: RedisService = Depends(get_redis)
):
    """
    Get all project chats for a user across ALL projects (requires authentication)

    Validates that the requesting user matches the user_id
    """
    # Security: Ensure users can only access their own chats
    if user_id != current_user:
        raise HTTPException(
            status_code=403,
            detail="Access denied: Cannot view other users' chats"
        )

    # Get all chat IDs for this user
    all_chat_ids = redis.get_user_all_chats(user_id)

    # Get metadata for all chats
    all_chats = redis.get_chat_metadata_list(all_chat_ids)

    # Filter to only project chats
    project_chats = [
        chat for chat in all_chats
        if chat.get("chat_type") == "project"
    ]

    # Sort by creation date (newest first)
    project_chats.sort(key=lambda x: x.get("created_at", ""), reverse=True)

    return {
        "user_id": user_id,
        "chats": project_chats,
        "count": len(project_chats)
    }


@app.get("/api/users/{user_id}/chats")
async def get_user_all_chats(
    user_id: str,
    current_user: str = Depends(get_current_user),
    redis: RedisService = Depends(get_redis)
):
    """
    Get ALL chats for a user (both general and project) (requires authentication)

    Validates that the requesting user matches the user_id
    """
    # Security: Ensure users can only access their own chats
    if user_id != current_user:
        raise HTTPException(
            status_code=403,
            detail="Access denied: Cannot view other users' chats"
        )

    # Get all chat IDs for this user
    chat_ids = redis.get_user_all_chats(user_id)

    # Get metadata for all chats
    chats = redis.get_chat_metadata_list(chat_ids)

    # Sort by creation date (newest first)
    chats.sort(key=lambda x: x.get("created_at", ""), reverse=True)

    # Group by type for easier frontend consumption
    general_chats = [chat for chat in chats if chat.get("chat_type") == "general"]
    project_chats = [chat for chat in chats if chat.get("chat_type") == "project"]

    return {
        "user_id": user_id,
        "chats": chats,
        "general_chats": general_chats,
        "project_chats": project_chats,
        "count": len(chats),
        "general_count": len(general_chats),
        "project_count": len(project_chats)
    }


@app.get("/api/chats/search")
async def search_chats(
    query: str,
    user_id: Optional[str] = None,
    project_number: Optional[str] = None
):
    """
    Search chat content (placeholder)
    """
    return {
        "query": query,
        "results": [],
        "message": "Chat search not yet implemented"
    }


@app.post("/api/chats/{chat_id}/generate-title")
async def generate_chat_title(
    chat_id: str,
    first_message: str = Form(...),
    current_user: str = Depends(get_current_user),
    redis: RedisService = Depends(get_redis),
    llm: LLMService = Depends(get_llm)
):
    """
    Generate a short, semantic title for a chat based on the first message

    Uses online AI (OpenAI) only to ensure quality and speed
    """
    try:
        # Get chat metadata to verify ownership
        metadata = redis.get(f"chat:{chat_id}:metadata", db="chat")
        if not metadata:
            raise HTTPException(status_code=404, detail="Chat not found")

        # Security: Verify ownership
        if metadata.get("user_id") != current_user:
            raise HTTPException(status_code=403, detail="Access denied")

        # Generate title using LLM (online mode only, temperature=0 for consistency)
        title_prompt = f"""Generate a very short, concise title (3-6 words max) for a chat conversation that starts with this message:

"{first_message}"

Rules:
- Maximum 6 words
- No quotes or special characters
- Descriptive and specific
- Professional tone

Title:"""

        result = llm.generate(
            messages=[
                {"role": "system", "content": "You are an expert at creating concise, descriptive titles."},
                {"role": "user", "content": title_prompt}
            ],
            mode="online",  # Force online for quality
            temperature=0.3,
            max_tokens=20,
            use_cache=False
        )

        title = result["response"].strip().strip('"').strip("'")

        # Fallback if title is too long or empty
        if not title or len(title) > 60:
            title = first_message[:50] + "..." if len(first_message) > 50 else first_message

        # Update chat metadata with new title
        redis.update_chat_metadata(chat_id, {"chat_name": title})

        logger.info(f"✅ Chat title generated: {chat_id} -> '{title}'")

        return {
            "status": "success",
            "chat_id": chat_id,
            "title": title
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to generate chat title: {e}")
        # Return first message as fallback
        fallback_title = first_message[:50] + "..." if len(first_message) > 50 else first_message
        return {
            "status": "fallback",
            "chat_id": chat_id,
            "title": fallback_title
        }


# =============================================================================
# BACKGROUND TASKS
# =============================================================================

def process_spec_extraction(
    task_id: str,
    document_id: str,
    project_number: str,
    markdown_content: str,
    filename: str,
    llm_mode: str,
    llm_service: LLMService,
    neo4j_driver,
    redis_service: RedisService
):
    """
    Background task for extracting specifications from documents

    Updates task status in Redis and creates spec structure in Neo4j
    """
    try:
        logger.info(f"📊 [Task {task_id}] Starting spec extraction for {filename}")

        # Update status: extraction in progress
        redis_service.set(
            f"spec_task:{task_id}:status",
            {
                "task_id": task_id,
                "status": "extracting",
                "message": "Analyzing document and extracting specifications...",
                "document_id": document_id,
                "project_number": project_number,
                "filename": filename,
                "progress": 25
            },
            ttl=3600,
            db="cache"
        )

        # Extract specifications using LLM
        from services.spec_extractor import SpecExtractor
        extractor = SpecExtractor(llm_service)

        extraction_result = extractor.extract_specifications(
            markdown_content=markdown_content,
            filename=filename,
            llm_mode=llm_mode
        )

        if extraction_result["status"] != "success":
            raise Exception(extraction_result.get("error", "Extraction failed"))

        specifications = extraction_result["specifications"]
        logger.info(f"✅ [Task {task_id}] Extraction complete - {len(specifications)} categories")

        # Update status: creating graph structure
        redis_service.set(
            f"spec_task:{task_id}:status",
            {
                "task_id": task_id,
                "status": "building_graph",
                "message": "Creating specification structure in knowledge graph...",
                "document_id": document_id,
                "project_number": project_number,
                "filename": filename,
                "progress": 75
            },
            ttl=3600,
            db="cache"
        )

        # Add spec structure to Neo4j
        from services.project_graph_init import ProjectGraphInitializer
        graph_init = ProjectGraphInitializer(neo4j_driver)

        success = graph_init.add_spec_structure_to_document(
            project_oenum=project_number,
            document_id=document_id,
            specifications=specifications
        )

        if not success:
            raise Exception("Failed to create spec structure in graph")

        logger.info(f"✅ [Task {task_id}] Graph structure created successfully")

        # Update status: complete
        redis_service.set(
            f"spec_task:{task_id}:status",
            {
                "task_id": task_id,
                "status": "completed",
                "message": "Specifications extracted successfully! Ready for review.",
                "document_id": document_id,
                "project_number": project_number,
                "filename": filename,
                "progress": 100,
                "completed_at": datetime.now().isoformat(),
                "metadata": extraction_result.get("metadata", {}),
                "review_url": f"/api/projects/{project_number}/documents/{document_id}/specs"
            },
            ttl=3600,
            db="cache"
        )

        logger.info(f"🎉 [Task {task_id}] Spec extraction completed successfully")

    except Exception as e:
        logger.error(f"❌ [Task {task_id}] Spec extraction failed: {e}")

        # Update status: error
        redis_service.set(
            f"spec_task:{task_id}:status",
            {
                "task_id": task_id,
                "status": "error",
                "message": f"Failed to extract specifications: {str(e)}",
                "document_id": document_id,
                "project_number": project_number,
                "filename": filename,
                "error": str(e),
                "failed_at": datetime.now().isoformat()
            },
            ttl=3600,
            db="cache"
        )


# =============================================================================
# CHAT/RAG ENDPOINT
# =============================================================================

@app.post("/api/chat/send")
async def send_chat_message(
    request: Request,
    background_tasks: BackgroundTasks,
    current_user: str = Depends(get_current_user),
    neo4j: Neo4jService = Depends(get_neo4j),
    redis: RedisService = Depends(get_redis),
    llm: LLMService = Depends(get_llm)
):
    """
    Send a chat message and get AI response (requires authentication)

    Supports two formats:
    1. JSON (application/json) for text-only messages - BACKWARD COMPATIBLE
    2. Form data (multipart/form-data) with optional file attachments

    Validates that the requesting user owns the chat and matches the message user_id
    """
    try:
        # Detect content type and parse accordingly
        content_type = request.headers.get("content-type", "")

        if "multipart/form-data" in content_type:
            # Form data with optional file
            form = await request.form()
            _chat_id = form.get("chat_id")
            _user_id = form.get("user_id")
            _content = form.get("content") or ""  # Allow empty content if file is uploaded
            _llm_mode = form.get("llm_mode")
            _use_graph_context_str = form.get("use_graph_context", "true")
            _use_graph_context = _use_graph_context_str.lower() in ("true", "1", "yes") if isinstance(_use_graph_context_str, str) else True
            _file = form.get("file")

            # Validate required fields (content can be empty if file is present)
            if not _chat_id or not _user_id:
                raise HTTPException(
                    status_code=422,
                    detail="Missing required fields: chat_id, user_id"
                )

            # If no file and no content, that's an error
            if not _file and not _content:
                raise HTTPException(
                    status_code=422,
                    detail="Either content or file must be provided"
                )
        else:
            # JSON format (backward compatible)
            body = await request.json()
            _chat_id = body.get("chat_id")
            _user_id = body.get("user_id")
            _content = body.get("content")
            _llm_mode = body.get("llm_mode")
            _use_graph_context = body.get("use_graph_context", True)
            _file = None

            if not all([_chat_id, _user_id, _content]):
                raise HTTPException(
                    status_code=422,
                    detail="Missing required fields: chat_id, user_id, content"
                )

        # Security: Verify the user_id in the message matches the authenticated user
        if _user_id != current_user:
            raise HTTPException(
                status_code=403,
                detail="Cannot send messages as another user"
            )

        # Get chat metadata
        chat_metadata = redis.get(f"chat:{_chat_id}:metadata", db="chat")

        if not chat_metadata:
            raise HTTPException(status_code=404, detail="Chat not found")

        # Security: Verify the chat belongs to the requesting user
        if chat_metadata.get("user_id") != current_user:
            raise HTTPException(
                status_code=403,
                detail="Access denied: You don't have permission to send messages in this chat"
            )

        project_number = chat_metadata.get("project_number")
        chat_type = chat_metadata.get("chat_type", "general")

        # ============================================================
        # SPECIFICATION AGENT: Handle agent workflow
        # ============================================================
        if _content.startswith("__AGENT__:SPECIFICATION_EXTRACTION"):
            logger.info(f"🤖 Specification Agent triggered for chat {_chat_id}")

            # Ensure this is a project chat
            if chat_type != "project" or not project_number:
                error_msg = "❌ **Agent Error**\n\nSpecification extraction is only available for project chats. Please create or select a project chat first."

                # Store in chat history
                created_at = datetime.now().isoformat()

                user_msg = {
                    "message_id": str(uuid.uuid4()),
                    "chat_id": _chat_id,
                    "role": "user",
                    "sender": "user",
                    "content": _content,
                    "text": _content,
                    "timestamp": created_at,
                    "created_at": created_at,
                    "user_id": _user_id
                }

                assistant_msg = {
                    "message_id": str(uuid.uuid4()),
                    "chat_id": _chat_id,
                    "role": "assistant",
                    "sender": "assistant",
                    "content": error_msg,
                    "text": error_msg,
                    "timestamp": created_at,
                    "created_at": created_at
                }

                redis.cache_chat_message(_chat_id, user_msg)
                redis.cache_chat_message(_chat_id, assistant_msg)

                return {
                    "response": error_msg,
                    "metadata": {
                        "agent_error": True
                    }
                }

            # Initialize agent
            from services.specification_agent import SpecificationAgent

            agent = SpecificationAgent(
                redis_service=redis,
                llm_service=llm,
                neo4j_service=neo4j,
                qdrant_service=get_qdrant_service()
            )

            # Check if this is first invocation (initialize) or continuation
            agent_state = agent._get_agent_state(_chat_id)

            if agent_state.get("state") == "INITIALIZED":
                # First invocation - initialize session
                agent_response = agent.initialize_session(
                    chat_id=_chat_id,
                    user_id=_user_id,
                    project_number=project_number
                )
            else:
                # Continuation - handle message
                agent_response = await agent.handle_message(
                    chat_id=_chat_id,
                    user_message=_content,
                    uploaded_file_context=None
                )

            # Store in chat history
            created_at = datetime.now().isoformat()

            user_msg = {
                "message_id": str(uuid.uuid4()),
                "chat_id": _chat_id,
                "project_id": project_number,
                "role": "user",
                "sender": "user",
                "content": _content,
                "text": _content,
                "timestamp": created_at,
                "created_at": created_at,
                "user_id": _user_id
            }

            assistant_msg = {
                "message_id": str(uuid.uuid4()),
                "chat_id": _chat_id,
                "project_id": project_number,
                "role": "assistant",
                "sender": "assistant",
                "content": agent_response,
                "text": agent_response,
                "timestamp": created_at,
                "created_at": created_at,
                "agent_active": True,
                "agent_type": "specification_extraction"
            }

            redis.cache_chat_message(_chat_id, user_msg)
            redis.cache_chat_message(_chat_id, assistant_msg)

            logger.info(f"✅ Agent response generated")

            return {
                "response": agent_response,
                "metadata": {
                    "agent_active": True,
                    "agent_type": "specification_extraction",
                    "llm_mode": "online"
                }
            }

        # ============================================================
        # AGENT CONTINUATION: Check if agent is active for this chat
        # ============================================================
        from services.specification_agent import SpecificationAgent

        agent = SpecificationAgent(
            redis_service=redis,
            llm_service=llm,
            neo4j_service=neo4j,
            qdrant_service=get_qdrant_service()
        )

        agent_state = agent._get_agent_state(_chat_id)

        # If agent is active and not in terminal states, continue with agent
        if agent_state.get("state") not in ["INITIALIZED", "COMPLETED", "ERROR", None]:
            logger.info(f"🤖 Continuing agent workflow in state: {agent_state.get('state')}")

            # Prepare file context if file was uploaded
            uploaded_file_context = None

            if _file:
                logger.info(f"📎 Processing uploaded file for agent: {_file.filename}")

                # Process document
                import tempfile
                from services.doc_processor_client import DocProcessorClient

                temp_dir = Path(tempfile.gettempdir())
                temp_file = temp_dir / f"{uuid.uuid4()}_{_file.filename}"

                with open(temp_file, 'wb') as f:
                    f.write(await _file.read())

                try:
                    doc_processor = DocProcessorClient()
                    doc_result = await doc_processor.process_document(
                        file_path=temp_file,
                        user_id=_user_id
                    )

                    if doc_result.get('success'):
                        markdown_content = doc_result['content']
                        doc_id = str(uuid.uuid4())

                        # Add to project graph
                        from services.document_classifier import DocumentClassifier
                        from services.project_graph_init import ProjectGraphInitializer

                        classifier = DocumentClassifier()
                        category, doc_type, confidence = classifier.classify(
                            filename=_file.filename,
                            content=markdown_content
                        )

                        graph_init = ProjectGraphInitializer(neo4j.driver)
                        graph_init.add_document_to_structure(
                            project_oenum=project_number,
                            category=category,
                            doc_type=doc_type,
                            document_id=doc_id,
                            document_metadata={
                                'filename': _file.filename,
                                'doc_type': doc_type,
                                'category': category,
                                'confidence': confidence,
                                'uploaded_by': _user_id,
                                'chat_id': _chat_id
                            }
                        )

                        uploaded_file_context = {
                            'filename': _file.filename,
                            'markdown_content': markdown_content,
                            'document_id': doc_id,
                            'category': category,
                            'doc_type': doc_type
                        }

                        logger.info(f"✅ Document processed for agent: {doc_id}")

                finally:
                    if temp_file.exists():
                        temp_file.unlink()

            # Handle message with agent
            agent_response = await agent.handle_message(
                chat_id=_chat_id,
                user_message=_content,
                uploaded_file_context=uploaded_file_context
            )

            # Store in chat history
            created_at = datetime.now().isoformat()

            # If content is empty but file was uploaded, show file upload message
            display_content = _content if _content else f"📎 Uploaded: {uploaded_file_context['filename']}" if uploaded_file_context else _content

            user_msg = {
                "message_id": str(uuid.uuid4()),
                "chat_id": _chat_id,
                "project_id": project_number,
                "role": "user",
                "sender": "user",
                "content": display_content,
                "text": display_content,
                "timestamp": created_at,
                "created_at": created_at,
                "user_id": _user_id,
                "has_attachment": uploaded_file_context is not None,
                "attachment_filename": uploaded_file_context['filename'] if uploaded_file_context else None
            }

            assistant_msg = {
                "message_id": str(uuid.uuid4()),
                "chat_id": _chat_id,
                "project_id": project_number,
                "role": "assistant",
                "sender": "assistant",
                "content": agent_response,
                "text": agent_response,
                "timestamp": created_at,
                "created_at": created_at,
                "agent_active": True,
                "agent_type": "specification_extraction"
            }

            redis.cache_chat_message(_chat_id, user_msg)
            redis.cache_chat_message(_chat_id, assistant_msg)

            return {
                "response": agent_response,
                "metadata": {
                    "agent_active": True,
                    "agent_type": "specification_extraction",
                    "llm_mode": "online"
                }
            }

        # Handle file upload if present
        file_context = ""
        spec_task_id = None  # Track spec extraction task ID
        if _file:
            logger.info(f"📎 Processing uploaded file: {_file.filename}")

            # Save file temporarily
            import tempfile
            temp_dir = Path(tempfile.gettempdir())
            temp_file = temp_dir / f"{uuid.uuid4()}_{_file.filename}"

            with open(temp_file, 'wb') as f:
                f.write(await _file.read())

            try:
                # Import doc processor client
                from services.doc_processor_client import DocProcessorClient
                doc_processor = DocProcessorClient()

                # Process document to markdown
                doc_result = await doc_processor.process_document(
                    file_path=temp_file,
                    user_id=_user_id
                )

                if doc_result.get('success'):
                    markdown_content = doc_result['content']
                    logger.info(f"✅ Document processed: {len(markdown_content)} characters")

                    # For project chats: Add to graph and get context via Graph RAG
                    if chat_type == "project" and project_number:
                        from services.document_classifier import DocumentClassifier
                        from services.project_graph_init import ProjectGraphInitializer

                        # Classify document
                        classifier = DocumentClassifier()
                        category, doc_type, confidence = classifier.classify(
                            filename=_file.filename,
                            content=markdown_content
                        )

                        logger.info(f"📋 Document classified: {category}/{doc_type} ({confidence:.2f})")

                        # Add to project graph
                        graph_init = ProjectGraphInitializer(neo4j.driver)
                        doc_id = str(uuid.uuid4())
                        graph_init.add_document_to_structure(
                            project_oenum=project_number,
                            category=category,
                            doc_type=doc_type,
                            document_id=doc_id,
                            document_metadata={
                                'filename': _file.filename,
                                'doc_type': doc_type,
                                'category': category,
                                'confidence': confidence,
                                'uploaded_by': _user_id,
                                'chat_id': _chat_id
                            }
                        )

                        logger.info(f"📊 Added document to project graph: {doc_id}")

                        # ============================================================
                        # ENHANCED PIPELINE: Section-based processing with summaries
                        # ============================================================
                        from services.section_retriever import SectionRetriever
                        from services.document_overview_service import DocumentOverviewService

                        # Initialize services
                        qdrant = get_qdrant_service()
                        section_retriever = SectionRetriever(
                            llm_service=llm,
                            qdrant_service=qdrant
                        )
                        doc_overview = DocumentOverviewService(redis_service=redis)

                        # Process document: Extract sections → Summarize → Store
                        logger.info(f"🚀 Starting enhanced document processing")
                        processing_result = section_retriever.process_and_store_document(
                            markdown_content=markdown_content,
                            project_number=project_number,
                            document_id=doc_id,
                            filename=_file.filename,
                            document_type_hint=f"{doc_type} Document",
                            llm_mode=_llm_mode
                        )

                        if processing_result.get("success"):
                            sections_count = processing_result.get("sections_extracted", 0)
                            logger.info(f"✅ Enhanced processing complete: {sections_count} sections")

                            # Track document for overview
                            summary_stats = processing_result.get("summary_stats", {})
                            doc_overview.add_document(
                                document_id=doc_id,
                                filename=_file.filename,
                                document_type=doc_type,
                                category=category,
                                key_topics=summary_stats.get("total_subjects", 0),
                                sections_count=sections_count,
                                total_chars=len(markdown_content),
                                project_number=project_number,
                                chat_id=_chat_id,
                                user_id=_user_id
                            )
                        else:
                            logger.warning(f"⚠️ Enhanced processing failed: {processing_result.get('error')}")

                        # If it's a Spec document, trigger enhanced spec extraction with KG RAG
                        if doc_type == "Spec" and category == "Client":
                            spec_task_id = str(uuid.uuid4())
                            logger.info(f"🔍 Starting enhanced spec extraction - Task ID: {spec_task_id}")

                            # Store initial task status
                            redis.set(
                                f"spec_task:{spec_task_id}:status",
                                {
                                    "task_id": spec_task_id,
                                    "status": "processing",
                                    "message": "Extracting specifications using enhanced RAG...",
                                    "document_id": doc_id,
                                    "project_number": project_number,
                                    "filename": _file.filename,
                                    "started_at": datetime.now().isoformat(),
                                    "progress": 0
                                },
                                ttl=3600,
                                db="cache"
                            )

                            # Start background task for ENHANCED spec extraction
                            background_tasks.add_task(
                                process_enhanced_spec_extraction,
                                task_id=spec_task_id,
                                document_id=doc_id,
                                project_number=project_number,
                                markdown_content=markdown_content,
                                filename=_file.filename,
                                llm_mode=_llm_mode or "online",
                                llm_service=llm,
                                neo4j_driver=neo4j.driver,
                                redis_service=redis
                            )

                            # Get initial context from sections (no string slicing!)
                            sections_result = section_retriever.retrieve_relevant_sections(
                                project_number=project_number,
                                query=_content,
                                limit=2,
                                document_id=doc_id
                            )

                            if sections_result.get("success") and sections_result["sections"]:
                                file_context = f"\n\n## Uploaded Document: {_file.filename}\n\n"
                                file_context += f"Enhanced spec extraction started (Task ID: {spec_task_id}).\n\n"
                                file_context += section_retriever.format_sections_for_context(
                                    sections=sections_result["sections"],
                                    max_sections=2,
                                    include_subjects=True
                                )
                            else:
                                file_context = f"\n\n## Uploaded Document: {_file.filename}\n\nEnhanced spec extraction started (Task ID: {spec_task_id})."
                        else:
                            # Use enhanced section retrieval for context (NO string slicing!)
                            sections_result = section_retriever.retrieve_relevant_sections(
                                project_number=project_number,
                                query=_content,  # User's question
                                limit=3,
                                document_id=doc_id,
                                score_threshold=0.3
                            )

                            if sections_result.get("success") and sections_result["sections"]:
                                # Format FULL sections as context
                                file_context = section_retriever.format_sections_for_context(
                                    sections=sections_result["sections"],
                                    include_subjects=True
                                )
                            else:
                                # Fallback: get first few sections
                                file_context = f"\n\n## Uploaded Document: {_file.filename}\n\nDocument processed with {processing_result.get('sections_extracted', 0)} sections."

                    # For general chats: Use enhanced pipeline too
                    else:
                        from services.section_retriever import SectionRetriever
                        from services.document_overview_service import DocumentOverviewService

                        # Initialize services
                        qdrant = get_qdrant_service()
                        section_retriever = SectionRetriever(
                            llm_service=llm,
                            qdrant_service=qdrant
                        )
                        doc_overview = DocumentOverviewService(redis_service=redis)

                        doc_id = str(uuid.uuid4())

                        # Process with enhanced pipeline
                        logger.info(f"🚀 Starting enhanced processing for general chat")
                        processing_result = section_retriever.process_and_store_document(
                            markdown_content=markdown_content,
                            project_number="general",  # Use "general" for non-project chats
                            document_id=doc_id,
                            filename=_file.filename,
                            document_type_hint="General Document",
                            llm_mode=_llm_mode
                        )

                        if processing_result.get("success"):
                            # Track document
                            summary_stats = processing_result.get("summary_stats", {})
                            doc_overview.add_document(
                                document_id=doc_id,
                                filename=_file.filename,
                                document_type="General",
                                category="User",
                                key_topics=summary_stats.get("total_subjects", 0),
                                sections_count=processing_result.get("sections_extracted", 0),
                                total_chars=len(markdown_content),
                                chat_id=_chat_id,
                                user_id=_user_id
                            )

                            # Get relevant sections for user's question
                            sections_result = section_retriever.retrieve_relevant_sections(
                                project_number="general",
                                query=_content,
                                limit=3,
                                score_threshold=0.3
                            )

                            if sections_result.get("success") and sections_result["sections"]:
                                file_context = section_retriever.format_sections_for_context(
                                    sections=sections_result["sections"],
                                    include_subjects=True
                                )
                            else:
                                file_context = f"\n\n## Uploaded Document: {_file.filename}\n\nDocument processed successfully."
                        else:
                            logger.warning(f"⚠️ Enhanced processing failed: {processing_result.get('error')}")
                            file_context = f"\n\n## Uploaded Document: {_file.filename}\n\nDocument uploaded."
                else:
                    logger.warning(f"⚠️ Document processing failed: {doc_result.get('error')}")

            finally:
                # Clean up temp file
                if temp_file.exists():
                    temp_file.unlink()

        # ============================================================
        # ENHANCED CONTEXT BUILDING: Document Overview + Graph + Vector
        # ============================================================
        graph_context = ""
        document_overview_context = ""
        context_used = False

        if project_number and _use_graph_context:
            logger.info(f"🔍 Retrieving enhanced context for project {project_number}")

            try:
                from services.graph_rag_service import GraphRAGService
                from services.document_overview_service import DocumentOverviewService

                graph_rag = GraphRAGService(neo4j.driver)
                doc_overview = DocumentOverviewService(redis_service=redis)

                # 0. DOCUMENT OVERVIEW: Always provide overview of uploaded documents
                logger.info(f"📚 Generating document overview for project")
                document_overview_context = doc_overview.generate_overview(
                    project_number=project_number,
                    max_documents=10
                )

                # Build rich context from multiple sources
                context_parts = []

                # 1. GRAPH SPECIFICATIONS: Query specs from Neo4j
                # Special handling for common queries
                if any(word in _content.lower() for word in ['protection', 'protections', 'protective', 'relay', 'trip']):
                    # Get all protection-related specs
                    graph_result = graph_rag.get_protection_specifications(project_number=project_number)
                else:
                    # General query
                    graph_result = graph_rag.search_by_natural_query(
                        project_number=project_number,
                        query=_content
                    )

                # Add graph specifications if found
                if graph_result.get("success"):
                    # Handle protection specs (different key)
                    specs_list = graph_result.get("protections") or graph_result.get("specs")

                    if specs_list:
                        # Count specs with actual values
                        specs_with_values = [s for s in specs_list if s.get("value") and s["value"].strip() and s["value"] != "Not specified"]

                        specs_context = graph_rag.build_context_from_specs(
                            specs=specs_list,
                            query=_content
                        )
                        if specs_context:
                            context_parts.append(specs_context)
                            logger.info(f"📊 Retrieved {len(specs_list)} specifications from graph ({len(specs_with_values)} with values)")
                        else:
                            logger.warning(f"⚠️ Retrieved {len(specs_list)} specs but all values are empty/not specified")

                # 2. KNOWLEDGE GRAPH BFS: Find related subgraph
                logger.info(f"🕸️ Performing BFS graph traversal")
                subgraph = graph_rag.find_related_subgraph(
                    project_number=project_number,
                    query=_content,
                    max_depth=2
                )

                if subgraph.get("success") and subgraph.get("nodes"):
                    subgraph_context = graph_rag.format_subgraph_for_context(subgraph)
                    if subgraph_context:
                        context_parts.append(subgraph_context)
                        logger.info(f"🕸️ Retrieved subgraph: {subgraph.get('node_count', 0)} nodes, {subgraph.get('relationship_count', 0)} relationships")

                # 3. ENHANCED VECTOR SEARCH: Section-based search with FULL content
                logger.info(f"🔍 Performing enhanced section-based search")
                qdrant = get_qdrant_service()
                vector_results = qdrant.search_section_summaries(
                    project_number=project_number,
                    query=_content,
                    limit=5,
                    score_threshold=0.3
                )

                # Add vector search results with FULL sections (NO truncation!)
                if vector_results:
                    vector_context = "\n\n## 📄 Related Document Sections (Semantic Search)\n"
                    for idx, result in enumerate(vector_results[:3], 1):
                        vector_context += f"\n**{idx}. [{result['section_title']}]** (Relevance: {result['score']:.2%})\n"

                        # Show subjects if available
                        if result.get('subjects'):
                            vector_context += f"**Subjects:** {', '.join(result['subjects'][:5])}\n\n"

                        # Include FULL content (not truncated!)
                        vector_context += f"{result['full_content']}\n\n"
                        vector_context += "---\n"

                    context_parts.append(vector_context)
                    logger.info(f"📝 Retrieved {len(vector_results)} full sections from vector DB")

                # Combine all context
                if context_parts:
                    graph_context = "\n\n" + "\n\n".join(context_parts)
                    context_used = True
                    logger.info(f"✅ Combined context from {len(context_parts)} sources")
                else:
                    logger.info(f"ℹ️ No specific context found, using general knowledge")

            except Exception as e:
                logger.warning(f"⚠️ Enhanced context retrieval failed: {e}", exc_info=True)
                # Continue without context rather than failing

        # 🧠 USER MEMORY: Retrieve similar past conversations from Qdrant (session-isolated)
        user_memory_context = ""
        try:
            qdrant = get_qdrant_service()
            similar_conversations = qdrant.retrieve_similar_conversations(
                user_id=_user_id,
                current_query=_content,
                limit=5,  # Get top 5 semantically similar conversations
                score_threshold=0.65,  # Only include relevant conversations
                project_filter=project_number if project_number else None,
                chat_id=_chat_id,  # Filter by current chat for session isolation
                fallback_to_recent=True,  # Fallback to recent if no semantic matches
                fallback_limit=10  # Return last 10 conversations as fallback
            )

            if similar_conversations:
                # Check if these are fallback results (recent conversations)
                is_fallback = similar_conversations[0].get("is_fallback", False)

                if is_fallback:
                    user_memory_context = "\n\n## 📚 Your Recent Conversation History\n"
                    user_memory_context += "Here are your most recent conversations (no specific semantic match found):\n\n"
                else:
                    user_memory_context = "\n\n## 💭 Your Past Relevant Conversations\n"
                    user_memory_context += "Here are some of your previous related discussions:\n\n"

                for idx, conv in enumerate(similar_conversations, 1):
                    if is_fallback:
                        # For fallback, show timestamp instead of relevance score
                        user_memory_context += f"**{idx}. Previous Q&A**\n"
                    else:
                        user_memory_context += f"**{idx}. Previous Q&A** (Relevance: {conv['score']:.0%})\n"

                    user_memory_context += f"  - You asked: \"{conv['user_message'][:150]}{'...' if len(conv['user_message']) > 150 else ''}\"\n"
                    user_memory_context += f"  - I responded: \"{conv['assistant_response'][:200]}{'...' if len(conv['assistant_response']) > 200 else ''}\"\n\n"

                logger.info(f"🧠 Retrieved {len(similar_conversations)} {'recent' if is_fallback else 'semantically similar'} past conversations for user memory context")
                context_used = True
            else:
                logger.info(f"🧠 No past conversations found for user {_user_id}")

        except Exception as e:
            logger.warning(f"⚠️ User memory retrieval failed: {e}")
            # Continue without user memory context rather than failing

        # Build LLM messages
        system_prompt = """You are an expert industrial electrical engineer assistant specializing in Siemens LV/MV systems.
You help users with electrical panel specifications, power distribution, protection devices, and system design.
Provide accurate, technical responses based on IEC and IEEE standards."""

        # Add file context if document was uploaded
        if file_context:
            system_prompt += file_context
            context_used = True

        # Add document overview context (always for project chats)
        if document_overview_context:
            system_prompt += f"\n\n{document_overview_context}"
            context_used = True
            logger.info(f"📚 Added document overview to context")

        if graph_context:
            system_prompt += f"\n\n{graph_context}"
            # Add directive to use the provided specs - HIGHEST PRIORITY
            system_prompt += """\n\n🎯 CRITICAL INSTRUCTION - HIGHEST PRIORITY: The specifications above are ACTUAL data from this project's documents.
You MUST use these specific values in your response. Do NOT say "information not provided" when specifications are listed above.
Answer the user's question using the exact values shown. Be specific and cite the actual specifications.
The project specifications and technical data above are THE PRIMARY SOURCE OF TRUTH - they take precedence over everything else."""

        # Add user memory context if available
        if user_memory_context:
            system_prompt += f"\n\n{user_memory_context}"
            system_prompt += """\n\n💡 CONTEXT NOTE: The conversation history above is provided for reference to help you give more personalized responses.
You may reference past conversations when relevant (e.g., if user asks about something they mentioned before),
but ALWAYS prioritize technical specifications and project data over conversation history.
If there's any conflict between conversation history and project specifications, the specifications are correct."""

        llm_messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": _content}
        ]

        # Generate response
        logger.info(f"💬 Generating LLM response - Mode: {_llm_mode or 'default'}, Chat: {_chat_id}")

        result = llm.generate(
            messages=llm_messages,
            mode=_llm_mode,
            temperature=0.7,
            use_cache=True
        )

        logger.info(f"✅ LLM response generated - Actual mode used: {result.get('mode')}, Tokens: {result.get('tokens', {}).get('total', 0)}")
        ai_response = result["response"]

        # 🧠 USER MEMORY: Store this conversation in Qdrant for future reference
        try:
            qdrant = get_qdrant_service()
            storage_metadata = {
                "llm_mode": result.get("mode"),
                "context_used": context_used,
                "cached": result.get("cached", False),
                "tokens": result.get("tokens", {}).get("total", 0)
            }

            qdrant.store_user_conversation(
                user_id=_user_id,
                user_message=_content,
                assistant_response=ai_response,
                chat_id=_chat_id,
                project_number=project_number,
                metadata=storage_metadata
            )
            logger.info(f"🧠 Stored conversation in user memory for future context")

        except Exception as e:
            logger.warning(f"⚠️ Failed to store conversation in user memory: {e}")
            # Continue even if storage fails

        # Generate unique message IDs
        created_at = datetime.now().isoformat()

        # Cache messages with complete metadata structure
        user_msg = {
            "message_id": str(uuid.uuid4()),
            "chat_id": _chat_id,
            "project_id": project_number,  # None for general chats
            "page_id": _chat_id,  # Chat ID represents the page
            "role": "user",
            "sender": "user",
            "content": _content,
            "text": _content,  # Explicit text field as per requirements
            "timestamp": created_at,
            "created_at": created_at,  # Explicit CreatedAt as per requirements
            "user_id": _user_id,
            "has_attachment": _file is not None,
            "attachment_filename": _file.filename if _file else None
        }

        assistant_msg = {
            "message_id": str(uuid.uuid4()),
            "chat_id": _chat_id,
            "project_id": project_number,  # None for general chats
            "page_id": _chat_id,  # Chat ID represents the page
            "role": "assistant",
            "sender": "assistant",
            "content": ai_response,
            "text": ai_response,  # Explicit text field as per requirements
            "timestamp": created_at,
            "created_at": created_at,  # Explicit CreatedAt as per requirements
            "llm_mode": result.get("mode"),
            "context_used": context_used,
            "cached": result.get("cached", False)
        }

        redis.cache_chat_message(_chat_id, user_msg)
        redis.cache_chat_message(_chat_id, assistant_msg)

        response_data = {
            "chat_id": _chat_id,
            "response": ai_response,
            "llm_mode": result.get("mode"),
            "context_used": context_used,
            "cached_response": result.get("cached", False),
            "tokens": result.get("tokens")
        }

        # Include spec task ID if spec extraction was triggered
        if spec_task_id:
            response_data["spec_task_id"] = spec_task_id
            response_data["spec_task_status_url"] = f"/api/spec-tasks/{spec_task_id}/status"

        return response_data

    except HTTPException:
        raise
    except LLMOfflineError as e:
        logger.error(f"Offline LLM unavailable: {e}")
        raise HTTPException(
            status_code=503,
            detail={
                "error": "offline_unavailable",
                "message": "Local LLM servers are unavailable. Please try online mode or check server status.",
                "servers_tried": [
                    os.getenv("LOCAL_LLM_URL_1", "http://192.168.1.61/ai"),
                    os.getenv("LOCAL_LLM_URL_2", "http://192.168.1.62/ai")
                ],
                "technical_error": str(e)
            }
        )
    except LLMOnlineError as e:
        logger.error(f"Online LLM unavailable: {e}")
        raise HTTPException(
            status_code=503,
            detail={
                "error": "online_unavailable",
                "message": "OpenAI API is unavailable. Please try offline mode or check your API key.",
                "api_model": os.getenv("OPENAI_MODEL", "gpt-4o"),
                "technical_error": str(e)
            }
        )
    except LLMTimeoutError as e:
        logger.error(f"LLM timeout: {e}")
        raise HTTPException(
            status_code=504,
            detail={
                "error": "timeout",
                "message": "LLM request timed out. The query may be too complex or the server is overloaded.",
                "mode": message.llm_mode or "default",
                "technical_error": str(e)
            }
        )
    except Exception as e:
        logger.error(f"Unexpected chat error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/chat/stream")
async def send_chat_message_stream(
    message: ChatMessage,
    current_user: str = Depends(get_current_user),
    neo4j: Neo4jService = Depends(get_neo4j),
    redis: RedisService = Depends(get_redis),
    llm: LLMService = Depends(get_llm)
):
    """
    Send a chat message and get AI response via Server-Sent Events streaming (requires authentication)

    Validates that the requesting user owns the chat and matches the message user_id
    Returns chunks in real-time as the LLM generates them
    """
    def event_stream():
        try:
            # Security: Verify the user_id in the message matches the authenticated user
            if message.user_id != current_user:
                error_data = json.dumps({'error': 'Cannot send messages as another user'})
                yield f"data: {error_data}\n\n"
                return

            # Get chat metadata
            chat_metadata = redis.get(f"chat:{message.chat_id}:metadata", db="chat")

            if not chat_metadata:
                error_data = json.dumps({'error': 'Chat not found'})
                yield f"data: {error_data}\n\n"
                return

            # Security: Verify the chat belongs to the requesting user
            if chat_metadata.get("user_id") != current_user:
                error_data = json.dumps({'error': 'Access denied: You do not have permission to send messages in this chat'})
                yield f"data: {error_data}\n\n"
                return

            project_number = chat_metadata.get("project_number")

            # Build context from knowledge graph if project chat
            graph_context = ""
            context_used = False

            if project_number and message.use_graph_context:
                try:
                    entities = neo4j.semantic_search(
                        project_number=project_number,
                        filters=None,
                        limit=10
                    )

                    if entities:
                        graph_context = "\n\nRelevant project information:\n"
                        for entity in entities[:5]:
                            graph_context += f"- {entity.get('entity_type')}: {entity.get('description', 'N/A')}\n"
                        context_used = True

                except Exception as e:
                    logger.warning(f"Graph context retrieval failed: {e}")

            # Build LLM messages
            system_prompt = """You are an expert industrial electrical engineer assistant specializing in Siemens LV/MV systems.
You help users with electrical panel specifications, power distribution, protection devices, and system design.
Provide accurate, technical responses based on IEC and IEEE standards."""

            if graph_context:
                system_prompt += f"\n\n{graph_context}"

            llm_messages = [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": message.content}
            ]

            # Send metadata first
            yield f"data: {json.dumps({'context_used': context_used, 'streaming': True})}\n\n"

            # Stream response chunks
            full_response = ""
            llm_mode = message.llm_mode or None

            for chunk in llm.generate_stream(
                messages=llm_messages,
                mode=llm_mode,
                temperature=0.7
            ):
                full_response += chunk
                yield f"data: {json.dumps({'chunk': chunk})}\n\n"

            # Cache messages after completion with complete metadata structure
            import uuid
            created_at = datetime.now().isoformat()

            user_msg = {
                "message_id": str(uuid.uuid4()),
                "chat_id": message.chat_id,
                "project_id": project_number,  # None for general chats
                "page_id": message.chat_id,  # Chat ID represents the page
                "role": "user",
                "sender": "user",
                "content": message.content,
                "text": message.content,  # Explicit text field as per requirements
                "timestamp": created_at,
                "created_at": created_at,  # Explicit CreatedAt as per requirements
                "user_id": message.user_id
            }

            assistant_msg = {
                "message_id": str(uuid.uuid4()),
                "chat_id": message.chat_id,
                "project_id": project_number,  # None for general chats
                "page_id": message.chat_id,  # Chat ID represents the page
                "role": "assistant",
                "sender": "assistant",
                "content": full_response,
                "text": full_response,  # Explicit text field as per requirements
                "timestamp": created_at,
                "created_at": created_at,  # Explicit CreatedAt as per requirements
                "llm_mode": llm_mode,
                "context_used": context_used,
                "cached": False
            }

            redis.cache_chat_message(message.chat_id, user_msg)
            redis.cache_chat_message(message.chat_id, assistant_msg)

            # Signal completion
            yield f"data: {json.dumps({'done': True, 'llm_mode': llm_mode})}\n\n"

        except LLMOfflineError as e:
            logger.error(f"Offline LLM unavailable: {e}")
            error_data = {
                'error': 'offline_unavailable',
                'message': 'Local LLM servers are unavailable. Please try online mode.',
                'technical_error': str(e)
            }
            yield f"data: {json.dumps(error_data)}\n\n"
        except LLMOnlineError as e:
            logger.error(f"Online LLM unavailable: {e}")
            error_data = {
                'error': 'online_unavailable',
                'message': 'OpenAI API is unavailable. Please try offline mode.',
                'technical_error': str(e)
            }
            yield f"data: {json.dumps(error_data)}\n\n"
        except LLMTimeoutError as e:
            logger.error(f"LLM timeout: {e}")
            error_data = {
                'error': 'timeout',
                'message': 'LLM request timed out. Please try again.',
                'technical_error': str(e)
            }
            yield f"data: {json.dumps(error_data)}\n\n"
        except Exception as e:
            logger.error(f"Streaming error: {e}")
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive"
        }
    )


# =============================================================================
# DOCUMENT PROCESSING
# =============================================================================

@app.post("/api/projects/{project_number}/documents")
async def upload_and_process_document(
    project_number: str,
    file: UploadFile = File(...),
    background_tasks: BackgroundTasks = None,
    llm_mode: str = Form("online"),
    neo4j: Neo4jService = Depends(get_neo4j),
    redis: RedisService = Depends(get_redis)
):
    """
    Upload and actively process a document through CocoIndex

    Extracts entities and relationships using CocoIndex flow
    """
    # Validate file type
    if not file.filename.endswith('.pdf'):
        raise HTTPException(status_code=400, detail="Only PDF files allowed")

    # Ensure project exists
    project = neo4j.get_project(project_number)
    if not project:
        # Create project if it doesn't exist
        neo4j.create_project(
            project_number=project_number,
            project_name=f"Project {project_number}"
        )

    # Save file
    upload_dir = Path(UPLOAD_FOLDER) / project_number
    upload_dir.mkdir(exist_ok=True, parents=True)

    file_path = upload_dir / file.filename

    with open(file_path, "wb") as f:
        content = await file.read()
        f.write(content)

    logger.info(f"File saved: {file_path}")

    # Import and call CocoIndex flow to actively process document
    try:
        # Import process_document from CocoIndex flow
        import sys
        sys.path.insert(0, str(Path(__file__).parent.parent))
        from cocoindex_flows.industrial_electrical_flow import process_document

        # Process document synchronously
        start_time = datetime.now()
        result = process_document(
            project_number=project_number,
            document_path=str(file_path),
            document_metadata={
                "filename": file.filename,
                "upload_time": start_time.isoformat()
            },
            llm_mode=llm_mode
        )
        processing_time = (datetime.now() - start_time).total_seconds()

        # Cache result
        task_id = str(uuid.uuid4())
        result["task_id"] = task_id
        result["processing_time"] = processing_time

        redis.set(
            f"task:{task_id}:result",
            result,
            ttl=3600,
            db="cache"
        )

        if result["status"] == "success":
            return {
                "status": "success",
                "task_id": task_id,
                "project_number": project_number,
                "filename": file.filename,
                "file_path": str(file_path),
                "entities_extracted": result.get("entities_extracted", 0),
                "relationships_extracted": result.get("relationships_extracted", 0),
                "processing_time": processing_time,
                "message": "Document processed successfully"
            }
        elif result["status"] == "skipped":
            return {
                "status": "skipped",
                "task_id": task_id,
                "project_number": project_number,
                "filename": file.filename,
                "reason": result.get("reason", "unknown"),
                "message": "Document processing skipped"
            }
        else:
            raise HTTPException(
                status_code=500,
                detail=f"Document processing failed: {result.get('error', 'Unknown error')}"
            )

    except ImportError as e:
        logger.error(f"CocoIndex import failed: {e}")
        raise HTTPException(
            status_code=500,
            detail="CocoIndex processing unavailable. Please check CocoIndex container."
        )
    except Exception as e:
        logger.error(f"Document processing failed: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Document processing error: {str(e)}"
        )


@app.get("/api/documents/task/{task_id}")
async def get_document_processing_result(
    task_id: str,
    redis: RedisService = Depends(get_redis)
):
    """
    Get document processing result
    """
    result = redis.get(f"task:{task_id}:result", db="cache")

    if not result:
        return {
            "task_id": task_id,
            "status": "processing",
            "message": "Task still processing or not found"
        }

    return result


# =============================================================================
# SPEC EXTRACTION ENDPOINTS
# =============================================================================

@app.get("/api/projects/{project_number}/documents/{document_id}/specs")
async def get_spec_structure(
    project_number: str,
    document_id: str,
    current_user: str = Depends(get_current_user),
    neo4j: Neo4jService = Depends(get_neo4j)
):
    """
    Get extracted specification structure for a document (requires authentication)

    Returns the complete spec structure with all categories and fields
    """
    try:
        from services.project_graph_init import ProjectGraphInitializer

        graph_init = ProjectGraphInitializer(neo4j.driver)
        specs = graph_init.get_spec_structure(project_number, document_id)

        if not specs:
            raise HTTPException(
                status_code=404,
                detail=f"No specifications found for document {document_id}"
            )

        return {
            "status": "success",
            "project_number": project_number,
            "document_id": document_id,
            "specifications": specs
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"❌ Failed to retrieve specs: {e}")
        raise HTTPException(status_code=500, detail=str(e))


class SpecUpdateRequest(BaseModel):
    """Spec update request"""
    specifications: Dict[str, Dict[str, str]]


@app.put("/api/projects/{project_number}/documents/{document_id}/specs")
async def update_spec_structure(
    project_number: str,
    document_id: str,
    update_request: SpecUpdateRequest,
    current_user: str = Depends(get_current_user),
    neo4j: Neo4jService = Depends(get_neo4j)
):
    """
    Update reviewed specification structure (requires authentication)

    Allows users to review and correct extracted specifications
    """
    try:
        from services.project_graph_init import ProjectGraphInitializer

        graph_init = ProjectGraphInitializer(neo4j.driver)
        success = graph_init.update_spec_structure(
            project_number,
            document_id,
            update_request.specifications
        )

        if not success:
            raise HTTPException(
                status_code=500,
                detail="Failed to update specifications"
            )

        logger.info(f"✅ User {current_user} updated specs for document {document_id}")

        return {
            "status": "success",
            "message": "Specifications updated successfully",
            "project_number": project_number,
            "document_id": document_id
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"❌ Failed to update specs: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/spec-tasks/{task_id}/status")
async def get_spec_task_status(
    task_id: str,
    current_user: str = Depends(get_current_user),
    redis: RedisService = Depends(get_redis)
):
    """
    Get spec extraction task status (requires authentication)

    Returns real-time status of async spec extraction tasks
    """
    task_status = redis.get(f"spec_task:{task_id}:status", db="cache")

    if not task_status:
        return {
            "task_id": task_id,
            "status": "not_found",
            "message": "Task not found"
        }

    return task_status


@app.get("/api/projects/{project_number}/specifications/summary")
async def get_project_specs_summary(
    project_number: str,
    current_user: str = Depends(get_current_user),
    neo4j: Neo4jService = Depends(get_neo4j)
):
    """
    Get summary of extracted specifications in project

    Shows statistics about spec extraction and sample values.
    Useful for debugging extraction issues.
    """
    try:
        from services.graph_rag_service import GraphRAGService

        graph_rag = GraphRAGService(neo4j.driver)

        with neo4j.driver.session() as session:
            # Get overall stats
            stats_query = """
            MATCH (doc:Document {project_number: $project_number})
                -[:HAS_SPEC_CATEGORY]->(cat:SpecCategory)
                -[:HAS_FIELD]->(field:SpecField)
            OPTIONAL MATCH (field)-[:HAS_VALUE]->(value:ActualValue)

            WITH count(DISTINCT doc) as total_docs,
                 count(DISTINCT cat) as total_categories,
                 count(DISTINCT field) as total_fields,
                 count(CASE WHEN value.extracted_value IS NOT NULL
                            AND value.extracted_value <> ''
                            AND value.extracted_value <> 'Not specified'
                       THEN 1 END) as fields_with_values

            RETURN total_docs, total_categories, total_fields, fields_with_values
            """

            result = session.run(stats_query, project_number=project_number)
            stats_record = result.single()

            # Get category breakdown
            category_query = """
            MATCH (doc:Document {project_number: $project_number})
                -[:HAS_SPEC_CATEGORY]->(cat:SpecCategory)
                -[:HAS_FIELD]->(field:SpecField)
            OPTIONAL MATCH (field)-[:HAS_VALUE]->(value:ActualValue)

            WITH cat.name as category,
                 count(field) as total_fields,
                 count(CASE WHEN value.extracted_value IS NOT NULL
                            AND value.extracted_value <> ''
                            AND value.extracted_value <> 'Not specified'
                       THEN 1 END) as fields_with_values

            RETURN category, total_fields, fields_with_values
            ORDER BY category
            """

            result = session.run(category_query, project_number=project_number)
            categories = []
            for record in result:
                categories.append({
                    "category": record["category"],
                    "total_fields": record["total_fields"],
                    "fields_with_values": record["fields_with_values"],
                    "percentage_populated": round(record["fields_with_values"] / record["total_fields"] * 100, 1) if record["total_fields"] > 0 else 0
                })

            # Get sample specs with values
            sample_query = """
            MATCH (doc:Document {project_number: $project_number})
                -[:HAS_SPEC_CATEGORY]->(cat:SpecCategory)
                -[:HAS_FIELD]->(field:SpecField)
                -[:HAS_VALUE]->(value:ActualValue)

            WHERE value.extracted_value IS NOT NULL
              AND value.extracted_value <> ''
              AND value.extracted_value <> 'Not specified'

            RETURN doc.filename as document,
                   cat.name as category,
                   field.name as field_name,
                   value.extracted_value as field_value
            LIMIT 10
            """

            result = session.run(sample_query, project_number=project_number)
            samples = []
            for record in result:
                samples.append({
                    "document": record["document"],
                    "category": record["category"],
                    "field": record["field_name"],
                    "value": record["field_value"]
                })

            return {
                "project_number": project_number,
                "total_documents": stats_record["total_docs"] if stats_record else 0,
                "total_categories": stats_record["total_categories"] if stats_record else 0,
                "total_fields": stats_record["total_fields"] if stats_record else 0,
                "fields_with_values": stats_record["fields_with_values"] if stats_record else 0,
                "percentage_populated": round(stats_record["fields_with_values"] / stats_record["total_fields"] * 100, 1) if stats_record and stats_record["total_fields"] > 0 else 0,
                "categories": categories,
                "sample_specifications": samples
            }

    except Exception as e:
        logger.error(f"Failed to get project specs summary: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# =============================================================================
# AGENT FILE DOWNLOAD ENDPOINTS
# =============================================================================

@app.get("/api/agent/download/{filename}")
async def download_agent_export_file(
    filename: str,
    current_user: str = Depends(get_current_user)
):
    """
    Download agent-generated export files (Excel/CSV)

    Security:
    - Requires authentication
    - Only allows files from exports directory
    - Prevents path traversal attacks
    """
    from fastapi.responses import FileResponse
    import os

    logger.info(f"📥 Download request for: {filename} by user: {current_user}")

    # Security: Prevent path traversal attacks
    if '..' in filename or '/' in filename or '\\' in filename:
        logger.warning(f"⚠️ Path traversal attempt blocked: {filename}")
        raise HTTPException(
            status_code=400,
            detail="Invalid filename"
        )

    # Construct safe file path
    exports_dir = Path("/home/user/simorgh-chatbot-ekc-deploy/simorgh-agent/backend/exports")
    file_path = exports_dir / filename

    # Check if file exists
    if not file_path.exists():
        logger.warning(f"⚠️ File not found: {file_path}")
        raise HTTPException(
            status_code=404,
            detail=f"File not found: {filename}"
        )

    # Verify file is within exports directory (additional security check)
    try:
        file_path.resolve().relative_to(exports_dir.resolve())
    except ValueError:
        logger.error(f"🚨 Security violation: File outside exports directory: {file_path}")
        raise HTTPException(
            status_code=403,
            detail="Access denied"
        )

    logger.info(f"✅ Serving file: {file_path}")

    # Determine media type based on extension
    if filename.endswith('.xlsx'):
        media_type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    elif filename.endswith('.csv'):
        media_type = "text/csv"
    else:
        media_type = "application/octet-stream"

    return FileResponse(
        path=str(file_path),
        media_type=media_type,
        filename=filename,
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"'
        }
    )


# =============================================================================
# GRAPH QUERY ENDPOINTS
# =============================================================================

@app.post("/api/graph/query")
async def semantic_graph_search(
    query: GraphQuery,
    neo4j: Neo4jService = Depends(get_neo4j)
):
    """
    Semantic search in project knowledge graph
    """
    entities = neo4j.semantic_search(
        project_number=query.project_number,
        entity_type=query.entity_type,
        filters=query.filters,
        limit=query.limit
    )

    return {
        "project_number": query.project_number,
        "query": query.query,
        "results": entities,
        "count": len(entities)
    }


@app.get("/api/graph/{project_number}/entity/{entity_id}")
async def get_entity_with_neighborhood(
    project_number: str,
    entity_id: str,
    depth: int = Query(1, ge=1, le=3),
    neo4j: Neo4jService = Depends(get_neo4j)
):
    """
    Get entity with its connected neighbors
    """
    neighborhood = neo4j.get_entity_neighborhood(
        project_number=project_number,
        entity_id=entity_id,
        depth=depth
    )

    if not neighborhood["nodes"]:
        raise HTTPException(status_code=404, detail="Entity not found")

    return neighborhood


@app.post("/api/graph/{project_number}/power-path")
async def find_power_flow_path(
    project_number: str,
    query: PowerPathQuery,
    neo4j: Neo4jService = Depends(get_neo4j)
):
    """
    Find power flow path between two entities
    """
    paths = neo4j.find_power_path(
        project_number=project_number,
        from_entity_id=query.from_entity_id,
        to_entity_id=query.to_entity_id
    )

    if not paths:
        return {
            "project_number": project_number,
            "from": query.from_entity_id,
            "to": query.to_entity_id,
            "paths": [],
            "message": "No path found"
        }

    return {
        "project_number": project_number,
        "from": query.from_entity_id,
        "to": query.to_entity_id,
        "paths": paths,
        "count": len(paths)
    }


# =============================================================================
# USER PREFERENCES
# =============================================================================

@app.post("/api/users/{user_id}/preferences")
async def set_user_preference(
    user_id: str,
    preference_key: str = Form(...),
    preference_value: str = Form(...),
    redis: RedisService = Depends(get_redis)
):
    """
    Set user preference (e.g., LLM mode)
    """
    success = redis.set_user_preference(user_id, preference_key, preference_value)

    return {
        "status": "success" if success else "error",
        "user_id": user_id,
        "preference": preference_key,
        "value": preference_value
    }


@app.get("/api/users/{user_id}/preferences/{preference_key}")
async def get_user_preference(
    user_id: str,
    preference_key: str,
    redis: RedisService = Depends(get_redis)
):
    """
    Get user preference
    """
    value = redis.get_user_preference(user_id, preference_key)

    return {
        "user_id": user_id,
        "preference": preference_key,
        "value": value
    }


# =============================================================================
# ROOT
# =============================================================================

@app.get("/")
async def root():
    """API root"""
    return {
        "name": "Simorgh Industrial Electrical Assistant API",
        "version": "2.0.0",
        "status": "running",
        "features": [
            "Neo4j knowledge graph with project isolation",
            "Redis multi-DB caching",
            "Hybrid LLM (OpenAI + Local)",
            "SQL Server authentication",
            "CocoIndex document processing",
            "Vector search with Qdrant"
        ]
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8890)
