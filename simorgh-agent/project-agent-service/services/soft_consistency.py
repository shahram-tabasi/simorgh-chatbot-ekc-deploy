"""
soft_consistency.py — cross-document conflict / deviation detection.

Real scenario: a user uploads a SPEC for project A and an SLD for
project B by mistake. Their extracted values disagree (6.6 kV vs 20 kV,
different plant/OE number, different standard). Silently reconciling
"highest-confidence wins" would bake one project's data into the other
— exactly the high-importance-client-data loss we must avoid.

This module reads the stored proposals (each carries its source
document + value + confidence) and finds fields where two DIFFERENT
documents propose materially different values. It returns:

  * deviations — one entry per conflicting field, with every competing
    (value, source document) pair, ranked by severity.
  * mixed_projects — a boolean + reason when the IDENTITY fields
    (project number, client, system voltage, standard) disagree across
    documents, which strongly implies the docs are from different
    projects.
  * note — a ready-to-show Markdown summary the chat surfaces, ending
    with a request for the user to choose the correct value per field
    (they resolve in the proposals drawer, which already stacks the
    competing values).

No writes. Pure detection + reporting; the user's choice flows through
the existing approve/reject path.
"""
from __future__ import annotations

import logging
import re
from typing import Any, Dict, List, Tuple

logger = logging.getLogger(__name__)

# Fields whose disagreement across documents most strongly signals the
# documents are from DIFFERENT projects (identity + headline electrical).
_IDENTITY_FIELDS = {
    "projectNumber", "projectId", "client", "location",
    "standard", "country",
    "techSettings.general.nominalVoltage",
    "technicalSettings.mediumVoltage.nominalVoltage",
    "techSettings.general.ratedFrequency",
    "techSettings.general.shortCircuitCurrent",
}

# Human labels for the note (fallback: the raw field name).
_LABELS = {
    "projectNumber": "Project / OE number",
    "projectId": "Project ID (PID)",
    "client": "Client",
    "location": "Location",
    "standard": "Standard",
    "country": "Country",
    "language": "Document language",
    "techSettings.general.nominalVoltage": "Nominal voltage",
    "technicalSettings.mediumVoltage.nominalVoltage": "MV nominal voltage",
    "techSettings.general.ratedFrequency": "Rated frequency",
    "techSettings.general.shortCircuitCurrent": "Short-circuit current",
    "techSettings.general.bil": "Basic insulation level (BIL)",
}


def _norm(v: Any) -> str:
    """Normalise a value for equality comparison: lowercase, collapse
    whitespace, strip punctuation. '6.6 kV' == '6.6kv' == '6,6 KV'."""
    s = str(v if v is not None else "").strip().lower().replace(",", ".")
    return re.sub(r"\s+", " ", re.sub(r"[^\w.]+", " ", s)).strip()


def _doc_of(prop: Dict[str, Any]) -> str:
    """Best human label for the source document of a proposal."""
    return (str(prop.get("source_note") or "").strip()
            or str(prop.get("doc_id") or "").strip()
            or str(prop.get("source_kind") or "").strip()
            or "unknown source")


def detect_conflicts(pending: List[Dict[str, Any]],
                     approved: List[Dict[str, Any]]
                     ) -> Dict[str, Any]:
    """Group all proposals by field; flag fields where ≥2 DISTINCT
    normalised values come from DIFFERENT source documents. Returns the
    deviations + mixed-projects verdict + a Markdown note."""
    all_props = list(pending or []) + list(approved or [])
    by_field: Dict[str, List[Dict[str, Any]]] = {}
    for p in all_props:
        f = p.get("field")
        if f:
            by_field.setdefault(f, []).append(p)

    deviations: List[Dict[str, Any]] = []
    identity_conflicts: List[str] = []
    for field, props in by_field.items():
        # Bucket distinct normalised values, remembering each one's docs.
        buckets: Dict[str, Dict[str, Any]] = {}
        for p in props:
            key = _norm(p.get("value"))
            if not key:
                continue
            b = buckets.setdefault(key, {"value": p.get("value"), "docs": set()})
            b["docs"].add(_doc_of(p))
        # A conflict needs ≥2 distinct values AND those values must come
        # from genuinely different sources (a single doc proposing two
        # phrasings of the same thing isn't a cross-doc conflict).
        if len(buckets) < 2:
            continue
        all_docs = set()
        for b in buckets.values():
            all_docs |= b["docs"]
        if len(all_docs) < 2:
            continue
        is_identity = field in _IDENTITY_FIELDS
        deviations.append({
            "field": field,
            "label": _LABELS.get(field, field),
            "severity": "high" if is_identity else "normal",
            "values": [
                {"value": b["value"], "documents": sorted(b["docs"])}
                for b in buckets.values()
            ],
        })
        if is_identity:
            identity_conflicts.append(field)

    # Mixed-projects verdict: ≥2 identity fields disagreeing across docs.
    mixed = len(identity_conflicts) >= 2
    deviations.sort(key=lambda d: (0 if d["severity"] == "high" else 1,
                                   d["label"]))

    note = _render_note(deviations, mixed, identity_conflicts)
    return {
        "deviations": deviations,
        "mixed_projects": mixed,
        "identity_conflicts": identity_conflicts,
        "conflict_count": len(deviations),
        "note": note,
    }


def _render_note(deviations: List[Dict[str, Any]], mixed: bool,
                 identity_conflicts: List[str]) -> str:
    if not deviations:
        return ("✅ No conflicts found across your documents — the "
                "extracted values are consistent.")
    lines: List[str] = []
    if mixed:
        lines.append(
            "⚠️ **Your documents may be from DIFFERENT projects.** "
            "Key identity values (e.g. "
            + ", ".join(_LABELS.get(f, f) for f in identity_conflicts[:4])
            + ") disagree between the uploaded files. Please double-check "
            "you uploaded the right documents before continuing.")
    else:
        lines.append(
            f"⚠️ I found **{len(deviations)} value(s)** that differ "
            "between your uploaded documents:")
    lines.append("")
    for d in deviations:
        lines.append(f"**{d['label']}**"
                     + ("  _(key identity field)_" if d["severity"] == "high"
                        else ""))
        for v in d["values"]:
            srcs = ", ".join(v["documents"])
            lines.append(f"  - `{v['value']}`  — from {srcs}")
        lines.append("")
    lines.append(
        "Please tell me which value is correct for each field (or type "
        "the right one), and I'll use that. You can also resolve them in "
        "the review panel on the right.")
    return "\n".join(lines)
