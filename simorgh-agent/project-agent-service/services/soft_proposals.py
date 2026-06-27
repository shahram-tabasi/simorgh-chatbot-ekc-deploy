"""
soft_proposals.py — CRUD for the soft_spec_proposal table.

Proposal lifecycle:
  insert (extractor)  → review pending (NULL approved)
  approve/edit/reject (CoT, via user) → approved BOOLEAN set, approved_at stamped

The reconciler still picks best-by-source*confidence at *approval* time,
not at extraction time — so all the existing reconcile() logic carries
over. The difference: it runs against approved proposals only, never
against raw extractor output.
"""
from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


def _pg():
    """Shared with soft_spec_state — works inside FastAPI and one-shot."""
    from services.soft_spec_state import _pg as shared
    return shared()


# ---------------------------------------------------------------------------
# Insert proposals from an extractor run.
# ---------------------------------------------------------------------------
async def replace_proposals(project_id: str, source_kind: str,
                            proposals: List[Dict[str, Any]]) -> int:
    """Atomic replace of PENDING proposals from this source.

    Why replace not append: a re-extraction on the same source must not
    pile up duplicate pending rows. Approved/rejected rows stay (they're
    history). New pending rows replace the previous pending set from the
    same source_kind.

    Each entry in `proposals`:
      {field, value, confidence, note?, doc_id?}
    """
    if not proposals:
        return 0
    try:
        # Wipe prior pending rows from this source for this project.
        await _pg().execute_one_async(
            "DELETE FROM soft_spec_proposal "
            " WHERE project_id = $1 AND source_kind = $2 AND approved IS NULL "
            " RETURNING project_id",
            project_id, source_kind,
        )
    except Exception as e:
        logger.warning("replace_proposals delete %s/%s: %s",
                       project_id, source_kind, e)
    n = 0
    for p in proposals:
        field = p.get("field")
        if not field:
            continue
        try:
            await _pg().execute_one_async(
                "INSERT INTO soft_spec_proposal "
                "  (project_id, source_kind, source_note, doc_id, "
                "   field, value, confidence) "
                "VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7) RETURNING id",
                project_id, source_kind, p.get("note"),
                p.get("doc_id"), field,
                json.dumps(p.get("value")),
                float(p.get("confidence") or 0.5),
            )
            n += 1
        except Exception as e:
            logger.warning("replace_proposals insert %s/%s: %s",
                           project_id, field, e)
    return n


def _value_key(value: Any) -> str:
    """Stable, whitespace/case-insensitive key for a proposal value so the
    SAME parameter extracted on two different turns dedups, but genuinely
    different values for the same field are both kept."""
    try:
        if isinstance(value, str):
            # Whitespace-insensitive + case-folded so '40 kA' == '40kA'.
            return "".join(value.split()).lower()
        return json.dumps(value, sort_keys=True, ensure_ascii=False).lower()
    except Exception:
        return str(value).strip().lower()


async def clear_proposals(project_id: str, *,
                          include_approved: bool = False) -> int:
    """Delete proposals for a project — used by the 'clear & re-extract'
    action so stale/mislabelled rows from earlier extractions don't linger
    next to fresh ones. By default only PENDING rows are removed; approved
    rows (project history) are kept unless include_approved is set."""
    sql = "DELETE FROM soft_spec_proposal WHERE project_id = $1"
    if not include_approved:
        sql += " AND approved IS NULL"
    sql += " RETURNING id"
    try:
        rows = await _pg().execute_async(sql, project_id)
        n = len(rows or [])
        logger.info("clear_proposals: deleted %d row(s) for %s "
                    "(include_approved=%s)", n, project_id, include_approved)
        return n
    except Exception as e:  # noqa: BLE001
        logger.warning("clear_proposals %s: %s", project_id, e)
        return 0


async def merge_proposals(project_id: str, source_kind: str,
                          proposals: List[Dict[str, Any]]) -> int:
    """ACCUMULATE proposals from this source — never delete.

    The extractor is an LLM and its output varies turn to turn; an atomic
    replace therefore *loses* parameters whenever a later run happens to
    surface fewer of them (the 105 -> 64 regression). Instead we union:
    a (field, value) pair is inserted only if it isn't already present for
    this project+source in ANY review state. That means:

      * a re-extraction of the same parameter does NOT pile up duplicates,
      * a value the user already APPROVED or REJECTED is NOT re-proposed,
      * the pending set only ever grows as new parameters are discovered.

    Each entry in `proposals`: {field, value, confidence, note?, doc_id?}
    Returns the number of genuinely-new rows inserted.
    """
    if not proposals:
        return 0
    # Existing (field, value-key) pairs for this source, ALL states — so
    # approvals and rejections both suppress a re-propose.
    seen: set = set()
    try:
        rows = await _pg().execute_async(
            "SELECT field, COALESCE(approved_value, value) AS value "
            "  FROM soft_spec_proposal "
            " WHERE project_id = $1 AND source_kind = $2",
            project_id, source_kind,
        )
        for r in (rows or []):
            d = _decode_row(dict(r))
            seen.add((d.get("field"), _value_key(d.get("value"))))
    except Exception as e:
        logger.warning("merge_proposals preload %s/%s: %s",
                       project_id, source_kind, e)
    # Defence in depth: never persist an abstention / null-like, even if a
    # caller forgets to pre-filter.
    try:
        from services.soft_value_filter import is_meaningful_value
    except Exception:  # pragma: no cover
        def is_meaningful_value(_v):  # type: ignore
            return True
    n = 0
    for p in proposals:
        field = p.get("field")
        if not field:
            continue
        if not is_meaningful_value(p.get("value")):
            continue
        key = (field, _value_key(p.get("value")))
        if key in seen:
            continue
        seen.add(key)
        try:
            await _pg().execute_one_async(
                "INSERT INTO soft_spec_proposal "
                "  (project_id, source_kind, source_note, doc_id, "
                "   field, value, confidence) "
                "VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7) RETURNING id",
                project_id, source_kind, p.get("note"),
                p.get("doc_id"), field,
                json.dumps(p.get("value")),
                float(p.get("confidence") or 0.5),
            )
            n += 1
        except Exception as e:
            logger.warning("merge_proposals insert %s/%s: %s",
                           project_id, field, e)
    return n


# ---------------------------------------------------------------------------
# Read proposals — pending (for review) and approved (for spec build).
# ---------------------------------------------------------------------------
async def list_pending(project_id: str) -> List[Dict[str, Any]]:
    try:
        rows = await _pg().execute_async(
            "SELECT id, source_kind, source_note, doc_id, field, value, "
            "       confidence, created_at "
            "  FROM soft_spec_proposal "
            " WHERE project_id = $1 AND approved IS NULL "
            " ORDER BY field, confidence DESC, created_at ASC",
            project_id,
        )
    except Exception as e:
        logger.warning("list_pending %s: %s", project_id, e)
        return []
    return [_decode_row(dict(r)) for r in (rows or [])]


async def list_approved(project_id: str) -> List[Dict[str, Any]]:
    try:
        rows = await _pg().execute_async(
            "SELECT id, source_kind, source_note, doc_id, field, "
            "       COALESCE(approved_value, value) AS value, confidence, "
            "       approved_at "
            "  FROM soft_spec_proposal "
            " WHERE project_id = $1 AND approved = TRUE "
            " ORDER BY field, approved_at DESC",
            project_id,
        )
    except Exception as e:
        logger.warning("list_approved %s: %s", project_id, e)
        return []
    return [_decode_row(dict(r)) for r in (rows or [])]


async def get_proposal(proposal_id: str) -> Optional[Dict[str, Any]]:
    """Fetch a single proposal (any review state) by id — used by the
    source-markup endpoint to resolve the document + evidence span."""
    try:
        row = await _pg().execute_one_async(
            "SELECT id, project_id, source_kind, source_note, doc_id, field, "
            "       COALESCE(approved_value, value) AS value, confidence, "
            "       approved "
            "  FROM soft_spec_proposal "
            " WHERE id = $1",
            proposal_id,
        )
    except Exception as e:
        logger.warning("get_proposal %s: %s", proposal_id, e)
        return None
    return _decode_row(dict(row)) if row else None


# ---------------------------------------------------------------------------
# Approval actions.
# ---------------------------------------------------------------------------
async def approve(proposal_id: str,
                  approved_value: Optional[Any] = None) -> Optional[Dict[str, Any]]:
    """Mark a proposal approved. If approved_value is given (user edited),
    store it; otherwise the original `value` stands."""
    try:
        av = json.dumps(approved_value) if approved_value is not None else None
        row = await _pg().execute_one_async(
            "UPDATE soft_spec_proposal "
            "   SET approved = TRUE, approved_value = $2::jsonb, "
            "       approved_at = CURRENT_TIMESTAMP "
            " WHERE id = $1 AND approved IS NULL "
            "RETURNING id, project_id, field, source_kind, source_note, "
            "          COALESCE(approved_value, value) AS value, confidence",
            proposal_id, av,
        )
    except Exception as e:
        logger.warning("approve %s: %s", proposal_id, e)
        return None
    return _decode_row(dict(row)) if row else None


async def reject(proposal_id: str) -> Optional[Dict[str, Any]]:
    try:
        row = await _pg().execute_one_async(
            "UPDATE soft_spec_proposal "
            "   SET approved = FALSE, approved_at = CURRENT_TIMESTAMP "
            " WHERE id = $1 AND approved IS NULL "
            "RETURNING id, project_id, field",
            proposal_id,
        )
    except Exception as e:
        logger.warning("reject %s: %s", proposal_id, e)
        return None
    return dict(row) if row else None


# ---------------------------------------------------------------------------
# User-typed values become a synthetic source — same shape as extractor
# rows but source_kind="user" so the reconciler ranks them top.
# ---------------------------------------------------------------------------
async def add_user_value(project_id: str, field: str, value: Any,
                         note: str = "user-provided") -> Optional[str]:
    try:
        row = await _pg().execute_one_async(
            "INSERT INTO soft_spec_proposal "
            "  (project_id, source_kind, source_note, field, value, "
            "   confidence, approved, approved_value, approved_at) "
            "VALUES ($1, 'user', $2, $3, $4::jsonb, 0.99, TRUE, $4::jsonb, "
            "        CURRENT_TIMESTAMP) RETURNING id",
            project_id, note, field, json.dumps(value),
        )
    except Exception as e:
        logger.warning("add_user_value %s/%s: %s", project_id, field, e)
        return None
    return str(row["id"]) if row else None


def _decode_row(d: Dict[str, Any]) -> Dict[str, Any]:
    v = d.get("value")
    if isinstance(v, str):
        try:
            d["value"] = json.loads(v)
        except Exception:
            pass
    return d
