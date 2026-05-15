"""Thin HTTP client for the context-search-service.

Used by:
  - project-agent-service       — ships completed CoT traces at the end of analyze()
  - tpms-fetcher-service        — upserts ProjectMeta after every TPMS fetch
  - chat-service / others       — same surface, optional

All calls are FIRE-AND-FORGET: failures are logged but never raised.
The agent must continue to work when ELK is offline.
"""
from __future__ import annotations

import logging
import os
from typing import Any

import httpx

log = logging.getLogger(__name__)

CONTEXT_SEARCH_URL = os.getenv("CONTEXT_SEARCH_URL", "http://context-search:8049")
TIMEOUT_SECONDS    = float(os.getenv("CONTEXT_SEARCH_TIMEOUT", "5.0"))


async def index_cot_trace(trace: dict[str, Any]) -> bool:
    """POST a completed CoT trace. Returns True on success.

    trace must match the CotTrace pydantic model:
      chain_id (required), question (required), session_id, user_id,
      project_id, oenum, reasoning, final_answer, success, steps[], tags[]
    """
    return await _post("/index/cot", trace)


async def index_project_meta(meta: dict[str, Any]) -> bool:
    """Upsert a structured project record (oenum-keyed)."""
    return await _post("/index/project_meta", meta)


async def _post(path: str, body: dict[str, Any]) -> bool:
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT_SECONDS) as c:
            r = await c.post(f"{CONTEXT_SEARCH_URL}{path}", json=body)
            if r.status_code >= 400:
                log.warning("context_search_index_failed",
                            extra={"path": path, "status": r.status_code,
                                   "body": r.text[:200]})
                return False
            return True
    except Exception as e:
        # Never propagate — the calling service must remain functional even
        # when context-search is down.
        log.warning("context_search_unreachable",
                    extra={"path": path, "error": str(e)})
        return False
