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
import re
import time
from typing import Any, AsyncIterator, Dict, List, Optional, Tuple, Union

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

import live_settings
from harmony import (
    is_harmony_output,
    parse_harmony,
    sanitize_chat_message,
)

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("llm-gateway")


# ---------------------------------------------------------------------------
# Configuration — every value is resolved through live_settings (DB →
# admin-service) with the env var as the fallback default. Cached 30 s.
# ---------------------------------------------------------------------------
def _cfg(key: str, default: str = "") -> str:
    v = live_settings.get_sync(key, default)
    return (v or "").strip()


def _cfg_url(key: str, default: str) -> str:
    return _cfg(key, default).rstrip("/")


def _openai_api_key()      -> str: return _cfg("OPENAI_API_KEY")
def _openai_base_url()     -> str: return _cfg_url("OPENAI_BASE_URL", "https://api.openai.com/v1")
def _openai_model()        -> str: return _cfg("OPENAI_MODEL", "gpt-4o")
def _openai_embed_model()  -> str: return _cfg("OPENAI_EMBED_MODEL", "text-embedding-3-large")
def _local_llm_url_text()  -> str: return _cfg_url("LOCAL_LLM_URL_TEXT", "http://192.168.1.61/v1")
def _local_llm_url_vlm()   -> str: return _cfg_url("LOCAL_LLM_URL_VLM",  "http://192.168.1.62/v1")
def _local_llm_model_text()-> str: return _cfg("LOCAL_LLM_MODEL_TEXT", "qwen3-30b-a3b")
def _local_llm_model_vlm() -> str: return _cfg("LOCAL_LLM_MODEL_VLM",  "qwen2.5-vl-7b")
def _local_llm_api_key()   -> str: return _cfg("LOCAL_LLM_API_KEY")
def _default_llm_mode()    -> str: return _cfg("DEFAULT_LLM_MODE", "online").lower()

# --- LiteLLM shim (opt-in, see svc-litellm.yml + litellm/config.yaml) ---
# When USE_LITELLM=1, every backend's base_url is rewritten to LITELLM_URL.
# Model names stay the same — litellm/config.yaml's model_list uses the
# identical names already used by this gateway (gpt-oss-20b, qwen2.5-vl-7b,
# gpt-4o). _resolve_backend() preserves all mode + vision logic; only the
# transport changes. Default off; flipping cannot break production.
def _use_litellm()       -> bool: return _cfg("USE_LITELLM", "0").lower() in ("1", "true", "yes", "on")
def _litellm_url()       -> str:  return _cfg_url("LITELLM_URL", "http://litellm:4000")
def _litellm_master_key()-> str:  return _cfg("LITELLM_MASTER_KEY")


def _timeout_sec() -> float:
    try: return float(_cfg("LLM_GATEWAY_TIMEOUT_SEC", "1800"))
    except ValueError: return 1800.0


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
    # Force a specific local backend regardless of image-content sniffing.
    # "text" → gpt-oss on .61 (fast, supports guided decoding).
    # "vlm"  → Qwen-VL on .62 (only when vision is actually needed).
    # None   → legacy auto behaviour (image content → VLM else text).
    force_backend: Optional[str] = Field(
        None, description='"text" | "vlm" | None  (offline only)',
    )
    # OpenAI-compatible tool calling. The local LLM (gpt-oss-20b via
    # vLLM serve, post-Harmony migration) supports `tools=[...]` with
    # native Harmony parsing. Setting these emits proper
    # `message.tool_calls` in the response — strictly better than
    # `extra={"guided_json": ...}` which produces degenerate plans.
    tools:       Optional[List[Dict[str, Any]]] = None
    tool_choice: Optional[Union[str, Dict[str, Any]]] = None
    # Carried through to OpenAI / vllm but not interpreted here.
    # Use this to pass guided_json / guided_regex / response_format etc.
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
    force_backend: Optional[str] = None,
) -> Tuple[str, str, str, Optional[str]]:
    """
    Pick (mode, base_url, model, api_key) for a request.

    mode resolution:
        request.mode > DEFAULT_LLM_MODE
    backend resolution within mode=offline:
        force_backend="text" → LLM (.61)
        force_backend="vlm"  → VLM (.62)
        else: has image content → VLM (.62), else LLM (.61)
    """
    effective_mode = (mode or _default_llm_mode()).lower()
    if effective_mode not in {"online", "offline", "auto"}:
        raise HTTPException(status_code=400, detail=f"unknown mode: {mode!r}")

    # LiteLLM shim: rewrite transport, preserve mode + vision selection.
    # litellm/config.yaml routes by model_name, so we keep the existing
    # model names (gpt-4o / gpt-oss-20b / qwen2.5-vl-7b) and only swap
    # the base_url + api_key. The kind labels stay identical so /stats
    # counters and the "auto" online→offline fallback in /generate keep
    # working unchanged.
    if _use_litellm():
        url = _litellm_url()
        key = _litellm_master_key() or None
        if effective_mode == "online":
            return ("online", url, _openai_model(), key)
        fb = (force_backend or "").lower() or None
        if fb == "text":
            return ("offline_text", url, _local_llm_model_text(), key)
        if fb == "vlm":
            return ("offline_vlm", url, _local_llm_model_vlm(), key)
        if fb is not None:
            raise HTTPException(status_code=400, detail=f"unknown force_backend: {force_backend!r}")
        if _has_image(messages):
            return ("offline_vlm", url, _local_llm_model_vlm(), key)
        return ("offline_text", url, _local_llm_model_text(), key)

    if effective_mode == "online":
        key = _openai_api_key()
        if not key:
            raise HTTPException(status_code=503, detail="OPENAI_API_KEY not set")
        return ("online", _openai_base_url(), _openai_model(), key)

    # offline OR auto-with-online-failure: pick local backend
    local_key = _local_llm_api_key() or None
    fb = (force_backend or "").lower() or None
    if fb == "text":
        return ("offline_text", _local_llm_url_text(), _local_llm_model_text(), local_key)
    if fb == "vlm":
        return ("offline_vlm", _local_llm_url_vlm(), _local_llm_model_vlm(), local_key)
    if fb is not None:
        raise HTTPException(status_code=400, detail=f"unknown force_backend: {force_backend!r}")
    if _has_image(messages):
        return ("offline_vlm", _local_llm_url_vlm(), _local_llm_model_vlm(), local_key)
    return ("offline_text", _local_llm_url_text(), _local_llm_model_text(), local_key)


def _build_payload(
    messages: List[Dict[str, Any]],
    *,
    model: str,
    temperature: float,
    max_tokens: Optional[int],
    extra: Optional[Dict[str, Any]],
    stream: bool,
    tools: Optional[List[Dict[str, Any]]] = None,
    tool_choice: Optional[Union[str, Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    body: Dict[str, Any] = {
        "model":       model,
        "messages":    messages,
        "temperature": temperature,
        "stream":      stream,
    }
    if max_tokens is not None:
        body["max_tokens"] = max_tokens
    if tools:
        body["tools"] = tools
    if tool_choice is not None:
        body["tool_choice"] = tool_choice
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
        "default_mode": _default_llm_mode(),
        "local_text_url": _local_llm_url_text(),
        "local_vlm_url":  _local_llm_url_vlm(),
        "litellm": {
            "enabled": _use_litellm(),
            "url":     _litellm_url() if _use_litellm() else None,
        },
    }


@app.on_event("startup")
async def _start_live_settings() -> None:
    asyncio.create_task(live_settings.start_refresher())


@app.get("/health/deep")
async def health_deep() -> Dict[str, Any]:
    """Probe each configured backend's /health (or /v1/models for OpenAI)."""
    out: Dict[str, Any] = {"checks": {}}
    openai_key = _openai_api_key()
    openai_base = _openai_base_url()
    text_url = _local_llm_url_text()
    vlm_url = _local_llm_url_vlm()

    async with httpx.AsyncClient(timeout=10.0) as c:
        # OpenAI
        if openai_key:
            try:
                r = await c.get(
                    f"{openai_base}/models",
                    headers=_auth_headers(openai_key),
                )
                out["checks"]["online"] = {"ok": r.status_code == 200,
                                           "status": r.status_code}
            except Exception as e:
                out["checks"]["online"] = {"ok": False, "error": str(e)[:200]}
        else:
            out["checks"]["online"] = {"ok": False, "error": "OPENAI_API_KEY not set"}

        # Local LLM
        try:
            r = await c.get(f"{text_url.rsplit('/v1',1)[0]}/health")
            out["checks"]["offline_text"] = {"ok": r.status_code == 200,
                                              "status": r.status_code,
                                              "url": text_url}
        except Exception as e:
            out["checks"]["offline_text"] = {"ok": False, "error": str(e)[:200],
                                              "url": text_url}

        # Local VLM
        try:
            r = await c.get(f"{vlm_url.rsplit('/v1',1)[0]}/health")
            out["checks"]["offline_vlm"] = {"ok": r.status_code == 200,
                                             "status": r.status_code,
                                             "url": vlm_url}
        except Exception as e:
            out["checks"]["offline_vlm"] = {"ok": False, "error": str(e)[:200],
                                             "url": vlm_url}

        # LiteLLM shim (only meaningful when USE_LITELLM=1).
        if _use_litellm():
            lurl = _litellm_url()
            try:
                r = await c.get(f"{lurl}/health/liveliness")
                out["checks"]["litellm"] = {"ok": r.status_code == 200,
                                             "status": r.status_code,
                                             "url": lurl}
            except Exception as e:
                out["checks"]["litellm"] = {"ok": False, "error": str(e)[:200],
                                             "url": lurl}

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
    async with httpx.AsyncClient(timeout=_timeout_sec()) as c:
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
    # Harmony cleanup is gpt-oss-specific: drop the `analysis` channel
    # and collapse raw Harmony tokens / recover commentary-channel tool
    # calls. Qwen3 uses the Hermes tool-call format and emits NO Harmony
    # channel tokens, so this sanitiser is a no-op for it AND its tool-
    # call recovery could mis-fire on a clean response — so we gate it
    # behind OFFLINE_TEXT_HARMONY (default 0 = off, set 1 only when the
    # offline backend is gpt-oss). See svc-llm-gateway.yml.
    harmony_enabled = os.getenv("OFFLINE_TEXT_HARMONY", "0").lower() in (
        "1", "true", "yes", "on")
    is_gpt_oss = backend_kind == "offline_text" and harmony_enabled
    debug: Dict[str, Any] = {}
    if is_gpt_oss:
        msg, debug = sanitize_chat_message(msg)
        if debug.get("analysis"):
            logger.debug(
                "harmony: dropped %d chars of analysis channel from response",
                len(debug["analysis"]),
            )
    return {
        "response":      msg.get("content") or "",
        # Surface tool_calls verbatim so the caller can drive a tool-
        # using agent loop (or extract a plan from
        # tool_calls[0].function.arguments, as the CoT planner does).
        "tool_calls":    msg.get("tool_calls") or [],
        "model":         body.get("model"),
        "finish_reason": choice.get("finish_reason"),
        "usage":         body.get("usage", {}),
        "backend":       backend_kind,
    }


@app.post("/generate")
async def generate(req: GenerateRequest) -> Dict[str, Any]:
    _stats["total"] += 1
    msgs = [m.model_dump() for m in req.messages]
    mode_resolve = (req.mode or _default_llm_mode()).lower()
    primary_kind, primary_url, primary_model, primary_key = _resolve_backend(
        req.mode, msgs, req.force_backend,
    )
    payload = _build_payload(
        msgs, model=req.model or primary_model,
        temperature=req.temperature, max_tokens=req.max_tokens,
        extra=req.extra, stream=False,
        tools=req.tools, tool_choice=req.tool_choice,
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
            "offline", msgs, req.force_backend,
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
class _HarmonyStreamFilter:
    """Streaming-side Harmony scrubber for gpt-oss outputs.

    Two concerns:
      1. vLLM's openai_gptoss reasoning parser emits the analysis channel
         in `delta.reasoning_content`. We never want that leaving the
         gateway — drop it at this layer.
      2. When the reasoning parser isn't enabled server-side, raw
         Harmony tokens leak into `delta.content` interleaved across
         channels. A small state machine over a sliding buffer
         suppresses non-`final` channels and strips stray sentinels.
    """
    _OPEN_RE = re.compile(
        r"<\|channel\|>(?P<ch>analysis|commentary|final)"
        r"(?:\s+to=[^\s<|]+)?(?:\s*<\|constrain\|>[a-zA-Z0-9_-]+)?"
        r"<\|message\|>"
    )
    # Channel-close / role-change tokens. Anything after these returns to
    # the suppressed default state until the next channel-open marker.
    _CLOSE_RE = re.compile(r"<\|(?:end|return|call|start)\|>")
    # Any stray standalone sentinel that survived the open/close passes —
    # strip from emitted text so users never see `<|message|>` etc.
    _STRAY_RE = re.compile(r"<\|(?:start|end|return|call|message|channel|constrain)\|>")

    def __init__(self) -> None:
        self.in_final = False
        self.saw_any_channel = False
        self.buf = ""

    def feed(self, chunk: str) -> str:
        """Append a streaming chunk; return whatever portion is safe to
        emit downstream (final channel only, sentinels stripped)."""
        if not chunk:
            return ""
        self.buf += chunk
        out_parts: List[str] = []
        # Repeatedly consume channel-open / channel-close markers in
        # order. Anything in between is content for the current channel.
        while True:
            m_open = self._OPEN_RE.search(self.buf)
            m_close = self._CLOSE_RE.search(self.buf)
            # Pick whichever marker is earliest; bail if neither.
            if m_open and m_close:
                m, kind = (m_open, "open") if m_open.start() <= m_close.start() else (m_close, "close")
            elif m_open:
                m, kind = m_open, "open"
            elif m_close:
                m, kind = m_close, "close"
            else:
                break
            head = self.buf[:m.start()]
            if self.in_final or not self.saw_any_channel:
                out_parts.append(head)
            if kind == "open":
                self.saw_any_channel = True
                self.in_final = (m.group("ch") == "final")
            else:
                # Channel closed — leave the final channel; next emit
                # waits for another channel-open marker.
                self.in_final = False
            self.buf = self.buf[m.end():]
        # Tail may contain a partial sentinel (`<|chan…`). Hold back the
        # last 40 chars so we never yield half of a marker.
        if self.in_final or not self.saw_any_channel:
            if len(self.buf) > 40:
                emit = self._STRAY_RE.sub("", self.buf[:-40])
                self.buf = self.buf[-40:]
                out_parts.append(emit)
        return "".join(out_parts)

    def flush(self) -> str:
        """End-of-stream: emit whatever's left in the buffer if we're
        in the final channel (or we never saw a channel marker)."""
        if self.in_final or not self.saw_any_channel:
            tail = self._STRAY_RE.sub("", self.buf)
            self.buf = ""
            return tail
        self.buf = ""
        return ""


async def _stream_chat_completion(
    backend_kind: str,
    base_url: str,
    api_key: Optional[str],
    payload: Dict[str, Any],
) -> AsyncIterator[str]:
    """Yield content chunks (str) parsed from an OpenAI streaming response.

    For offline_text gpt-oss the chunks are scrubbed through
    _HarmonyStreamFilter so the analysis channel never reaches the
    client. Gated behind OFFLINE_TEXT_HARMONY (default off) — Qwen3
    emits no Harmony tokens so the filter is unneeded and is skipped."""
    harmony_enabled = os.getenv("OFFLINE_TEXT_HARMONY", "0").lower() in (
        "1", "true", "yes", "on")
    is_gpt_oss = backend_kind == "offline_text" and harmony_enabled
    harmony = _HarmonyStreamFilter() if is_gpt_oss else None
    async with httpx.AsyncClient(timeout=_timeout_sec()) as c:
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
                    break
                try:
                    payload_obj = json.loads(data)
                except Exception:
                    continue
                choices = payload_obj.get("choices") or []
                if not choices:
                    continue
                delta = choices[0].get("delta") or {}
                # gpt-oss-specific: drop the analysis channel surfaced by
                # vLLM's openai_gptoss reasoning parser. Never forward to
                # users (unaligned CoT per OpenAI's guidance).
                if is_gpt_oss and "reasoning_content" in delta:
                    delta.pop("reasoning_content", None)
                chunk = delta.get("content") or ""
                if not chunk:
                    continue
                if harmony is not None:
                    safe = harmony.feed(chunk)
                    if safe:
                        yield safe
                else:
                    yield chunk
    # End-of-stream: flush any final-channel residue still in the buffer.
    if harmony is not None:
        tail = harmony.flush()
        if tail:
            yield tail


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
    backend_kind, base_url, model, api_key = _resolve_backend(
        req.mode, msgs, req.force_backend,
    )
    payload = _build_payload(
        msgs, model=req.model or model,
        temperature=req.temperature, max_tokens=req.max_tokens,
        extra=req.extra, stream=True,
        tools=req.tools, tool_choice=req.tool_choice,
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
    Embeddings via /v1/embeddings.

    Direct mode (USE_LITELLM=0): online → OpenAI only. vllm-openai by
    default doesn't serve embeddings; for offline embeddings use
    embeddings-service:8031 (sentence-transformers) directly.

    LiteLLM mode (USE_LITELLM=1): POST to LiteLLM with the requested model.
    LiteLLM's model_list decides whether that's OpenAI or a local backend.
    """
    model = req.model or _openai_embed_model()

    if _use_litellm():
        base = _litellm_url()
        key = _litellm_master_key() or None
        async with httpx.AsyncClient(timeout=60.0) as c:
            r = await c.post(
                f"{base}/embeddings",
                json={"model": model, "input": req.text},
                headers=_auth_headers(key),
            )
        if r.status_code != 200:
            raise HTTPException(status_code=502,
                                detail=f"litellm embeddings: {r.status_code} {r.text[:200]}")
        body = r.json()
        vec = (body.get("data") or [{}])[0].get("embedding") or []
        return {"embedding": vec, "dim": len(vec), "model": body.get("model", model)}

    key = _openai_api_key()
    if not key:
        raise HTTPException(status_code=503,
                            detail="OPENAI_API_KEY not set; offline embeddings "
                                   "not configured. Use embeddings-service:8031 "
                                   "(sentence-transformers) instead.")
    async with httpx.AsyncClient(timeout=60.0) as c:
        r = await c.post(
            f"{_openai_base_url()}/embeddings",
            json={"model": model, "input": req.text},
            headers=_auth_headers(key),
        )
    if r.status_code != 200:
        raise HTTPException(status_code=502,
                            detail=f"openai embeddings: {r.status_code} {r.text[:200]}")
    body = r.json()
    vec = (body.get("data") or [{}])[0].get("embedding") or []
    return {"embedding": vec, "dim": len(vec), "model": body.get("model", model)}
