"""
Graph RAG Service
=================
Standalone REST microservice for Neo4j-backed graph RAG over project
documents. Wraps two real classes:

* `GraphRAG` (async) — natural-language query → entity extraction →
  subgraph retrieval → LLM-formatted context. Wraps neo4j + OpenAI.

* `GraphRAGService` (sync) — read-only structured queries:
  specifications by criteria, project summary, BFS traversal, etc.

Mounts at `/api/v2/graph-rag/*`. Requires Neo4j (start with
`compose/infra-neo4j.yml`).
"""
import logging
import os
from contextlib import asynccontextmanager
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from mcp.server.fastmcp import FastMCP

from services.graph_rag import GraphRAG
from services.graph_rag_service import GraphRAGService

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("graph-rag-service")


_neo4j_driver = None
_graph_rag: Optional[GraphRAG] = None
_graph_rag_service: Optional[GraphRAGService] = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _neo4j_driver, _graph_rag, _graph_rag_service

    neo4j_uri = os.getenv("NEO4J_URI")
    if not neo4j_uri:
        logger.warning("NEO4J_URI not set; graph-rag-service will return 503 on every call")
    else:
        try:
            from neo4j import GraphDatabase
            _neo4j_driver = GraphDatabase.driver(
                neo4j_uri,
                auth=(os.getenv("NEO4J_USER", "neo4j"), os.getenv("NEO4J_PASSWORD", "")),
            )
            _graph_rag = GraphRAG(driver=_neo4j_driver, openai_api_key=os.getenv("OPENAI_API_KEY"))
            _graph_rag_service = GraphRAGService(driver=_neo4j_driver)
            logger.info("graph-rag-service ready")
        except Exception as e:
            logger.error("Neo4j init failed: %s", e)

    yield

    if _neo4j_driver is not None:
        _neo4j_driver.close()


app = FastAPI(title="Simorgh Graph RAG Service", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ALLOW_ORIGINS", "*").split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------
class QueryRequest(BaseModel):
    project_oenum: str
    user_query: str
    project_context: str = ""
    max_hops: int = 2
    use_llm_formatting: bool = True


class HybridSearchRequest(BaseModel):
    project_oenum: str
    user_query: str
    vector_results: Optional[List[Dict[str, Any]]] = None
    project_context: str = ""
    max_hops: int = 2


class EntitiesRequest(BaseModel):
    query: str
    project_context: str = ""


class SearchByQueryRequest(BaseModel):
    project_oenum: str
    natural_query: str
    limit: int = 10


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------
@app.get("/health")
def health():
    return {
        "status": "healthy",
        "service": "graph-rag-service",
        "neo4j_connected": _neo4j_driver is not None,
    }


# ---------------------------------------------------------------------------
# Async (GraphRAG): natural-language flows
# ---------------------------------------------------------------------------
@app.post("/api/v2/graph-rag/query")
async def query(req: QueryRequest) -> Dict[str, Any]:
    if _graph_rag is None:
        raise HTTPException(status_code=503, detail="Neo4j unavailable")
    return await _graph_rag.query(
        project_oenum=req.project_oenum,
        user_query=req.user_query,
        project_context=req.project_context,
        max_hops=req.max_hops,
        use_llm_formatting=req.use_llm_formatting,
    )


@app.post("/api/v2/graph-rag/hybrid-search")
async def hybrid_search(req: HybridSearchRequest) -> Dict[str, Any]:
    if _graph_rag is None:
        raise HTTPException(status_code=503, detail="Neo4j unavailable")
    return await _graph_rag.hybrid_search(
        project_oenum=req.project_oenum,
        user_query=req.user_query,
        vector_results=req.vector_results,
        project_context=req.project_context,
        max_hops=req.max_hops,
    )


@app.post("/api/v2/graph-rag/entities")
async def entities(req: EntitiesRequest) -> Dict[str, Any]:
    if _graph_rag is None:
        raise HTTPException(status_code=503, detail="Neo4j unavailable")
    return await _graph_rag.extract_entities(query=req.query, project_context=req.project_context)


# ---------------------------------------------------------------------------
# Sync (GraphRAGService): structured read queries
# ---------------------------------------------------------------------------
@app.post("/api/v2/graph-rag/search")
def search_natural(req: SearchByQueryRequest) -> Dict[str, Any]:
    if _graph_rag_service is None:
        raise HTTPException(status_code=503, detail="Neo4j unavailable")
    return {
        "results": _graph_rag_service.search_by_natural_query(
            project_oenum=req.project_oenum,
            query=req.natural_query,
            limit=req.limit,
        )
    }


@app.get("/api/v2/graph-rag/projects/{project_oenum}/summary")
def project_summary(project_oenum: str) -> Dict[str, Any]:
    if _graph_rag_service is None:
        raise HTTPException(status_code=503, detail="Neo4j unavailable")
    return _graph_rag_service.get_project_summary(project_oenum=project_oenum)


@app.get("/api/v2/graph-rag/documents/{document_id}/specifications")
def document_specifications(document_id: str) -> Dict[str, Any]:
    if _graph_rag_service is None:
        raise HTTPException(status_code=503, detail="Neo4j unavailable")
    return {"specs": _graph_rag_service.get_document_specifications(document_id=document_id)}


# ---------------------------------------------------------------------------
# MCP — exposes the graph-RAG surface to the project-agent COT engine.
# Only useful when Neo4j is enabled (compose/infra-neo4j.yml uncommented);
# tools return {error: "..."} otherwise so the agent gracefully skips them.
# ---------------------------------------------------------------------------
mcp = FastMCP(
    "graph-rag-service",
    instructions=(
        "Neo4j-backed graph RAG: extract entities from a query, traverse "
        "the project's knowledge graph for related items, and produce "
        "LLM-formatted context strings. Use these tools when answering "
        "questions about specific equipment / parts / relationships in a "
        "project rather than free-text content."
    ),
)


@mcp.tool()
async def graph_query(
    project_oenum: str,
    user_query: str,
    project_context: str = "",
    max_hops: int = 2,
    use_llm_formatting: bool = True,
) -> Dict[str, Any]:
    """
    Full graph-RAG flow for a project: extract entities → BFS the
    subgraph → return LLM-ready context (when use_llm_formatting=true)
    plus raw subgraph data.
    """
    if _graph_rag is None:
        return {"error": "Neo4j unavailable"}
    return await _graph_rag.query(
        project_oenum=project_oenum,
        user_query=user_query,
        project_context=project_context,
        max_hops=max_hops,
        use_llm_formatting=use_llm_formatting,
    )


@mcp.tool()
async def graph_hybrid_search(
    project_oenum: str,
    user_query: str,
    vector_results: Optional[List[Dict[str, Any]]] = None,
    project_context: str = "",
    max_hops: int = 2,
) -> Dict[str, Any]:
    """
    graph_query + optional Qdrant vector results merged into one context
    block. Pass `vector_results` from search_project_documents when you
    want the agent to reason over both surfaces.
    """
    if _graph_rag is None:
        return {"error": "Neo4j unavailable"}
    return await _graph_rag.hybrid_search(
        project_oenum=project_oenum,
        user_query=user_query,
        vector_results=vector_results,
        project_context=project_context,
        max_hops=max_hops,
    )


@mcp.tool()
async def graph_extract_entities(
    query: str, project_context: str = "",
) -> Dict[str, Any]:
    """LLM-driven entity extraction without graph traversal."""
    if _graph_rag is None:
        return {"error": "Neo4j unavailable"}
    return await _graph_rag.extract_entities(
        query=query, project_context=project_context,
    )


@mcp.tool()
async def graph_project_summary(project_oenum: str) -> Dict[str, Any]:
    """Aggregated summary of a project's graph."""
    if _graph_rag_service is None:
        return {"error": "Neo4j unavailable"}
    return _graph_rag_service.get_project_summary(project_oenum=project_oenum)


@mcp.tool()
async def graph_document_specifications(document_id: str) -> Dict[str, Any]:
    """All specs attached to a single document in the graph."""
    if _graph_rag_service is None:
        return {"error": "Neo4j unavailable"}
    return {"specs": _graph_rag_service.get_document_specifications(document_id=document_id)}


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
