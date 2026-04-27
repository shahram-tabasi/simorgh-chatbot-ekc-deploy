"""
Graph RAG Service
=================
Standalone REST microservice for Neo4j-based graph RAG queries
(entity linking, relationship traversal, hybrid graph+vector retrieval).

Routes:
- POST /api/v2/graph-rag/answer   → answer a question with graph context
- POST /api/v2/graph-rag/entities → entity linking from a text block
- GET  /health
"""
import logging
import os
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from services.graph_rag_service import get_graph_rag_service
from services.graph_rag import GraphRAG

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("graph-rag-service")

app = FastAPI(title="Simorgh Graph RAG Service", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ALLOW_ORIGINS", "*").split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class AnswerRequest(BaseModel):
    question: str
    project_id: Optional[str] = None
    top_k: int = 5


class EntitiesRequest(BaseModel):
    text: str


@app.get("/health")
def health():
    return {"status": "healthy", "service": "graph-rag-service"}


@app.post("/api/v2/graph-rag/answer")
async def answer(req: AnswerRequest) -> Dict[str, Any]:
    try:
        svc = get_graph_rag_service()
        return await svc.answer_with_graph(
            question=req.question, project_id=req.project_id, top_k=req.top_k
        )
    except Exception as e:
        logger.exception("graph-rag answer failed")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/v2/graph-rag/entities")
async def entities(req: EntitiesRequest) -> Dict[str, Any]:
    try:
        svc = get_graph_rag_service()
        return {"entities": await svc.entity_linking(req.text)}
    except Exception as e:
        logger.exception("entity linking failed")
        raise HTTPException(status_code=500, detail=str(e))
