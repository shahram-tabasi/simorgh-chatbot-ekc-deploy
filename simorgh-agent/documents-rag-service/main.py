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
    # FastAPI ignores @app.on_event when lifespan= is set, so the MCP
    # streamable-http session manager has to be started here.
    async with mcp.session_manager.run():
        try:
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


@mcp.tool()
async def list_project_documents(
    user_id: str,
    project_oenum: Optional[str] = None,
    session_id: Optional[str] = None,
) -> Dict[str, Any]:
    """List the documents that have been uploaded and indexed for this
    project/session. Returns one entry per document: document_id, filename,
    and chunk_count.

    USE THIS FIRST when the user refers to "the document(s) I uploaded",
    "the attached file", or asks to compare/aggregate across files — so you
    KNOW what exists before searching. If it returns an empty list, no
    documents are indexed yet; tell the user rather than inventing content.
    """
    if _qdrant is None:
        return {"error": "Qdrant unavailable", "documents": []}
    try:
        docs = _qdrant.list_documents(
            user_id=user_id,
            session_id=session_id,
            project_oenum=project_oenum,
        )
        return {"documents": docs, "count": len(docs)}
    except Exception as e:
        logger.exception("list_project_documents failed")
        return {"error": str(e)[:200], "documents": []}


@mcp.tool()
async def read_document(
    user_id: str,
    filename: Optional[str] = None,
    document_id: Optional[str] = None,
    project_oenum: Optional[str] = None,
    session_id: Optional[str] = None,
    max_chars: int = 20000,
) -> Dict[str, Any]:
    """Return the FULL text of one uploaded document (its chunks
    reassembled in order). Identify it by `filename` (PREFERRED — pass the
    exact name the user attached, e.g. "موجودی انبار.xlsx") or by
    `document_id` from list_project_documents. Use when the user asks to
    summarise/analyse a whole file, or to compare two files (read each).
    Truncated at max_chars.

    Prefer filename: you know it from the user's message at plan time,
    whereas document_id is only known after list_project_documents runs and
    cannot be threaded into this call.
    """
    if _qdrant is None:
        return {"error": "Qdrant unavailable", "text": ""}
    try:
        return _qdrant.get_document_text(
            document_id=document_id,
            user_id=user_id,
            session_id=session_id,
            project_oenum=project_oenum,
            filename=filename,
            max_chars=max_chars,
        )
    except Exception as e:
        logger.exception("read_document failed")
        return {"error": str(e)[:200], "text": ""}


# FastMCP's streamable_http_app exposes route /mcp internally. Mount at
# "/" so its public path is /mcp (mounting at "/mcp" would produce /mcp/mcp).
# Its session_manager needs an active TaskGroup; when the inner app is
# mounted under another FastAPI, the inner lifespan never fires — start
# the session manager from the outer app's lifespan instead, otherwise
# every POST returns 500 with "Task group is not initialized".
_mcp_streamable_app = mcp.streamable_http_app()

@app.on_event("startup")
async def _mcp_session_manager_start():
    cm = mcp.session_manager.run()
    app.state._mcp_session_manager_cm = cm
    await cm.__aenter__()

@app.on_event("shutdown")
async def _mcp_session_manager_stop():
    cm = getattr(app.state, "_mcp_session_manager_cm", None)
    if cm is not None:
        await cm.__aexit__(None, None, None)

app.mount("/", _mcp_streamable_app)
