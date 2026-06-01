"""
soft_reconciler.py — merge multi-source field proposals into one ProjectSpec.

Inputs:
  bag: Dict[field_name, List[FieldValue]]   # what each source proposed

Outputs:
  spec:     ProjectSpec           # the JSON payload (defaults applied)
  prov:     List[FieldProvenance] # per-field source + conflict info
  gaps:     List[str]             # REQUIRED_FIELDS missing across sources
  conflicts: List[str]            # fields where ≥2 sources strongly disagreed

The merge rule: for each field, score every proposal as
SOURCE_RANK[src] * confidence, pick the top, and flag a conflict if the
runner-up is within 80% of the top score AND its value materially differs.
The UI shows the conflict so the user picks (or types over).
"""
from __future__ import annotations

import re
from typing import Any, Dict, List, Tuple

from services.soft_spec import (
    CONFIRMABLE_FIELDS, FieldProvenance, FieldValue, ProjectSpec,
    REQUIRED_FIELDS, SOURCE_RANK,
)


def _norm(v: Any) -> str:
    s = str(v or "").strip().lower()
    # Collapse whitespace + drop punctuation differences for comparison.
    return re.sub(r"\s+", " ", re.sub(r"[\W_]+", " ", s)).strip()


def _score(fv: FieldValue) -> float:
    return SOURCE_RANK.get(fv.source, 0) * max(0.0, min(1.0, fv.confidence))


def reconcile(bag: Dict[str, List[FieldValue]]
              ) -> Tuple[ProjectSpec, List[FieldProvenance], List[str], List[str]]:
    chosen: Dict[str, FieldValue] = {}
    prov: List[FieldProvenance] = []
    conflicts: List[str] = []

    all_fields = set(bag.keys()) | set(CONFIRMABLE_FIELDS)
    for field in all_fields:
        proposals = sorted(bag.get(field, []), key=_score, reverse=True)
        if not proposals:
            continue
        top = proposals[0]
        chosen[field] = top
        entry = FieldProvenance(
            field=field, value=top.value,
            source=top.source, confidence=top.confidence, note=top.note,
        )
        # Conflict detection: ≥2 proposals, runner-up close in score, value differs.
        if len(proposals) >= 2:
            runner = proposals[1]
            if (_score(runner) >= 0.8 * _score(top)
                    and _norm(runner.value) != _norm(top.value)):
                entry.conflict_with = {
                    "value": runner.value, "source": runner.source,
                    "confidence": runner.confidence, "note": runner.note,
                }
                if field in CONFIRMABLE_FIELDS:
                    conflicts.append(field)
        prov.append(entry)

    # Build ProjectSpec — start with defaults, layer chosen values on top.
    # projectName is REQUIRED by Pydantic; supply a placeholder if no source
    # proposed one so the model validates. The reconciler also lists it in
    # `gaps` so the UI flags it as needing user input.
    spec_kwargs: Dict[str, Any] = {"projectName": "New Project"}
    for field, fv in chosen.items():
        spec_kwargs[field] = fv.value
    # Pydantic will reject unknown nested-only keys silently via extra="allow".
    spec = ProjectSpec(**spec_kwargs)

    gaps = [f for f in REQUIRED_FIELDS
            if f not in chosen or not str(chosen[f].value).strip()]
    # If chat/uploads/tpms didn't surface projectName, treat the placeholder
    # as a gap so the UI prompts.
    if "projectName" not in chosen and "projectName" not in gaps:
        gaps.append("projectName")

    # Stable order for the UI.
    prov.sort(key=lambda p: (CONFIRMABLE_FIELDS.index(p.field)
                             if p.field in CONFIRMABLE_FIELDS else 999))
    return spec, prov, gaps, conflicts
