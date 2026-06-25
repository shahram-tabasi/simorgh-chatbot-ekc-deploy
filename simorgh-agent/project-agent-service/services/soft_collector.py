"""
soft_collector.py — background slot collector for the Design Suite spec.

`refresh(project_id)` runs the existing extractors (services/soft_extractor.py),
reconciles via services/soft_reconciler.py, computes a per-field
provenance + completeness%, and persists to soft_spec_state.

Cheap to call: a `sources_signature` hash (chat-message count + doc-count +
oenum + repo path + recent-message-tail digest) short-circuits the refresh
when nothing has changed, so the post-hook in handle_input / upload_document
is safe to fire after every event.

NEVER raises — failures are logged. The chat path must not break because
of a slot-collector hiccup.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import os
from typing import Any, Dict, List, Optional

from services.soft_spec import CONFIRMABLE_FIELDS, REQUIRED_FIELDS

logger = logging.getLogger(__name__)


def _enabled() -> bool:
    return os.getenv("SOFT_BRIDGE_ENABLED", "").lower() in ("1", "true", "yes", "on")


def _digest_recent_messages(msgs: List[Dict[str, Any]], n: int = 8) -> str:
    """Fingerprint the last N (role, content[:160]) pairs so we re-extract
    only when the chat tail actually moved. Cheap MD5 is fine here."""
    tail = msgs[-n:]
    h = hashlib.md5()
    for m in tail:
        h.update((m.get("role") or "?").encode("utf-8", "ignore"))
        h.update(b"\x00")
        h.update((m.get("content") or "")[:160].encode("utf-8", "ignore"))
        h.update(b"\x01")
    return h.hexdigest()


async def _build_signature(*, project_id: str, project_row: Dict[str, Any],
                           recent: List[Dict[str, Any]]) -> str:
    """Stable fingerprint of all sources contributing to the spec. Bumps
    whenever ANY of them moves; otherwise refresh() short-circuits."""
    se = project_row.get("sources_enabled") or {}
    parts = [
        f"oe={project_row.get('tpms_oenum') or ''}",
        f"repo={project_row.get('gitlab_repo_path') or ''}",
        f"ts_oe={(se.get('techserver_oenum') or '')}",
        f"src={int(bool(se.get('tpms')))}{int(bool(se.get('gitlab')))}"
              f"{int(bool(se.get('techserver')))}{int(bool(se.get('upload')))}",
        f"hasdocs={int(bool(project_row.get('has_documents')))}",
        f"chat={_digest_recent_messages(recent)}",
    ]
    # The set of indexed documents matters too — if uploads changed, we
    # want a fresh extraction. Use the qdrant list as the doc-fingerprint.
    try:
        from services.project_memory_service import get_project_memory_service
        q = getattr(get_project_memory_service(), "qdrant", None)
        scope = (project_row.get("tpms_oenum") or project_id)
        docs = q.list_documents(user_id="system", project_oenum=scope) if q else []
        names = sorted([str(d.get("filename") or "") for d in (docs or [])])
        parts.append("docs=" + "|".join(names))
    except Exception:
        parts.append("docs=?")
    return hashlib.md5("\n".join(parts).encode()).hexdigest()


def _completeness(spec_dump: Dict[str, Any], gaps: List[str]) -> int:
    """0..100 over CONFIRMABLE_FIELDS, EXCLUDING fields that are optional
    by nature (`comment` is a freeform note — its emptiness shouldn't
    drag the score down)."""
    optional = {"comment"}
    counted = [f for f in CONFIRMABLE_FIELDS if f not in optional]
    n = len(counted) or 1
    filled = 0
    for f in counted:
        v = spec_dump.get(f)
        if v not in (None, "", [], {}) and f not in gaps:
            filled += 1
    return int(round(filled * 100 / n))


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------
async def _ensure_memory_pools(memory) -> None:
    """Make sure the memory service has working pg + qdrant pools. Inside
    a FastAPI request these are always set by main.py at startup; from a
    one-shot script (`python3 -c "..."`) they default to None and every
    .pg.execute_one_async crashes with NoneType. Lazy-bootstrap here so
    the collector is callable from either context.

    Pool-per-loop: asyncpg pools are bound to the event loop they were
    created on. A second `asyncio.run()` in the same process gets a NEW
    loop, but our pool sits on the OLD one → "another operation in
    progress" / "loop is closed". Rebuild whenever the current loop
    doesn't match the pool's loop."""
    import asyncio
    current_loop = asyncio.get_running_loop()

    pg = getattr(memory, "pg", None)
    pool = getattr(pg, "_async_pool", None) if pg is not None else None
    pool_loop = getattr(pool, "_loop", None) if pool is not None else None
    if pg is None or pool is None or pool_loop is not current_loop:
        try:
            from database.postgres_connection import PostgresConnection
            pc = PostgresConnection()
            await pc.init_async_pool()
            memory.pg = pc
            logger.info("soft_collector: bootstrapped pg (one-shot mode)")
        except Exception as e:
            logger.warning("soft_collector: could not bootstrap pg: %s", e)
    if getattr(memory, "qdrant", None) is None:
        try:
            from services.qdrant_service import QdrantService
            memory.qdrant = QdrantService(llm_service=None)
            logger.info("soft_collector: bootstrapped qdrant (one-shot mode)")
        except Exception as e:
            logger.warning("soft_collector: could not bootstrap qdrant: %s", e)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------
async def refresh(project_id: str, *, force: bool = False,
                  latest_answer: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Re-run the extractors (sequential LLM calls, parallel non-LLM) and
    persist if the signature changed. Returns the new state row or the
    current row if nothing was recomputed; returns None when disabled or
    on a hard failure (logged)."""
    if not _enabled():
        return None
    try:
        from services.project_memory_service import get_project_memory_service
        from services.soft_extractor import gather_all
        from services.soft_reconciler import reconcile
        from services import soft_spec_state as sss
    except Exception as e:
        logger.warning("soft_collector.refresh import failed: %s", e)
        return None

    memory = get_project_memory_service()
    # Bootstrap pools if we're running outside the FastAPI app context.
    await _ensure_memory_pools(memory)
    try:
        project = await memory.get_project(project_id)
    except Exception as e:
        logger.warning("soft_collector.refresh get_project %s: %s", project_id, e)
        return None
    if not project:
        return None

    try:
        # Pull a generous slice of the conversation so chat extraction sees
        # the agent's full response(s), not just the last handful of turns
        # (the extractor itself caps the per-message text, not the count).
        recent = await memory.get_recent_context(project_id, limit=40)
    except Exception:
        recent = []

    # The chatbot the user actually talks to (V2 chat sessions) persists its
    # turns to the chat_messages store, NOT project_messages — so the agent's
    # rich, cited analyses never reached the response-miner above. Pull that
    # history too (chat_messages.project_number == project id) and merge it
    # in so the miner can mine the answers and the signature reflects new
    # chat activity.
    try:
        from services.message_persistence import get_message_persistence
        chat_hist = await get_message_persistence().get_recent_messages_by_project(
            str(project_id), limit=40)
        logger.info("soft_collector: pulled %d V2 chat_messages for project=%s",
                    len(chat_hist or []), project_id)
        if chat_hist:
            recent = list(recent) + chat_hist
    except Exception as e:
        logger.debug("soft_collector: chat_messages fetch failed: %s", e)

    # When the caller hands us the answer it just produced, fold it in
    # directly — the response-miner then sees it without waiting on the
    # message to be persisted, and the signature below changes so the
    # refresh can't short-circuit on a stale digest.
    if latest_answer and len(latest_answer) >= 40:
        recent = list(recent) + [{"role": "assistant", "content": latest_answer}]

    sig = await _build_signature(project_id=project_id, project_row=project,
                                 recent=recent)
    existing = await sss.get_state(project_id)
    if existing and not force and existing.get("sources_signature") == sig:
        return existing

    se = project.get("sources_enabled") or {}
    # Source isolation: every extractor MUST be gated by sources_enabled.
    # Pre-fix, the TPMS branch fell through to project.tpms_oenum
    # unconditionally — so a project created with only TechServer
    # enabled (sources_enabled.tpms=False) but with project.tpms_oenum
    # populated from the shared-OE creation flow would still pull
    # TPMS data into its proposals. Bug surfaced live: a new
    # TechServer-only project showed Mobarakeh Steel (OE 04A12065)
    # proposals because tpms_oenum had been carried over.
    #
    # Now: each source returns its oenum/repo ONLY when its flag is
    # enabled. No silent fallbacks across sources.
    tpms_oenum = project.get("tpms_oenum") if se.get("tpms") else None
    repo_path  = project.get("gitlab_repo_path") if se.get("gitlab") else None
    ts_oenum   = se.get("techserver_oenum") if se.get("techserver") else None
    logger.info(
        "soft_collector: project=%s sources=%s tpms_oe=%s ts_oe=%s repo=%s",
        project_id,
        {k: bool(v) for k, v in se.items() if k in ("tpms", "techserver", "gitlab", "upload")},
        tpms_oenum or "-", ts_oenum or "-", repo_path or "-",
    )

    agent_singleton = None
    try:
        from main import get_project_agent_singleton as _gas  # type: ignore
        agent_singleton = _gas()
    except Exception:
        try:
            from services.project_agent import get_project_agent
            agent_singleton = get_project_agent()
        except Exception:
            pass
    mcp = getattr(agent_singleton, "mcp_manager", None) if agent_singleton else None

    try:
        bag = await gather_all(
            project_id=project_id, tpms_oenum=tpms_oenum,
            repo_path=repo_path, techserver_oenum=ts_oenum,
            recent_messages=recent, mcp_manager=mcp,
        )
    except Exception as e:
        logger.warning("soft_collector.refresh gather %s: %s", project_id, e)
        return existing

    # HITL contract: extractors PROPOSE, the user APPROVES, only THEN does
    # the spec change. Write each FieldValue into soft_spec_proposal grouped
    # by source_kind (so a re-extraction from the same source replaces its
    # pending proposals atomically — no duplicate buildup). We deliberately
    # do NOT call reconcile / upsert_state here — that would silently push
    # opportunistic values into the spec the user can't see.
    try:
        from services import soft_proposals as sp
        by_kind: Dict[str, List[Dict[str, Any]]] = {}
        for field, fvs in (bag or {}).items():
            for fv in fvs:
                kind = (getattr(fv, "source", None) or "uploads")
                by_kind.setdefault(kind, []).append({
                    "field":      field,
                    "value":      getattr(fv, "value", None),
                    "confidence": float(getattr(fv, "confidence", 0.5) or 0.5),
                    "note":       getattr(fv, "note", None),
                    "doc_id":     getattr(fv, "doc_id", None),
                })
        total = 0
        for kind, proposals in by_kind.items():
            total += await sp.replace_proposals(project_id, kind, proposals)
        # Persist the signature + counts on soft_spec_state for the chip,
        # but the spec dict itself stays empty until the user approves.
        # completeness here is "how many CONFIRMABLE_FIELDS have at least
        # one *approved* proposal".
        approved = await sp.list_approved(project_id)
        approved_fields = {a["field"] for a in approved}
        from services.soft_spec import REQUIRED_FIELDS
        gaps = [f for f in REQUIRED_FIELDS if f not in approved_fields]
        spec_dump = {a["field"]: a["value"] for a in approved}
        completeness = _completeness(spec_dump, gaps)
        await sss.upsert_state(
            project_id, spec=spec_dump, prov=[], gaps=gaps, conflicts=[],
            completeness=completeness, sources_signature=sig,
        )
        logger.info(
            "soft_collector: project=%s proposed=%d approved=%d completeness=%d",
            project_id, total, len(approved), completeness,
        )
    except Exception as e:
        logger.warning("soft_collector.refresh persist %s: %s", project_id, e)
    return await sss.get_state(project_id)


def schedule_refresh(project_id: str,
                     latest_answer: Optional[str] = None) -> None:
    """Fire-and-forget. Safe to call from anywhere; survives shutdown.
    Used as a post-hook in handle_input / upload_document / wizard.
    `latest_answer` (the reply the agent just produced) is fed straight to
    the response-miner so its parameters are proposed on this same turn."""
    if not _enabled():
        return
    try:
        loop = asyncio.get_running_loop()
        loop.create_task(refresh(project_id, latest_answer=latest_answer))
    except RuntimeError:
        # No running loop (sync caller) — best-effort: spin one off.
        try:
            asyncio.run(refresh(project_id, latest_answer=latest_answer))
        except Exception as e:
            logger.warning("schedule_refresh sync fallback failed: %s", e)
    except Exception as e:
        logger.warning("schedule_refresh %s: %s", project_id, e)
