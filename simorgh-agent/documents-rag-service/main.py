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

# Router has its own prefix "/api". Don't add another one.
app.include_router(documents_rag_router)


@app.get("/health")
def health():
    return {"status": "healthy", "service": "documents-rag-service"}
