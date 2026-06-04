"""
soft_extractor.py — parallel extractors that propose Design Suite project
fields from every source the chatbot has access to.

Each extractor returns Dict[field_name, FieldValue]. The reconciler merges
them into a single ProjectSpec + a FieldProvenance map. None of the
extractors blocks on failure — if a source is unavailable, it just
returns {}, and the reconciler fills the field from a lower-priority
source (or applies the default).

v1 implements: TPMS (high-signal for OE/client/name), chat history (LLM
extractor for free-text intent), uploads (semantic search + LLM
extraction). gitlab + techserver stubs return {} for now.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from typing import Any, Dict, List, Optional

import httpx

from services.soft_spec import FieldValue

logger = logging.getLogger(__name__)

TPMS_FETCHER_URL = os.getenv("TPMS_FETCHER_URL", "http://tpms-fetcher:8021")
LLM_GATEWAY_URL = os.getenv("LLM_GATEWAY_URL", "http://llm-gateway:8030")


# ---------------------------------------------------------------------------
# TPMS extractor — maps View_Project_Main + technical_project_identity_ to
# ProjectSpec fields. The mapping is precise and high-confidence because
# every value comes from a typed DB column.
# ---------------------------------------------------------------------------
async def from_tpms(oenum: Optional[str], timeout: float = 20.0
                    ) -> Dict[str, FieldValue]:
    """Tier 1 + Tier 2 extraction from TPMS.

    Tier 1 (project-level fields):
      * View_Project_Main → projectNumber, projectName, projectDescription,
        noticeToProceedDate
      * technical_project_identity_ → deliveryDate, projectDescription
        (Persian name), techSettings.general (altitude, design temperature),
        techSettings.wireManufacturer (lv/mv brand), client (from
        Project_Group when present)

    Tier 2 (design data):
      * technical_panel_identity → equipments[] (one Equipment per panel,
        type computed from rated_voltage, properties carrying voltage /
        busbar / IP / cell count etc.)
      * View_draft → DeviceTableRow[] inside each panel's equipment, joined
        by Tablo_ID == IDProjectScope.

    The whole call is best-effort: if the fetcher 502s or the JSON shape
    is unexpected, we return whatever did succeed.
    """
    if not oenum:
        return {}
    try:
        async with httpx.AsyncClient(timeout=timeout) as c:
            r = await c.get(f"{TPMS_FETCHER_URL}/project/{oenum}")
            if r.status_code != 200:
                r = await c.post(f"{TPMS_FETCHER_URL}/fetch/{oenum}")
            r.raise_for_status()
            data = r.json()
    except Exception as e:
        logger.warning("soft.extract.tpms failed for %s: %s", oenum, e)
        return {}

    proj = data.get("project") or {}
    pid = data.get("project_identity") or {}
    panels = data.get("panels") or []
    feeders = data.get("feeders") or []
    out: Dict[str, FieldValue] = {}
    note = f"from TPMS OENUM {oenum}"

    def put(field: str, value: Any, conf: float = 0.9):
        if value not in (None, "", 0):
            out[field] = FieldValue(value=str(value), source="tpms",
                                    confidence=conf, note=note)

    # ---- Tier 1: identity ----
    put("projectNumber", proj.get("oenum"), 0.95)
    put("projectName", proj.get("project_name"))
    put("projectDescription",
        proj.get("project_name_fa") or proj.get("project_name"), 0.8)
    put("noticeToProceedDate", proj.get("oe_date"), 0.7)

    # ---- Tier 1: project_identity → techSettings ----
    if pid.get("Delivery_Date"):
        put("deliveryDate", pid["Delivery_Date"], 0.7)
    if pid.get("Project_Group"):
        put("client", pid["Project_Group"], 0.6)
    # nested techSettings.general
    gen: Dict[str, Any] = {}
    if pid.get("Above_Sea_Level"):
        gen["altitudeAboveSeaLevel"] = _digits(pid["Above_Sea_Level"])
    if pid.get("Average_Temperature"):
        gen["designTemperature"] = _digits(pid["Average_Temperature"])
    if gen:
        out["techSettings.general"] = FieldValue(
            value=gen, source="tpms", confidence=0.8, note=note)
    # wire brands
    wm: Dict[str, str] = {}
    if pid.get("Wire_Brand"):
        wm["mv"] = str(pid["Wire_Brand"])
    if pid.get("Control_Wire_Brand"):
        wm["lv"] = str(pid["Control_Wire_Brand"])
    if wm:
        out["techSettings.wireManufacturer"] = FieldValue(
            value=wm, source="tpms", confidence=0.8, note=note)

    # ---- Tier 2: panels → equipments[], feeders → devices per panel ----
    from services.soft_spec import (Equipment, DeviceTableRow, classify_voltage)
    if panels:
        feeders_by_tablo: Dict[Any, List[Dict[str, Any]]] = {}
        for f in feeders:
            feeders_by_tablo.setdefault(f.get("tablo_id"), []).append(f)

        equipments: List[Equipment] = []
        for p in panels:
            scope = p.get("id_project_scope")
            vtype = classify_voltage(p.get("rated_voltage")
                                     or p.get("voltage_rate"))
            eq_id = f"tpms-panel-{scope or p.get('id') or len(equipments)}"
            rows: List[DeviceTableRow] = []
            for idx, f in enumerate(feeders_by_tablo.get(scope, []), start=1):
                rows.append(DeviceTableRow(
                    id=f"tpms-feeder-{f.get('id') or idx}",
                    rowNumber=idx,
                    templateId="",
                    templateName=f.get("template_name") or "",
                    busSection=f.get("bus_section") or "",
                    feederNo=f.get("feeder_no") or "",
                    wiringType=f.get("wiring_type") or "",
                    ratingPower=f.get("rating_power") or "",
                    flc=f.get("flc") or "",
                    equipmentId=eq_id,
                    tag=f.get("tag") or "",
                    description=f.get("designation") or "",
                    cableSize=f.get("cable_size") or "",
                    sfdHfd=f.get("sfd_hfd") or "",
                    moduleNo=f.get("module") or "",
                    size=f.get("size") or "",
                ))
            equipments.append(Equipment(
                id=eq_id,
                name=(p.get("plane_name") or p.get("scope_name")
                      or f"Panel {scope}"),
                type=vtype,
                power=(p.get("switch_amperage") or ""),
                deviceCount=len(rows),
                description=(p.get("product_type") or p.get("plane_type") or ""),
                properties={
                    "voltageRate":      p.get("voltage_rate") or "",
                    "ratedVoltage":     p.get("rated_voltage") or "",
                    "switchAmperage":   p.get("switch_amperage") or "",
                    "kabus":            p.get("kabus") or "",
                    "abus":             p.get("abus") or "",
                    "mainBusbarSize":   p.get("main_busbar_size") or "",
                    "earthBusbarSize":  p.get("earth_size") or "",
                    "neutralBusbarSize":p.get("neutral_size") or "",
                    "ip":               p.get("ip_rating") or "",
                    "cellCount":        p.get("cell_count") or "",
                    "frequency":        p.get("frequency") or "",
                    "tpmsPanelId":      scope,
                },
                devices=rows,
            ))
        # FieldValue.value carries a list of dicts (pydantic serialises
        # Equipment instances when we model_dump at the reconcile step).
        out["equipments"] = FieldValue(
            value=[e.model_dump() for e in equipments],
            source="tpms", confidence=0.9,
            note=f"{len(equipments)} panels, {sum(e.deviceCount for e in equipments)} feeders from TPMS")
    return out


def _digits(s: Any) -> str:
    """Strip non-numeric junk so '1800m' / '45 °C' become '1800' / '45'.
    Returns the original string if nothing numeric is found."""
    import re
    m = re.search(r"[0-9]+(?:\.[0-9]+)?", str(s or ""))
    return m.group(0) if m else str(s or "")


# ---------------------------------------------------------------------------
# Chat-history extractor — runs a small LLM extraction over the last N
# messages to lift free-text mentions (project name, location, client,
# dates the user typed in chat).
# ---------------------------------------------------------------------------
_EXTRACT_SCHEMA_PROMPT = """You extract Simorgh Design Suite project
fields from the input below. Return JSON ONLY containing the keys you
actually saw values for — OMIT keys you didn't see. Do NOT invent.

Top-level fields (use exact keys):
- projectName            human name of the project (often after "called", in a title block)
- projectDescription     1-3 sentence scope/description
- client                 customer organisation name (often top of cover sheet)
- location               site / city / country (only the site name; country goes in `country`)
- country                country name if explicit
- projectNumber          OE / order / project number (string)
- projectId              PID / internal id if present
- standard               IEC | ANSI | GOST (only if explicit)
- language               document language
- noticeToProceedDate    ISO 8601 if a contract / NTP date is given
- deliveryDate           ISO 8601 if a delivery / completion date is given
- planner                planner / engineering firm if explicit
- designOffice           design office if explicit
- comment                any extra free-form note worth keeping

Nested techSettings (use these DOTTED keys — flat at the top level):
- techSettings.general.altitudeAboveSeaLevel   number in meters (string)
- techSettings.general.designTemperature       number in °C (string)
- techSettings.wireManufacturer.lv             LV control-wire brand
- techSettings.wireManufacturer.mv             MV power-wire brand

Nested technicalSettings (also dotted keys):
- technicalSettings.mediumVoltage.nominalVoltage    e.g. "20" (kV)
- technicalSettings.mediumVoltage.maxShortCircuitPower  MVA (string)
- technicalSettings.lowVoltage.nominalVoltage       e.g. "400" (V)
- technicalSettings.lowVoltage.frequency            e.g. "50" (Hz)
- technicalSettings.lowVoltage.ambientTemperature   °C

Output JUST the JSON object, no prose.

Input:
{transcript}
"""

# Keys whose values are full sub-dicts in our ProjectSpec; the dotted
# prompt keys are reshaped into a single FieldValue carrying that dict.
_NESTED_GROUPS = {
    "techSettings.general":               "techSettings.general",
    "techSettings.wireManufacturer":      "techSettings.wireManufacturer",
    "technicalSettings.mediumVoltage":    "technicalSettings.mediumVoltage",
    "technicalSettings.lowVoltage":       "technicalSettings.lowVoltage",
}


async def _extract_via_llm(transcript: str, *, source: str, confidence: float,
                           note: str, timeout: float = 30.0
                           ) -> Dict[str, FieldValue]:
    """One LLM call → robustly parsed Dict[field, FieldValue]. Used by
    chat-history, uploads, techserver, SLD extractors so they share one
    prompt + one parser. Retries 5xx with backoff because llm-gateway
    routinely 502s under bursts (observed during gather)."""
    if not transcript or len(transcript) < 30:
        return {}
    payload = {
        "messages": [
            {"role": "system", "content": "You are a precise data extractor."},
            {"role": "user", "content":
                _EXTRACT_SCHEMA_PROMPT.format(transcript=transcript[:24000])},
        ],
        "mode": "online",
        "temperature": 0.0,
        "max_tokens": 900,
    }
    body = None
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
    if body is None:
        logger.warning("soft.extract.llm (%s) failed after retries: %s",
                       source, last_err)
        return {}
    text = (body.get("response") or body.get("text") or "").strip()
    flat = _parse_extracted_json(text, source=source,
                                 confidence=confidence, note=note)
    return _reshape_dotted(flat)


def _reshape_dotted(flat: Dict[str, FieldValue]) -> Dict[str, FieldValue]:
    """Collapse 'techSettings.general.altitudeAboveSeaLevel' style keys
    into one FieldValue per group whose value is a sub-dict. Lets the
    reconciler treat techSettings.general atomically (so the form can show
    one provenance pill per group instead of per-leaf)."""
    out: Dict[str, FieldValue] = {}
    grouped: Dict[str, Dict[str, Any]] = {}
    meta: Dict[str, FieldValue] = {}
    for k, fv in flat.items():
        if "." in k:
            head, leaf = k.rsplit(".", 1)
            # Only group keys that match one of our known nested heads.
            for g in _NESTED_GROUPS:
                if head == g:
                    grouped.setdefault(g, {})[leaf] = fv.value
                    meta[g] = fv  # keep one example for source/conf/note
                    break
            else:
                out[k] = fv
        else:
            out[k] = fv
    for g, val in grouped.items():
        ex = meta[g]
        out[g] = FieldValue(value=val, source=ex.source,
                            confidence=ex.confidence, note=ex.note)
    return out


async def from_chat_history(messages: List[Dict[str, Any]], timeout: float = 30.0
                            ) -> Dict[str, FieldValue]:
    if not messages:
        return {}
    transcript = "\n".join(
        f"{(m.get('role') or '?')}: {(m.get('content') or '')[:600]}"
        for m in messages[-12:]
    )
    return await _extract_via_llm(transcript, source="chat", confidence=0.7,
                                  note="from chat history", timeout=timeout)


# ---------------------------------------------------------------------------
# Uploads extractor — same LLM lift over the documents already pre-loaded
# into the chat's vector store. Picks up names/clients/dates embedded in
# uploaded specs / inventory lists.
# ---------------------------------------------------------------------------
_TITLE_BLOCK_PREFIX_CHARS = 1500


_TYPE_GUIDANCE = {
    "spec": (
        "This file is a TECHNICAL SPECIFICATION. The title block usually "
        "names the END CLIENT (top-of-cover-sheet), the PROJECT or PLANT, "
        "and the document number. Pull these fields:\n"
        "  - client                = client/owner organisation\n"
        "  - projectName           = plant/project name from the header\n"
        "  - projectDescription    = the subject line / document title\n"
        "  - projectNumber         = doc number containing 'ETS' or the OE/order\n"
        "  - standard              = IEC / ANSI / GOST if cited\n"
        "  - technicalSettings.mediumVoltage.nominalVoltage  = MV nominal (e.g. '6.6')\n"
        "  - technicalSettings.lowVoltage.frequency          = Hz if stated\n"
        "  - techSettings.general.altitudeAboveSeaLevel      = if site-conditions table appears\n"
        "  - techSettings.general.designTemperature          = same\n\n"
        "FEW-SHOT EXAMPLES (study these — the real cover sheets look like this):\n\n"
        "Example 1 — title block reads:\n"
        "    Mobarakeh Steel Company\n"
        "    HOT STRIP MILL #2\n"
        "    DOCUMENT TITLE: Technical Specification for 6.6KV Switchgears\n"
        "    DOCUMENT No. 347180ETS802   Rev. A\n"
        "→ correct output:\n"
        "  {\"client\": \"Mobarakeh Steel Company\",\n"
        "   \"projectName\": \"Hot Strip Mill #2 — 6.6 kV Switchgears\",\n"
        "   \"projectDescription\": \"Technical Specification for 6.6 kV Switchgears\",\n"
        "   \"projectNumber\": \"347180ETS802\",\n"
        "   \"technicalSettings.mediumVoltage.nominalVoltage\": \"6.6\"}\n\n"
        "Example 2 — title block reads:\n"
        "    Chahfiroozeh copper concentration plant\n"
        "    Doc. Title: Data Sheet for MV PANEL\n"
        "    G26S1  ME  DD  EL  DSH  W11  AA  99  006   REV.:03\n"
        "→ correct output:\n"
        "  {\"client\": \"Chahfiroozeh\",\n"
        "   \"projectName\": \"Chahfiroozeh copper concentration plant — MV Panel\",\n"
        "   \"projectDescription\": \"Data Sheet for MV PANEL (20 & 6.6 kV)\",\n"
        "   \"projectNumber\": \"G26S1MEDDELDSHW11AA99006\",\n"
        "   \"technicalSettings.mediumVoltage.nominalVoltage\": \"20\"}"
    ),
    "datasheet": (
        "This file is an EQUIPMENT DATA SHEET (likely MV/LV PANEL). The "
        "title block carries: PROJECT TITLE (e.g. 'Chahfiroozeh copper "
        "concentration plant'), an equipment doc code (e.g. "
        "'G26S1MEDDELDSHW11AA99006'). Extract:\n"
        "  - projectName / client = the plant / project named in the title\n"
        "  - projectNumber = the doc code\n"
        "  - technicalSettings.mediumVoltage.nominalVoltage (kV) if shown\n"
        "  - standard = IEC / ANSI if cited\n"
        "  - planner / designOffice = the 'Doc Originator' or supplier"
    ),
    "sld": (
        "This file is a SINGLE LINE DIAGRAM (mostly graphical). The title "
        "block usually has a small text block with project + doc code. "
        "Extract project / client / standard ONLY if clearly visible — do "
        "NOT invent. The detailed equipment list will come from the SLD "
        "vision pipeline separately."
    ),
    "loadlist": (
        "This file is a LOAD LIST or BOM (Excel/markdown table). The header "
        "rows often carry the project/client. Extract those header values; "
        "the per-row equipment will come from the load-list pipeline "
        "separately."
    ),
    "other": (
        "Extract any of the simorgh-soft top-level fields you see; otherwise "
        "return {}."
    ),
}


def _typed_prompt(doc_type: str, transcript: str) -> str:
    return (f"{_EXTRACT_SCHEMA_PROMPT.split('Input:')[0]}"
            f"DOCUMENT TYPE: {doc_type}\n"
            f"DOCUMENT-TYPE GUIDANCE:\n{_TYPE_GUIDANCE.get(doc_type, _TYPE_GUIDANCE['other'])}\n\n"
            f"Input:\n{transcript}\n")


async def _extract_via_llm_typed(transcript: str, *, doc_type: str,
                                 source: str, confidence: float, note: str,
                                 timeout: float = 30.0
                                 ) -> Dict[str, FieldValue]:
    """Same as _extract_via_llm but with per-document-type guidance prepended
    so the LLM looks for the right title-block fields per type."""
    if not transcript or len(transcript) < 30:
        return {}
    payload = {
        "messages": [
            {"role": "system",
             "content": "You are a precise data extractor for engineering documents."},
            {"role": "user", "content": _typed_prompt(doc_type, transcript[:24000])},
        ],
        "mode": "online", "temperature": 0.0, "max_tokens": 900,
    }
    body = None
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
    if body is None:
        logger.warning("soft.extract.llm_typed (%s/%s) failed after retries: %s",
                       source, doc_type, last_err)
        return {}
    text = (body.get("response") or body.get("text") or "").strip()
    flat = _parse_extracted_json(text, source=source,
                                 confidence=confidence, note=note)
    return _reshape_dotted(flat)


async def from_uploads(project_id: str, project_oenum: str,
                       timeout: float = 60.0) -> Dict[str, FieldValue]:
    """Tier 1 extraction over uploaded client documents.

    Per-file, doc-type-aware: filename pattern (ETS/DSH/SLD/LDL/etc.) picks
    a type-specific prompt that knows the title-block conventions in real
    Electro Kavir / MSC engineering packages. ALWAYS includes the first
    1.5k chars of every document (the title block + cover sheet, where the
    project/client/doc-number always live) plus extra body context up to
    PER_DOC. Specs get a bigger body budget than datasheets / SLDs.

    When SOFT_WHOLE_DOC=1 (default), the LLM stage is replaced with a
    schema-driven whole-document extractor against the local gpt-oss-20b
    + vLLM `guided_json`. The regex pass still runs as a cheap pre-fill,
    but the LLM now sees the FULL markdown (not a 16K-char window) and
    runs a second verification pass over the gaps — the old path
    silently truncated 95% of a 27-page spec."""
    try:
        from services.project_memory_service import get_project_memory_service
        q = getattr(get_project_memory_service(), "qdrant", None)
        if q is None:
            return {}
        scope = str(project_id)
        docs = q.list_documents(user_id="system", project_oenum=scope) or []
    except Exception as e:
        logger.warning("soft.extract.uploads list failed: %s", e)
        return {}
    if not docs:
        return {}

    use_whole_doc = os.getenv("SOFT_WHOLE_DOC", "1").lower() in ("1", "true", "yes", "on")

    PER_TYPE_BUDGET = {
        "spec": 16000, "datasheet": 10000, "sld": 4000,
        "loadlist": 8000, "other": 8000,
    }
    MAX_DOCS = 6
    bag: Dict[str, FieldValue] = {}
    for d in docs[:MAX_DOCS]:
        fn = d.get("filename") or ""
        if not fn:
            continue
        dt = _doc_type_of(fn)
        budget = PER_TYPE_BUDGET.get(dt, 8000)
        try:
            txt = (q.get_document_text(user_id="system", project_oenum=scope,
                                       filename=fn, max_chars=budget)
                   or {}).get("text") or ""
        except Exception as e:
            logger.warning("soft.extract.uploads read %s: %s", fn, e)
            continue
        if not txt:
            continue
        # Title-block bias: prepend the FIRST 1.5k chars (cover sheet,
        # where client / project / doc-number always live) so even when
        # the body budget gets trimmed by the LLM, the header is in view.
        head = txt[:_TITLE_BLOCK_PREFIX_CHARS]

        # 1. REGEX FIRST. Deterministic title-block extractor — runs in
        #    milliseconds, no gateway dependency, anchors on doc-code +
        #    DOCUMENT No / TITLE / REV / kV / Hz / IEC patterns common to
        #    real client packages. Lifts completeness even when llm-gateway
        #    is busy (the LLM-only path returned 0 on gateway 502s).
        try:
            for k, fv in extract_via_regex(fn, txt, dt).items():
                if k not in bag:
                    bag[k] = fv
        except Exception as e:
            logger.warning("soft.extract.regex %s: %s", fn, e)

        # 2. LLM SECOND. The legacy path used a type-aware prompt over a
        #    16K-char transcript window, which silently dropped pages 3+
        #    of any 27-page spec. When SOFT_WHOLE_DOC=1 we delegate to
        #    soft_extractor_whole_doc.extract_one_document, which sees
        #    the FULL markdown, uses vLLM guided_json for schema-tight
        #    output, and runs a verification pass over null/low-conf
        #    fields. Best-effort: gateway failures still don't block
        #    the regex contribution.
        if use_whole_doc:
            try:
                from services.soft_extractor_whole_doc import extract_one_document
                # Whole-doc path needs the un-truncated text — refetch
                # with a generous cap. The per-file budget above is for
                # the legacy LLM stage only.
                wd = q.get_document_text(
                    user_id="system", project_oenum=scope,
                    filename=fn, max_chars=200_000,
                )
                full_md = (wd or {}).get("text") or txt
                got = await extract_one_document(
                    filename=fn, doc_type=dt,
                    markdown=full_md, timeout=timeout,
                )
            except Exception as e:
                logger.warning(
                    "soft.extract.whole_doc %s: %s — falling back to legacy LLM stage",
                    fn, e,
                )
                got = {}
        else:
            transcript = (f"## FILE: {fn}\n## TYPE: {dt}\n"
                          f"## TITLE BLOCK / COVER:\n{head}\n\n"
                          f"## BODY:\n{txt[_TITLE_BLOCK_PREFIX_CHARS:]}")
            got = await _extract_via_llm_typed(
                transcript, doc_type=dt,
                source="uploads", confidence=0.82,
                note=f"from {dt} '{fn}'", timeout=timeout,
            )
        # Merge: regex already populated bag; LLM only fills new fields.
        for k, fv in got.items():
            if k not in bag:
                bag[k] = fv
    return bag


# ---------------------------------------------------------------------------
# Stubs for sources we'll wire in v2.
# ---------------------------------------------------------------------------
async def from_gitlab(repo_path: Optional[str]) -> Dict[str, FieldValue]:
    return {}


_SLD_NAME_HINTS = ("sld", "single line", "singleline", "single-line",
                   "تک خطی", "تک-خطی", "تک‌خطی", "تكخطی")
_LIST_NAME_HINTS = ("load list", "loadlist", "load_list", "datasheet",
                    "data sheet", "نیاز پروژه", "موجودی")
# Electro Kavir / Mobarakeh Steel doc-code conventions used in real
# client packages (e.g. "G26S1MEDDELDSHW11AA99006" or "347180ETS802"):
#   ETS  -> Engineering Technical Specification (project spec)
#   DSH  -> Data Sheet
#   SLD  -> Single Line Diagram
#   LDL  -> Load List
#   CTP  -> Cable / Termination plan
# Detection is on filename; case-insensitive substring.
_DOC_TYPE_HINTS = {
    "spec":      ("ets", "specification", "technical spec",
                  "spec for", "تکنیکال", "specification."),
    "datasheet": ("dsh", "data sheet", "datasheet"),
    "sld":       _SLD_NAME_HINTS,
    "loadlist":  ("ldl", "load list", "loadlist", "load_list",
                  "نیاز پروژه", "موجودی"),
}


def _doc_type_of(filename: str) -> str:
    low = (filename or "").lower()
    for t, hints in _DOC_TYPE_HINTS.items():
        if any(h in low for h in hints):
            return t
    return "other"


# ---------------------------------------------------------------------------
# Deterministic title-block regex extractor.
#
# The LLM extractor is gateway-bound — when llm-gateway is busy (gpt-oss
# is capacity-constrained under load and routinely 502s), the upload path
# returns nothing. Per the hybrid-extraction research (arxiv 2604.00003 +
# 2506.17374), engineering documents have STABLE title-block conventions
# that regex catches with 90%+ accuracy and ZERO latency / cost.
#
# Patterns below are tuned to real client packages observed in this stack
# (Mobarakeh Steel "DOCUMENT No 347180ETS802 / Rev A / Page X of Y",
# Chahfiroozeh / Electro Kavir "G26S1MEDDELDSHW11AA99006 REV.:03"). They
# produce FieldValues with the same shape as the LLM extractor; the
# reconciler picks the best per field — usually regex when the LLM 502s,
# LLM when both succeed and confidence is closer.
# ---------------------------------------------------------------------------
# Header noise — known boilerplate words we DON'T want as the client name.
_CLIENT_NEGATIVE = (
    "document", "doc.", "title", "subject", "for approval", "page",
    "rev.", "rev:", "data sheet", "specification", "drawing",
)

# Electro-Kavir style "G26S1MEDDELDSHW11AA99006" — leading letter, digits,
# at least two more uppercase segments, ending in digits. Matches the
# concatenated cover-sheet form too ("G26S1 ME DD EL DSH W11 AA 99 006"
# with whitespace stripped).
_EK_CODE_RE = re.compile(
    r"\b[A-Z][0-9]{1,3}[A-Z][0-9]?[A-Z]{1,4}[A-Z][A-Z0-9]+[0-9]{2,6}\b"
)
# Mobarakeh-style "347180ETS802" (numeric+letters+numeric).
_MSC_CODE_RE = re.compile(r"\b[0-9]{4,8}[A-Z]{2,5}[0-9]{2,5}[A-Z]?\b")
# Generic DOCUMENT No: token capture.
_DOC_NO_RE = re.compile(r"DOCUMENT\s*N[oO][\.\s:]+([A-Z0-9\-]+)", re.IGNORECASE)
_TITLE_RE = re.compile(
    r"DOCUMENT\s+TITLE\s*[:\.]?\s*\n?\s*(.+?)(?:\n\s*\n|\n\s*DOCUMENT|$)",
    re.IGNORECASE | re.DOTALL,
)
_DOC_TITLE_PERSIAN_RE = re.compile(
    r"Doc\.\s*Title\s*[:\.]?\s*(.+?)(?:\n|$)", re.IGNORECASE,
)
_REV_RE = re.compile(r"\bREV\.?\s*[:\.]?\s*([A-Z0-9]+)\b", re.IGNORECASE)
_KV_RE = re.compile(r"(\b\d{1,3}(?:\.\d{1,2})?)\s*[kK][vV]\b")
_HZ_RE = re.compile(r"\b(50|60)\s*[hH][zZ]\b")
_STD_RE = re.compile(r"\b(IEC|ANSI|GOST|BS|DIN)\b")
_ALT_M_RE = re.compile(r"\b(\d{2,5})\s*m(?:eters?)?\s*(?:above|asl|amsl)?",
                       re.IGNORECASE)
_TEMP_C_RE = re.compile(r"(?:design|ambient|max(?:imum)?)\s*temp[a-z]*\s*[:\.]?\s*"
                        r"(\d{1,3}(?:\.\d)?)\s*°?\s*[cC]",
                        re.IGNORECASE)


def _good_client_line(line: str) -> bool:
    s = (line or "").strip()
    if not (5 <= len(s) <= 80):
        return False
    low = s.lower()
    if any(w in low for w in _CLIENT_NEGATIVE):
        return False
    # need at least 2 alphabetic words (filters out things like "347180ETS802")
    words = [w for w in re.split(r"[\s\-_]+", s) if w.isalpha() and len(w) > 2]
    return len(words) >= 2


def extract_via_regex(filename: str, text: str, doc_type: str
                      ) -> Dict[str, "FieldValue"]:
    """Pull title-block fields with regex anchors only. Fast (<5ms), no
    network. Returns a FieldValue dict the same shape as the LLM extractor
    so the reconciler can merge them transparently."""
    if not text:
        return {}
    head = text[:3500]   # title block always lives in the cover sheet
    out: Dict[str, FieldValue] = {}
    note = f"regex from {doc_type} '{filename}'"

    def put(field: str, value: Any, conf: float):
        if value in (None, ""):
            return
        out[field] = FieldValue(value=str(value).strip(),
                                source="uploads", confidence=conf, note=note)

    # 1. Project / doc number — try doc-code regexes first (high precision),
    #    then the generic "DOCUMENT No" header capture.
    m = _MSC_CODE_RE.search(head) or _EK_CODE_RE.search(head)
    if m:
        put("projectNumber", m.group(0), 0.88)
    else:
        m = _DOC_NO_RE.search(head)
        if m:
            put("projectNumber", m.group(1), 0.82)

    # 2. Description = document title. Persian datasheets use "Doc. Title".
    m = _TITLE_RE.search(head) or _DOC_TITLE_PERSIAN_RE.search(head)
    if m:
        title = re.sub(r"\s+", " ", m.group(1)).strip()
        if 6 <= len(title) <= 200:
            put("projectDescription", title, 0.85)

    # 3. Client = first non-empty, "human readable" line near the top
    #    (company names always sit in the cover sheet header). Skip lines
    #    that look like doc numbers / boilerplate words.
    first_lines = [ln.strip() for ln in head.splitlines() if ln.strip()][:8]
    for ln in first_lines:
        if _good_client_line(ln):
            put("client", ln, 0.75)
            # Also use as project hint if no title found.
            if "projectName" not in out and 10 <= len(ln) <= 120:
                # Combine "<client>" + nearest "<subject>" line if present.
                idx = first_lines.index(ln)
                tail = " ".join(first_lines[idx+1: idx+4])
                tail = re.sub(r"\b(DOCUMENT|TITLE|Doc\.|REV\.|Page).*", "",
                              tail, flags=re.IGNORECASE).strip()
                pn = ln if len(tail) < 4 else f"{ln} — {tail[:80]}"
                put("projectName", pn, 0.65)
            break

    # 4. Electrical anchors.
    m = _KV_RE.search(head)
    if m:
        out["technicalSettings.mediumVoltage.nominalVoltage"] = FieldValue(
            value=m.group(1), source="uploads", confidence=0.72, note=note)
    m = _HZ_RE.search(head)
    if m:
        out["technicalSettings.lowVoltage.frequency"] = FieldValue(
            value=m.group(1), source="uploads", confidence=0.75, note=note)
    # `standard` rarely appears on the cover sheet; specs cite it on the
    # "Applicable Standards" page deeper in. Search the WHOLE text.
    m = _STD_RE.search(text)
    if m:
        put("standard", m.group(1).upper(), 0.78)

    # 5. Language / country inference — high-confidence cheap heuristics
    # that work without any external context. Persian script anywhere in
    # the doc → language=Persian (mixed Persian/English docs in this
    # stack are still "Persian" for the form). Common Iranian company
    # patterns → country=Iran (most projects here ARE Iranian; the
    # heuristic biases right). These are SOFT signals (lower confidence,
    # 0.6) so a regex match in the LLM enrichment pass can override.
    persian_chars = sum(1 for ch in text[:5000]
                        if '؀' <= ch <= 'ۿ')
    if persian_chars >= 5:
        put("language", "Persian", 0.7)
    else:
        # English bias is also valid when no Persian found AND the title
        # block contains English words.
        if re.search(r"\bSpecification|Document|Title|Project\b", head):
            put("language", "English", 0.65)
    # Country heuristic: Mobarakeh / Iran-flagged companies → Iran.
    if (persian_chars >= 5
            or re.search(r"\b(Iran|MSC|Mobarakeh|MOBARAKEH|Tehran|Isfahan|"
                         r"Chahfiroozeh|NIOC|NIORDC|NIGC|NIPC)\b", text[:8000])):
        put("country", "Iran", 0.7)

    # 6. Site-conditions (rare in cover sheet, more often in spec body).
    m = _ALT_M_RE.search(text[:8000])
    if m:
        out["techSettings.general"] = FieldValue(
            value={"altitudeAboveSeaLevel": m.group(1)},
            source="uploads", confidence=0.7, note=note)
    m = _TEMP_C_RE.search(text[:8000])
    if m:
        cur = out.get("techSettings.general")
        merged = (cur.value if cur and isinstance(cur.value, dict) else {})
        merged["designTemperature"] = m.group(1)
        out["techSettings.general"] = FieldValue(
            value=merged, source="uploads", confidence=0.7, note=note)

    return out


async def from_sld_uploads(project_id: str, project_oenum: str,
                           timeout: float = 120.0) -> Dict[str, FieldValue]:
    """Tier 2: if the project has uploaded files that look like a Single
    Line Diagram, run the existing GPT-4o-vision SLD pipeline on them and
    map the extracted equipment list to simorgh-soft Equipments.

    The analyze_sld pipeline already indexes results into Qdrant; here we
    just enumerate SLD-shaped files and SCROLL the SLD-analysis chunks
    that already exist in the persistent doc store (filename pattern
    `<base>_sld_analysis.json` from project_agent.analyze_sld). For files
    that haven't been analysed yet, we mark `pending` so the UI can
    expose a "run SLD analysis on file X" button (post-MVP).
    """
    try:
        from services.project_memory_service import get_project_memory_service
        q = getattr(get_project_memory_service(), "qdrant", None)
        if q is None:
            return {}
        scope = str(project_id)
        docs = q.list_documents(user_id="system", project_oenum=scope) or []
    except Exception as e:
        logger.warning("soft.extract.sld list failed: %s", e)
        return {}
    sld_docs = [d for d in docs
                if any(h in (d.get("filename") or "").lower()
                       for h in _SLD_NAME_HINTS)]
    if not sld_docs:
        return {}

    # Read each SLD's full text from the persistent store; if it was run
    # through analyze_sld earlier, the structured JSON output lives in the
    # workspace AND was indexed as an extra chunk. Look for chunks whose
    # section_title starts with "SLD Analysis:" — that's what analyze_sld
    # tags. If not present, fall back to the parsed (markdown) chunks.
    blocks: List[str] = []
    used = 0
    BUDGET = 18000
    for d in sld_docs[:3]:
        fn = d.get("filename") or ""
        try:
            txt = (q.get_document_text(user_id="system", project_oenum=scope,
                                       filename=fn, max_chars=BUDGET)
                   or {}).get("text") or ""
        except Exception:
            txt = ""
        if not txt:
            continue
        blocks.append(f"## SLD: {fn}\n{txt}")
        used += len(txt)
        if used >= BUDGET:
            break
    if not blocks:
        return {}

    # Ask the LLM to extract a list of equipment in our simorgh-soft shape.
    transcript = "\n\n".join(blocks)
    extract = await _extract_sld_equipments(transcript, source="uploads",
                                            note="from SLD upload (vision-analysed)",
                                            timeout=timeout)
    return extract


_SLD_EQUIP_PROMPT = """You see one or more Single Line Diagram extractions
below (already vision-analysed; equipment lists are visible). Build a
JSON array of equipments for the simorgh-soft Design Suite. Output JSON
ONLY in this exact shape:

{{
  "equipments": [
    {{
      "name": "Panel name / tag",
      "type": "LV" | "MV" | "HV",   // ≤1kV LV, 1-36kV MV, >36kV HV
      "power": "rated current / power if shown",
      "description": "one-line description",
      "properties": {{
        "ratedVoltage": "e.g. 11kV",
        "switchAmperage": "e.g. 1250A",
        "mainBusbarSize": "if shown",
        "ip": "if shown"
      }},
      "devices": [
        {{
          "feederNo": "F1 / outgoing 1",
          "templateName": "circuit-breaker model / template",
          "ratingPower": "kW or A",
          "flc": "amps if shown",
          "wiringType": "type if shown",
          "busSection": "bus tie / section if shown",
          "tag": "panel-feeder tag",
          "description": "what the feeder serves",
          "cableSize": "if shown"
        }}
      ]
    }}
  ]
}}

OMIT keys you didn't see. Do NOT invent.

Input:
{transcript}
"""


async def _extract_sld_equipments(transcript: str, *, source: str, note: str,
                                  timeout: float = 120.0
                                  ) -> Dict[str, FieldValue]:
    try:
        async with httpx.AsyncClient(timeout=timeout) as c:
            r = await c.post(f"{LLM_GATEWAY_URL}/generate", json={
                "messages": [
                    {"role": "system", "content": "You are a precise data extractor."},
                    {"role": "user", "content":
                        _SLD_EQUIP_PROMPT.format(transcript=transcript)},
                ],
                "mode": "online",
                "temperature": 0.0,
                "max_tokens": 2400,
            })
            r.raise_for_status()
            body = r.json()
    except Exception as e:
        logger.warning("soft.extract.sld llm failed: %s", e)
        return {}
    raw = (body.get("response") or body.get("text") or "").strip()
    parsed = _parse_extracted_json(raw, source=source, confidence=0.75, note=note)
    if "equipments" not in parsed:
        return {}
    # Stamp ids + rowNumbers + classify voltage so the payload is valid.
    from services.soft_spec import Equipment, DeviceTableRow, classify_voltage
    equips_in = parsed["equipments"].value or []
    out: List[Dict[str, Any]] = []
    for i, e in enumerate(equips_in if isinstance(equips_in, list) else []):
        if not isinstance(e, dict):
            continue
        props = e.get("properties") or {}
        vtype = e.get("type") or classify_voltage(props.get("ratedVoltage")
                                                  or props.get("voltageRate"))
        eq_id = f"sld-eq-{i+1}"
        devs_in = e.get("devices") or []
        devs: List[Dict[str, Any]] = []
        for j, d in enumerate(devs_in if isinstance(devs_in, list) else []):
            if not isinstance(d, dict):
                continue
            devs.append(DeviceTableRow(
                id=f"sld-dev-{i+1}-{j+1}", rowNumber=j+1,
                equipmentId=eq_id,
                templateId=str(d.get("templateId") or ""),
                templateName=str(d.get("templateName") or ""),
                busSection=str(d.get("busSection") or ""),
                feederNo=str(d.get("feederNo") or ""),
                wiringType=str(d.get("wiringType") or ""),
                ratingPower=str(d.get("ratingPower") or ""),
                flc=str(d.get("flc") or ""),
                tag=str(d.get("tag") or ""),
                description=str(d.get("description") or ""),
                cableSize=str(d.get("cableSize") or ""),
            ).model_dump())
        out.append(Equipment(
            id=eq_id, name=str(e.get("name") or f"Panel {i+1}"),
            type=vtype, power=str(e.get("power") or ""),
            deviceCount=len(devs),
            description=str(e.get("description") or ""),
            properties={k: str(v) for k, v in props.items()},
            devices=devs,
        ).model_dump())
    if not out:
        return {}
    return {"equipments": FieldValue(
        value=out, source=source, confidence=0.75, note=note)}


async def from_techserver(oenum: Optional[str], mcp_manager=None,
                          timeout: float = 60.0) -> Dict[str, FieldValue]:
    """Walk the techserver share for client-supplied specification docs
    (Documents/Clients/**, also tries Document/Client/Specification/**),
    fetch each PDF/Excel as markdown via techserver_read_artifact, run the
    JSON extractor over the concatenated text.

    Heavy by design — client specs are large; we cap at MAX_DOCS files and
    MAX_CHARS chars to keep the gateway call bounded. No-ops cleanly if
    techserver MCP is offline."""
    if not oenum or mcp_manager is None:
        return {}
    MAX_DOCS = 6
    MAX_CHARS = 24000
    try:
        tree_resp = await mcp_manager.call_tool(
            "techserver_get_tree", {"oenum": str(oenum)})
    except Exception as e:
        logger.warning("soft.extract.techserver tree failed: %s", e)
        return {}
    tree_text = (tree_resp or {}).get("output") or (tree_resp or {}).get("text") or ""
    if not tree_text:
        return {}

    # Find candidate paths: anything under client/specification/spec folders
    # that ends with a parseable extension. The tree is a newline list of
    # paths (one per file).
    candidates: List[str] = []
    want_dirs = ("document/client", "documents/client", "client/spec",
                 "client/specification", "client_spec", "specification")
    want_ext = (".pdf", ".docx", ".doc", ".xlsx", ".xls", ".txt", ".md")
    for line in tree_text.splitlines():
        path = line.strip().lstrip("- ").strip()
        low = path.lower()
        if not low.endswith(want_ext):
            continue
        if any(w in low for w in want_dirs):
            candidates.append(path)
    candidates = candidates[:MAX_DOCS]
    if not candidates:
        return {}

    # Fetch each as markdown, concatenate.
    blocks: List[str] = []
    used = 0
    for path in candidates:
        if used >= MAX_CHARS:
            break
        try:
            r = await mcp_manager.call_tool(
                "techserver_read_artifact", {"oenum": str(oenum), "path": path})
        except Exception as e:
            logger.warning("soft.extract.techserver read %s failed: %s", path, e)
            continue
        md = (r or {}).get("output") or (r or {}).get("text") or ""
        if not md:
            continue
        slice_ = md[: max(2000, MAX_CHARS - used)]
        blocks.append(f"## {path}\n{slice_}")
        used += len(slice_)
    if not blocks:
        return {}

    transcript = "\n\n".join(blocks)
    return await _extract_via_llm(transcript, source="techserver",
                                  confidence=0.8,
                                  note=f"from techserver client docs (oenum {oenum})",
                                  timeout=timeout)


# ---------------------------------------------------------------------------
# JSON parser — robust to markdown fences / leading prose.
# ---------------------------------------------------------------------------
def _parse_extracted_json(text: str, *, source: str, confidence: float,
                          note: str) -> Dict[str, FieldValue]:
    if not text:
        return {}
    # Strip ```json fences if present.
    t = text.strip()
    if t.startswith("```"):
        t = re.sub(r"^```(?:json)?\s*", "", t)
        t = re.sub(r"\s*```$", "", t)
    # Outermost {...}.
    m = re.search(r"\{.*\}", t, re.DOTALL)
    if not m:
        return {}
    try:
        obj = json.loads(m.group(0))
    except Exception:
        return {}
    if not isinstance(obj, dict):
        return {}
    out: Dict[str, FieldValue] = {}
    for k, v in obj.items():
        if v in (None, "", []):
            continue
        out[str(k)] = FieldValue(value=v, source=source,  # type: ignore[arg-type]
                                 confidence=confidence, note=note)
    return out


# ---------------------------------------------------------------------------
# Orchestrator — runs extractors in parallel; never raises.
# ---------------------------------------------------------------------------
async def gather_all(*, project_id: str, tpms_oenum: Optional[str],
                     repo_path: Optional[str], techserver_oenum: Optional[str],
                     recent_messages: List[Dict[str, Any]],
                     mcp_manager=None,
                     ) -> Dict[str, List[FieldValue]]:
    """Returns Dict[field, list-of-FieldValue (one per source that proposed
    a value)]. Multi-value lists are what the reconciler resolves.

    Sources run in PARALLEL; failures are swallowed so a single dead
    source can't sink the gather. Tier 1 (project fields) + Tier 2
    (equipments/devices) are both populated here — the reconciler picks
    the highest-confidence source per field.

    Source isolation contract: callers pass `tpms_oenum=None /
    repo_path=None / techserver_oenum=None` to disable each source.
    Each extractor self-guards: passing None / "" yields an empty
    result without making any external call (no SMB, no TPMS HTTP,
    no GitLab clone). Defence in depth — soft_collector already gates
    on sources_enabled but a defensive extractor catches future
    callers who forget the gate.
    """
    logger.info(
        "soft.gather_all: project=%s tpms_oe=%s ts_oe=%s repo=%s",
        project_id, tpms_oenum or "-", techserver_oenum or "-",
        repo_path or "-",
    )
    # Run NON-LLM extractors in parallel — they don't touch llm-gateway,
    # so concurrency is safe and cheap.
    fast_results = await asyncio.gather(
        from_tpms(tpms_oenum),
        from_gitlab(repo_path),
        return_exceptions=True,
    )
    # Run LLM-backed extractors SEQUENTIALLY. The gateway routinely 502s
    # when 3+ /generate calls hit it concurrently, which was the actual
    # cause of "uploads never reached the form" (observed: chat + uploads
    # both 502'd while TPMS landed cleanly). One-at-a-time + 5xx retries
    # in _extract_via_llm trades a few seconds of latency for reliability.
    llm_results: List[Any] = []
    for coro in [
        from_chat_history(recent_messages),
        from_uploads(project_id, str(project_id)),
        from_techserver(techserver_oenum, mcp_manager=mcp_manager),
        from_sld_uploads(project_id, str(project_id)),
    ]:
        try:
            llm_results.append(await coro)
        except Exception as e:
            llm_results.append(e)
    bag: Dict[str, List[FieldValue]] = {}
    for r in list(fast_results) + llm_results:
        if isinstance(r, Exception) or not isinstance(r, dict):
            if isinstance(r, Exception):
                logger.warning("soft.extract source raised: %s", r)
            continue
        for k, fv in r.items():
            bag.setdefault(k, []).append(fv)
    return bag
