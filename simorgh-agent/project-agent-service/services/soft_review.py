"""
soft_review.py — turn raw pending proposals into a HITL review model.

Applies the master-data-management reconciliation pattern (matching →
survivorship → conflict routing) that golden-record platforms such as
Profisee and Semarchy use, plus the human-in-the-loop "exception
routing" pattern for values a machine shouldn't silently pick:

  * MATCH      — proposals for the SAME field whose values are equal after
                 normalization are MERGED into one corroborated value, so
                 the same parameter extracted over and over collapses to a
                 single row (with an occurrence / source count).
  * SURVIVORSHIP — within a field, candidate values are ranked by source
                 trust (SOURCE_RANK) × confidence × corroboration; the top
                 candidate is flagged `suggested` as a default.
  * CONFLICT ROUTING — a field carrying ≥2 DISTINCT values is a CONFLICT
                 and is routed to its own review section for the user to
                 decide; a field with exactly one value is `agreed`.

Pure function (no DB / IO) so it is trivially testable and can run in any
context. NEVER raises on bad input — the worst case is an empty model.
"""
from __future__ import annotations

import json
import logging
from typing import Any, Dict, List

logger = logging.getLogger(__name__)

try:
    from services.soft_spec import SOURCE_RANK as _SOURCE_RANK
except Exception:  # pragma: no cover - import-time safety
    _SOURCE_RANK = {}


def match_key(value: Any) -> str:
    """Normalized key for MATCHING two values (not for display).

    Whitespace-insensitive + case-folded so '40 kA' == '40kA' == '40 KA',
    and numerically tidy so 40 == 40.0. Conservative otherwise — it does
    NOT parse units or synonyms, so genuinely different values stay
    distinct and surface as a conflict for the user to decide."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        try:
            f = float(value)
            return str(int(f)) if f.is_integer() else repr(f)
        except Exception:
            return str(value)
    if isinstance(value, str):
        return "".join(value.split()).lower()
    try:
        return json.dumps(value, sort_keys=True, ensure_ascii=False).lower()
    except Exception:
        return str(value).strip().lower()


def _src_rank(kind: Any) -> int:
    try:
        return int(_SOURCE_RANK.get(kind, 50))
    except Exception:
        return 50


def build_review(pending: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Group pending proposals into {conflicts, agreed, counts}.

    Each `pending` entry is a proposal dict:
        {id, field, value, source_kind, source_note, confidence, doc_id}

    Returns clusters that are themselves Proposal-shaped (id, field, value,
    source_kind, source_note, confidence, doc_id) PLUS review metadata
    (corroboration, sources[], proposal_ids[], suggested) so the frontend
    can render them with the existing proposal-row component."""
    fields: Dict[str, Dict[str, Dict[str, Any]]] = {}
    for p in (pending or []):
        field = p.get("field")
        if not field:
            continue
        k = match_key(p.get("value"))
        clusters = fields.setdefault(field, {})
        cl = clusters.get(k)
        conf = float(p.get("confidence") or 0.5)
        if cl is None:
            cl = {
                "id":           p.get("id"),
                "field":        field,
                "value":        p.get("value"),
                "source_kind":  p.get("source_kind"),
                "source_note":  p.get("source_note"),
                "confidence":   conf,
                "doc_id":       p.get("doc_id"),
                "corroboration": 0,
                "proposal_ids": [],
                "sources":      [],
                "_rank":        -1.0,
            }
            clusters[k] = cl
        cl["corroboration"] += 1
        if p.get("id") is not None:
            cl["proposal_ids"].append(p.get("id"))
        cl["sources"].append({
            "kind":        p.get("source_kind"),
            "note":        p.get("source_note"),
            "confidence":  conf,
            "doc_id":      p.get("doc_id"),
            "proposal_id": p.get("id"),
        })
        # Survivorship: representative = highest (source-rank + confidence).
        score = _src_rank(p.get("source_kind")) + conf
        if score > cl["_rank"]:
            cl["_rank"] = score
            cl["id"] = p.get("id")
            cl["value"] = p.get("value")
            cl["source_kind"] = p.get("source_kind")
            cl["source_note"] = p.get("source_note")
            cl["doc_id"] = p.get("doc_id")
        if conf > cl["confidence"]:
            cl["confidence"] = conf

    conflicts: List[Dict[str, Any]] = []
    agreed: List[Dict[str, Any]] = []
    for field, clusters in fields.items():
        cand = list(clusters.values())
        # Rank candidates so the survivor (suggested default) is first.
        cand.sort(
            key=lambda c: (c.get("_rank", 0.0), c.get("corroboration", 0),
                           c.get("confidence", 0.0)),
            reverse=True,
        )
        for i, c in enumerate(cand):
            c["suggested"] = (i == 0)
            c.pop("_rank", None)
        if len(cand) >= 2:
            # Distinct values for the same parameter — needs a human call.
            conflicts.append({"field": field, "candidates": cand})
        else:
            agreed.append(cand[0])

    conflicts.sort(key=lambda x: x["field"])
    agreed.sort(key=lambda x: x["field"])
    return {
        "conflicts": conflicts,
        "agreed": agreed,
        "counts": {
            "conflict_fields": len(conflicts),
            "agreed_fields": len(agreed),
            "pending_proposals": sum(len(p.get("proposal_ids", [])) for p in agreed)
            + sum(len(c.get("proposal_ids", []))
                  for g in conflicts for c in g["candidates"]),
        },
    }
