"""
LLM Gateway Service
===================
Standalone REST microservice wrapping the unified LLM service.

Routes:
- POST /generate           → sync generation
- POST /generate/stream    → SSE streaming
- POST /generate/async     → async non-blocking generation (per-user tracking)
- POST /embeddings         → embedding vector
- GET  /health             → service health (OpenAI + local LLM endpoints)
- GET  /stats              → usage statistics

Backed by `llm_service.LLMService` (extracted from backend monolith in Phase 2).
Talks to OpenAI and the load-balanced local LLM endpoint (nginx → 192.168.1.61/.62).
"""
import logging
import os
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from llm_service import LLMService, LLMError, LLMOfflineError, LLMOnlineError, LLMTimeoutError

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("llm-gateway")

app = FastAPI(title="Simorgh LLM Gateway", version="1.0.0")

llm = LLMService()


class Message(BaseModel):
    role: str
    content: str


class GenerateRequest(BaseModel):
    messages: List[Message]
    mode: Optional[str] = None
    temperature: float = 0.7
    max_tokens: Optional[int] = None
    use_cache: bool = False
    inject_knowledge: bool = False


class AsyncGenerateRequest(GenerateRequest):
    user_id: str = "anonymous"


class EmbeddingRequest(BaseModel):
    text: str
    mode: Optional[str] = None
    model: Optional[str] = None


@app.get("/health")
def health() -> Dict[str, Any]:
    return llm.health_check()


@app.get("/stats")
def stats() -> Dict[str, Any]:
    return llm.get_stats()


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
    def event_stream():
        try:
            for chunk in llm.generate_stream(
                messages=[m.model_dump() for m in req.messages],
                mode=req.mode,
                temperature=req.temperature,
                max_tokens=req.max_tokens,
            ):
                yield f"data: {chunk}\n\n"
            yield "data: [DONE]\n\n"
        except Exception as e:
            logger.exception("stream failed")
            yield f"data: [ERROR] {e}\n\n"

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
