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
# each cryptic key means. Mirrors simorgh-soft's `ProjectData` schema
# AND the IEC 61439-1 / 62271-200 canonical category taxonomy. The
# frontend FIELD_META in ProposalsReviewDrawer.tsx is the user-facing
# mirror — keep both in sync when adding fields.
_FIELD_LABELS: Dict[str, str] = {
    # ── Project Identity ───────────────────────────────────────────────
    "projectName":         "Project name (e.g. 'Mobarakeh Steel HSM-2 6.6kV Switchgear')",
    "projectDescription":  "PROSE description of the project's scope, in one or two complete sentences. NEVER copy the document's title-block (lines containing 'DOCUMENT No.', 'Rev. A', 'Page of N', pipe-separators '|'); if no real prose description exists in the document, leave this field absent.",
    "projectNumber":       "OE number / project code, format YYAXXXXX (e.g. '04A12065')",
    "projectId":           "Internal PID (often equals OE number)",
    "client":              "End customer / owner / operating entity",
    "planner":             "Planner / design engineer / responsible person",
    "designOffice":        "Design office or EPC contractor",
    "comment":             "Any other freeform note worth capturing",
    # ── Regional & Dates ───────────────────────────────────────────────
    "country":             "Country of installation (IEC: Iran / Germany / USA / France / China / ...)",
    "language":            "Document language (English / Persian / Arabic / German / French / ...)",
    "standard":            "Primary standard family (IEC / IEEE / ANSI / DIN / GOST / GB)",
    "noticeToProceedDate": "NTP date, ISO 8601 YYYY-MM-DD (Jalali also accepted)",
    "deliveryDate":        "Delivery / contractual completion date, ISO 8601",
    # ── Site & Environmental (IEC 62271-1 §2) ──────────────────────────
    "location":            "Plant or site location",
    "techSettings.general.designTemperature":
        "Design ambient temperature, °C (IEC envelope: -40 to +60)",
    "techSettings.general.altitudeAboveSeaLevel":
        "Altitude above sea level, m (0..5000; derate above 1000)",
    # ── Network Characteristics (IEC 60909 inputs) ─────────────────────
    "techSettings.general.nominalVoltage":
        "Nominal voltage of the medium-voltage system (kV, e.g. '6.6')",
    "techSettings.general.ratedFrequency":
        "Rated frequency, Hz (50 or 60)",
    "techSettings.general.shortCircuitCurrent":
        "Short-circuit current Icw, kA (e.g. '40' for 40 kA / 1 s)",
    "technicalSettings.mediumVoltage.nominalVoltage":
        "MV nominal voltage, kV (alt. nesting; same physical value)",
    "technicalSettings.mediumVoltage.maxShortCircuitPower":
        "MV max short-circuit power, MVA",
    "technicalSettings.mediumVoltage.minShortCircuitPower":
        "MV min short-circuit power, MVA",
    "technicalSettings.lowVoltage.nominalVoltage":
        "LV nominal voltage, V (e.g. '400')",
    "technicalSettings.lowVoltage.frequency":
        "LV frequency, Hz (50 or 60)",
    "technicalSettings.lowVoltage.permissibleTouchVoltage":
        "Permissible touch voltage, V",
    "technicalSettings.lowVoltage.ambientTemperature":
        "LV ambient temperature, °C",
    "technicalSettings.lowVoltage.numberOfPoles":
        "Number of poles (3 / 4)",
    "technicalSettings.lowVoltage.earthFaultDetection":
        "Earth-fault detection method",
    # ── Type Testing & Compliance (IEC 62271-200) ──────────────────────
    "techSettings.general.bil":
        "Basic insulation level Up, kV peak (1.2/50 µs impulse)",
    "techSettings.general.iacClass":
        "Internal Arc Classification per IEC 62271-200 (e.g. 'IAC AFLR 25 kA 1 s')",
    # ── Panel / Enclosure Construction (IEC 61439-1 §8) ────────────────
    "techSettings.general.ipRating":
        "IP / IK class (IEC 60529 / IEC 62262, e.g. 'IP4X', 'IK10')",
    "techSettings.general.controlVoltage":
        "Control / auxiliary voltage (e.g. '110 V DC')",
    # ── Wiring — Size (cross-section, mm²) ─────────────────────────────
    "techSettings.wireSize.controlCircuit":
        "Control circuit wire size, mm² (e.g. '1.5')",
    "techSettings.wireSize.ctSecondary":
        "CT secondary wire size, mm² (e.g. '2.5')",
    "techSettings.wireSize.ptSecondary":
        "PT/VT secondary wire size, mm² (e.g. '1.5')",
    "techSettings.wireSize.plcPowerSupply":
        "PLC power-supply wire size, mm²",
    # ── Wiring — Colour (IEC 60446) ────────────────────────────────────
    "techSettings.wireColor.acPhase":
        "AC phase wire colour (e.g. 'L1 brown / L2 black / L3 grey')",
    "techSettings.wireColor.acNeutral":
        "AC neutral wire colour (IEC default: blue)",
    "techSettings.wireColor.dcPlus":
        "DC + wire colour",
    "techSettings.wireColor.dcMinus":
        "DC − wire colour",
    "techSettings.wireColor.plcInput":
        "PLC input wire colour",
    "techSettings.wireColor.plcOutput":
        "PLC output wire colour",
    "techSettings.wireColor.threePhase":
        "Three-phase wire colour-code system",
    # ── Wiring — Manufacturer ──────────────────────────────────────────
    "techSettings.wireManufacturer.mv":
        "MV wire / cable manufacturer(s)",
    "techSettings.wireManufacturer.lv":
        "LV wire / cable manufacturer(s)",
    # ── Construction / Finishes (RAL paint, dimensions) ────────────────
    "techSettings.others.thicknessOfPainting":
        "Paint coat thickness, µm (typical: 60-100)",
    "techSettings.others.colorType":
        "Paint colour standard (e.g. 'RAL 7032')",
    "techSettings.others.backgroundColor":
        "Background colour for labels",
    "techSettings.others.writingColor":
        "Engraving / lettering colour for labels",
    # ── Main characteristic (IEC 62271-1/-200 nameplate Table 101) ─────
    "techSettings.mainCharacteristic.switchgearType":
        "Switchgear type / construction (e.g. 'Metal-clad air-insulated, "
        "withdrawable, indoor', 'GIS', 'AIS')",
    "techSettings.mainCharacteristic.ratedVoltage":
        "Rated voltage Ur, kV — IEC 62271-1 (highest voltage for equipment "
        "Um, e.g. '7.2 kV' for a 6.6 kV service voltage)",
    "techSettings.mainCharacteristic.ratedPowerFrequencyWithstandVoltage":
        "Rated power-frequency (1-min) withstand voltage Ud, kV rms "
        "(e.g. '28 kV / 1 min' for 7.2 kV)",
    "techSettings.mainCharacteristic.mainBusbarRatedCurrent":
        "Main busbar rated continuous current Ir, A (e.g. '1250', '2000', "
        "'3150', '4000')",
    "techSettings.mainCharacteristic.shortTimeWithstandCurrent":
        "Rated short-time withstand current Icw, kA / duration s "
        "(e.g. '40 kA / 3 s', '31.5 kA / 1 s') — IEC 62271-1",
    "techSettings.mainCharacteristic.lscPartitionClass":
        "LSC category + partition class per IEC 62271-200 (e.g. 'LSC2B-PM')",
    "techSettings.mainCharacteristic.switchboardColor":
        "Switchboard / cubicle paint colour (RAL code, e.g. 'RAL 7035 light grey')",
    "techSettings.mainCharacteristic.connectionInPanel":
        "Cable entry / connection direction (top / bottom / rear; front access)",
    "techSettings.mainCharacteristic.sheetThickness":
        "Enclosure sheet-steel thickness, mm (typical: 2.0 - 2.5)",
    # ── Dimensions (H × W × D, mm) + cubicle count ─────────────────────
    "techSettings.dimension.height":
        "Cubicle height, mm (typical MV: 2100 - 2600)",
    "techSettings.dimension.width":
        "Cubicle width, mm (typical MV: 500 - 1200)",
    "techSettings.dimension.depth":
        "Cubicle depth, mm (typical MV: 1100 - 1800)",
    "techSettings.dimension.numberOfCubicles":
        "Total number of cubicles / panels / cells / bays in the switchboard",
    # ── Type of Entrance (incoming + outgoing panel counts) ────────────
    "techSettings.entrance.incomingPanels":
        "Number / arrangement of incoming panels (e.g. '2 incomers, "
        "top entry')",
    "techSettings.entrance.outgoingPanels":
        "Number / arrangement of outgoing feeders (e.g. '15 outgoing "
        "transformer / motor feeders, bottom entry')",
    # ── Busbar (ABB UniGear / Siemens NXAIR conventions) ───────────────
    "techSettings.busbar.configuration":
        "Busbar configuration (e.g. '3PH', '3PH + N', '3PH + N + PE', "
        "single/double-busbar)",
    "techSettings.busbar.coating":
        "Busbar coating / surface (electrolytic copper bare / tin-plated / "
        "silver-plated; per ABB UniGear)",
    "techSettings.busbar.thermofitCover":
        "Busbar insulation cover (yes/no; heat-shrink / insulating shell)",
    "techSettings.busbar.mainBusbarSize":
        "Main busbar cross-section or per-bar dimensions, mm² or mm×mm "
        "(e.g. '40×10', '60×10', '80×10')",
    "techSettings.busbar.neutralBusbarSize":
        "Neutral busbar size, mm² or mm×mm (LV only; blank for MV ungrounded)",
    "techSettings.busbar.earthBusbarSize":
        "Earth / PE busbar size, mm² or mm×mm (e.g. '30×8', '40×10', "
        "ABB UniGear standard)",
    # ── Auxiliary voltage (Ua, IEC 62271-1 Tables 6/7) ─────────────────
    "techSettings.auxiliaryVoltage.controlProtectionClosingTrippingSignalling":
        "Auxiliary voltage Ua for control / protection / closing coil / "
        "tripping coil / signalling (e.g. '110 V DC')",
    "techSettings.auxiliaryVoltage.springChargingMotor":
        "Auxiliary voltage for the CB spring-charging motor / motor "
        "operating mechanism (e.g. '230 V AC' or '110 V DC')",
    "techSettings.auxiliaryVoltage.panelLightingSpaceHeater":
        "Auxiliary voltage for panel lighting + cubicle anti-condensation "
        "space heater (typically '230 V AC')",
    "techSettings.auxiliaryVoltage.motorSpaceHeater":
        "Auxiliary voltage for motor anti-condensation heaters "
        "(typically '230 V AC')",
}

# The list of (dotted) keys we EXTRACT. Superset of CONFIRMABLE_FIELDS
# plus the nested techSettings / technicalSettings fields the LLM can
# realistically read out of a typical IEC switchgear spec. Order
# matches _FIELD_LABELS for readable prompt rendering.
_EXTRACT_KEYS: List[str] = list(dict.fromkeys([
    # Identity
    "projectName", "projectDescription", "projectNumber", "projectId",
    "client", "planner", "designOffice", "comment",
    # Regional & dates
    "country", "language", "standard",
    "noticeToProceedDate", "deliveryDate",
    # Site
    "location",
    "techSettings.general.designTemperature",
    "techSettings.general.altitudeAboveSeaLevel",
    # Network
    "techSettings.general.nominalVoltage",
    "techSettings.general.ratedFrequency",
    "techSettings.general.shortCircuitCurrent",
    "technicalSettings.mediumVoltage.nominalVoltage",
    "technicalSettings.mediumVoltage.maxShortCircuitPower",
    "technicalSettings.mediumVoltage.minShortCircuitPower",
    "technicalSettings.lowVoltage.nominalVoltage",
    "technicalSettings.lowVoltage.frequency",
    "technicalSettings.lowVoltage.permissibleTouchVoltage",
    "technicalSettings.lowVoltage.ambientTemperature",
    "technicalSettings.lowVoltage.numberOfPoles",
    "technicalSettings.lowVoltage.earthFaultDetection",
    # Compliance / construction
    "techSettings.general.bil",
    "techSettings.general.iacClass",
    "techSettings.general.ipRating",
    "techSettings.general.controlVoltage",
    # Wiring — size
    "techSettings.wireSize.controlCircuit",
    "techSettings.wireSize.ctSecondary",
    "techSettings.wireSize.ptSecondary",
    "techSettings.wireSize.plcPowerSupply",
    # Wiring — colour
    "techSettings.wireColor.acPhase",
    "techSettings.wireColor.acNeutral",
    "techSettings.wireColor.dcPlus",
    "techSettings.wireColor.dcMinus",
    "techSettings.wireColor.plcInput",
    "techSettings.wireColor.plcOutput",
    "techSettings.wireColor.threePhase",
    # Wiring — manufacturer
    "techSettings.wireManufacturer.mv",
    "techSettings.wireManufacturer.lv",
    # Finishes
    "techSettings.others.thicknessOfPainting",
    "techSettings.others.colorType",
    "techSettings.others.backgroundColor",
    "techSettings.others.writingColor",
    # Main characteristic (IEC 62271-1 nameplate)
    "techSettings.mainCharacteristic.switchgearType",
    "techSettings.mainCharacteristic.ratedVoltage",
    "techSettings.mainCharacteristic.ratedPowerFrequencyWithstandVoltage",
    "techSettings.mainCharacteristic.mainBusbarRatedCurrent",
    "techSettings.mainCharacteristic.shortTimeWithstandCurrent",
    "techSettings.mainCharacteristic.lscPartitionClass",
    "techSettings.mainCharacteristic.switchboardColor",
    "techSettings.mainCharacteristic.connectionInPanel",
    "techSettings.mainCharacteristic.sheetThickness",
    # Dimensions
    "techSettings.dimension.height",
    "techSettings.dimension.width",
    "techSettings.dimension.depth",
    "techSettings.dimension.numberOfCubicles",
    # Entrance
    "techSettings.entrance.incomingPanels",
    "techSettings.entrance.outgoingPanels",
    # Busbar
    "techSettings.busbar.configuration",
    "techSettings.busbar.coating",
    "techSettings.busbar.thermofitCover",
    "techSettings.busbar.mainBusbarSize",
    "techSettings.busbar.neutralBusbarSize",
    "techSettings.busbar.earthBusbarSize",
    # Auxiliary voltage (IEC 62271-1 Tables 6/7)
    "techSettings.auxiliaryVoltage.controlProtectionClosingTrippingSignalling",
    "techSettings.auxiliaryVoltage.springChargingMotor",
    "techSettings.auxiliaryVoltage.panelLightingSpaceHeater",
    "techSettings.auxiliaryVoltage.motorSpaceHeater",
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
                     doc_type: str,
                     doc_id: Optional[str] = None) -> Dict[str, FieldValue]:
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
            doc_id=doc_id,
        )
    return out


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------
async def extract_one_document(*, filename: str, doc_type: str,
                               markdown: str,
                               timeout: float = WHOLE_DOC_TIMEOUT,
                               doc_id: Optional[str] = None,
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

    # Phase B: post-extraction validation. Runs the LLM's JSON output
    # through unit-canonicalisers, format-normalisers, allowed-value
    # gates, and plausibility ranges (services/soft_extractor_validators).
    # Failed validators DROP the field (set present=False with reason)
    # rather than silently fix it — so "design temperature 354°C"
    # disappears from the proposal stream entirely instead of being
    # surfaced for the user to approve.
    try:
        from services.soft_extractor_validators import validate_extracted_dict

        def _log_reject(field: str, raw, reason: str) -> None:
            logger.info(
                "soft.whole_doc: validator dropped %s/%s=%r — %s",
                filename, field, raw, reason,
            )

        validated = validate_extracted_dict(pass1 or {}, on_reject=_log_reject)
    except Exception as e:  # noqa: BLE001
        logger.warning(
            "soft.whole_doc: validator pass failed (%s) — using raw LLM output",
            e,
        )
        validated = pass1 or {}

    return _to_field_values(validated, filename, doc_type, doc_id=doc_id)


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
    # Relevance gate — lazy import so a missing module never blocks
    # the legacy code path.
    try:
        from services.soft_doc_relevance import is_spec_document
    except Exception as e:  # noqa: BLE001
        logger.warning("soft.whole_doc: relevance gate unavailable (%s) — "
                       "extracting from EVERY file (legacy behaviour)", e)
        is_spec_document = None  # type: ignore

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

        # === DOCUMENT RELEVANCE GATE ====================================
        # Decide whether THIS file is a switchgear specification before
        # spending tokens extracting from it. Inventory spreadsheets,
        # invoices, POs, drawings — all skipped, so they can't pollute
        # the proposal stream with "country=Iran, frequency=60" etc.
        # On any failure the gate falls back to is_spec=True so a hiccup
        # never blocks a legitimate spec.
        if is_spec_document is not None:
            try:
                rel = await is_spec_document(filename=fn, head=markdown[:1500])
            except Exception as e:  # noqa: BLE001
                logger.warning("soft.whole_doc relevance gate %s: %s — "
                               "proceeding anyway", fn, e)
                rel = None
            if rel is not None and not rel.is_spec:
                logger.info(
                    "soft.whole_doc: SKIP %s — classified as %s "
                    "(conf=%.2f, stage=%s): %s",
                    fn, rel.doc_type, rel.confidence, rel.stage, rel.reason,
                )
                continue
        # ================================================================

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


# ===========================================================================
# Response miner — turn the AGENT'S OWN ANSWER into proposals.
#
# When the user asks "tell me the key parameters" the agent reads the spec
# (deep / vision plan) and replies with a cited, exhaustive list — far richer
# than the background text-only extractor recovers. That answer IS the
# extraction; we mine it directly so every parameter the agent surfaced
# becomes a reviewable proposal (requirement: "extraction must run on the
# result of the response"). Parameters that match a canonical spec field are
# mapped to it; anything else is kept under `parameters.<name>` so nothing
# the agent found is lost (ProjectSpec allows extra keys, and the reconciler
# nests dotted keys, so approved extras still reach simorgh-soft).
# ===========================================================================
_MINE_MIN_CHARS = int(os.getenv("SOFT_MINE_MIN_CHARS", "350"))


def _mine_schema() -> Dict[str, Any]:
    return {
        "type": "object", "additionalProperties": False,
        "required": ["parameters"],
        "properties": {
            "parameters": {
                "type": "array",
                "items": {
                    "type": "object", "additionalProperties": False,
                    "required": ["name", "value"],
                    "properties": {
                        "name":            {"type": "string"},
                        "canonical_field": {"type": ["string", "null"]},
                        "value":           {"type": "string"},
                        "unit":            {"type": ["string", "null"]},
                        "page":            {"type": ["string", "null"]},
                        "section":         {"type": ["string", "null"]},
                        "evidence":        {"type": ["string", "null"]},
                    },
                },
            },
        },
    }


def _slug_param_key(name: str) -> str:
    import re
    s = re.sub(r"[^a-z0-9]+", "_", (name or "").strip().lower()).strip("_")
    return f"parameters.{s or 'value'}"


# Assistant-side roles vary by code path (project_agent stores "assistant",
# the CoT engine stores "agent"); treat them all as the agent's reply.
_ASSISTANT_ROLES = {"assistant", "agent", "ai", "bot"}


def _pick_answer(messages: List[Dict[str, Any]]) -> str:
    """The substantial assistant reply to mine — the longest assistant
    message in the tail, provided it's long enough to be an analysis."""
    asst = [(m.get("content") or "") for m in (messages or [])
            if str(m.get("role") or "").lower() in _ASSISTANT_ROLES]
    asst = [c for c in asst if len(c) >= _MINE_MIN_CHARS]
    if not asst:
        return ""
    return max(asst, key=len)[:WHOLE_DOC_MAX_CHARS]


async def from_assistant_response(messages: List[Dict[str, Any]], *,
                                  doc_id: Optional[str] = None,
                                  timeout: float = WHOLE_DOC_TIMEOUT,
                                  ) -> Dict[str, FieldValue]:
    """Mine the agent's latest analytical answer into FieldValue proposals."""
    answer = _pick_answer(messages)
    if not answer:
        return {}
    allowed = ", ".join(_EXTRACT_KEYS)
    system = (
        "You convert an engineer's written analysis of electrical switchgear "
        "specification documents into STRUCTURED parameters. The analysis "
        "already states each parameter with its value and (often) a page and "
        "section citation. Extract EVERY distinct parameter it states — do not "
        "summarise, do not skip any. For each, return: name (the parameter "
        "label), value, unit (if any), page, section, and a short verbatim "
        "evidence snippet copied from the analysis. If a parameter clearly "
        "corresponds to one of the CANONICAL FIELDS, set canonical_field to "
        "that exact key; otherwise set canonical_field to null."
    )
    user = (
        f"CANONICAL FIELDS (use the exact key when a parameter matches one):\n"
        f"{allowed}\n\n"
        f"ANALYSIS TEXT:\n{answer}\n\n"
        "Return JSON: {\"parameters\": [ {name, canonical_field, value, unit, "
        "page, section, evidence}, ... ] }. Include ALL parameters stated."
    )
    parsed = await _call_gpt_oss(
        [{"role": "system", "content": system},
         {"role": "user", "content": user}],
        _mine_schema(), timeout=timeout,
    )
    if not parsed or not isinstance(parsed, dict):
        return {}

    allowed_set = set(_EXTRACT_KEYS)
    out: Dict[str, FieldValue] = {}
    for item in (parsed.get("parameters") or []):
        if not isinstance(item, dict):
            continue
        name = (item.get("name") or "").strip()
        value = item.get("value")
        if not name or value in (None, "", []):
            continue
        cf = (item.get("canonical_field") or "").strip()
        field = cf if cf in allowed_set else _slug_param_key(name)
        if field in out:        # first mention wins — keep it deduped
            continue
        unit = (item.get("unit") or "").strip()
        val_s = str(value).strip()
        if unit and unit.lower() not in val_s.lower():
            val_s = f"{val_s} {unit}".strip()
        # Build a source note the drawer/Excel/Source-viewer understand:
        #   "from analysis · § <section> · p.<page> · \"<evidence>\""
        parts: List[str] = ["from analysis"]
        sec = (item.get("section") or "").strip()
        page = (item.get("page") or "").strip()
        ev = (item.get("evidence") or "").strip()
        if sec:
            parts.append(f"§ {sec}")
        if page:
            parts.append(f"p.{page}")
        if ev:
            ev_short = ev[:240] + ("…" if len(ev) > 240 else "")
            parts.append(f"\"{ev_short}\"")
        out[field] = FieldValue(
            value=val_s, source="chat",
            confidence=0.8, note=" · ".join(parts),
            # Link to the source PDF so the "Source" button can locate the
            # evidence span and box it (search_for finds it regardless of the
            # stated page). Only set when the caller resolved a single doc.
            doc_id=doc_id,
        )
    logger.info("soft.mine_response: %d parameters from agent answer", len(out))
    # Flat per-parameter keys (same contract as from_uploads) so each
    # parameter is its own reviewable proposal. reconcile() nests the
    # dotted keys when the user approves.
    return out
