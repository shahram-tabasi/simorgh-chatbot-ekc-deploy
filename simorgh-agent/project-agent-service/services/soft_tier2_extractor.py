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
    "You are an electrical switchgear engineer. The text below is a "
    "VLM transcription of a single-line diagram (SLD): a FULL-PAGE pass "
    "(carrying the busbar header) plus several overlapping TILE passes "
    "of the feeder table. Build structured JSON:\n"
    "  • equipments — usually ONE switchboard per busbar tag (e.g. "
    "'04BHV01'). Create one equipment object PER DISTINCT BUSBAR, with "
    "EVERY feeder/cubicle as a row in its `devices` array. Do NOT split "
    "one switchboard into several equipments.\n"
    "  • devices (inside each equipment) — one row per feeder: feederNo, "
    "tag, wiringType (Incoming/Outgoing/Bus-tie/Transformer/Spare), "
    "ratingPower (kW), cableSize, description (LOAD NAME).\n"
    "  • templates — reusable feeder/cell TYPES seen (e.g. 'Outgoing "
    "transformer feeder', 'Incomer', 'Bus-tie').\n"
    "  • deviceLibrary — distinct apparatus types named (CB, CT, VT) "
    "with properties.\n"
    "CRITICAL RULES:\n"
    "  - The tiles OVERLAP, so the SAME feeder appears in multiple "
    "tiles. MERGE duplicates: a feeder is identified by its column "
    "number + tag; keep ONE row per real feeder, choosing the most "
    "complete cell values. Do NOT emit a feeder twice.\n"
    "  - Extract ONLY what the transcription states. A cell marked "
    "'(blank)' is UNKNOWN — leave it empty, never invent.\n"
    "  - Do NOT set the voltage tier yourself (a later step stamps it "
    "from the busbar voltage). Return JSON only."
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


# Higher DPI than the verifier default (180) — dense SLD feeder-table
# cell text is 2-3 mm and illegible below ~300 DPI after the VLM's
# internal resize (research: render so each glyph is ≥20 px tall).
TIER2_SLD_DPI = int(os.getenv("SOFT_TIER2_SLD_DPI", "400"))

_SLD_VLM_PROMPT = (
    "You are reading a MEDIUM/LOW-VOLTAGE SWITCHGEAR SINGLE-LINE "
    "DIAGRAM (SLD). Transcribe EXACTLY what is drawn — never invent or "
    "guess a value. Procedure:\n"
    "STEP 1 — BUSBAR HEADER: find the busbar/switchboard label line and "
    "transcribe it VERBATIM (e.g. '04BHV01 3PH 50Hz 20kV 3150A "
    "31.5kA/3s'). The voltage there (e.g. 20kV) sets the WHOLE board's "
    "class.\n"
    "STEP 2 — COUNT: count the feeder/cubicle columns in the bottom "
    "table. State the integer count.\n"
    "STEP 3 — FEEDER TABLE: output a Markdown table with EXACTLY that "
    "many rows, left-to-right, columns: Number | TAG (Incoming/"
    "Outgoing/Bus-tie/Transformer/Spare) | LOAD TYPE | Cable/OHL | "
    "LOAD kW | LOAD NAME. For ANY cell you cannot read clearly, write "
    "the literal '(blank)' — do NOT guess. Transcribe codes, tags, "
    "cable sizes and ratings character-for-character.\n"
    "Output ONLY: the busbar header line, the count, then the Markdown "
    "table. No commentary."
)

# Busbar voltage → board tier. Deterministic; eliminates the VLM
# misclassifying a 20 kV (MV) board as LV/HV. We must read the RATED
# voltage off the BUSBAR HEADER line specifically — NOT max() of every
# kV in the transcription, because an insulation/BIL/impulse rating
# (e.g. "125 kV peak") elsewhere on the drawing would dominate and
# push a 20 kV board to HV (observed bug: tier=HV on a 20 kV board).
_KV_RE = __import__("re").compile(
    r"(\d+(?:\.\d+)?)\s*k\s*v", __import__("re").IGNORECASE)
_AMP_RE = __import__("re").compile(
    r"\d+(?:\.\d+)?\s*a\b", __import__("re").IGNORECASE)


def _kv_to_tier(kv: float) -> str:
    if kv <= 1.0:
        return "LV"
    if kv <= 36.0:
        return "MV"
    return "HV"


def _tier_from_text(text: str) -> Optional[str]:
    """Determine board tier from the BUSBAR HEADER's rated voltage.

    A busbar header line carries voltage + current + freq/short-circuit
    together (e.g. '04BHV01 3PH 50Hz 20kV 3150A 31.5kA/3s'). We find the
    line that has a kV AND an ampere/kA/Hz token and read the kV from
    THERE — that's the rated voltage, not a BIL/impulse number. Falls
    back to the SMALLEST kV anywhere (rated voltage is always below the
    insulation levels) only if no header-shaped line is found."""
    if not text:
        return None
    # Pass 1: busbar-header-shaped line.
    for line in text.splitlines():
        low = line.lower()
        has_kv = "kv" in low
        has_rating = ("hz" in low or "ka" in low
                      or bool(_AMP_RE.search(low)))
        if has_kv and has_rating:
            m = _KV_RE.search(line)
            if m:
                try:
                    return _kv_to_tier(float(m.group(1)))
                except ValueError:
                    pass
    # Pass 2 fallback: the rated voltage is the LOWEST kV on the sheet
    # (insulation/impulse levels are always higher), so min() is far
    # safer than max() for avoiding the BIL-dominates bug.
    kvs = []
    for m in _KV_RE.finditer(text):
        try:
            kvs.append(float(m.group(1)))
        except ValueError:
            continue
    if not kvs:
        return None
    return _kv_to_tier(min(kvs))


TIER2_TILES = int(os.getenv("SOFT_TIER2_TILES", "3"))
TIER2_TILE_OVERLAP = float(os.getenv("SOFT_TIER2_TILE_OVERLAP", "0.2"))

_TILE_VLM_PROMPT = (
    "This is a HORIZONTAL SLICE of a switchgear single-line diagram's "
    "feeder table — it shows only SOME of the feeder/cubicle columns. "
    "Transcribe ONLY the feeder columns clearly visible in THIS slice as "
    "a Markdown table: Number | TAG (Incoming/Outgoing/Bus-tie/"
    "Transformer/Spare) | LOAD TYPE | Cable/OHL | LOAD kW | LOAD NAME. "
    "Transcribe tags, cable sizes and ratings VERBATIM. Write '(blank)' "
    "for any cell you cannot read clearly — NEVER guess. Skip columns "
    "that are cut off at the slice edge. Output ONLY the Markdown table."
)


def _png_to_tiles(png_bytes: bytes, n_tiles: int,
                  overlap_frac: float) -> List[bytes]:
    """Split a wide SLD page PNG into `n_tiles` overlapping VERTICAL
    slices (full height, partial width) so the VLM sees each ~9-column
    band of the feeder table at high effective resolution. Overlap
    (~20%) guarantees boundary feeders appear in two tiles for dedup.
    Returns [] on any PIL failure (caller falls back to full page)."""
    try:
        import io
        from PIL import Image
        img = Image.open(io.BytesIO(png_bytes)).convert("RGB")
        W, H = img.size
        if W <= 0 or n_tiles < 1:
            return []
        step = W / n_tiles
        ov = int(step * max(0.0, overlap_frac))
        tiles: List[bytes] = []
        for i in range(n_tiles):
            x0 = max(0, int(i * step) - ov)
            x1 = min(W, int((i + 1) * step) + ov)
            crop = img.crop((x0, 0, x1, H))
            buf = io.BytesIO()
            crop.save(buf, format="PNG")
            tiles.append(buf.getvalue())
        return tiles
    except Exception as e:  # noqa: BLE001
        logger.warning("soft.tier2: tiling failed: %s", e)
        return []


async def _vlm_transcribe_pages(document_id: str, max_pages: int = 6
                                ) -> str:
    """Render each SLD page at high DPI, then transcribe via the VLM
    using a FULL-PAGE pass (for the busbar header + identity) PLUS
    overlapping VERTICAL TILES of the feeder table (so the dense
    27-column row is read at real resolution instead of being crushed
    into the VLM's max_pixels). All VLM calls for a page run
    concurrently to keep wall-time near one call. The combined
    transcription is handed to the extraction LLM, which merges +
    dedups feeders across the overlapping tiles. Multi-sheet SLDs:
    every renderable page is read and tagged with its sheet number."""
    import asyncio
    try:
        from services.vlm_verifier import render_pdf_page, _call_vlm
    except Exception as e:  # noqa: BLE001
        logger.warning("soft.tier2: vlm_verifier unavailable: %s", e)
        return ""
    parts: List[str] = []
    for page in range(1, max_pages + 1):
        try:
            png = render_pdf_page(document_id, page, dpi=TIER2_SLD_DPI)
        except Exception as e:  # noqa: BLE001
            logger.warning("soft.tier2: render page %d failed: %s", page, e)
            break
        if png is None:
            break

        # Full page (busbar header) + N feeder-table tiles.
        jobs = [_call_vlm(_SLD_VLM_PROMPT, png, timeout=TIER2_TIMEOUT)]
        tiles = _png_to_tiles(png, TIER2_TILES, TIER2_TILE_OVERLAP)
        for t in tiles:
            jobs.append(_call_vlm(_TILE_VLM_PROMPT, t, timeout=TIER2_TIMEOUT))
        try:
            results = await asyncio.gather(*jobs, return_exceptions=True)
        except Exception as e:  # noqa: BLE001
            logger.warning("soft.tier2: VLM gather page %d failed: %s",
                           page, e)
            continue

        page_parts: List[str] = []
        for idx, res in enumerate(results):
            if isinstance(res, Exception) or not res:
                continue
            label = "full page" if idx == 0 else f"tile {idx}"
            page_parts.append(f"[{label}]\n{str(res).strip()}")
        if page_parts:
            parts.append(
                f"--- SLD sheet {page} ---\n" + "\n\n".join(page_parts))
            logger.info("soft.tier2: sheet %d transcribed "
                        "(%d/%d VLM passes ok)",
                        page, len(page_parts), len(jobs))
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
    # Dedup by filename: the user often re-uploads the same SLD across
    # attempts; each is a distinct document_id with the SAME filename.
    # Processing all copies triples the equipment count (observed: 12 =
    # 4×3 for one 4-equipment SLD). Keep ONE document_id per filename —
    # the LAST one wins (most recent upload).
    by_name: Dict[str, str] = {}
    for d in docs:
        fn = d.get("filename") or ""
        did = d.get("document_id") or ""
        if fn and did:
            by_name[fn] = did  # later entries overwrite → last upload
    typed = []
    for fn, did in by_name.items():
        dt = _doc_type_of(fn)
        typed.append((fn, did, dt, rank.get(dt, 9)))
    typed.sort(key=lambda x: x[3])

    equipments: List[Dict[str, Any]] = []
    templates: Dict[str, List] = {"LV": [], "MV": [], "HV": []}
    device_lib: Dict[str, List] = {"LV": [], "MV": [], "HV": []}

    for fn, did, dt, _ in typed[:TIER2_MAX_DOCS]:
        is_drawing = _is_drawing(fn, dt)
        # Only DRAWINGS (SLD) and LOAD LISTS / panel schedules enumerate
        # panels + feeders. A prose specification ("the CTs shall be
        # 5P20…") does NOT — asking the LLM to pull equipments/devices
        # from it just invents generic panels (observed: the 6.6kV spec
        # PDF produced 4 fabricated equipments). Skip everything that
        # isn't a drawing or a load list so tier-2 never hallucinates
        # equipment from requirements prose.
        if not (is_drawing or dt in ("loadlist", "panelschedule")):
            logger.info(
                "soft.tier2: skipping %s (doc_type=%s) — not a drawing or "
                "load list; tier-2 data lives in SLDs / schedules only",
                fn, dt)
            continue
        # SLD / drawing → VLM transcription (the PDF text layer of a
        # vector drawing is positional garbage; the VLM on .62 can
        # actually SEE the diagram and transcribe the feeder table).
        # Everything else → the indexed text from Qdrant.
        text = ""
        if is_drawing and did:
            logger.info("soft.tier2: %s is a drawing — using VLM", fn)
            text = await _vlm_transcribe_pages(did)
            if not text:
                # CRITICAL: do NOT fall back to the PDF text layer for a
                # drawing — it's positional garbage and the LLM will
                # HALLUCINATE feeders/ratings from it (observed: an MV
                # 20kV board extracted as LV with wrong feeder numbers
                # because poppler was missing and the VLM never ran).
                # Skip the doc and let the caller report that the SLD
                # couldn't be read so the user can fix the input.
                logger.warning(
                    "soft.tier2: VLM produced no text for drawing %s — "
                    "SKIPPING (will not extract from garbage text layer)",
                    fn)
                continue
        else:
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
        doc_equip = _shape_equipments(parsed.get("equipments") or [])
        # MV/LV GROUNDING: derive the board tier from the busbar voltage
        # in the (VLM-transcribed) text and STAMP it on every equipment +
        # its devices. The busbar rating is authoritative; per-equipment
        # VLM/LLM tier guesses are not (a 20 kV board kept coming back as
        # LV). Deterministic regex, not model judgement.
        board_tier = _tier_from_text(text)
        if board_tier:
            for eq in doc_equip:
                eq["type"] = board_tier
            logger.info("soft.tier2 %s: busbar tier=%s stamped on %d equip",
                        fn, board_tier, len(doc_equip))
        equipments.extend(doc_equip)
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
