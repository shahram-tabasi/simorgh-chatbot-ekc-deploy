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

# Ubiquitous filler + UNIT words. Units are excluded from the distinctive-token
# set on purpose: otherwise a hallucinated "125 kV" or "20 kA" scores ~0.5 for
# free just because the source is full of "kV"/"kA" — the NUMBER is what has to
# be grounded, not the unit.
_STOP = {
    "the", "and", "for", "per", "with", "from", "min", "max", "approx",
    # units / suffixes
    "kv", "kva", "mva", "mvar", "kvar", "mw", "kw", "hz", "khz", "ka", "ma",
    "mm", "cm", "km", "ms", "sec", "deg", "vac", "vdc", "dc", "ac", "db",
    "rms", "mm2", "sqmm", "no", "nos", "off",
}


def _fold(s: str) -> str:
    """Lowercase + fold Persian/Arabic digits, keeping spacing/punctuation
    (needed for whole-number boundary matching)."""
    return str(s or "").translate(_DIGIT_MAP).lower()


def _norm(s: str) -> str:
    """Lowercase, fold digits, drop ALL whitespace (for verbatim substring)."""
    return re.sub(r"\s+", "", _fold(s))


def _significant_tokens(value: Any) -> Dict[str, List[str]]:
    """Split a value into the parts that make it distinctive:
    {"nums": [...], "words": [...]}, excluding units + filler. Numbers are
    matched as whole numbers; words as substrings."""
    raw = _fold(value)
    nums = _NUM_RE.findall(raw)
    words = [w for w in _WORD_RE.findall(raw) if w not in _STOP]
    # de-dup, preserve order
    nums = list(dict.fromkeys(nums))
    words = list(dict.fromkeys(words))
    return {"nums": nums, "words": words}


def grounded_score(value: Any, source_text: str,
                   evidence: Optional[str] = None) -> float:
    """0..1 — fraction of the value's distinctive tokens found in the source.

    A NUMBER must match as a WHOLE number (not as a digit inside another
    number — so "6" does not match "6.6", and a fabricated "125" is not
    rescued by the document merely containing a "12" or "1"). Unit words are
    ignored. Returns 1.0 on a whitespace-insensitive verbatim hit. Uses the
    better of (value, evidence)."""
    sfold = _fold(source_text)
    snorm = re.sub(r"\s+", "", sfold)
    if not snorm:
        return 0.0

    def num_in(num: str) -> bool:
        # Whole-number match: not preceded/followed by a digit or decimal dot.
        return re.search(r"(?<![\d.])" + re.escape(num) + r"(?![\d.])",
                         sfold) is not None

    def score_one(v: Any) -> float:
        vnorm = _norm(v)
        if len(vnorm) >= 3 and vnorm in snorm:
            return 1.0                      # contiguous verbatim — strongest
        tk = _significant_tokens(v)
        toks = tk["nums"] + tk["words"]
        if not toks:
            return 1.0                      # nothing distinctive → don't penalise
        hit = sum(1 for n in tk["nums"] if num_in(n)) \
            + sum(1 for w in tk["words"] if w in snorm)
        return hit / len(toks)

    best = score_one(value)
    if evidence:
        best = max(best, score_one(evidence))
    return best


# Which source kinds are verified against WHAT.
#   * analysis / chat  → TRUSTED, never dropped. These come from the agent's
#     own answer, which the chat pipeline ALREADY grounded (react_engine's
#     grounding_verifier runs on it). The proposal set must MIRROR that
#     answer — the user asked for exactly the parameters the AI extracted.
#     Re-verifying here was wrong: the miner correctly DE-SCRAMBLES a value
#     (answer quotes "7.kV 2"; miner emits "7.2 kV"), then a token check
#     against the scrambled answer fails and a real parameter gets dropped.
#   * uploads / gitlab / techserver → verified against the source document
#     (with an answer-match rescue). These are independent schema extractors
#     that can drift OFF the answer, so they still need the precision gate.
#   * tpms / user / default / (anything else) → trusted, not verified.
_ANSWER_KINDS = {"analysis", "chat"}        # trusted — see above
_DOC_KINDS = {"uploads", "gitlab", "techserver"}


async def verify_against_docs(
    by_kind: Dict[str, List[Dict[str, Any]]],
    project_id: str,
    scope: str,
    *,
    answer_text: str = "",
    threshold: float = _DEFAULT_THRESHOLD,
) -> Dict[str, List[Dict[str, Any]]]:
    """Prune proposal candidates that are not grounded in their actual source.
    `by_kind` maps source_kind → list of candidate dicts
    {field, value, confidence, note, doc_id}. `answer_text` is the clean AI
    answer corpus used to verify analysis/chat values. Returns a pruned copy
    and logs what was dropped. Never raises — on any error the input is
    returned unchanged (fail-open: a precision gate must not break
    extraction)."""
    if not by_kind:
        return by_kind
    try:
        from services.soft_source_markup import parse_source_note
        from services.project_memory_service import get_project_memory_service
        q = getattr(get_project_memory_service(), "qdrant", None)
    except Exception as e:  # noqa: BLE001
        logger.warning("soft_grounding: deps unavailable (%s) — skipping", e)
        return by_kind

    answer_norm = _norm(answer_text or "")
    have_answer = len(answer_norm) >= _MIN_SOURCE_CHARS
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
            value = c.get("value")
            score: Optional[float] = None

            if kind in _ANSWER_KINDS:
                # Trusted — the answer is already grounded by the chat
                # pipeline; mirror it verbatim. Leave score None → keep.
                pass
            elif kind in _DOC_KINDS:
                fn = note.get("filename")
                src = text_for(fn) if fn else ""
                if len(src) >= _MIN_SOURCE_CHARS:
                    score = grounded_score(value, src,
                                           evidence=note.get("evidence"))
                # An answer match can still rescue a doc value whose own text
                # layer was unreadable / scrambled.
                if (score is None or score < threshold) and have_answer:
                    a = grounded_score(value, answer_text,
                                       evidence=note.get("evidence"))
                    score = a if score is None else max(score, a)
            # else: trusted kind (tpms/user/default) — leave score None.

            if score is None:
                out.append(c)                     # unverifiable → keep
                continue
            verified += 1
            if score < threshold:
                dropped += 1
                logger.debug("soft_grounding: drop [%s] %s=%r score=%.2f",
                             kind, c.get("field"), value, score)
                continue
            if score >= 0.99:                     # calibration bump
                c["confidence"] = min(0.99, float(c.get("confidence") or 0.5) + 0.1)
            out.append(c)
        if out:
            kept[kind] = out
    if verified:
        logger.info("soft_grounding: verified=%d dropped=%d kept=%d "
                    "(threshold=%.2f, answer=%s)", verified, dropped,
                    verified - dropped, threshold, have_answer)
    return kept
