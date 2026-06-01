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
async def from_tpms(oenum: Optional[str], timeout: float = 8.0
                    ) -> Dict[str, FieldValue]:
    if not oenum:
        return {}
    try:
        async with httpx.AsyncClient(timeout=timeout) as c:
            # The fetcher's GET serves cached data; POST forces a fresh pull.
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
    out: Dict[str, FieldValue] = {}
    note = f"from TPMS OENUM {oenum}"

    def put(field: str, value: Any, conf: float = 0.9):
        if value not in (None, "", 0):
            out[field] = FieldValue(value=str(value), source="tpms",
                                    confidence=conf, note=note)

    put("projectNumber", proj.get("oenum"), 0.95)
    put("projectName", proj.get("project_name"))
    put("projectDescription",
        proj.get("project_name_fa") or proj.get("project_name"), 0.8)
    put("noticeToProceedDate", proj.get("oe_date"), 0.7)
    # technical_project_identity_ has site conditions; leave for v2.
    if pid.get("Delivery_Date"):
        put("deliveryDate", pid["Delivery_Date"], 0.7)
    # Project name often encodes the client (e.g. "Mobarakeh Steel Co ...").
    return out


# ---------------------------------------------------------------------------
# Chat-history extractor — runs a small LLM extraction over the last N
# messages to lift free-text mentions (project name, location, client,
# dates the user typed in chat).
# ---------------------------------------------------------------------------
_CHAT_EXTRACT_PROMPT = """You extract Design Suite project fields from a
chat conversation. Return JSON ONLY with the keys present below — leave
out fields you didn't see. Do not invent values.

Fields to extract (use exact keys):
- projectName     (a human name for the project, often in quotes or after "called")
- projectDescription (1-2 sentence scope description if the user explained it)
- client          (customer organization name)
- location        (city / site)
- standard        (IEC | ANSI | GOST — only if explicitly mentioned)
- noticeToProceedDate, deliveryDate (ISO 8601 if dates are mentioned)

Output JUST the JSON object, no prose.

Conversation:
{transcript}
"""


async def from_chat_history(messages: List[Dict[str, Any]], timeout: float = 30.0
                            ) -> Dict[str, FieldValue]:
    if not messages:
        return {}
    transcript = "\n".join(
        f"{(m.get('role') or '?')}: {(m.get('content') or '')[:600]}"
        for m in messages[-12:]
    )
    if len(transcript) < 30:
        return {}
    try:
        async with httpx.AsyncClient(timeout=timeout) as c:
            r = await c.post(f"{LLM_GATEWAY_URL}/generate", json={
                "messages": [
                    {"role": "system", "content": "You are a precise data extractor."},
                    {"role": "user", "content": _CHAT_EXTRACT_PROMPT.format(transcript=transcript)},
                ],
                "mode": "online",
                "temperature": 0.0,
                "max_tokens": 600,
            })
            r.raise_for_status()
            body = r.json()
    except Exception as e:
        logger.warning("soft.extract.chat failed: %s", e)
        return {}
    text = (body.get("response") or body.get("text") or "").strip()
    return _parse_extracted_json(text, source="chat", confidence=0.7,
                                 note="from chat history")


# ---------------------------------------------------------------------------
# Uploads extractor — same LLM lift over the documents already pre-loaded
# into the chat's vector store. Picks up names/clients/dates embedded in
# uploaded specs / inventory lists.
# ---------------------------------------------------------------------------
async def from_uploads(project_id: str, project_oenum: str,
                       timeout: float = 30.0) -> Dict[str, FieldValue]:
    # Pull the first chunks of each indexed doc and ask the LLM to extract.
    try:
        from services.project_memory_service import get_project_memory_service
        q = getattr(get_project_memory_service(), "qdrant", None)
        if q is None:
            return {}
        scope = project_oenum or project_id
        docs = q.list_documents(user_id="system", project_oenum=scope) or []
        if not docs:
            return {}
        blocks: List[str] = []
        for d in docs[:3]:
            fn = d.get("filename") or ""
            if not fn:
                continue
            txt = (q.get_document_text(user_id="system", project_oenum=scope,
                                       filename=fn, max_chars=3000)
                    or {}).get("text") or ""
            if txt:
                blocks.append(f"## {fn}\n{txt}")
        if not blocks:
            return {}
        transcript = "\n\n".join(blocks)
    except Exception as e:
        logger.warning("soft.extract.uploads gather failed: %s", e)
        return {}

    try:
        async with httpx.AsyncClient(timeout=timeout) as c:
            r = await c.post(f"{LLM_GATEWAY_URL}/generate", json={
                "messages": [
                    {"role": "system", "content": "You are a precise data extractor."},
                    {"role": "user", "content": _CHAT_EXTRACT_PROMPT.format(
                        transcript=transcript[:14000])},
                ],
                "mode": "online",
                "temperature": 0.0,
                "max_tokens": 600,
            })
            r.raise_for_status()
            body = r.json()
    except Exception as e:
        logger.warning("soft.extract.uploads llm failed: %s", e)
        return {}
    return _parse_extracted_json((body.get("response") or body.get("text") or "").strip(),
                                 source="uploads", confidence=0.75,
                                 note="from uploaded documents")


# ---------------------------------------------------------------------------
# Stubs for sources we'll wire in v2.
# ---------------------------------------------------------------------------
async def from_gitlab(repo_path: Optional[str]) -> Dict[str, FieldValue]:
    return {}


async def from_techserver(oenum: Optional[str]) -> Dict[str, FieldValue]:
    return {}


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
                     ) -> Dict[str, List[FieldValue]]:
    """Returns Dict[field, list-of-FieldValue (one per source that proposed
    a value)]. Multi-value lists are what the reconciler resolves."""
    coros = [
        from_tpms(tpms_oenum),
        from_chat_history(recent_messages),
        from_uploads(project_id, tpms_oenum or project_id),
        from_gitlab(repo_path),
        from_techserver(techserver_oenum),
    ]
    results = await asyncio.gather(*coros, return_exceptions=True)
    bag: Dict[str, List[FieldValue]] = {}
    for r in results:
        if isinstance(r, Exception) or not isinstance(r, dict):
            continue
        for k, fv in r.items():
            bag.setdefault(k, []).append(fv)
    return bag
