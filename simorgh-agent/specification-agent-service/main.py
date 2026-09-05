"""
Specification Agent Service
===========================
Standalone microservice for electrical-spec extraction + equipment
classification of indexed project documents.

Surfaces (per the agreed convention "AI/COT uses MCP, others use REST"):

  REST  /api/v2/specs/extract   → run two-stage spec extraction
        /api/v2/specs/classify  → classify a document by filename + content
  MCP   /mcp tools:
        extract_specifications, classify_document

The chat-style SpecificationAgent (which uses Redis-backed multi-turn
state and a CocoIndex graph adapter) is intentionally NOT exposed yet —
the CocoIndex dependency isn't bundled and wiring it up cleanly is its
own piece of work. See README "Roadmap".
"""
import logging
import os
from contextlib import asynccontextmanager
from typing import Any, Dict, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from mcp.server.fastmcp import FastMCP

from services.document_classifier import DocumentClassifier
from services.enhanced_spec_extractor import EnhancedSpecExtractor
from services.llm_service import get_llm_service
from services.qdrant_service import QdrantService

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("specification-agent-service")


# ---------------------------------------------------------------------------
# Wired-up singletons (filled in on startup)
# ---------------------------------------------------------------------------
_classifier: Optional[DocumentClassifier] = None
_spec_extractor: Optional[EnhancedSpecExtractor] = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _classifier, _spec_extractor
    logger.info("Initializing specification-agent-service dependencies...")

    # FastAPI ignores @app.on_event when lifespan= is set, so the MCP
    # streamable-http session manager has to be started here.
    async with mcp.session_manager.run():
        _classifier = DocumentClassifier()

        # EnhancedSpecExtractor needs llm_service + qdrant_service + graph_initializer.
        # graph_initializer wraps a Neo4j driver; if Neo4j isn't configured, we
        # still construct the extractor with None and let it fail per-call rather
        # than at import.
        llm_service = get_llm_service()
        try:
            qdrant_service = QdrantService(llm_service=llm_service)
        except Exception as e:
            logger.warning("Qdrant not reachable; spec extraction disabled: %s", e)
            qdrant_service = None

        graph_initializer = None
        neo4j_uri = os.getenv("NEO4J_URI", "")
        if neo4j_uri:
            try:
                from neo4j import GraphDatabase
                from services.project_graph_init import ProjectGraphInitializer
                driver = GraphDatabase.driver(
                    neo4j_uri,
                    auth=(os.getenv("NEO4J_USER", "neo4j"), os.getenv("NEO4J_PASSWORD", "")),
                )
                graph_initializer = ProjectGraphInitializer(driver=driver)
            except Exception as e:
                logger.warning("Neo4j unavailable; graph-aware extraction disabled: %s", e)

        if qdrant_service is not None:
            try:
                _spec_extractor = EnhancedSpecExtractor(
                    llm_service=llm_service,
                    qdrant_service=qdrant_service,
                    graph_initializer=graph_initializer,
                )
            except Exception as e:
                logger.warning("EnhancedSpecExtractor init failed: %s", e)

        logger.info("specification-agent-service ready")
        yield
        logger.info("specification-agent-service shutting down")


app = FastAPI(title="Simorgh Specification Agent", version="1.0.0", lifespan=lifespan)

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
class ClassifyRequest(BaseModel):
    filename: str
    content: Optional[str] = None


class ExtractRequest(BaseModel):
    project_number: str
    document_id: str
    llm_mode: str = "online"
    search_limit: int = 5


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------
@app.get("/health")
def health():
    return {
        "status": "healthy",
        "service": "specification-agent-service",
        "classifier_ready": _classifier is not None,
        "extractor_ready": _spec_extractor is not None,
    }


# ---------------------------------------------------------------------------
# REST
# ---------------------------------------------------------------------------
@app.post("/api/v2/specs/classify")
def classify_rest(req: ClassifyRequest) -> Dict[str, Any]:
    if _classifier is None:
        raise HTTPException(status_code=503, detail="classifier not initialised")
    category, doc_type, confidence = _classifier.classify(
        filename=req.filename, content=req.content
    )
    return {
        "category": category.value if hasattr(category, "value") else str(category),
        "doc_type": doc_type,
        "confidence": confidence,
    }


@app.post("/api/v2/specs/extract")
def extract_rest(req: ExtractRequest) -> Dict[str, Any]:
    if _spec_extractor is None:
        raise HTTPException(status_code=503, detail="extractor not initialised (Qdrant down?)")
    return {
        "specs": _spec_extractor.extract_specifications_enhanced(
            project_number=req.project_number,
            document_id=req.document_id,
            llm_mode=req.llm_mode,
            search_limit=req.search_limit,
        )
    }


# ---------------------------------------------------------------------------
# MCP
# ---------------------------------------------------------------------------
mcp = FastMCP(
    "specification-agent-service",
    instructions=(
        "Electrical document classification and two-stage RAG-based "
        "specification extraction over indexed project documents."
    ),
)


@mcp.tool()
async def classify_document(filename: str, content: Optional[str] = None) -> Dict[str, Any]:
    """
    Classify a document into category × doc_type by filename, optionally
    refined with the document's text content.

    Returns: {category, doc_type, confidence}
    """
    if _classifier is None:
        return {"error": "classifier not initialised"}
    category, doc_type, confidence = _classifier.classify(filename=filename, content=content)
    return {
        "category": category.value if hasattr(category, "value") else str(category),
        "doc_type": doc_type,
        "confidence": confidence,
    }


@mcp.tool()
async def extract_specifications(
    project_number: str,
    document_id: str,
    llm_mode: str = "online",
    search_limit: int = 5,
) -> Dict[str, Any]:
    """
    Two-stage RAG extraction of structured specifications from a document
    that has ALREADY been indexed into Qdrant under (project_number, document_id).

    Returns: {category: {field: value, ...}, ...}
    """
    if _spec_extractor is None:
        return {"error": "extractor not initialised"}
    return {
        "specs": _spec_extractor.extract_specifications_enhanced(
            project_number=project_number,
            document_id=document_id,
            llm_mode=llm_mode,
            search_limit=search_limit,
        )
    }


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
