"""
soft_doc_relevance.py — Document relevance gate for the whole-doc extractor.

The previous extractor ran on EVERY uploaded file, so an inventory
spreadsheet (`موجودی انبار.xlsx`) yielded proposals like "country=Iran,
frequency=60, voltage=12" — the LLM saw enough lexical context (the
words "60", "12", "Iran" appeared somewhere) to emit them, and the
HITL viewer surfaced the garbage.

This gate runs BEFORE the heavy extractor and answers one question
per file: "Is this a switchgear specification document?" If no, the
file is skipped entirely — its data never enters the proposal stream.

Two-stage classification, cheapest first:

  1. **Filename heuristics** — instant decision for the obvious cases
     (موجودی, inventory, stock, invoice, drawing, SLD, etc.). No LLM
     call. Returns a tri-state: SPEC / NOT_SPEC / UNKNOWN.

  2. **LLM triage** (only for UNKNOWN filenames) — sends filename
     + first ~500 chars of the document to gpt-oss-20b with a
     ``DocTriage`` guided_json schema; the model classifies and gives
     a confidence + one-sentence reason.

Best-effort: any failure (gateway down, malformed response) returns
"unknown — proceed with extraction" so the gate can never block a
legitimate spec because of a hiccup. Disable globally by setting
``SOFT_DOC_RELEVANCE_GATE=0``.
"""
from __future__ import annotations

import json
import logging
import os
import re
from dataclasses import dataclass
from typing import Literal, Optional, Tuple

import httpx

logger = logging.getLogger(__name__)

LLM_GATEWAY_URL = os.getenv("LLM_GATEWAY_URL", "http://llm-gateway:8030").rstrip("/")
GATE_ENABLED = os.getenv("SOFT_DOC_RELEVANCE_GATE", "1").lower() in ("1", "true", "yes", "on")
GATE_MIN_CONFIDENCE = float(os.getenv("SOFT_DOC_RELEVANCE_MIN_CONF", "0.7"))
GATE_TIMEOUT_SEC = float(os.getenv("SOFT_DOC_RELEVANCE_TIMEOUT_SEC", "30"))


# ---------------------------------------------------------------------------
# Doc-type taxonomy — Literal-style for clarity. Anything not in
# SPEC_TYPES is skipped by the extractor. Keep this list in sync with
# the DocTriage schema below.
# ---------------------------------------------------------------------------
DocType = Literal[
    "spec_sheet",          # the wanted thing — switchgear / panel / equipment spec
    "datasheet",           # vendor datasheet — also extractable
    "drawing",             # SLD / GA drawing / wiring diagram — skip
    "single_line_diagram", # alias of drawing
    "load_list",           # loads tabulation — useful but not project-level
    "inventory",           # stock / parts inventory — skip ALWAYS
    "invoice",             # supplier invoice — skip
    "purchase_order",      # PO — skip
    "tender",              # tender / RFQ — partial; cover sheet only
    "report",              # commissioning / test report — context only
    "other",               # unrecognised — proceed with caution
]

# Types we WILL extract from. Everything else returns SKIP.
SPEC_TYPES = {"spec_sheet", "datasheet"}

# Types we explicitly want to skip even if the user uploaded them
# under a project (no signal value for project-level fields).
SKIP_TYPES = {"inventory", "invoice", "purchase_order",
              "drawing", "single_line_diagram"}


# ---------------------------------------------------------------------------
# Stage 1: filename heuristics (no LLM call)
# ---------------------------------------------------------------------------
# Patterns are intentionally aggressive — when they match, we're
# confident enough to skip the LLM call entirely. False positives are
# acceptable because filenames are operator-controlled and an
# accidentally-named "spec.xlsx" of stock will get re-uploaded with a
# clearer name.

_INVENTORY_RX = re.compile(
    r"(?i)(?:^|[^a-z])"
    r"(موجودی|انبار|inventory|stock|parts.list|قیمت|price[-_]?list|"
    r"BOM|bill.of.materials)"
    r"(?:$|[^a-z])"
)
_INVOICE_RX = re.compile(
    r"(?i)(?:^|[^a-z])(invoice|فاکتور|پیش[-_]?فاکتور|proforma)(?:$|[^a-z])"
)
_PO_RX = re.compile(
    r"(?i)(?:^|[^a-z])(purchase[-_ ]?order|سفارش[-_ ]?خرید|^P\.?O\.?)(?:$|[^a-z])"
)
_DRAWING_RX = re.compile(
    r"(?i)(?:^|[-_ ])(SLD|single[-_ ]?line|GA[-_ ]?drawing|GA[-_ ]?layout|"
    r"wiring|schematic|نقشه)(?:[-_ ]|$)"
)
# Strong positive signals — give them a head-start.
_SPEC_POSITIVE_RX = re.compile(
    r"(?i)(?:^|[-_ ])(spec|specification|technical[-_ ]?specification|"
    r"ETS|TS|datasheet|data[-_ ]?sheet|requirements?)(?:[-_ ]|$)"
)
# Document codes that real EPC packages use — strong spec signal.
_SPEC_CODE_RX = re.compile(
    r"(?i)\b("
    r"[A-Z0-9]+[-_]?ETS[-_]?\d+|"     # 347180ETS802
    r"[A-Z]+[-_]?DD[-_]?EL[-_]?SP[-_]?\d+|"  # HCS-DD-EL-SP-003
    r"[A-Z]+[-_]?DS[-_]?\d+|"
    r"[A-Z]+[-_]?TS[-_]?\d+"
    r")\b"
)


@dataclass
class FilenameVerdict:
    classification: Literal["SPEC", "NOT_SPEC", "UNKNOWN"]
    reason: str
    matched_pattern: Optional[str] = None


def classify_filename(filename: str) -> FilenameVerdict:
    """Cheap tri-state classification from filename alone."""
    if not filename:
        return FilenameVerdict("UNKNOWN", "empty filename")
    fn = filename.strip()

    # NEGATIVE — instant skip
    if _INVENTORY_RX.search(fn):
        return FilenameVerdict("NOT_SPEC", "filename matches inventory/stock pattern",
                                _INVENTORY_RX.pattern)
    if _INVOICE_RX.search(fn):
        return FilenameVerdict("NOT_SPEC", "filename matches invoice pattern",
                                _INVOICE_RX.pattern)
    if _PO_RX.search(fn):
        return FilenameVerdict("NOT_SPEC", "filename matches purchase-order pattern",
                                _PO_RX.pattern)
    if _DRAWING_RX.search(fn):
        return FilenameVerdict("NOT_SPEC", "filename matches drawing/SLD pattern",
                                _DRAWING_RX.pattern)

    # POSITIVE — likely a spec, lower the bar
    if _SPEC_CODE_RX.search(fn):
        return FilenameVerdict("SPEC", "filename contains EPC-style document code",
                                _SPEC_CODE_RX.pattern)
    if _SPEC_POSITIVE_RX.search(fn):
        return FilenameVerdict("SPEC", "filename matches spec/datasheet pattern",
                                _SPEC_POSITIVE_RX.pattern)

    return FilenameVerdict("UNKNOWN", "no decisive filename pattern")


# ---------------------------------------------------------------------------
# Stage 2: LLM triage (only when filename is UNKNOWN)
# ---------------------------------------------------------------------------
_DOCTRIAGE_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["doc_type", "is_switchgear_spec", "confidence", "reason"],
    "properties": {
        "doc_type": {
            "type": "string",
            "enum": ["spec_sheet", "datasheet", "drawing", "single_line_diagram",
                     "load_list", "inventory", "invoice", "purchase_order",
                     "tender", "report", "other"],
        },
        "is_switchgear_spec": {"type": "boolean"},
        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
        "reason": {"type": "string",
                   "description": "one short sentence quoting filename + content"},
    },
}

_SYSTEM_PROMPT = (
    "You are a document-triage classifier for an electrical-engineering "
    "chatbot. Decide whether the attached document is a switchgear / "
    "electrical-equipment SPECIFICATION (the kind a project engineer "
    "would use to derive panel ratings, busbar sizes, protection settings, "
    "etc.). Reject inventories, invoices, purchase orders, drawings, "
    "and unrelated office documents. Be decisive: when in doubt, lean "
    "toward `other` with low confidence, NOT toward `spec_sheet`."
)


async def classify_doc_llm(*, filename: str, head: str,
                            timeout: float = GATE_TIMEOUT_SEC,
                            ) -> Optional[dict]:
    """LLM triage. Returns the parsed DocTriage dict, or None on any
    failure (gateway down, no JSON, etc.)."""
    head = (head or "")[:1500]   # cheap call — short context
    user_prompt = (
        f"# FILENAME\n{filename}\n\n"
        f"# FIRST CHARACTERS OF DOCUMENT\n"
        f"```\n{head}\n```\n\n"
        f"# OUTPUT\n"
        f"Return a single JSON object matching the schema. "
        f"Examples of NOT-spec: inventory ('موجودی انبار'), stock list, "
        f"invoice ('فاکتور'), purchase order, single-line drawing, "
        f"BOM. Examples of SPEC: 'Technical Specification for X', "
        f"datasheet, requirements document with electrical fields, "
        f"clauses citing IEC standards.\n"
    )
    payload = {
        "messages": [
            {"role": "system", "content": _SYSTEM_PROMPT},
            {"role": "user",   "content": user_prompt},
        ],
        "mode":          "offline",
        "force_backend": "text",
        "temperature":   1.0,
        "max_tokens":    400,
        "extra": {
            "guided_json": _DOCTRIAGE_SCHEMA,
            "response_format": {"type": "json_object"},
            "reasoning_effort": "low",
        },
    }
    try:
        async with httpx.AsyncClient(timeout=timeout) as c:
            r = await c.post(f"{LLM_GATEWAY_URL}/generate", json=payload)
            r.raise_for_status()
            body = r.json()
    except Exception as e:  # noqa: BLE001
        logger.warning("soft_doc_relevance: gateway failed for %s: %s", filename, e)
        return None
    text = (body.get("response") or body.get("text") or "").strip()
    if not text:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        # Try to extract the outermost {...} (vLLM with guided_json
        # should never need this, but cheap belt-and-braces).
        start = text.find("{"); end = text.rfind("}")
        if start != -1 and end != -1 and end > start:
            try: return json.loads(text[start:end + 1])
            except json.JSONDecodeError: return None
    return None


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------
@dataclass
class RelevanceDecision:
    is_spec: bool
    doc_type: str
    confidence: float
    reason: str
    stage: Literal["filename", "llm", "disabled", "default"]

    def to_dict(self) -> dict:
        return {
            "is_spec": self.is_spec, "doc_type": self.doc_type,
            "confidence": self.confidence, "reason": self.reason,
            "stage": self.stage,
        }


async def is_spec_document(*, filename: str, head: str = "",
                            timeout: float = GATE_TIMEOUT_SEC,
                            ) -> RelevanceDecision:
    """The one function the extractor should call. Returns a decision
    that .is_spec=True only when extraction should proceed."""
    if not GATE_ENABLED:
        return RelevanceDecision(
            is_spec=True, doc_type="unchecked", confidence=1.0,
            reason="gate disabled (SOFT_DOC_RELEVANCE_GATE=0)",
            stage="disabled",
        )

    # Stage 1 — filename heuristics
    fn_verdict = classify_filename(filename)
    if fn_verdict.classification == "NOT_SPEC":
        return RelevanceDecision(
            is_spec=False, doc_type="filename_match", confidence=0.95,
            reason=fn_verdict.reason, stage="filename",
        )
    if fn_verdict.classification == "SPEC":
        # Strong positive — trust the filename and skip the LLM call.
        return RelevanceDecision(
            is_spec=True, doc_type="filename_match", confidence=0.85,
            reason=fn_verdict.reason, stage="filename",
        )

    # Stage 2 — LLM triage
    triage = await classify_doc_llm(filename=filename, head=head, timeout=timeout)
    if triage is None:
        # Default to proceeding rather than blocking on a hiccup.
        return RelevanceDecision(
            is_spec=True, doc_type="unknown", confidence=0.5,
            reason="LLM triage unavailable — proceeding with extraction",
            stage="default",
        )
    doc_type = str(triage.get("doc_type") or "other")
    is_swsp = bool(triage.get("is_switchgear_spec"))
    try:
        conf = float(triage.get("confidence") or 0.0)
    except (TypeError, ValueError):
        conf = 0.0
    reason = (triage.get("reason") or "")[:200]

    # Decision rule:
    #   accept if (is_switchgear_spec AND conf ≥ threshold)
    #          OR (doc_type ∈ SPEC_TYPES AND conf ≥ threshold)
    #   reject if doc_type ∈ SKIP_TYPES
    if doc_type in SKIP_TYPES:
        return RelevanceDecision(
            is_spec=False, doc_type=doc_type, confidence=conf,
            reason=reason or f"classified as {doc_type}",
            stage="llm",
        )
    accept = (is_swsp or doc_type in SPEC_TYPES) and conf >= GATE_MIN_CONFIDENCE
    return RelevanceDecision(
        is_spec=accept, doc_type=doc_type, confidence=conf,
        reason=reason or ("accepted" if accept else "below confidence threshold"),
        stage="llm",
    )
