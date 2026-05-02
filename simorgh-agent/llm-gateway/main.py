"""
LLM Gateway Service
===================
Single client-facing endpoint for every LLM call in the simorgh stack.
Routes between three backends, all speaking the OpenAI HTTP API:

  online   ──►  api.openai.com         (OPENAI_API_KEY)
  offline-text ──► 192.168.1.61/v1     (vllm/vllm-openai, gpt-oss-20b)
  offline-vlm  ──► 192.168.1.62/v1     (vllm/vllm-openai, Qwen2-VL-7B)

mode selection (request field `mode`):
    "online"   force OpenAI
    "offline"  force the matching local backend (LLM or VLM, see below)
    "auto"     try online first, fall back to offline on failure
    null       use DEFAULT_LLM_MODE env (default: "online")

Local-text vs local-VLM is picked automatically: the request is
inspected for any `content` part whose `type == "image_url"`; if found,
the request is routed to LOCAL_LLM_URL_VLM, otherwise to
LOCAL_LLM_URL_TEXT. Online mode also passes vision content through —
GPT-4o is multimodal natively.

Endpoints (all OpenAI-shape requests + clean wrappers):

  GET  /health                liveness; no upstream call
  GET  /health/deep           pings each configured backend
  GET  /stats                 in-memory counters
  POST /generate              sync; returns {response, model, usage, mode, backend}
  POST /generate/stream       SSE; data: {"chunk":"..."}, terminator {"done":true}
  POST /generate/async        non-blocking; same shape as /generate
  POST /embeddings            single text → vector

This file is intentionally self-contained — does not import the old
LLMService class. The heavyweight bulk-copied llm_service.py module
stays in this directory for backwards-compat with anything still
importing from it, but the request path no longer touches it.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from typing import Any, AsyncIterator, Dict, List, Optional, Tuple, Union

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("llm-gateway")


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
OPENAI_API_KEY      = os.getenv("OPENAI_API_KEY", "").strip()
OPENAI_BASE_URL     = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
OPENAI_MODEL        = os.getenv("OPENAI_MODEL", "gpt-4o")
OPENAI_EMBED_MODEL  = os.getenv("OPENAI_EMBED_MODEL", "text-embedding-3-large")

# Two distinct local backends. Both are vllm/vllm-openai instances.
LOCAL_LLM_URL_TEXT  = os.getenv("LOCAL_LLM_URL_TEXT", "http://192.168.1.61/v1").rstrip("/")
LOCAL_LLM_URL_VLM   = os.getenv("LOCAL_LLM_URL_VLM",  "http://192.168.1.62/v1").rstrip("/")
LOCAL_LLM_MODEL_TEXT = os.getenv("LOCAL_LLM_MODEL_TEXT", "gpt-oss-20b")
LOCAL_LLM_MODEL_VLM  = os.getenv("LOCAL_LLM_MODEL_VLM",  "qwen2.5-vl-7b")
LOCAL_LLM_API_KEY   = os.getenv("LOCAL_LLM_API_KEY", "").strip()  # vllm --api-key

DEFAULT_LLM_MODE    = os.getenv("DEFAULT_LLM_MODE", "online").lower()  # online | offline | auto
TIMEOUT_SEC         = float(os.getenv("LLM_GATEWAY_TIMEOUT_SEC", "1800"))


# ---------------------------------------------------------------------------
# In-memory counters
# ---------------------------------------------------------------------------
_stats: Dict[str, Any] = {
    "total":       0,
    "online":      0,
    "offline":     0,
    "offline_text": 0,
    "offline_vlm":  0,
    "fallbacks":   0,
    "failures":    0,
    "start_ts":    time.time(),
}


# ---------------------------------------------------------------------------
# Request shapes — OpenAI-compatible
# ---------------------------------------------------------------------------
class Message(BaseModel):
    """OpenAI-shape chat message. `content` may be a plain string OR a list
    of typed content parts (text / image_url) for multimodal input."""
    role: str
    content: Union[str, List[Dict[str, Any]]]


class GenerateRequest(BaseModel):
    messages: List[Message]
    mode: Optional[str] = Field(
        None, description='"online" | "offline" | "auto" | None=DEFAULT_LLM_MODE',
    )
    temperature: float = 0.7
    max_tokens: Optional[int] = None
    # Optional explicit model override. If null we pick per backend
    # (OPENAI_MODEL online, LOCAL_LLM_MODEL_{TEXT,VLM} offline).
    model: Optional[str] = None
    # Carried through to OpenAI / vllm but not interpreted here.
    extra: Optional[Dict[str, Any]] = None


class AsyncGenerateRequest(GenerateRequest):
    user_id: str = "anonymous"


class EmbeddingRequest(BaseModel):
    text: str
    mode: Optional[str] = None
    model: Optional[str] = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _has_image(messages: List[Dict[str, Any]]) -> bool:
    """True if any message has a content part with type == image_url."""
    for m in messages:
        c = m.get("content")
        if isinstance(c, list):
            for part in c:
                if isinstance(part, dict) and part.get("type") == "image_url":
                    return True
    return False


def _resolve_backend(
    mode: Optional[str], messages: List[Dict[str, Any]],
) -> Tuple[str, str, str, Optional[str]]:
    """
    Pick (mode, base_url, model, api_key) for a request.

    mode resolution:
        request.mode > DEFAULT_LLM_MODE
    backend resolution within mode=offline:
        has image content → VLM (.62), else LLM (.61)
    """
    effective_mode = (mode or DEFAULT_LLM_MODE).lower()
    if effective_mode not in {"online", "offline", "auto"}:
        raise HTTPException(status_code=400, detail=f"unknown mode: {mode!r}")

    if effective_mode == "online":
        if not OPENAI_API_KEY:
            raise HTTPException(status_code=503, detail="OPENAI_API_KEY not set")
        return ("online", OPENAI_BASE_URL, OPENAI_MODEL, OPENAI_API_KEY)

    # offline OR auto-with-online-failure: pick local backend
    if _has_image(messages):
        return ("offline_vlm", LOCAL_LLM_URL_VLM, LOCAL_LLM_MODEL_VLM,
                LOCAL_LLM_API_KEY or None)
    return ("offline_text", LOCAL_LLM_URL_TEXT, LOCAL_LLM_MODEL_TEXT,
            LOCAL_LLM_API_KEY or None)


def _build_payload(
    messages: List[Dict[str, Any]],
    *,
    model: str,
    temperature: float,
    max_tokens: Optional[int],
    extra: Optional[Dict[str, Any]],
    stream: bool,
) -> Dict[str, Any]:
    body: Dict[str, Any] = {
        "model":       model,
        "messages":    messages,
        "temperature": temperature,
        "stream":      stream,
    }
    if max_tokens is not None:
        body["max_tokens"] = max_tokens
    if extra:
        body.update(extra)
    return body


def _auth_headers(api_key: Optional[str]) -> Dict[str, str]:
    return {"Authorization": f"Bearer {api_key}"} if api_key else {}


# ---------------------------------------------------------------------------
# FastAPI
# ---------------------------------------------------------------------------
app = FastAPI(title="Simorgh LLM Gateway", version="2.0.0")


@app.get("/health")
def health() -> Dict[str, Any]:
    """Cheap liveness — process is up. No upstream calls."""
    return {
        "status":  "healthy",
        "service": "llm-gateway",
        "default_mode": DEFAULT_LLM_MODE,
        "local_text_url": LOCAL_LLM_URL_TEXT,
        "local_vlm_url":  LOCAL_LLM_URL_VLM,
    }


@app.get("/health/deep")
async def health_deep() -> Dict[str, Any]:
    """Probe each configured backend's /health (or /v1/models for OpenAI)."""
    out: Dict[str, Any] = {"checks": {}}

    async with httpx.AsyncClient(timeout=10.0) as c:
        # OpenAI
        if OPENAI_API_KEY:
            try:
                r = await c.get(
                    f"{OPENAI_BASE_URL}/models",
                    headers=_auth_headers(OPENAI_API_KEY),
                )
                out["checks"]["online"] = {"ok": r.status_code == 200,
                                           "status": r.status_code}
            except Exception as e:
                out["checks"]["online"] = {"ok": False, "error": str(e)[:200]}
        else:
            out["checks"]["online"] = {"ok": False, "error": "OPENAI_API_KEY not set"}

        # Local LLM
        try:
            r = await c.get(f"{LOCAL_LLM_URL_TEXT.rsplit('/v1',1)[0]}/health")
            out["checks"]["offline_text"] = {"ok": r.status_code == 200,
                                              "status": r.status_code,
                                              "url": LOCAL_LLM_URL_TEXT}
        except Exception as e:
            out["checks"]["offline_text"] = {"ok": False, "error": str(e)[:200],
                                              "url": LOCAL_LLM_URL_TEXT}

        # Local VLM
        try:
            r = await c.get(f"{LOCAL_LLM_URL_VLM.rsplit('/v1',1)[0]}/health")
            out["checks"]["offline_vlm"] = {"ok": r.status_code == 200,
                                             "status": r.status_code,
                                             "url": LOCAL_LLM_URL_VLM}
        except Exception as e:
            out["checks"]["offline_vlm"] = {"ok": False, "error": str(e)[:200],
                                             "url": LOCAL_LLM_URL_VLM}

    out["status"] = "healthy" if any(c.get("ok") for c in out["checks"].values()) else "unhealthy"
    return out


@app.get("/stats")
def stats() -> Dict[str, Any]:
    s = dict(_stats)
    s["uptime_sec"] = time.time() - s.pop("start_ts")
    return s


# ---------------------------------------------------------------------------
# /generate — sync chat completion
# ---------------------------------------------------------------------------
async def _do_chat_completion(
    backend_kind: str,
    base_url: str,
    api_key: Optional[str],
    payload: Dict[str, Any],
) -> Dict[str, Any]:
    """One non-streaming POST /v1/chat/completions to a chosen backend."""
    async with httpx.AsyncClient(timeout=TIMEOUT_SEC) as c:
        r = await c.post(
            f"{base_url}/chat/completions",
            json=payload, headers=_auth_headers(api_key),
        )
    if r.status_code != 200:
        raise HTTPException(status_code=502,
                            detail=f"{backend_kind}: {r.status_code} {r.text[:300]}")
    body = r.json()
    choice = (body.get("choices") or [{}])[0]
    msg    = choice.get("message", {}) or {}
    return {
        "response":      msg.get("content", ""),
        "model":         body.get("model"),
        "finish_reason": choice.get("finish_reason"),
        "usage":         body.get("usage", {}),
        "backend":       backend_kind,
    }


@app.post("/generate")
async def generate(req: GenerateRequest) -> Dict[str, Any]:
    _stats["total"] += 1
    msgs = [m.model_dump() for m in req.messages]
    mode_resolve = (req.mode or DEFAULT_LLM_MODE).lower()
    primary_kind, primary_url, primary_model, primary_key = _resolve_backend(req.mode, msgs)
    payload = _build_payload(
        msgs, model=req.model or primary_model,
        temperature=req.temperature, max_tokens=req.max_tokens,
        extra=req.extra, stream=False,
    )

    try:
        out = await _do_chat_completion(primary_kind, primary_url, primary_key, payload)
        out["mode"] = primary_kind
        _stats[primary_kind] = _stats.get(primary_kind, 0) + 1
        if primary_kind.startswith("offline"):
            _stats["offline"] += 1
        else:
            _stats["online"] += 1
        return out

    except HTTPException as primary_err:
        # Auto fallback: if the first try was online, try offline (local).
        if mode_resolve != "auto" or primary_kind != "online":
            _stats["failures"] += 1
            raise

        logger.warning("auto-mode online failed (%s), falling back to offline",
                       primary_err.detail)
        _stats["fallbacks"] += 1

        fallback_kind, fallback_url, fallback_model, fallback_key = _resolve_backend(
            "offline", msgs,
        )
        payload["model"] = req.model or fallback_model
        try:
            out = await _do_chat_completion(
                fallback_kind, fallback_url, fallback_key, payload,
            )
            out["mode"] = f"auto→{fallback_kind}"
            _stats[fallback_kind] = _stats.get(fallback_kind, 0) + 1
            _stats["offline"] += 1
            return out
        except HTTPException:
            _stats["failures"] += 1
            raise


# ---------------------------------------------------------------------------
# /generate/stream — SSE
# ---------------------------------------------------------------------------
async def _stream_chat_completion(
    backend_kind: str,
    base_url: str,
    api_key: Optional[str],
    payload: Dict[str, Any],
) -> AsyncIterator[str]:
    """Yield content chunks (str) parsed from an OpenAI streaming response."""
    async with httpx.AsyncClient(timeout=TIMEOUT_SEC) as c:
        async with c.stream(
            "POST",
            f"{base_url}/chat/completions",
            json={**payload, "stream": True},
            headers=_auth_headers(api_key),
        ) as r:
            if r.status_code != 200:
                body = (await r.aread()).decode("utf-8", errors="replace")[:300]
                raise HTTPException(status_code=502,
                                    detail=f"{backend_kind}: {r.status_code} {body}")
            async for line in r.aiter_lines():
                if not line:
                    continue
                if line.startswith("data: "):
                    data = line[6:].strip()
                else:
                    data = line.strip()
                if data == "[DONE]":
                    return
                try:
                    payload_obj = json.loads(data)
                except Exception:
                    continue
                choices = payload_obj.get("choices") or []
                if not choices:
                    continue
                delta = choices[0].get("delta") or {}
                chunk = delta.get("content") or ""
                if chunk:
                    yield chunk


@app.post("/generate/stream")
async def generate_stream(req: GenerateRequest):
    """
    SSE proxy. Each event payload is JSON so newlines / special chars are
    transport-safe:

        data: {"chunk": "Hello"}\\n\\n
        data: {"chunk": " world"}\\n\\n
        data: {"meta":  {"backend":"offline_vlm","model":"qwen2-vl-7b"}}\\n\\n
        data: {"done":  true}\\n\\n
        data: {"error": "..."}\\n\\n   (on failure)
    """
    _stats["total"] += 1
    msgs = [m.model_dump() for m in req.messages]
    backend_kind, base_url, model, api_key = _resolve_backend(req.mode, msgs)
    payload = _build_payload(
        msgs, model=req.model or model,
        temperature=req.temperature, max_tokens=req.max_tokens,
        extra=req.extra, stream=True,
    )
    _stats[backend_kind] = _stats.get(backend_kind, 0) + 1
    if backend_kind.startswith("offline"):
        _stats["offline"] += 1
    else:
        _stats["online"] += 1

    async def event_stream():
        # Tell the client which backend was selected — useful for the UI.
        yield f"data: {json.dumps({'meta': {'backend': backend_kind, 'model': payload['model']}})}\n\n"
        try:
            async for chunk in _stream_chat_completion(
                backend_kind, base_url, api_key, payload,
            ):
                yield f"data: {json.dumps({'chunk': chunk})}\n\n"
            yield f"data: {json.dumps({'done': True})}\n\n"
        except HTTPException as e:
            _stats["failures"] += 1
            yield f"data: {json.dumps({'error': e.detail})}\n\n"
        except Exception as e:
            _stats["failures"] += 1
            logger.exception("stream failed")
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


# ---------------------------------------------------------------------------
# /generate/async — same shape as /generate, kept for backwards-compat
# ---------------------------------------------------------------------------
@app.post("/generate/async")
async def generate_async(req: AsyncGenerateRequest) -> Dict[str, Any]:
    """
    Non-blocking variant. Per-user counters could go here in a future
    revision; for now it's identical to /generate plus a trace tag.
    """
    out = await generate(req)
    out["user_id"] = req.user_id
    return out


# ---------------------------------------------------------------------------
# /embeddings
# ---------------------------------------------------------------------------
@app.post("/embeddings")
async def embeddings(req: EmbeddingRequest) -> Dict[str, Any]:
    """
    Embeddings via OpenAI's /v1/embeddings endpoint (online mode only —
    vllm-openai by default doesn't serve embeddings; flip with
    --task=embedding on a separate model if you ever need offline).
    """
    if not OPENAI_API_KEY:
        raise HTTPException(status_code=503,
                            detail="OPENAI_API_KEY not set; offline embeddings "
                                   "not configured. Use embeddings-service:8031 "
                                   "(sentence-transformers) instead.")
    model = req.model or OPENAI_EMBED_MODEL
    async with httpx.AsyncClient(timeout=60.0) as c:
        r = await c.post(
            f"{OPENAI_BASE_URL}/embeddings",
            json={"model": model, "input": req.text},
            headers=_auth_headers(OPENAI_API_KEY),
        )
    if r.status_code != 200:
        raise HTTPException(status_code=502,
                            detail=f"openai embeddings: {r.status_code} {r.text[:200]}")
    body = r.json()
    vec = (body.get("data") or [{}])[0].get("embedding") or []
    return {"embedding": vec, "dim": len(vec), "model": body.get("model", model)}
