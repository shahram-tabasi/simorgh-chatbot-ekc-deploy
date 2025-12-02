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

from fastapi import FastAPI, File, UploadFile, Form, HTTPException, Depends, Query, BackgroundTasks
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
from services.llm_service import (
    get_llm_service,
    LLMService,
    LLMOfflineError,
    LLMOnlineError,
    LLMTimeoutError
)
from models.ontology import *

# Import authentication routes and utilities
from routes.auth import router as auth_router
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

# Include authentication routes
app.include_router(auth_router)

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
llm_service: Optional[LLMService] = None


# =============================================================================
# PYDANTIC MODELS
# =============================================================================

class UserAuth(BaseModel):
    """User authentication info"""
    username: str
    project_number: str


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
    project_number: Optional[str] = None
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
    global neo4j_service, redis_service, sql_auth_service, llm_service

    logger.info("🚀 Starting Simorgh Industrial Assistant...")

    # Initialize Redis first (needed by LLM service)
    redis_service = get_redis_service()
    logger.info("✅ Redis service initialized")

    # Initialize Neo4j
    neo4j_service = get_neo4j_service()
    logger.info("✅ Neo4j service initialized")

    # Initialize SQL Auth
    sql_auth_service = get_sql_auth_service()
    logger.info("✅ SQL Auth service initialized")

    # Initialize LLM with Redis
    llm_service = get_llm_service(redis_service=redis_service)
    logger.info("✅ LLM service initialized")

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


def get_llm() -> LLMService:
    """Get LLM service instance"""
    if llm_service is None:
        raise HTTPException(status_code=503, detail="LLM service not available")
    return llm_service


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


# =============================================================================
# AUTHENTICATION ENDPOINTS
# =============================================================================

@app.post("/api/auth/check-project-access")
async def check_project_access(
    auth: UserAuth,
    sql_auth: SQLAuthService = Depends(get_sql_auth),
    redis: RedisService = Depends(get_redis)
):
    """
    Check if a user has access to a specific project

    Uses SQL Server for authorization with Redis caching
    """
    username = auth.username
    project_number = auth.project_number

    # Check cache first
    cached_result = redis.get_cached_authorization(username, project_number)
    if cached_result is not None:
        return {
            "username": username,
            "project_number": project_number,
            "has_access": cached_result,
            "cached": True
        }

    # Query SQL Server
    has_access = sql_auth.check_project_access(username, project_number)

    # Cache result (1 hour TTL)
    redis.cache_project_authorization(username, project_number, has_access, ttl=3600)

    return {
        "username": username,
        "project_number": project_number,
        "has_access": has_access,
        "cached": False
    }


@app.get("/api/auth/user-projects/{username}")
async def get_user_projects(
    username: str,
    sql_auth: SQLAuthService = Depends(get_sql_auth),
    redis: RedisService = Depends(get_redis)
):
    """
    Get all projects a user has access to

    Uses SQL Server with Redis caching
    """
    # Check cache
    cached_projects = redis.get_cached_user_projects(username)
    if cached_projects is not None:
        return {
            "username": username,
            "projects": cached_projects,
            "cached": True
        }

    # Query SQL Server
    projects = sql_auth.get_user_projects(username)

    # Extract project numbers for caching
    project_numbers = [p["project_number"] for p in projects]

    # Cache result
    redis.cache_user_projects(username, project_numbers, ttl=3600)

    return {
        "username": username,
        "projects": projects,
        "count": len(projects),
        "cached": False
    }


# =============================================================================
# PROJECT ENDPOINTS
# =============================================================================

@app.post("/api/projects")
async def create_project(
    project: ProjectCreate,
    neo4j: Neo4jService = Depends(get_neo4j)
):
    """
    Create a new project

    Creates the root Project node in Neo4j
    """
    try:
        project_node = neo4j.create_project(
            project_number=project.project_number,
            project_name=project.project_name,
            client=project.client or "",
            contract_number=project.contract_number or "",
            contract_date=project.contract_date or "",
            description=project.description or ""
        )

        return {
            "status": "success",
            "project": project_node
        }

    except Exception as e:
        logger.error(f"Error creating project: {e}")
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
    neo4j: Neo4jService = Depends(get_neo4j)
):
    """
    List all projects
    """
    projects = neo4j.list_all_projects()

    return {
        "projects": projects,
        "count": len(projects)
    }


# =============================================================================
# CHAT ENDPOINTS
# =============================================================================

@app.post("/api/chats")
async def create_chat(
    chat: ChatCreate,
    current_user: str = Depends(get_current_user),
    redis: RedisService = Depends(get_redis)
):
    """
    Create a new chat session (requires authentication)

    Validates that the requesting user matches the chat owner
    """
    # Security: Ensure the user_id in the request matches the authenticated user
    if chat.user_id != current_user:
        raise HTTPException(
            status_code=403,
            detail="Cannot create chat for another user"
        )

    # Validation: Project chats MUST have a project_number
    if chat.chat_type == "project" and not chat.project_number:
        raise HTTPException(
            status_code=400,
            detail="Project chats must have a project_number"
        )

    # Validation: General chats must NOT have a project_number
    if chat.chat_type == "general" and chat.project_number:
        raise HTTPException(
            status_code=400,
            detail="General chats cannot have a project_number"
        )

    chat_id = str(uuid.uuid4())

    chat_data = {
        "chat_id": chat_id,
        "chat_name": chat.chat_name,
        "user_id": chat.user_id,
        "chat_type": chat.chat_type,
        "project_number": chat.project_number,
        "created_at": datetime.now().isoformat(),
        "message_count": 0
    }

    # Store in Redis
    redis.set(f"chat:{chat_id}:metadata", chat_data, db="chat")

    # Add to user's chat list
    user_chats_key = f"user:{chat.user_id}:chats"
    existing = redis.get(user_chats_key, default=[], db="chat")
    existing.append(chat_id)
    redis.set(user_chats_key, existing, db="chat")

    logger.info(f"✅ Chat created: {chat_id} for user: {chat.user_id}")

    return {
        "status": "success",
        "chat": chat_data
    }


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


@app.get("/api/projects/{project_number}/chats")
async def get_project_chats(
    project_number: str,
    redis: RedisService = Depends(get_redis)
):
    """
    Get all chats for a project
    """
    # This is a simplified implementation
    # In production, you'd maintain a project->chats index
    return {
        "project_number": project_number,
        "chats": [],
        "message": "Project chat listing not yet implemented"
    }


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

    chat_ids = redis.get(f"user:{user_id}:chats", default=[], db="chat")

    chats = []
    for chat_id in chat_ids:
        metadata = redis.get(f"chat:{chat_id}:metadata", db="chat")
        if metadata and metadata.get("chat_type") == "general":
            chats.append(metadata)

    return {
        "user_id": user_id,
        "chats": chats,
        "count": len(chats)
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


# =============================================================================
# CHAT/RAG ENDPOINT
# =============================================================================

@app.post("/api/chat/send")
async def send_chat_message(
    message: ChatMessage,
    current_user: str = Depends(get_current_user),
    neo4j: Neo4jService = Depends(get_neo4j),
    redis: RedisService = Depends(get_redis),
    llm: LLMService = Depends(get_llm)
):
    """
    Send a chat message and get AI response (requires authentication)

    Validates that the requesting user owns the chat and matches the message user_id
    """
    try:
        # Security: Verify the user_id in the message matches the authenticated user
        if message.user_id != current_user:
            raise HTTPException(
                status_code=403,
                detail="Cannot send messages as another user"
            )

        # Get chat metadata
        chat_metadata = redis.get(f"chat:{message.chat_id}:metadata", db="chat")

        if not chat_metadata:
            raise HTTPException(status_code=404, detail="Chat not found")

        # Security: Verify the chat belongs to the requesting user
        if chat_metadata.get("user_id") != current_user:
            raise HTTPException(
                status_code=403,
                detail="Access denied: You don't have permission to send messages in this chat"
            )

        project_number = chat_metadata.get("project_number")

        # Build context from knowledge graph if project chat
        graph_context = ""
        context_used = False

        if project_number and message.use_graph_context:
            # Get recent chat history for context
            recent_messages = redis.get_chat_history(message.chat_id, limit=5)

            # Simple semantic search in graph (can be enhanced with Qdrant)
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

        # Generate response
        llm_mode = message.llm_mode or None
        result = llm.generate(
            messages=llm_messages,
            mode=llm_mode,
            temperature=0.7,
            use_cache=True
        )

        ai_response = result["response"]

        # Cache messages
        user_msg = {
            "role": "user",
            "content": message.content,
            "timestamp": datetime.now().isoformat(),
            "user_id": message.user_id
        }

        assistant_msg = {
            "role": "assistant",
            "content": ai_response,
            "timestamp": datetime.now().isoformat(),
            "llm_mode": result.get("mode"),
            "context_used": context_used,
            "cached": result.get("cached", False)
        }

        redis.cache_chat_message(message.chat_id, user_msg)
        redis.cache_chat_message(message.chat_id, assistant_msg)

        return {
            "chat_id": message.chat_id,
            "response": ai_response,
            "llm_mode": result.get("mode"),
            "context_used": context_used,
            "cached_response": result.get("cached", False),
            "tokens": result.get("tokens")
        }

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

            # Cache messages after completion
            user_msg = {
                "role": "user",
                "content": message.content,
                "timestamp": datetime.now().isoformat(),
                "user_id": message.user_id
            }

            assistant_msg = {
                "role": "assistant",
                "content": full_response,
                "timestamp": datetime.now().isoformat(),
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
