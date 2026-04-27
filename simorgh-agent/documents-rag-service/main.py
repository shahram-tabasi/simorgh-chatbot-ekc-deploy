"""
Documents RAG Service
=====================
Standalone REST microservice for document upload, chunking, embedding,
indexing into Qdrant, and semantic search.

Mounts the documents_rag router at /api/v2/documents.

Backed by:
- Qdrant (vector store)
- Redis (cache, task tracking)
- LLM service (for spec extraction / classification)
- doc-processor (PDF/Excel/Word → Markdown)
- (optional) Neo4j (legacy GraphRAG)
"""
import logging
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from routes.documents_rag import router as documents_rag_router

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("documents-rag-service")

app = FastAPI(title="Simorgh Documents RAG Service", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ALLOW_ORIGINS", "*").split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(documents_rag_router, prefix="/api/v2/documents", tags=["documents"])


@app.get("/health")
def health():
    return {"status": "healthy", "service": "documents-rag-service"}
