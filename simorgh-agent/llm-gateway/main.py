"""
LLM Gateway Service
===================
Standalone REST microservice wrapping the unified LLM logic (OpenAI + the
load-balanced local LLM endpoint that fronts 192.168.1.61 / 192.168.1.62).

Endpoints
---------
GET  /health           liveness — does NOT call upstream (cheap)
GET  /health/deep      readiness — pings OpenAI + local LLM
GET  /stats            usage statistics
POST /generate         sync completion
POST /generate/stream  SSE streaming (chunks are JSON-encoded; clients parse)
POST /generate/async   non-blocking generation with per-user tracking
POST /embeddings       single text → embedding vector

The bulk of the implementation lives in `llm_service.py` (the
LLMService class extracted from backend in phase 2) plus
`llm_async_client.py` and `output_parser.py`. This module is a thin
FastAPI shell.
"""
import json
import logging
import os
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from llm_service import (
    LLMError,
    LLMOfflineError,
    LLMOnlineError,
    LLMService,
    LLMTimeoutError,
)

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("llm-gateway")

app = FastAPI(title="Simorgh LLM Gateway", version="1.0.0")

# Lazy / lightweight construction; doesn't probe upstreams.
llm = LLMService()


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------
class Message(BaseModel):
    role: str
    content: str


class GenerateRequest(BaseModel):
    messages: List[Message]
    mode: Optional[str] = None       # "online" | "offline" | "auto"
    temperature: float = 0.7
    max_tokens: Optional[int] = None
    use_cache: bool = False
    inject_knowledge: bool = False   # NOTE: no-op in this service (see README)


class AsyncGenerateRequest(GenerateRequest):
    user_id: str = "anonymous"


class EmbeddingRequest(BaseModel):
    text: str
    mode: Optional[str] = None
    model: Optional[str] = None


# ---------------------------------------------------------------------------
# Health & stats
# ---------------------------------------------------------------------------
@app.get("/health")
def health() -> Dict[str, Any]:
    """Liveness — process is up. Does NOT call OpenAI / local LLM."""
    return {"status": "healthy", "service": "llm-gateway"}


@app.get("/health/deep")
def health_deep() -> Dict[str, Any]:
    """Readiness — actually probes OpenAI + the local LLM endpoint."""
    return llm.health_check()


@app.get("/stats")
def stats() -> Dict[str, Any]:
    return llm.get_stats()


# ---------------------------------------------------------------------------
# Generation
# ---------------------------------------------------------------------------
@app.post("/generate")
def generate(req: GenerateRequest) -> Dict[str, Any]:
    try:
        return llm.generate(
            messages=[m.model_dump() for m in req.messages],
            mode=req.mode,
            temperature=req.temperature,
            max_tokens=req.max_tokens,
            use_cache=req.use_cache,
            inject_knowledge=req.inject_knowledge,
        )
    except LLMTimeoutError as e:
        raise HTTPException(status_code=504, detail=str(e))
    except (LLMOfflineError, LLMOnlineError) as e:
        raise HTTPException(status_code=502, detail=str(e))
    except LLMError as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/generate/stream")
def generate_stream(req: GenerateRequest):
    """
    Server-Sent Events. Each event payload is a JSON object so chunks
    containing newlines or special characters survive transit:

        data: {"chunk": "Hello"}\\n\\n
        data: {"chunk": " world"}\\n\\n
        data: {"done": true}\\n\\n
        data: {"error": "..."}\\n\\n   (on failure)

    Clients should parse each `data: ` line as JSON.
    """
    def event_stream():
        try:
            for chunk in llm.generate_stream(
                messages=[m.model_dump() for m in req.messages],
                mode=req.mode,
                temperature=req.temperature,
                max_tokens=req.max_tokens,
            ):
                yield f"data: {json.dumps({'chunk': chunk})}\n\n"
            yield f"data: {json.dumps({'done': True})}\n\n"
        except Exception as e:
            logger.exception("stream failed")
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@app.post("/generate/async")
async def generate_async(req: AsyncGenerateRequest) -> Dict[str, Any]:
    try:
        return await llm.async_generate(
            messages=[m.model_dump() for m in req.messages],
            mode=req.mode,
            temperature=req.temperature,
            max_tokens=req.max_tokens,
            user_id=req.user_id,
            use_cache=req.use_cache,
        )
    except LLMTimeoutError as e:
        raise HTTPException(status_code=504, detail=str(e))
    except (LLMOfflineError, LLMOnlineError) as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.post("/embeddings")
def embeddings(req: EmbeddingRequest) -> Dict[str, Any]:
    try:
        vec = llm.generate_embedding(text=req.text, mode=req.mode, model=req.model)
        return {"embedding": vec, "dim": len(vec)}
    except LLMError as e:
        raise HTTPException(status_code=502, detail=str(e))
