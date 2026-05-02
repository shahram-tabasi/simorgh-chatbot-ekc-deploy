"""
Documents RAG Service
=====================
Standalone microservice for document upload + RAG, plus several legacy
endpoints that historically lived in the same FastAPI router as document
upload (see README — the router was a grab-bag in the monolith).

The router has its own prefix `/api`, so we include it WITHOUT an extra
prefix; combined paths look like `/api/documents/upload`,
`/api/chat/general`, `/api/sessions/{id}`, etc. nginx forwards the
matching paths to this service unchanged.

Surfaces:
  REST  /api/documents/*, /api/chat/*, /api/sessions/* (existing)
  MCP   /mcp tools for the project-agent COT engine (added below)

Backed by:
- Qdrant (vector store)
- Redis (cache, task tracking)
- LLM service (for spec extraction / classification)
- doc-processor (PDF/Excel/Word → Markdown)
- (optional) Neo4j (legacy GraphRAG)
"""
import logging
import os
from contextlib import asynccontextmanager
from typing import Any, Dict, List, Optional

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from mcp.server.fastmcp import FastMCP

from routes.documents_rag import router as documents_rag_router
from services.qdrant_service import QdrantService

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("documents-rag-service")


_qdrant: Optional[QdrantService] = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Construct the Qdrant client once on startup so MCP tools can reuse it."""
    global _qdrant
    try:
        # llm_service is None here; QdrantService falls back to its bundled
        # SentenceTransformer for embeddings. After phase C this will be
        # swapped for an embeddings-service HTTP client.
        _qdrant = QdrantService(llm_service=None)
        logger.info("documents-rag-service: Qdrant client ready")
    except Exception as e:
        logger.warning("Qdrant unavailable; MCP tools will return 503: %s", e)
        _qdrant = None
    yield


app = FastAPI(
    title="Simorgh Documents RAG Service", version="1.0.0", lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ALLOW_ORIGINS", "*").split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Router has its own prefix "/api". Don't add another one.
app.include_router(documents_rag_router)


@app.get("/health")
def health():
    return {
        "status": "healthy",
        "service": "documents-rag-service",
        "qdrant_ready": _qdrant is not None,
    }


# ---------------------------------------------------------------------------
# MCP — exposes the per-project / per-session vector RAG to project-agent.
# Closes the biggest gap in the COT tool surface: without these, the agent
# could never RAG over user-uploaded files.
# ---------------------------------------------------------------------------
mcp = FastMCP(
    "documents-rag-service",
    instructions=(
        "Vector RAG over the user's uploaded documents. Use these tools "
        "when answering questions that should be grounded in the project's "
        "own files (PDFs, Excel sheets, drawings) instead of general LLM "
        "knowledge. Each call MUST include either a project_oenum (project "
        "chat) or a session_id (general chat) so the search hits the right "
        "Qdrant collection."
    ),
)


@mcp.tool()
async def search_project_documents(
    user_id: str,
    query: str,
    project_oenum: Optional[str] = None,
    session_id: Optional[str] = None,
    document_id: Optional[str] = None,
    limit: int = 5,
    score_threshold: float = 0.5,
) -> Dict[str, Any]:
    """
    Semantic search over the uploaded documents for one user/session/project.
    Returns the top-K most-similar chunks with their text, source filename,
    page (where known), and similarity score. Use `document_id` to narrow
    the search to a single file.
    """
    if _qdrant is None:
        return {"error": "Qdrant unavailable", "results": []}
    try:
        results = _qdrant.semantic_search(
            user_id=user_id,
            query=query,
            limit=limit,
            document_id=document_id,
            score_threshold=score_threshold,
            session_id=session_id,
            project_oenum=project_oenum,
        )
        return {"results": results, "count": len(results)}
    except Exception as e:
        logger.exception("search_project_documents failed")
        return {"error": str(e)[:200], "results": []}


@mcp.tool()
async def retrieve_chunks(
    user_id: str,
    query: str,
    project_oenum: Optional[str] = None,
    session_id: Optional[str] = None,
    top_k: int = 10,
) -> Dict[str, Any]:
    """
    Same as search_project_documents but returns more chunks (default 10)
    and a lower score floor — useful when you want to gather a wider
    context window for grounded synthesis instead of point-answer
    extraction.
    """
    if _qdrant is None:
        return {"error": "Qdrant unavailable", "results": []}
    try:
        results = _qdrant.semantic_search(
            user_id=user_id,
            query=query,
            limit=top_k,
            score_threshold=0.3,
            session_id=session_id,
            project_oenum=project_oenum,
        )
        return {"results": results, "count": len(results)}
    except Exception as e:
        logger.exception("retrieve_chunks failed")
        return {"error": str(e)[:200], "results": []}


app.mount("/mcp", mcp.streamable_http_app())
