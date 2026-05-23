"""
Tiny adapter that translates the legacy `/generate-stream` request
shape into vLLM's OpenAI `/v1/chat/completions` and streams the
response back in the legacy SSE format.

Why this exists
---------------
The original ai_service exposed two endpoints:
  • /v1/chat/completions   — OpenAI-compatible chat
  • /generate-stream       — legacy SSE: takes {system_prompt, user_prompt,
                             thinking_level, stream}, emits {chunk, text,
                             output, status} JSON lines.

When we replaced ai_service with vLLM's native OpenAI serve mode
(to get Harmony tool calling), we lost /generate-stream. Seven
services still use the legacy endpoint via llm_async_client.py.
This adapter keeps them working without touching their code: nginx
routes /generate-stream here, this service proxies to vLLM serve
and translates on the fly.

Configuration (env vars)
------------------------
  UPSTREAM_URL   default http://ai_service:9000  (vLLM serve)
  UPSTREAM_MODEL default gpt-oss-20b
  TIMEOUT_SEC    default 1800
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Any, AsyncIterator, Dict

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("ai-adapter")

UPSTREAM_URL   = os.getenv("UPSTREAM_URL", "http://ai_service:9000").rstrip("/")
UPSTREAM_MODEL = os.getenv("UPSTREAM_MODEL", "gpt-oss-20b")
TIMEOUT_SEC    = float(os.getenv("TIMEOUT_SEC", "1800"))

app = FastAPI(title="ai-adapter", version="1.0.0")


class LegacyRequest(BaseModel):
    """The /generate-stream payload llm_async_client.py emits."""
    system_prompt: str = ""
    user_prompt:   str
    thinking_level: str = "medium"          # ignored; kept for compat
    max_tokens:    int = Field(default=2048)
    stream:        bool = True
    temperature:   float = 0.7
    # Not used by callers today but accepted to avoid 422s if they
    # ever start sending it.
    history: list[dict] = Field(default_factory=list)


@app.get("/health")
async def health() -> Dict[str, Any]:
    """Liveness probe + upstream check.

    nginx /health on the LLM box already proxies straight to
    ai_service:/health (the vLLM serve health). This is a separate
    probe specific to the adapter so docker healthchecks don't
    accidentally start it before vLLM is alive.
    """
    try:
        async with httpx.AsyncClient(timeout=5.0) as c:
            r = await c.get(f"{UPSTREAM_URL}/health")
        return {"status": "ok", "upstream_status": r.status_code,
                "upstream_url": UPSTREAM_URL}
    except Exception as e:
        return {"status": "degraded", "error": str(e),
                "upstream_url": UPSTREAM_URL}


@app.post("/generate-stream")
async def generate_stream(req: LegacyRequest, request: Request):
    """Translate legacy request → /v1/chat/completions, stream back
    in the legacy SSE shape llm_async_client.py expects."""
    messages = []
    if req.system_prompt:
        messages.append({"role": "system", "content": req.system_prompt})
    # Some callers pre-load multi-turn history.
    for h in req.history or []:
        if isinstance(h, dict) and h.get("role") and h.get("content"):
            messages.append({"role": h["role"], "content": h["content"]})
    messages.append({"role": "user", "content": req.user_prompt})

    payload = {
        "model":       UPSTREAM_MODEL,
        "messages":    messages,
        "temperature": req.temperature,
        "max_tokens":  req.max_tokens,
        "stream":      bool(req.stream),
    }

    if not req.stream:
        # Non-streaming legacy callers — collect and return one JSON.
        try:
            async with httpx.AsyncClient(timeout=TIMEOUT_SEC) as c:
                r = await c.post(f"{UPSTREAM_URL}/v1/chat/completions",
                                 json=payload)
            r.raise_for_status()
            body = r.json()
        except Exception as e:
            logger.exception("non-streaming legacy call failed")
            raise HTTPException(status_code=502, detail=str(e))
        content = (body.get("choices") or [{}])[0].get("message", {}).get("content") or ""
        return {
            "output": content,
            "tokens_used": (body.get("usage") or {}).get("completion_tokens", 0),
            "thinking_level": req.thinking_level,
        }

    # Streaming path — translate vLLM's SSE chunks into legacy frames.
    async def event_stream() -> AsyncIterator[bytes]:
        full = ""
        async with httpx.AsyncClient(timeout=TIMEOUT_SEC) as c:
            async with c.stream(
                "POST", f"{UPSTREAM_URL}/v1/chat/completions", json=payload,
            ) as r:
                if r.status_code != 200:
                    body = (await r.aread()).decode("utf-8", errors="replace")[:500]
                    yield (json.dumps({"error": f"{r.status_code} {body}"})
                           + "\n").encode()
                    return
                async for line in r.aiter_lines():
                    if not line:
                        continue
                    if line.startswith("data: "):
                        data = line[6:].strip()
                    else:
                        data = line.strip()
                    if data == "[DONE]":
                        # Match the legacy "completed" frame.
                        yield (json.dumps({"status": "completed",
                                           "output": full}) + "\n").encode()
                        return
                    try:
                        obj = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    choices = obj.get("choices") or []
                    if not choices:
                        continue
                    delta = choices[0].get("delta") or {}
                    chunk = delta.get("content") or ""
                    if chunk:
                        full += chunk
                        # Legacy clients expect either {chunk} or {text}.
                        # llm_async_client.py accepts both — pick {chunk}.
                        yield (json.dumps({"chunk": chunk}) + "\n").encode()

    return StreamingResponse(event_stream(),
                             media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache",
                                      "X-Accel-Buffering": "no"})


# Pass-throughs so nginx can route everything else here too without
# us needing two upstream blocks. They simply proxy to vLLM serve.
async def _passthrough(method: str, path: str, request: Request,
                       streaming: bool = False):
    body = await request.body()
    url = f"{UPSTREAM_URL}/{path.lstrip('/')}"
    headers = {k: v for k, v in request.headers.items()
               if k.lower() not in {"host", "content-length"}}
    if streaming:
        async def gen():
            async with httpx.AsyncClient(timeout=TIMEOUT_SEC) as c:
                async with c.stream(method, url, content=body, headers=headers,
                                    params=dict(request.query_params)) as r:
                    async for chunk in r.aiter_raw():
                        yield chunk
        return StreamingResponse(gen(), media_type="text/event-stream")
    async with httpx.AsyncClient(timeout=TIMEOUT_SEC) as c:
        r = await c.request(method, url, content=body, headers=headers,
                            params=dict(request.query_params))
    return r.json() if r.headers.get("content-type", "").startswith("application/json") else r.text


@app.get("/v1/models")
async def v1_models(request: Request):
    return await _passthrough("GET", "/v1/models", request)
