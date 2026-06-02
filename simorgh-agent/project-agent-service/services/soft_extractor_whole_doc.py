"""
soft_extractor_whole_doc.py — whole-document spec-field extraction.

Replaces the old window-based path (`soft_extractor.from_uploads`) for the
"uploads" source kind. The previous code retrieved at most 16,000 chars of
each document, ran a regex over the first 3,500, then asked the LLM for
JSON over a ~16K text window — which on a 27-page engineering spec
silently dropped pages 3-27.

This module instead:

  1. Pulls the FULL document text from Qdrant (no truncation cap).
  2. Asks the local gpt-oss-20b (`/generate`, mode=offline, force_backend=
     text) for every CONFIRMABLE_FIELD in a single call, with a strict
     `guided_json` schema constraint so the response is byte-valid JSON
     and every field carries an `evidence_span` (verbatim quote from the
     doc) plus a 0-1 `confidence`.
  3. Runs a SECOND pass that ONLY asks about fields where the first pass
     returned null or confidence < 0.7. That pass sees the whole doc
     again with the partial JSON, so silent omissions become explicit
     `present=false, reason=...` answers — which we can either drop or
     re-extract by hand.
  4. Returns `Dict[field, FieldValue]` matching the existing extractor
     contract so the reconciler and the HITL proposal gate are unchanged.

The HITL gate is the single source of truth for what reaches the spec.
This extractor's job is to PROPOSE every plausible value with provenance;
the human approves.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Any, Dict, List, Optional, Tuple

import httpx

from services.soft_spec import CONFIRMABLE_FIELDS, FieldValue
from services.soft_extractor import _reshape_dotted, _NESTED_GROUPS

logger = logging.getLogger(__name__)

LLM_GATEWAY_URL = os.getenv("LLM_GATEWAY_URL", "http://llm-gateway:8030")
WHOLE_DOC_MAX_CHARS = int(os.getenv("SOFT_WHOLE_DOC_MAX_CHARS", "200000"))
WHOLE_DOC_TIMEOUT = float(os.getenv("SOFT_WHOLE_DOC_TIMEOUT_SEC", "180"))
WHOLE_DOC_MAX_OUTPUT_TOKENS = int(os.getenv("SOFT_WHOLE_DOC_MAX_TOKENS", "4000"))
# gpt-oss official guidance: temperature=1.0, top_p=1.0. Determinism comes
# from `guided_json`, not from cooling the sampler.
WHOLE_DOC_TEMPERATURE = float(os.getenv("SOFT_WHOLE_DOC_TEMPERATURE", "1.0"))

# Field-level human labels surfaced in the prompt so the model sees what
# each cryptic key means. Keep in sync with frontend FIELD_LABELS.
_FIELD_LABELS: Dict[str, str] = {
    "projectName":         "Project name (e.g. 'Mobarakeh Steel HSM-2 6.6kV Switchgear')",
    "projectDescription":  "Short description / scope, free-text",
    "projectNumber":       "OE number / project code (e.g. '04A12065')",
    "projectId":           "Internal PID (often equals OE number)",
    "client":              "End customer / owner",
    "location":            "Plant or site location",
    "standard":            "Primary standard family (e.g. 'IEC', 'IEEE', 'ANSI')",
    "country":             "Country of installation",
    "language":            "Document language (English / Persian / mixed)",
    "noticeToProceedDate": "NTP date, ISO 8601 (YYYY-MM-DD)",
    "deliveryDate":        "Delivery / contractual completion date, ISO 8601",
    "planner":             "Planner / design engineer / responsible person",
    "designOffice":        "Design office or EPC",
    "comment":             "Any other freeform note worth capturing",
    # Nested techSettings fields (dotted keys; reshaped after extraction).
    "techSettings.general.designTemperature":
        "Design ambient temperature, °C (e.g. '50' or '40/-10')",
    "techSettings.general.altitudeAboveSeaLevel":
        "Altitude above sea level, meters (e.g. '1800')",
    "techSettings.general.nominalVoltage":
        "Nominal voltage of the medium-voltage system (e.g. '6.6 kV')",
    "techSettings.general.ratedFrequency":
        "Rated frequency (e.g. '50 Hz')",
    "techSettings.general.shortCircuitCurrent":
        "Short-circuit / fault current rating (e.g. '40 kA, 3 s')",
    "techSettings.general.bil":
        "Basic insulation level (e.g. '75 kV')",
    "techSettings.general.ipRating":
        "IP / IK class (e.g. 'IP4X', 'IK10')",
    "techSettings.general.iacClass":
        "Internal Arc Classification per IEC 62271-200",
    "techSettings.general.controlVoltage":
        "Control / auxiliary voltage (e.g. '110 V DC')",
    "techSettings.wireManufacturer.mv":
        "MV wire / cable manufacturer(s)",
    "techSettings.wireManufacturer.lv":
        "LV wire / cable manufacturer(s)",
}

# The list of (dotted) keys we EXTRACT — superset of CONFIRMABLE_FIELDS
# plus the nested techSettings.* fields we know real engineering specs
# always contain.
_EXTRACT_KEYS: List[str] = list(dict.fromkeys([
    *CONFIRMABLE_FIELDS,
    "techSettings.general.designTemperature",
    "techSettings.general.altitudeAboveSeaLevel",
    "techSettings.general.nominalVoltage",
    "techSettings.general.ratedFrequency",
    "techSettings.general.shortCircuitCurrent",
    "techSettings.general.bil",
    "techSettings.general.ipRating",
    "techSettings.general.iacClass",
    "techSettings.general.controlVoltage",
    "techSettings.wireManufacturer.mv",
    "techSettings.wireManufacturer.lv",
]))


def _per_field_object_schema() -> Dict[str, Any]:
    """JSON Schema for one extracted field. The extractor emits a value
    OR explicit `null` with `present=false` + reason — never silently
    omits a key. evidence_span is REQUIRED when present=true."""
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["present", "value", "confidence"],
        "properties": {
            "present":      {"type": "boolean"},
            "value":        {"type": ["string", "null"]},
            "evidence_span":{"type": ["string", "null"],
                             "description": "verbatim quote from the document"},
            "section":      {"type": ["string", "null"],
                             "description": "section heading where evidence appears"},
            "confidence":   {"type": "number", "minimum": 0, "maximum": 1},
            "reason":       {"type": ["string", "null"],
                             "description": "if present=false, why (e.g. 'not in this document')"},
        },
    }


def _whole_doc_schema() -> Dict[str, Any]:
    """vLLM `guided_json` schema: a flat object keyed by dotted field name,
    each value an extraction record. Forcing additionalProperties=false +
    requiring every key makes silent field-skip impossible."""
    return {
        "type": "object",
        "additionalProperties": False,
        "required": _EXTRACT_KEYS,
        "properties": {
            k: _per_field_object_schema() for k in _EXTRACT_KEYS
        },
    }


def _format_field_list_for_prompt() -> str:
    """Render the schema as a numbered, labelled list — guided_json
    enforces the shape, but the LLM still benefits from seeing what each
    cryptic key MEANS in plain English."""
    lines = []
    for i, k in enumerate(_EXTRACT_KEYS, 1):
        label = _FIELD_LABELS.get(k, k)
        lines.append(f"  {i:2d}. {k}  —  {label}")
    return "\n".join(lines)


_SYSTEM_PROMPT = (
    "You are a precise structured-extraction engine for IEC switchgear and "
    "low-voltage / medium-voltage engineering specifications. You extract "
    "values that are EXPLICITLY present in the document — you NEVER guess "
    "or infer from training-data context. For every requested field you "
    "either return the value with a verbatim evidence quote, or set "
    "`present=false` with a one-sentence `reason`. Your output is a single "
    "JSON object matching the supplied schema. No prose, no markdown, no "
    "code fences — JSON only."
)


def _extract_user_prompt(filename: str, doc_type: str, markdown: str) -> str:
    """First-pass user prompt: schema-driven exhaustive extraction over
    the whole document."""
    fields_block = _format_field_list_for_prompt()
    return (
        f"# FILE\n{filename}  (type: {doc_type})\n\n"
        f"# FIELDS TO EXTRACT\n{fields_block}\n\n"
        f"# RULES\n"
        f"- Output a JSON object with EVERY field above as a key. None may be missing.\n"
        f"- For each field, set `present` to true ONLY if the value is "
        f"explicitly stated or derivable from a verbatim quote in the "
        f"document below. `evidence_span` must be a literal substring of "
        f"the document.\n"
        f"- If a field is genuinely absent, set `present=false`, "
        f"`value=null`, `confidence=0`, and give a one-sentence `reason` "
        f"(e.g. 'no IP rating mentioned in this spec').\n"
        f"- `section` is the nearest heading above the evidence (Markdown "
        f"`#`/`##`/etc.). null if the doc has no headings.\n"
        f"- `confidence` is your honest 0-1 calibration: 1.0 only for an "
        f"exact, unambiguous title-block value; 0.5-0.8 for body-text "
        f"values; ≤0.3 for fuzzy or contextual readings.\n"
        f"- For Persian-language values, return the Persian text verbatim "
        f"(don't transliterate).\n"
        f"- For dates, normalise to ISO 8601 YYYY-MM-DD when possible.\n\n"
        f"# DOCUMENT\n{markdown}\n"
    )


def _verify_user_prompt(filename: str, markdown: str,
                        gaps: List[str]) -> str:
    """Second-pass prompt: focused re-scan for fields the first pass
    declared absent or low-confidence. The model gets the whole document
    again and a list of fields to RE-CHECK; this catches silent omissions
    where the first pass moved on without scanning the body for a value."""
    gap_block = "\n".join(f"  - {k}  —  {_FIELD_LABELS.get(k, k)}"
                          for k in gaps)
    return (
        f"# FILE\n{filename}\n\n"
        f"# FIELDS TO RE-CHECK\n"
        f"The first pass over this document declared the following fields "
        f"absent or low-confidence. Re-scan the ENTIRE document below and "
        f"either supply a value with verbatim evidence, or confirm the "
        f"absence with a one-sentence reason.\n\n{gap_block}\n\n"
        f"# RULES (identical to first pass)\n"
        f"- Output JSON with ONLY the fields listed above as keys, same "
        f"per-field shape.\n"
        f"- Be more thorough than the first pass: scan tables, footers, "
        f"appendices, drawings legends.\n"
        f"- `evidence_span` must be a verbatim substring of the document.\n\n"
        f"# DOCUMENT\n{markdown}\n"
    )


# ---------------------------------------------------------------------------
# LLM call
# ---------------------------------------------------------------------------
async def _call_gpt_oss(messages: List[Dict[str, Any]],
                        schema: Dict[str, Any],
                        timeout: float) -> Optional[Dict[str, Any]]:
    """One round-trip to the local gpt-oss-20b via llm-gateway. Uses
    guided_json for byte-valid JSON. Returns the parsed dict on success,
    None on any failure (logged)."""
    payload = {
        "messages":      messages,
        "mode":          "offline",
        "force_backend": "text",
        "temperature":   WHOLE_DOC_TEMPERATURE,
        "max_tokens":    WHOLE_DOC_MAX_OUTPUT_TOKENS,
        # vLLM passthrough — guided_json enforces the schema at the
        # token sampler. response_format is the OpenAI-compatible alias.
        "extra": {
            "guided_json":     schema,
            "response_format": {"type": "json_object"},
            # gpt-oss-specific knobs: low reasoning is the right tier for
            # mechanical extraction (3-10x faster than the default).
            "reasoning_effort": "low",
        },
    }
    last_err: Optional[Exception] = None
    for attempt in range(3):
        try:
            async with httpx.AsyncClient(timeout=timeout) as c:
                r = await c.post(f"{LLM_GATEWAY_URL}/generate", json=payload)
                if r.status_code in (502, 503, 504):
                    raise httpx.HTTPStatusError("gateway busy",
                                                request=r.request, response=r)
                r.raise_for_status()
                body = r.json()
                break
        except Exception as e:
            last_err = e
            await asyncio.sleep(1.5 * (attempt + 1))
    else:
        body = None
    if body is None:
        logger.warning("soft.whole_doc gateway failed: %s", last_err)
        return None
    text = (body.get("response") or body.get("text") or "").strip()
    if not text:
        return None
    # guided_json should hand us byte-valid JSON; if vLLM falls back, try
    # to find the JSON object inside markdown fences.
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    # Strip code fences if present, find the outermost {...}.
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1 and end > start:
        try:
            return json.loads(text[start:end + 1])
        except json.JSONDecodeError as e:
            logger.warning("soft.whole_doc JSON parse failed: %s", e)
    return None


def _to_field_values(extracted: Dict[str, Any], filename: str,
                     doc_type: str) -> Dict[str, FieldValue]:
    """Convert the LLM's per-field record into the existing FieldValue
    contract so the reconciler and proposals layer don't change. Dotted
    keys (techSettings.general.foo) are passed through; the caller
    applies `_reshape_dotted` to nest them."""
    out: Dict[str, FieldValue] = {}
    for k, rec in (extracted or {}).items():
        if not isinstance(rec, dict):
            continue
        if not rec.get("present"):
            continue
        value = rec.get("value")
        if value in (None, "", []):
            continue
        try:
            conf = float(rec.get("confidence") or 0.5)
        except (TypeError, ValueError):
            conf = 0.5
        ev = rec.get("evidence_span") or ""
        sec = rec.get("section") or ""
        # Trim runaway evidence — UI shows it as a hover note.
        ev_short = ev[:240] + ("…" if len(ev) > 240 else "")
        note_parts = [f"from {doc_type} '{filename}'"]
        if sec:
            note_parts.append(f"§ {sec}")
        if ev_short:
            note_parts.append(f"“{ev_short}”")
        out[k] = FieldValue(
            value=str(value), source="uploads",
            confidence=max(0.0, min(1.0, conf)),
            note=" · ".join(note_parts),
        )
    return out


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------
async def extract_one_document(*, filename: str, doc_type: str,
                               markdown: str,
                               timeout: float = WHOLE_DOC_TIMEOUT,
                               ) -> Dict[str, FieldValue]:
    """Run the two-pass schema-driven extractor over one document's full
    markdown. Returns a dotted-key dict of FieldValue ready to merge with
    the regex pass. Callers should reshape via `_reshape_dotted` before
    handing to the reconciler."""
    if not markdown or len(markdown) < 50:
        return {}
    markdown = markdown[:WHOLE_DOC_MAX_CHARS]
    schema = _whole_doc_schema()

    # ---- Pass 1: exhaustive extraction over the whole document ---------
    messages = [
        {"role": "system", "content": _SYSTEM_PROMPT},
        {"role": "user",
         "content": _extract_user_prompt(filename, doc_type, markdown)},
    ]
    pass1 = await _call_gpt_oss(messages, schema, timeout=timeout)
    if pass1 is None:
        return {}

    # ---- Pass 2: verify gaps -------------------------------------------
    gaps: List[str] = []
    for k in _EXTRACT_KEYS:
        rec = pass1.get(k) if isinstance(pass1, dict) else None
        if not isinstance(rec, dict):
            gaps.append(k)
            continue
        present = bool(rec.get("present"))
        try:
            conf = float(rec.get("confidence") or 0.0)
        except (TypeError, ValueError):
            conf = 0.0
        if not present or conf < 0.7:
            gaps.append(k)
    if gaps:
        gap_schema = {
            "type": "object", "additionalProperties": False,
            "required": gaps,
            "properties": {k: _per_field_object_schema() for k in gaps},
        }
        v_messages = [
            {"role": "system", "content": _SYSTEM_PROMPT},
            {"role": "user",
             "content": _verify_user_prompt(filename, markdown, gaps)},
        ]
        pass2 = await _call_gpt_oss(v_messages, gap_schema, timeout=timeout)
        # Merge: pass2 wins for any key it answers with higher confidence.
        if pass2:
            for k in gaps:
                rec2 = pass2.get(k) if isinstance(pass2, dict) else None
                if not isinstance(rec2, dict):
                    continue
                rec1 = pass1.get(k) if isinstance(pass1, dict) else {}
                try:
                    c1 = float((rec1 or {}).get("confidence") or 0.0)
                except (TypeError, ValueError):
                    c1 = 0.0
                try:
                    c2 = float(rec2.get("confidence") or 0.0)
                except (TypeError, ValueError):
                    c2 = 0.0
                # Prefer the more confident record. Pass-2 ties win
                # (more thorough re-scan).
                if rec2.get("present") and c2 >= c1:
                    pass1[k] = rec2

    return _to_field_values(pass1 or {}, filename, doc_type)


async def from_uploads_whole_doc(project_id: str, project_oenum: str,
                                 *, max_docs: int = 6,
                                 timeout: float = WHOLE_DOC_TIMEOUT,
                                 ) -> Dict[str, FieldValue]:
    """Whole-document replacement for `soft_extractor.from_uploads`.

    Walks every uploaded document for the project, pulls its FULL text
    from Qdrant (no truncation), runs the two-pass schema-driven extractor
    on each, and merges the results. The first document to claim a field
    wins (regex pass merged on top of this by the caller — same contract
    as the legacy path)."""
    try:
        from services.project_memory_service import get_project_memory_service
        q = getattr(get_project_memory_service(), "qdrant", None)
        if q is None:
            return {}
        scope = str(project_id)
        docs = q.list_documents(user_id="system", project_oenum=scope) or []
    except Exception as e:
        logger.warning("soft.whole_doc list failed: %s", e)
        return {}
    if not docs:
        return {}

    # Doc-type ranking: specs first (they carry most fields), then
    # datasheets, then everything else. The cap (`max_docs`) protects the
    # extractor from blowing up on a project with 50 uploads — the top
    # few specs are where the project-level fields live anyway.
    from services.soft_extractor import _doc_type_of  # reuse classifier
    typed: List[Tuple[str, str, int]] = []  # (filename, doc_type, rank)
    rank = {"spec": 0, "datasheet": 1, "loadlist": 2, "sld": 3, "other": 4}
    for d in docs:
        fn = d.get("filename") or ""
        if not fn:
            continue
        dt = _doc_type_of(fn)
        typed.append((fn, dt, rank.get(dt, 9)))
    typed.sort(key=lambda x: x[2])

    bag: Dict[str, FieldValue] = {}
    for fn, dt, _ in typed[:max_docs]:
        try:
            res = q.get_document_text(user_id="system", project_oenum=scope,
                                      filename=fn,
                                      max_chars=WHOLE_DOC_MAX_CHARS)
        except Exception as e:
            logger.warning("soft.whole_doc read %s: %s", fn, e)
            continue
        markdown = (res or {}).get("text") or ""
        if not markdown:
            continue
        try:
            got = await extract_one_document(
                filename=fn, doc_type=dt,
                markdown=markdown, timeout=timeout,
            )
        except Exception as e:
            logger.warning("soft.whole_doc extract %s: %s", fn, e)
            continue
        # First-document-wins, same as the legacy bag policy.
        for k, fv in got.items():
            if k not in bag:
                bag[k] = fv
        logger.info(
            "soft.whole_doc: %s/%s → %d field proposals",
            project_id, fn, len(got),
        )

    # Reshape dotted-key entries (techSettings.general.foo) into nested
    # FieldValue payloads the existing reconciler understands.
    return _reshape_dotted(bag)
