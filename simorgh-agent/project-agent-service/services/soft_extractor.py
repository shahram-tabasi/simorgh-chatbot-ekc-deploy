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
    chat-history, uploads, and techserver extractors so they share one
    prompt + one parser."""
    if not transcript or len(transcript) < 30:
        return {}
    try:
        async with httpx.AsyncClient(timeout=timeout) as c:
            r = await c.post(f"{LLM_GATEWAY_URL}/generate", json={
                "messages": [
                    {"role": "system", "content": "You are a precise data extractor."},
                    {"role": "user", "content":
                        _EXTRACT_SCHEMA_PROMPT.format(transcript=transcript[:24000])},
                ],
                "mode": "online",
                "temperature": 0.0,
                "max_tokens": 900,
            })
            r.raise_for_status()
            body = r.json()
    except Exception as e:
        logger.warning("soft.extract.llm (%s) failed: %s", source, e)
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
async def from_uploads(project_id: str, project_oenum: str,
                       timeout: float = 60.0) -> Dict[str, FieldValue]:
    """Tier 1 extraction over uploaded client documents (project
    specifications, mostly PDF — already parsed to markdown by doc-processor
    on upload, with docling/easyocr handling scanned PDFs).

    Runs the schema-aware extractor on EACH document separately (per-file
    provenance) and keeps the best value per field across files. Bigger
    char budget per doc than chat history because specs are dense."""
    try:
        from services.project_memory_service import get_project_memory_service
        q = getattr(get_project_memory_service(), "qdrant", None)
        if q is None:
            return {}
        scope = project_oenum or project_id
        docs = q.list_documents(user_id="system", project_oenum=scope) or []
    except Exception as e:
        logger.warning("soft.extract.uploads list failed: %s", e)
        return {}
    if not docs:
        return {}

    PER_DOC = 12000
    MAX_DOCS = 5
    bag: Dict[str, FieldValue] = {}
    for d in docs[:MAX_DOCS]:
        fn = d.get("filename") or ""
        if not fn:
            continue
        try:
            txt = (q.get_document_text(user_id="system", project_oenum=scope,
                                       filename=fn, max_chars=PER_DOC)
                   or {}).get("text") or ""
        except Exception as e:
            logger.warning("soft.extract.uploads read %s: %s", fn, e)
            continue
        if not txt:
            continue
        got = await _extract_via_llm(
            f"## FILE: {fn}\n{txt}", source="uploads", confidence=0.78,
            note=f"from uploaded file {fn}", timeout=timeout,
        )
        # Merge: keep the first value seen for each field (per-file source);
        # different files contributing different fields is the common case.
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
        scope = project_oenum or project_id
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
    """
    coros = [
        from_tpms(tpms_oenum),
        from_chat_history(recent_messages),
        from_uploads(project_id, tpms_oenum or project_id),
        from_gitlab(repo_path),
        from_techserver(techserver_oenum, mcp_manager=mcp_manager),
        from_sld_uploads(project_id, tpms_oenum or project_id),
    ]
    results = await asyncio.gather(*coros, return_exceptions=True)
    bag: Dict[str, List[FieldValue]] = {}
    for r in results:
        if isinstance(r, Exception) or not isinstance(r, dict):
            if isinstance(r, Exception):
                logger.warning("soft.extract source raised: %s", r)
            continue
        for k, fv in r.items():
            bag.setdefault(k, []).append(fv)
    return bag
