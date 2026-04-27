"""
Project Agent Service
=====================
Standalone microservice for project initialization, task execution, and the
chain-of-thought (COT) engine that drives the AI agent.

Exposes BOTH:
- REST endpoints (the project_agent_routes router)
- MCP server at /mcp (for AI/COT clients per the user's contract:
  "AI COT uses MCP, other containers use REST")

REST routes mounted at /api/v2/agent/*.
MCP tools at /mcp wrap project initialization and task execution.
"""
import logging
import os
from typing import Any, Dict, Optional

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from mcp.server.fastmcp import FastMCP

from routes.project_agent_routes import router as project_agent_router
from services.project_agent import get_project_agent
from services.project_memory_service import get_project_memory_service

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("project-agent-service")

app = FastAPI(title="Simorgh Project Agent Service", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ALLOW_ORIGINS", "*").split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(project_agent_router, prefix="/api/v2/agent", tags=["agent"])


@app.get("/health")
def health():
    return {"status": "healthy", "service": "project-agent-service"}


# ---------------------------------------------------------------------------
# MCP — AI / COT clients call these tools instead of the REST endpoints.
# ---------------------------------------------------------------------------
mcp = FastMCP(
    "project-agent-service",
    instructions="Project initialization, task execution, and COT chain generation.",
)


@mcp.tool()
async def initialize_project(project_id: str, owner: str = "system") -> Dict[str, Any]:
    """Initialize a project workspace (git init, instruction template, COT chain)."""
    agent = get_project_agent()
    return await agent.initialize_project(project_id=project_id, owner=owner)


@mcp.tool()
async def execute_task(project_id: str, task_id: str) -> Dict[str, Any]:
    """Execute a single project task (shell command, query, email, etc.)."""
    agent = get_project_agent()
    return await agent.execute_task(project_id=project_id, task_id=task_id)


@mcp.tool()
async def generate_cot(project_id: str, prompt: str) -> Dict[str, Any]:
    """Generate a chain-of-thought task list for a project given a prompt."""
    agent = get_project_agent()
    return await agent.generate_cot(project_id=project_id, prompt=prompt)


@mcp.tool()
async def list_tasks(project_id: str, status: Optional[str] = None) -> Dict[str, Any]:
    """List tasks for a project, optionally filtered by status."""
    memory = get_project_memory_service()
    return await memory.list_tasks(project_id=project_id, status=status)


@mcp.tool()
async def get_project_status(project_id: str) -> Dict[str, Any]:
    """Get current status of a project (active tasks, completed, errors)."""
    memory = get_project_memory_service()
    return await memory.get_status(project_id=project_id)


# Mount MCP onto the FastAPI app so it's reachable at /mcp
app.mount("/mcp", mcp.streamable_http_app())
