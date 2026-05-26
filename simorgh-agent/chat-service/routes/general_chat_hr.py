"""
General-Chat HR/Strategy SSE endpoint
=====================================

Mounted at `/api/v2/general-chat/hr/stream`. Modern-user-only fast
path that bypasses chatbot_core entirely. Drives
`services.hr_chat.stream_hr_answer` and wraps its event tuples as
text/event-stream frames.

Frame schema (one JSON object per SSE `data:` line):

    {"meta":    {"hits": [...], "top_score": 0.61, "threshold": 0.3}}
    {"chunk":   "بر اساس ماده ۶۴ قانون کار"}
    {"chunk":   ", مرخصی استحقاقی سالانه ۳۰ روز است [1]."}
    {"refusal": "متاسفم..."}
    {"done":    {"reason": "ok"}}
    {"error":   "..."}

The route is auth-gated: only **modern (UUID) users** can call it.
Legacy TPMS users get 403 — they have a different flow and shouldn't
hit this fast path.
"""

from __future__ import annotations

import json
import logging
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from services.hr_chat import (
    stream_hr_answer,
    retrieve as hr_retrieve,
    _embed as hr_embed,
    EMBEDDINGS_URL as HR_EMBEDDINGS_URL,
    QDRANT_URL as HR_QDRANT_URL,
    HR_KB_COLLECTION,
    RELEVANCE_THRESHOLD,
    LLM_GATEWAY_URL as HR_LLM_GATEWAY_URL,
    HR_LLM_MODEL,
)

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v2/general-chat/hr", tags=["HR General Chat"])


def _is_modern_user(user_id: str) -> bool:
    """UUID-shaped user_id ⇒ modern. Anything else (TPMS EMPUSERNAME,
    anon, admin shortcut) ⇒ not eligible for this fast path."""
    try:
        UUID(user_id)
        return True
    except (ValueError, AttributeError):
        return False


class HrStreamRequest(BaseModel):
    user_id: str = Field(..., description="Modern user UUID. Legacy users not allowed.")
    query: str = Field(..., min_length=1, max_length=2000)
    category: Optional[str] = Field(
        None,
        description='Optional facet filter: "hr_manner" or "org_strategy". '
                    'Omit to search both corpora.',
    )
    chat_id: Optional[str] = Field(
        None,
        description="The general-chat id this turn belongs to. Required to "
                    "persist the message pair so it survives chat-switch "
                    "navigation. Omit only for one-shot probes.",
    )


async def _persist_pair(chat_id: str, user_id: str, user_msg: str,
                         assistant_msg: str, citations: list,
                         refusal: bool = False) -> None:
    """Best-effort save of the user message + assistant response to the
    chat-history store. Called after the SSE stream completes.

    CRITICAL: writes to Redis (not Postgres). The previous version of
    this function used unified_memory_service.store_conversation_pair
    which only writes to PostgreSQL via message_persistence.
    /api/chats/{id} (backend/main.py:1245) reads from Redis via
    redis.get_chat_history → key chat:history:{chat_id}. So even
    though the messages WERE being saved, the sidebar's chat-load
    couldn't see them and the conversation appeared to vanish on
    chat-switch.

    Direct Redis write via redis_service.cache_chat_message matches
    what the legacy /api/chat/stream did before HR direct-RAG existed."""
    try:
        from services.redis_service import get_redis_service
        from datetime import datetime, timezone
        import uuid as _uuid
        redis = get_redis_service()
        now_iso = datetime.now(timezone.utc).isoformat()

        user_message_payload = {
            "message_id": str(_uuid.uuid4()),
            "chat_id": chat_id,
            "user_id": user_id,
            "role": "user",
            "content": user_msg,
            "timestamp": now_iso,
            "metadata": {"source": "hr_direct_rag"},
        }
        assistant_message_payload = {
            "message_id": str(_uuid.uuid4()),
            "chat_id": chat_id,
            "user_id": user_id,
            "role": "assistant",
            "content": assistant_msg,
            "timestamp": now_iso,
            "metadata": {
                "source": "hr_direct_rag",
                "citations": citations,
                "refusal": refusal,
            },
        }
        redis.cache_chat_message(chat_id, user_message_payload)
        redis.cache_chat_message(chat_id, assistant_message_payload)
        log.info("hr_stream: persisted pair to Redis chat=%s "
                  "(content_lens user=%d assistant=%d, citations=%d)",
                  chat_id, len(user_msg), len(assistant_msg),
                  len(citations or []))
    except Exception as e:
        # Persistence is best-effort. A failure here only means the
        # user loses scrollback on chat-switch — the live stream
        # already played, so the current turn is intact.
        log.warning("hr_stream: persist_pair failed for chat=%s: %s", chat_id, e)


@router.post("/stream")
async def hr_stream(req: HrStreamRequest):
    """Stream the grounded HR/strategy answer. SSE; one JSON event per
    data line. See module docstring for frame schema."""
    if not _is_modern_user(req.user_id):
        raise HTTPException(
            status_code=403,
            detail={
                "error": "modern_users_only",
                "message": "این سامانه فقط برای کاربران احراز شده در دسترس است.",
            },
        )
    if req.category and req.category not in ("hr_manner", "org_strategy", "fs_drop"):
        raise HTTPException(status_code=400, detail="invalid category")

    async def event_stream():
        # Accumulate the streamed response + metadata so we can save
        # the message pair AFTER the stream completes. The user
        # already saw the chunks live; persistence is what makes the
        # conversation survive a chat-switch (which was the
        # operator's "chat history disappears on general chats"
        # report — every turn vanished because the HR path never
        # wrote to the chat history store).
        accumulated = []
        citations: list = []
        was_refusal = False
        try:
            async for kind, data in stream_hr_answer(req.query, req.category):
                if kind == "chunk":
                    accumulated.append(str(data or ""))
                elif kind == "meta":
                    citations = (data or {}).get("hits") or []
                elif kind == "refusal":
                    was_refusal = True
                    accumulated.append(str(data or ""))
                frame = {kind: data}
                yield f"data: {json.dumps(frame, ensure_ascii=False)}\n\n"
        except Exception as e:
            log.exception("hr_stream pipeline crashed")
            yield f"data: {json.dumps({'error': str(e)}, ensure_ascii=False)}\n\n"

        # Persist after the stream is fully emitted to the client.
        # Avoids blocking the streaming with a slow Redis/postgres
        # write; the user sees the answer immediately and we save
        # in the trailing tail of the response.
        full_assistant = "".join(accumulated).strip()
        if req.chat_id and full_assistant:
            await _persist_pair(
                chat_id=req.chat_id, user_id=req.user_id,
                user_msg=req.query, assistant_msg=full_assistant,
                citations=citations, refusal=was_refusal,
            )

        # Record the question against the modern user's daily quota.
        # The chatbot_v2 (project-chat) route already does this via
        # _increment_modern_usage; general-chat-HR was missed when
        # the path was forked from the legacy stream handler, so the
        # quota ring stayed at "full" forever in the sidebar (issue
        # #3, May 2026). Done after persistence + after the stream
        # so a transient quota-service failure can't 5xx the SSE
        # response; worst case is the count is off by one.
        if not was_refusal:
            try:
                from services.user_tier_service import get_tier_service
                from uuid import UUID as _UUID
                tier_service = get_tier_service()
                if tier_service:
                    await tier_service.increment_usage(_UUID(req.user_id))
            except Exception as e:
                log.warning(
                    "hr_stream: failed to increment quota for user=%s: %s",
                    req.user_id, e,
                )

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            # Disable proxy buffering so the user sees tokens stream live
            # (nginx in front of chat-service does buffer by default).
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/health")
async def health():
    """Quick reachability check; doesn't probe Qdrant/embeddings."""
    return {"status": "ok", "service": "general-chat-hr"}


@router.get("/debug")
async def debug(q: str, category: Optional[str] = None, top_k: int = 5):
    """Diagnostic endpoint — runs the retrieval pipeline WITHOUT the
    LLM call and returns the raw scores + payload so you can tell why
    a query is or isn't matching. Auth-free on purpose so you can
    probe it from the deploy host with `docker exec`.

    Returns a structured response:

        {
          "config":   {EMBEDDINGS_URL, QDRANT_URL, collection,
                       threshold, llm_gateway, model},
          "embed":    {ok: bool, dim: int, error?: str},
          "hits":     [{score, doc_title, section_path, ...}, ...],
          "decision": "answer" | "refuse",
          "reason":   <human-readable>
        }
    """
    if not q.strip():
        raise HTTPException(status_code=400, detail="q is required")
    config = {
        "EMBEDDINGS_URL": HR_EMBEDDINGS_URL,
        "QDRANT_URL": HR_QDRANT_URL,
        "collection": HR_KB_COLLECTION,
        "threshold": RELEVANCE_THRESHOLD,
        "llm_gateway": HR_LLM_GATEWAY_URL,
        "llm_model": HR_LLM_MODEL,
    }
    vec = await hr_embed(q)
    if vec is None:
        return {
            "config": config,
            "embed": {"ok": False, "dim": 0,
                       "error": "embeddings-service unreachable or returned empty"},
            "hits": [],
            "decision": "refuse",
            "reason": "embed_failed",
        }
    hits = await hr_retrieve(q, top_k=top_k, category=category)
    top = max((h["raw_score"] for h in hits), default=0.0)
    return {
        "config": config,
        "embed": {"ok": True, "dim": len(vec)},
        "hits": hits,
        "top_score": top,
        "decision": "answer" if (hits and top >= RELEVANCE_THRESHOLD) else "refuse",
        "reason": (
            "no_hits" if not hits else
            "below_threshold" if top < RELEVANCE_THRESHOLD else
            "ok"
        ),
    }
