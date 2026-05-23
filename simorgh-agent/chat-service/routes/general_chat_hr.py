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

from services.hr_chat import stream_hr_answer

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
        # Use 'try' so any exception below still emits a clean error
        # frame instead of half-closing the SSE stream.
        try:
            async for kind, data in stream_hr_answer(req.query, req.category):
                frame = {kind: data}
                yield f"data: {json.dumps(frame, ensure_ascii=False)}\n\n"
        except Exception as e:
            log.exception("hr_stream pipeline crashed")
            yield f"data: {json.dumps({'error': str(e)}, ensure_ascii=False)}\n\n"

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
