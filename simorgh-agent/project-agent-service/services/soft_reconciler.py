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


# Fields whose VALUE is itself a dict that simorgh-soft reads at a nested
# path. They are merged atomically — runner-up dicts are not blended into
# the winner. The reconciler hoists them into the right place on the spec.
NESTED_GROUPS: Dict[str, Tuple[str, str]] = {
    "techSettings.general":            ("techSettings", "general"),
    "techSettings.wireManufacturer":   ("techSettings", "wireManufacturer"),
    "technicalSettings.mediumVoltage": ("technicalSettings", "mediumVoltage"),
    "technicalSettings.lowVoltage":    ("technicalSettings", "lowVoltage"),
}

# Fields whose value is a list (Tier 2 arrays). We don't conflict-merge
# arrays — best-scoring source wins whole. The UI shows the count and the
# user can refine inside simorgh-soft if more than one source produced
# equipments / devices.
ARRAY_FIELDS = {"equipments", "devices"}


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
        # Conflict detection — skip for arrays (incomparable) and groups
        # (their values are dicts; the UI shows them as one row anyway).
        if (field not in ARRAY_FIELDS and field not in NESTED_GROUPS
                and len(proposals) >= 2):
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

    # ---- Build the ProjectSpec ----
    # projectName is REQUIRED by Pydantic; supply a placeholder if no
    # source proposed one.
    #
    # CRITICAL: proposals are stored with DOTTED SCALAR keys that mirror
    # simorgh-soft's nested JSON schema, e.g.
    #   techSettings.general.altitudeAboveSeaLevel  = "1000"
    #   techSettings.wireColor.acPhase              = "L1 brown / L2 black …"
    #   technicalSettings.mediumVoltage.nominalVoltage = "6.6"
    # The simorgh-soft UI reads these at the NESTED path
    # (techSettings → general → altitudeAboveSeaLevel). Previously the
    # reconciler only hoisted four hard-coded GROUP keys (and only when
    # the proposal VALUE was itself a dict), so every individual dotted
    # SCALAR landed as a literal flat key named
    # "techSettings.general.altitudeAboveSeaLevel" on the spec — which
    # the UI's nested reader never found. Result: a project created from
    # 31 extracted fields showed only the 2 flat scalars (language,
    # nominalVoltage) that happened to map directly.
    #
    # Fix: walk EVERY dotted key into nested dicts. Scalar leaves are
    # set at their full path; dict-valued group proposals are merged at
    # their level (back-compat with extractors that emit whole groups).
    spec_kwargs: Dict[str, Any] = {"projectName": ""}

    def _set_nested(root: Dict[str, Any], dotted: str, value: Any) -> None:
        parts = dotted.split(".")
        cursor = root
        for p in parts[:-1]:
            nxt = cursor.get(p)
            if not isinstance(nxt, dict):
                nxt = {}
                cursor[p] = nxt
            cursor = nxt
        leaf = parts[-1]
        if isinstance(value, dict):
            # Group-shaped proposal — merge into any existing dict so we
            # don't clobber sibling keys set by other proposals.
            existing = cursor.get(leaf)
            if isinstance(existing, dict):
                existing.update(value)
            else:
                cursor[leaf] = dict(value)
        else:
            cursor[leaf] = value

    for field, fv in chosen.items():
        if "." in field:
            _set_nested(spec_kwargs, field, fv.value)
        else:
            spec_kwargs[field] = fv.value

    spec = ProjectSpec(**spec_kwargs)

    gaps = [f for f in REQUIRED_FIELDS
            if f not in chosen or not str(chosen[f].value).strip()]
    if "projectName" not in chosen and "projectName" not in gaps:
        gaps.append("projectName")

    prov.sort(key=lambda p: (CONFIRMABLE_FIELDS.index(p.field)
                             if p.field in CONFIRMABLE_FIELDS else 999))
    return spec, prov, gaps, conflicts
