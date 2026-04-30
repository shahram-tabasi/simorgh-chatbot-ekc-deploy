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
