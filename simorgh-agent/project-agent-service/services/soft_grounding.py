"""
soft_grounding.py — extract-then-VERIFY gate for Design Suite proposals.

The highest-precision lever in structured extraction is groundedness checking:
after a value is extracted, confirm it actually appears in its cited source
document and drop it otherwise — because, per the IE literature, "a system
that produces extraneous values is more problematic than one that leaves
entries unspecified" (precision over recall for knowledge-base population).

This module scores how well a proposal value is supported by its source text
and prunes the clearly-ungrounded ones. The matcher is deliberately tolerant:

  * Persian/Arabic digits and common unit spacings are normalized, so a value
    extracted as "6.6 kV" still matches a document that renders "۶٫۶ kV".
  * It scores by SIGNIFICANT-TOKEN coverage (numbers + words), not verbatim
    substring, so the RTL/LTR-scrambled text layer of real engineering PDFs
    (where "6.6 kV" comes out "6.kV 6") doesn't cause false drops.
  * It only DROPS when the source text was readable AND coverage is near-zero
    (the value's tokens are essentially absent) — i.e. a wrong-document
    attribution or a hallucinated value, not a formatting mismatch.

Values from sources we cannot read back (chat / TPMS / user-typed, or a doc
whose text we failed to fetch) are kept unchanged — we never penalise a value
just because it is unverifiable.
"""
from __future__ import annotations

import logging
import re
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

# Keep a value when at least this fraction of its significant tokens appear in
# the source. Low on purpose: we want to catch hallucinations (coverage ≈ 0),
# not nitpick formatting (a real value usually clears this easily).
_DEFAULT_THRESHOLD = 0.34
_MIN_SOURCE_CHARS = 50          # below this we treat the doc as "unreadable"

# Persian (۰-۹) and Arabic-Indic (٠-٩) digits → ASCII.
_DIGIT_MAP = {ord(c): str(i) for i, c in enumerate("۰۱۲۳۴۵۶۷۸۹")}
_DIGIT_MAP.update({ord(c): str(i) for i, c in enumerate("٠١٢٣٤٥٦٧٨٩")})
_DIGIT_MAP[ord("٫")] = "."      # Arabic decimal separator
_DIGIT_MAP[ord("،")] = ","

_NUM_RE = re.compile(r"[0-9]+(?:\.[0-9]+)?")
_WORD_RE = re.compile(r"[a-z؀-ۿ]{2,}")


def _norm(s: str) -> str:
    """Lowercase, fold Persian/Arabic digits, drop whitespace."""
    s = str(s or "").translate(_DIGIT_MAP).lower()
    return re.sub(r"\s+", "", s)


def _significant_tokens(value: Any) -> List[str]:
    """Numbers (with decimals) and ≥2-char words — the parts that make a
    value distinctive. Pure punctuation / 1-char noise is ignored."""
    raw = str(value or "").translate(_DIGIT_MAP).lower()
    toks = _NUM_RE.findall(raw) + _WORD_RE.findall(raw)
    # De-dup, preserve order, and drop a few ubiquitous filler words that
    # would otherwise inflate coverage for free.
    stop = {"the", "and", "for", "per", "with", "from", "min", "max"}
    out: List[str] = []
    for t in toks:
        if t in stop or t in out:
            continue
        out.append(t)
    return out


def grounded_score(value: Any, source_text: str,
                   evidence: Optional[str] = None) -> float:
    """0..1 — fraction of the value's significant tokens found in the source.
    Returns 1.0 immediately on a whitespace-insensitive verbatim hit. Uses the
    better of (value, evidence) so a good evidence span can rescue a value
    whose own surface form was reformatted."""
    snorm = _norm(source_text)
    if not snorm:
        return 0.0

    def score_one(v: Any) -> float:
        toks = _significant_tokens(v)
        if not toks:
            return 0.0
        vnorm = _norm(v)
        if len(vnorm) >= 3 and vnorm in snorm:
            return 1.0           # contiguous match — strongest evidence
        hit = sum(1 for t in toks if t in snorm)
        return hit / len(toks)

    best = score_one(value)
    if evidence:
        best = max(best, score_one(evidence))
    return best


async def verify_against_docs(
    by_kind: Dict[str, List[Dict[str, Any]]],
    project_id: str,
    scope: str,
    *,
    threshold: float = _DEFAULT_THRESHOLD,
) -> Dict[str, List[Dict[str, Any]]]:
    """Prune proposal candidates that are not grounded in their cited source
    document. `by_kind` maps source_kind → list of candidate dicts
    {field, value, confidence, note, doc_id}. Returns a pruned copy and logs
    what was dropped. Never raises — on any error the input is returned
    unchanged (fail-open: precision gate must not break extraction)."""
    if not by_kind:
        return by_kind
    try:
        from services.soft_source_markup import parse_source_note
        from services.project_memory_service import get_project_memory_service
        q = getattr(get_project_memory_service(), "qdrant", None)
    except Exception as e:  # noqa: BLE001
        logger.warning("soft_grounding: deps unavailable (%s) — skipping", e)
        return by_kind

    text_cache: Dict[str, str] = {}

    def text_for(fn: str) -> str:
        if fn in text_cache:
            return text_cache[fn]
        t = ""
        try:
            if q is not None and fn:
                r = q.get_document_text(user_id="system", project_oenum=scope,
                                        filename=fn, max_chars=200000) or {}
                t = r.get("text") or ""
        except Exception as e:  # noqa: BLE001
            logger.debug("soft_grounding: text fetch %r failed: %s", fn, e)
            t = ""
        text_cache[fn] = t
        return t

    kept: Dict[str, List[Dict[str, Any]]] = {}
    dropped = 0
    verified = 0
    for kind, cands in by_kind.items():
        out: List[Dict[str, Any]] = []
        for c in cands:
            note = parse_source_note(c.get("note"))
            fn = note.get("filename")
            if not fn:
                out.append(c)            # no cited doc → unverifiable, keep
                continue
            src = text_for(fn)
            if len(src) < _MIN_SOURCE_CHARS:
                out.append(c)            # couldn't read the doc → keep
                continue
            score = grounded_score(c.get("value"), src,
                                   evidence=note.get("evidence"))
            verified += 1
            if score < threshold:
                dropped += 1
                logger.debug("soft_grounding: drop %s=%r score=%.2f (doc=%s)",
                             c.get("field"), c.get("value"), score, fn)
                continue
            # Calibrate: a strongly-grounded value earns a small confidence
            # bump; a weakly-grounded one is nudged down (still kept).
            if score >= 0.99:
                c["confidence"] = min(0.99, float(c.get("confidence") or 0.5) + 0.1)
            out.append(c)
        if out:
            kept[kind] = out
    if verified:
        logger.info("soft_grounding: verified=%d dropped=%d kept=%d "
                    "(threshold=%.2f)", verified, dropped,
                    verified - dropped, threshold)
    return kept
