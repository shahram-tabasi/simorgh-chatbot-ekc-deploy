"""
soft_tier2_extractor.py — extract Design Suite TIER-2 data (templates,
deviceLibrary, equipments) from a project's uploaded documents and shape
it EXACTLY as simorgh-soft's project schema expects, so it can be PUT
into an existing project via /api/projects/:id.

Tier-1 (identity + techSettings) is handled by soft_extractor* and the
create flow. This module fills the "Create Template" and "Device
Selection" tabs:

  templates:     { LV: [TemplateItem], MV: [...], HV: [...] }
  deviceLibrary: { LV: [DeviceLibraryItem], MV: [...], HV: [...] }
  equipments:    [ Equipment{ ..., devices: [DeviceTableRow] } ]

Schemas mirror simorgh-soft/simorgh-frontend/src/types/project.ts:
  - TemplateItem      : { id, name, type, properties: {}, hierarchy? }
  - DeviceLibraryItem : { id, name, type, properties: {} }
  - Equipment         : { id, name, type, power?, deviceCount?,
                          description?, properties: {}, devices: [] }
  - DeviceTableRow    : { id, rowNumber, templateId, templateName,
                          busSection, feederNo, wiringType, ratingPower,
                          flc, equipmentId, tag?, description?,
                          cableSize?, ... }

Strategy: pull the FULL text of each spec/datasheet/loadlist/SLD doc
from Qdrant, ask the local LLM (guided_json) to identify panels
(equipments), their feeders (devices), and reusable cell types
(templates), then post-process to guarantee valid IDs + cross-links.

Best-effort throughout: any failure yields an empty section rather
than aborting the update.
"""
from __future__ import annotations

import json
import logging
import os
import uuid
from typing import Any, Dict, List, Optional

import httpx

logger = logging.getLogger(__name__)

LLM_GATEWAY_URL = os.getenv("LLM_GATEWAY_URL", "http://llm-gateway:8030")
TIER2_MAX_CHARS = int(os.getenv("SOFT_TIER2_MAX_CHARS", "120000"))
TIER2_TIMEOUT = float(os.getenv("SOFT_TIER2_TIMEOUT_SEC", "180"))
TIER2_MAX_DOCS = int(os.getenv("SOFT_TIER2_MAX_DOCS", "4"))
TIER2_MAX_OUTPUT_TOKENS = int(os.getenv("SOFT_TIER2_MAX_OUTPUT_TOKENS", "4000"))

_VTYPE = ("LV", "MV", "HV")

# guided_json schema — keeps the LLM output byte-valid and on-shape. We
# keep the schema permissive (strings everywhere, optional fields) so a
# partial extraction still parses; post-processing fills required keys.
_SCHEMA: Dict[str, Any] = {
    "type": "object",
    "properties": {
        "equipments": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "type": {"type": "string", "enum": list(_VTYPE)},
                    "power": {"type": "string"},
                    "description": {"type": "string"},
                    "properties": {"type": "object"},
                    "devices": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "templateName": {"type": "string"},
                                "busSection": {"type": "string"},
                                "feederNo": {"type": "string"},
                                "wiringType": {"type": "string"},
                                "ratingPower": {"type": "string"},
                                "flc": {"type": "string"},
                                "tag": {"type": "string"},
                                "description": {"type": "string"},
                                "cableSize": {"type": "string"},
                            },
                            "required": ["feederNo"],
                        },
                    },
                },
                "required": ["name", "type"],
            },
        },
        "templates": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "type": {"type": "string", "enum": list(_VTYPE)},
                    "properties": {"type": "object"},
                },
                "required": ["name", "type"],
            },
        },
        "deviceLibrary": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "type": {"type": "string", "enum": list(_VTYPE)},
                    "properties": {"type": "object"},
                },
                "required": ["name", "type"],
            },
        },
    },
    "required": ["equipments", "templates", "deviceLibrary"],
}

_SYSTEM = (
    "You are an electrical switchgear engineer extracting structured "
    "design data from a specification document. Identify:\n"
    "  • equipments  — the switchboards / panels / MCCs described (each "
    "with its voltage tier LV/MV/HV, rated power/current if stated, and "
    "its list of feeders/outgoing ways as `devices`).\n"
    "  • templates   — reusable feeder/cell TYPES (e.g. 'Motor feeder "
    "22kW', 'Incomer', 'Bus coupler', 'VT cell') with their key "
    "properties.\n"
    "  • deviceLibrary — distinct device/apparatus types named (e.g. "
    "'ABB VD4 vacuum CB 24kV', 'CT 5P20', 'VT 3P') with properties.\n"
    "Rules: extract ONLY what the document states; do not invent ratings. "
    "Leave a field as empty string if unknown. Voltage tier: ≤1kV=LV, "
    "1-36kV=MV, >36kV=HV. Return JSON only."
)


async def _call_llm(messages: List[Dict[str, Any]],
                    timeout: float) -> Optional[Dict[str, Any]]:
    payload = {
        "messages": messages,
        "mode": "offline",
        "force_backend": "text",
        "temperature": 0.0,
        "max_tokens": TIER2_MAX_OUTPUT_TOKENS,
        "extra": {
            "guided_json": _SCHEMA,
            "response_format": {"type": "json_object"},
            "reasoning_effort": "low",
        },
    }
    last_err: Optional[Exception] = None
    body = None
    for attempt in range(3):
        try:
            async with httpx.AsyncClient(timeout=timeout) as c:
                r = await c.post(f"{LLM_GATEWAY_URL}/generate", json=payload)
                if r.status_code in (502, 503, 504):
                    raise httpx.HTTPStatusError(
                        "gateway busy", request=r.request, response=r)
                r.raise_for_status()
                body = r.json()
                break
        except Exception as e:  # noqa: BLE001
            last_err = e
            import asyncio
            await asyncio.sleep(1.5 * (attempt + 1))
    if body is None:
        logger.warning("soft.tier2 gateway failed: %s", last_err)
        return None
    text = (body.get("response") or body.get("text") or "").strip()
    if not text:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        start, end = text.find("{"), text.rfind("}")
        if start != -1 and end != -1 and end > start:
            try:
                return json.loads(text[start:end + 1])
            except json.JSONDecodeError:
                pass
    logger.warning("soft.tier2: LLM output was not valid JSON")
    return None


def _tier(v: Any) -> str:
    s = str(v or "").strip().upper()
    return s if s in _VTYPE else "MV"


def _grouped(items: List[Dict[str, Any]], kind: str) -> Dict[str, List[Dict[str, Any]]]:
    """Shape a flat [{name,type,properties}] list into {LV,MV,HV: [...]}
    with valid ids. `kind` is a short id prefix ('tpl' / 'lib').
    Defensive: skips non-dict items (the LLM occasionally returns a
    list of bare strings, which previously crashed with
    'str' object has no attribute 'get')."""
    out: Dict[str, List[Dict[str, Any]]] = {"LV": [], "MV": [], "HV": []}
    for it in items or []:
        if not isinstance(it, dict):
            continue
        name = str(it.get("name") or "").strip()
        if not name:
            continue
        t = _tier(it.get("type"))
        props = it.get("properties")
        out[t].append({
            "id": f"{kind}-{uuid.uuid4().hex[:8]}",
            "name": name,
            "type": t,
            "properties": props if isinstance(props, dict) else {},
        })
    return out


def _shape_equipments(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for eq in items or []:
        if not isinstance(eq, dict):
            continue
        name = str(eq.get("name") or "").strip()
        if not name:
            continue
        t = _tier(eq.get("type"))
        eq_id = f"eq-{uuid.uuid4().hex[:8]}"
        rows: List[Dict[str, Any]] = []
        for i, d in enumerate(eq.get("devices") or [], start=1):
            if not isinstance(d, dict):
                # tolerate a bare string feeder name
                d = {"feederNo": str(d)} if d else {}
            rows.append({
                "id": f"row-{uuid.uuid4().hex[:8]}",
                "rowNumber": i,
                "templateId": "",
                "templateName": str(d.get("templateName") or ""),
                "busSection": str(d.get("busSection") or ""),
                "feederNo": str(d.get("feederNo") or str(i)),
                "wiringType": str(d.get("wiringType") or ""),
                "ratingPower": str(d.get("ratingPower") or ""),
                "flc": str(d.get("flc") or ""),
                "equipmentId": eq_id,
                "tag": str(d.get("tag") or ""),
                "description": str(d.get("description") or ""),
                "cableSize": str(d.get("cableSize") or ""),
            })
        props = eq.get("properties")
        out.append({
            "id": eq_id,
            "name": name,
            "type": t,
            "power": str(eq.get("power") or ""),
            "deviceCount": len(rows),
            "description": str(eq.get("description") or ""),
            "properties": props if isinstance(props, dict) else {},
            "devices": rows,
        })
    return out


def _merge_grouped(a: Dict[str, List], b: Dict[str, List]) -> Dict[str, List]:
    for t in _VTYPE:
        a.setdefault(t, []).extend(b.get(t, []))
    return a


_SLD_VLM_PROMPT = (
    "You are reading a MEDIUM/LOW-VOLTAGE SINGLE-LINE DIAGRAM (SLD) of "
    "switchgear. Transcribe it into structured Markdown a downstream "
    "model can parse:\n"
    "  1. The BUSBAR / switchboard header line verbatim (e.g. "
    "'04BHV01 3PH 50Hz 20kV 3150A 31.5kA/3s').\n"
    "  2. The FEEDER TABLE as a Markdown table — one row per cubicle/"
    "column, with every column you can read: number, TAG (Incoming/"
    "Outgoing/Bus-tie/Transformer/Spare), LOAD TYPE, Cable/OHL size, "
    "LOAD kW, LOAD NAME/tag.\n"
    "Transcribe codes, tags, cable sizes and ratings VERBATIM. Write "
    "'(blank)' for empty cells. Output ONLY Markdown, no preamble."
)


async def _vlm_transcribe_pages(document_id: str, max_pages: int = 4
                                ) -> str:
    """Render an SLD/drawing PDF's pages to PNG and ask the VLM
    (Qwen2.5-VL on .62) to transcribe each into structured Markdown.
    Returns the concatenated transcription, or "" when no pages render
    (e.g. the raw PDF wasn't stashed). SLDs are usually 1 page; we try
    up to max_pages and stop at the first that fails to render."""
    try:
        from services.vlm_verifier import render_pdf_page, _call_vlm
    except Exception as e:  # noqa: BLE001
        logger.warning("soft.tier2: vlm_verifier unavailable: %s", e)
        return ""
    parts: List[str] = []
    for page in range(1, max_pages + 1):
        try:
            img = render_pdf_page(document_id, page)
        except Exception as e:  # noqa: BLE001
            logger.warning("soft.tier2: render page %d failed: %s", page, e)
            break
        if img is None:
            break
        try:
            md = await _call_vlm(_SLD_VLM_PROMPT, img, timeout=TIER2_TIMEOUT)
        except Exception as e:  # noqa: BLE001
            logger.warning("soft.tier2: VLM page %d failed: %s", page, e)
            continue
        if md and md.strip():
            parts.append(f"--- SLD page {page} ---\n{md.strip()}")
    return "\n\n".join(parts)


def _is_drawing(filename: str, doc_type: str) -> bool:
    fn = (filename or "").lower()
    return (doc_type == "sld"
            or "sld" in fn or "single-line" in fn or "single line" in fn
            or "-el-" in fn or "diagram" in fn or "schematic" in fn)


async def extract_tier2_for_project(
    agent: Any, project_id: str, project_row: Dict[str, Any],
) -> Dict[str, Any]:
    """Walk the project's uploaded documents and extract tier-2 data.
    Returns a dict with any of templates / deviceLibrary / equipments
    that were found (empty/missing keys when nothing was extracted).

    `agent` is the ProjectManagerAgent (for memory.qdrant access);
    `project_row` is the chatbot project memory row."""
    try:
        from services.project_memory_service import get_project_memory_service
        q = getattr(get_project_memory_service(), "qdrant", None)
        if q is None:
            return {}
        scope = str(project_id)
        docs = q.list_documents(user_id="system", project_oenum=scope) or []
    except Exception as e:  # noqa: BLE001
        logger.warning("soft.tier2 list_documents failed: %s", e)
        return {}
    if not docs:
        return {}

    # Rank spec/loadlist/sld docs first — they carry panel/feeder data.
    try:
        from services.soft_extractor import _doc_type_of
    except Exception:  # noqa: BLE001
        _doc_type_of = lambda fn: "other"  # noqa: E731
    rank = {"loadlist": 0, "sld": 0, "spec": 1, "datasheet": 2, "other": 3}
    typed = []
    for d in docs:
        fn = d.get("filename") or ""
        did = d.get("document_id") or ""
        if fn:
            dt = _doc_type_of(fn)
            typed.append((fn, did, dt, rank.get(dt, 9)))
    typed.sort(key=lambda x: x[3])

    equipments: List[Dict[str, Any]] = []
    templates: Dict[str, List] = {"LV": [], "MV": [], "HV": []}
    device_lib: Dict[str, List] = {"LV": [], "MV": [], "HV": []}

    for fn, did, dt, _ in typed[:TIER2_MAX_DOCS]:
        # SLD / drawing → VLM transcription (the PDF text layer of a
        # vector drawing is positional garbage; the VLM on .62 can
        # actually SEE the diagram and transcribe the feeder table).
        # Everything else → the indexed text from Qdrant.
        text = ""
        if _is_drawing(fn, dt) and did:
            logger.info("soft.tier2: %s is a drawing — using VLM", fn)
            text = await _vlm_transcribe_pages(did)
        if not text:
            try:
                res = q.get_document_text(
                    user_id="system", project_oenum=scope,
                    filename=fn, max_chars=TIER2_MAX_CHARS)
                text = (res or {}).get("content") or (res or {}).get("text") or ""
            except Exception as e:  # noqa: BLE001
                logger.warning("soft.tier2 read %s: %s", fn, e)
                continue
        if not text or len(text.strip()) < 80:
            continue
        parsed = await _call_llm(
            [{"role": "system", "content": _SYSTEM},
             {"role": "user", "content":
              f"Document: {fn}\n\n{text}\n\nExtract the JSON now."}],
            timeout=TIER2_TIMEOUT)
        if not parsed:
            continue
        equipments.extend(_shape_equipments(parsed.get("equipments") or []))
        _merge_grouped(templates,
                       _grouped(parsed.get("templates") or [], "tpl"))
        _merge_grouped(device_lib,
                       _grouped(parsed.get("deviceLibrary") or [], "lib"))
        logger.info(
            "soft.tier2 %s: +%d equip, +%d tpl, +%d lib",
            fn, len(parsed.get("equipments") or []),
            sum(len(v) for v in _grouped(parsed.get("templates") or [],
                                         "tpl").values()),
            sum(len(v) for v in _grouped(parsed.get("deviceLibrary") or [],
                                         "lib").values()))

    result: Dict[str, Any] = {}
    if equipments:
        result["equipments"] = equipments
    if any(templates.values()):
        result["templates"] = templates
    if any(device_lib.values()):
        result["deviceLibrary"] = device_lib
    return result
