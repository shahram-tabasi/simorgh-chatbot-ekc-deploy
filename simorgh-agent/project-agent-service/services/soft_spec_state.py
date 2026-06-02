"""
soft_spec_state.py — persistence layer for the Design Suite spec collector.

Schema lives in migration 008. Two tables:

  soft_spec_state (per project)
    spec/prov/gaps/conflicts/completeness — the continuously-maintained
    output of the collector (services/soft_collector.py). Read by the
    ReAct tool `read_soft_spec`, the chat-UI completeness chip, and the
    submit endpoint that POSTs to simorgh-soft.

  soft_spec_pending_ask
    Open clarifying questions emitted by the ReAct loop's `ask_user` tool.
    Each row has a `questions` JSON and (eventually) the user's `answers`
    JSON; the loop merges those answers into the spec via the same
    reconciler used elsewhere.

All helpers are async, never raise to the caller — DB failures are
logged and we return an empty / unchanged state so the chat path never
breaks because of a slot-collector hiccup.
"""
from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


def _pg():
    """Resolve a PostgresConnection that's usable from any caller — the
    FastAPI request path or a one-shot script. The previous version went
    only through the project_memory singleton; when invoked from
    `python3 -c` BEFORE main.py wires up the pools, .pg is None and
    callers get NoneType.execute_one_async errors. Falls back to a
    self-initialising PostgresConnection (config from env)."""
    try:
        from services.project_memory_service import get_project_memory_service
        pg = get_project_memory_service().pg
        if pg is not None:
            return pg
    except Exception:
        pass
    # Fallback — works even outside the app context.
    from database.postgres_connection import PostgresConnection
    pc = PostgresConnection()
    # Ensure the async pool is initialised on first use.
    import asyncio
    try:
        loop = asyncio.get_running_loop()
        if pc._async_pool is None:
            loop.create_task(pc.init_async_pool())
    except RuntimeError:
        # No loop; one-shot tools can run it themselves.
        pass
    return pc


# ---------------------------------------------------------------------------
# soft_spec_state
# ---------------------------------------------------------------------------
async def get_state(project_id: str) -> Optional[Dict[str, Any]]:
    try:
        row = await _pg().execute_one_async(
            """SELECT project_id, spec, prov, gaps, conflicts, completeness,
                      sources_signature, last_collected_at, last_submitted_at,
                      soft_project_id, updated_at
                 FROM soft_spec_state WHERE project_id = $1""",
            project_id,
        )
    except Exception as e:
        logger.warning("soft_spec_state.get_state %s: %s", project_id, e)
        return None
    if not row:
        return None
    d = dict(row)
    for k in ("spec", "prov", "gaps", "conflicts"):
        v = d.get(k)
        if isinstance(v, str):
            try:
                d[k] = json.loads(v)
            except Exception:
                d[k] = {} if k == "spec" else []
    return d


async def upsert_state(project_id: str, *, spec: Dict[str, Any],
                       prov: List[Dict[str, Any]], gaps: List[str],
                       conflicts: List[str], completeness: int,
                       sources_signature: str) -> None:
    try:
        await _pg().execute_one_async(
            """INSERT INTO soft_spec_state
                 (project_id, spec, prov, gaps, conflicts, completeness,
                  sources_signature, last_collected_at, updated_at)
               VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb,
                       $6, $7, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
               ON CONFLICT (project_id) DO UPDATE SET
                 spec              = EXCLUDED.spec,
                 prov              = EXCLUDED.prov,
                 gaps              = EXCLUDED.gaps,
                 conflicts         = EXCLUDED.conflicts,
                 completeness      = EXCLUDED.completeness,
                 sources_signature = EXCLUDED.sources_signature,
                 last_collected_at = CURRENT_TIMESTAMP,
                 updated_at        = CURRENT_TIMESTAMP
               RETURNING project_id""",
            project_id, json.dumps(spec), json.dumps(prov),
            json.dumps(gaps), json.dumps(conflicts), int(completeness),
            sources_signature,
        )
    except Exception as e:
        logger.warning("soft_spec_state.upsert_state %s: %s", project_id, e)


async def mark_submitted(project_id: str, soft_project_id: str) -> None:
    try:
        await _pg().execute_one_async(
            """UPDATE soft_spec_state
                  SET soft_project_id   = $2,
                      last_submitted_at = CURRENT_TIMESTAMP,
                      updated_at        = CURRENT_TIMESTAMP
                WHERE project_id = $1 RETURNING project_id""",
            project_id, soft_project_id,
        )
    except Exception as e:
        logger.warning("soft_spec_state.mark_submitted %s: %s", project_id, e)


# ---------------------------------------------------------------------------
# soft_spec_pending_ask
# ---------------------------------------------------------------------------
async def create_pending_ask(project_id: str, chat_id: Optional[str],
                             questions: List[Dict[str, Any]]) -> Optional[str]:
    try:
        row = await _pg().execute_one_async(
            """INSERT INTO soft_spec_pending_ask (project_id, chat_id, questions)
               VALUES ($1, $2, $3::jsonb) RETURNING id""",
            project_id, chat_id, json.dumps(questions),
        )
    except Exception as e:
        logger.warning("create_pending_ask %s: %s", project_id, e)
        return None
    return str(row["id"]) if row else None


async def get_pending_ask(pending_id: str) -> Optional[Dict[str, Any]]:
    try:
        row = await _pg().execute_one_async(
            """SELECT id, project_id, chat_id, questions, answers, answered_at
                 FROM soft_spec_pending_ask WHERE id = $1""",
            pending_id,
        )
    except Exception as e:
        logger.warning("get_pending_ask %s: %s", pending_id, e)
        return None
    if not row:
        return None
    d = dict(row)
    for k in ("questions", "answers"):
        v = d.get(k)
        if isinstance(v, str):
            try:
                d[k] = json.loads(v)
            except Exception:
                d[k] = None
    return d


async def answer_pending_ask(pending_id: str,
                             answers: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    try:
        row = await _pg().execute_one_async(
            """UPDATE soft_spec_pending_ask
                  SET answers = $2::jsonb, answered_at = CURRENT_TIMESTAMP
                WHERE id = $1 AND answered_at IS NULL
            RETURNING id, project_id, chat_id, questions, answers, answered_at""",
            pending_id, json.dumps(answers),
        )
    except Exception as e:
        logger.warning("answer_pending_ask %s: %s", pending_id, e)
        return None
    return dict(row) if row else None


async def list_open_pending(project_id: str) -> List[Dict[str, Any]]:
    try:
        rows = await _pg().execute_async(
            """SELECT id, questions, created_at
                 FROM soft_spec_pending_ask
                WHERE project_id = $1 AND answered_at IS NULL
                ORDER BY created_at ASC""",
            project_id,
        )
    except Exception as e:
        logger.warning("list_open_pending %s: %s", project_id, e)
        return []
    out: List[Dict[str, Any]] = []
    for r in rows or []:
        d = dict(r)
        v = d.get("questions")
        if isinstance(v, str):
            try:
                d["questions"] = json.loads(v)
            except Exception:
                d["questions"] = []
        out.append(d)
    return out
