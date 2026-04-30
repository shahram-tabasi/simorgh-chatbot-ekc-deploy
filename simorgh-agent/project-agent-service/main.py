"""
Project Agent Service
=====================
Standalone microservice that owns the long-running project workflow:
- project initialization (git init, TPMS pull, techserver copy, COT chain)
- task execution (LLM, shell, email, file export, EPLAN, etc.)
- MCP-server endpoint for AI / chain-of-thought clients

Per the agreed contract: AI/COT clients use the **MCP** endpoint at `/mcp`;
other backend code can call the **REST** routes mounted by `project_agent_routes`.

The router carries its own prefix `/api/v2/agent`; we include it without
adding another prefix. nginx forwards `/api/v2/agent/*` here unchanged.

Startup wires up the same singletons backend's `main.py` does:
  llm_service → redis → postgres → qdrant → project_agent.initialize()
                                          → project_agent.connect_mcp()
"""
import logging
import os
from contextlib import asynccontextmanager
from typing import Any, Dict, List, Optional

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from mcp.server.fastmcp import FastMCP

from routes.project_agent_routes import router as project_agent_router
from services.project_agent import get_project_agent
from services.project_memory_service import get_project_memory_service
from services.llm_service import get_llm_service
from services.redis_service import get_redis_service
from services.qdrant_service import QdrantService
from database.postgres_connection import get_db

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("project-agent-service")


# ---------------------------------------------------------------------------
# Lifespan: wire up the agent on startup, the same way backend/main.py does
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Initializing project agent dependencies...")

    llm_service = get_llm_service()
    redis_service = get_redis_service()
    pg_db = get_db()

    # Qdrant client; OK to construct lazily — methods don't connect at __init__
    try:
        qdrant = QdrantService(llm_service=llm_service)
    except Exception as e:
        logger.warning("Qdrant unavailable, continuing without it: %s", e)
        qdrant = None

    agent = get_project_agent()
    agent.initialize(
        llm_service=llm_service,
        redis=redis_service,
        postgres=pg_db,
        qdrant=qdrant,
    )

    try:
        await agent.connect_mcp()
        logger.info("MCP tool discovery complete")
    except Exception as e:
        logger.warning("MCP connect failed (continuing without remote tools): %s", e)

    logger.info("project-agent-service ready")
    yield
    logger.info("project-agent-service shutting down")


app = FastAPI(title="Simorgh Project Agent Service", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ALLOW_ORIGINS", "*").split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Router has its own prefix /api/v2/agent. Don't add another.
app.include_router(project_agent_router)


@app.get("/health")
def health():
    return {"status": "healthy", "service": "project-agent-service"}


# ---------------------------------------------------------------------------
# MCP — AI / COT clients call these tools instead of the REST endpoints.
# Method signatures match what the real ProjectManagerAgent / ProjectMemoryService
# expose; nothing here is invented.
# ---------------------------------------------------------------------------
mcp = FastMCP(
    "project-agent-service",
    instructions=(
        "Long-running project workflows: free-text input handling, project "
        "initialization, task chain execution, and project/task introspection."
    ),
)


@mcp.tool()
async def handle_input(
    project_id: str,
    user_input: str,
    channel: str = "chat",
    chat_id: Optional[str] = None,
    user_id: Optional[str] = None,
    document_id: Optional[str] = None,
    document_filename: Optional[str] = None,
    email_from: Optional[str] = None,
    email_subject: Optional[str] = None,
    auto_execute: bool = True,
    stream: bool = False,
) -> Dict[str, Any]:
    """
    Main entry point. Send any free-text input — chat message, email body,
    document upload notice — and the agent plans a COT task chain and runs it.
    Returns the response plus the tasks it created and their results.
    """
    # The agent expects MessageChannel enum; we accept the string and let the
    # agent's signature default coerce it (handle_input does the import).
    from models.project_models import MessageChannel
    return await get_project_agent().handle_input(
        project_id=project_id,
        user_input=user_input,
        channel=MessageChannel(channel) if isinstance(channel, str) else channel,
        chat_id=chat_id,
        user_id=user_id,
        document_id=document_id,
        document_filename=document_filename,
        email_from=email_from,
        email_subject=email_subject,
        auto_execute=auto_execute,
        stream=stream,
    )


@mcp.tool()
async def initialize_project(
    project_id: str,
    name: str,
    owner_id: str,
    tpms_oenum: Optional[str] = None,
    is_legacy: bool = False,
) -> Dict[str, Any]:
    """
    Initialize a new project workspace: git init, TPMS sync (if oenum given),
    techserver copy (legacy users), directory structure.
    """
    return await get_project_agent().initialize_project(
        project_id=project_id,
        name=name,
        owner_id=owner_id,
        tpms_oenum=tpms_oenum,
        is_legacy=is_legacy,
    )


@mcp.tool()
async def get_project_status(project_id: str) -> Dict[str, Any]:
    """Return the current AgentState for a project (active task, last message, etc.)."""
    state = await get_project_agent().get_status(project_id)
    if hasattr(state, "model_dump"):
        return state.model_dump()
    if hasattr(state, "dict"):
        return state.dict()
    return dict(state) if state else {}


@mcp.tool()
async def list_tasks(
    project_id: str,
    status: Optional[str] = None,
    limit: int = 100,
) -> List[Dict[str, Any]]:
    """List tasks for a project, optionally filtered by status (pending|running|completed|failed)."""
    return await get_project_memory_service().get_tasks(
        project_id=project_id, status=status, limit=limit
    )


@mcp.tool()
async def list_projects(owner_id: str) -> List[Dict[str, Any]]:
    """List projects owned by a user."""
    return await get_project_memory_service().list_projects(owner_id=owner_id)


@mcp.tool()
async def get_recent_messages(project_id: str, limit: int = 10) -> List[Dict[str, Any]]:
    """Return the last N messages on a project's main channel (for context)."""
    return await get_project_memory_service().get_recent_context(
        project_id=project_id, limit=limit
    )


# Mount MCP onto the FastAPI app
app.mount("/mcp", mcp.streamable_http_app())
