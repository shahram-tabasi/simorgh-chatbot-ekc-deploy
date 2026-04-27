"""
Embeddings Service
==================
Standalone REST microservice for sentence-transformers embeddings.

This is the non-LLM embedding path used by Qdrant for indexing/search when
domain-tuned LLM embeddings (provided by llm-gateway) are not desired.

Routes:
- POST /embeddings        → single text → vector
- POST /embeddings/batch  → list of texts → list of vectors
- GET  /info              → model name, dimension
- GET  /health            → service health
"""
import logging
import os
from typing import List

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("embeddings-service")

MODEL_NAME = os.getenv("EMBEDDING_MODEL", "sentence-transformers/all-MiniLM-L6-v2")
DEVICE = os.getenv("EMBEDDING_DEVICE", "cpu")
NORMALIZE = os.getenv("EMBEDDING_NORMALIZE", "true").lower() == "true"

logger.info("Loading embedding model: %s on %s", MODEL_NAME, DEVICE)
model = SentenceTransformer(MODEL_NAME, device=DEVICE)
EMBEDDING_DIM = model.get_sentence_embedding_dimension()
logger.info("Loaded model. dim=%d", EMBEDDING_DIM)

app = FastAPI(title="Simorgh Embeddings Service", version="1.0.0")


class TextRequest(BaseModel):
    text: str


class BatchRequest(BaseModel):
    texts: List[str]


@app.get("/health")
def health():
    return {"status": "healthy", "model": MODEL_NAME, "dim": EMBEDDING_DIM, "device": DEVICE}


@app.get("/info")
def info():
    return {"model": MODEL_NAME, "dim": EMBEDDING_DIM, "device": DEVICE, "normalize": NORMALIZE}


@app.post("/embeddings")
def embeddings(req: TextRequest):
    if not req.text:
        raise HTTPException(status_code=400, detail="text is required")
    vec = model.encode(req.text, normalize_embeddings=NORMALIZE).tolist()
    return {"embedding": vec, "dim": len(vec)}


@app.post("/embeddings/batch")
def embeddings_batch(req: BatchRequest):
    if not req.texts:
        raise HTTPException(status_code=400, detail="texts is required")
    vecs = model.encode(req.texts, normalize_embeddings=NORMALIZE).tolist()
    return {"embeddings": vecs, "count": len(vecs), "dim": len(vecs[0]) if vecs else 0}
