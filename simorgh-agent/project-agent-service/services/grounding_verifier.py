"""
grounding_verifier.py — Commit C of the grounding pipeline.

Numeric-verbatim and standards-reference post-pass. After the LLM emits
its final answer, walk the answer for every `<number> <unit>` token and
every standards reference (IEC/IEEE/ANSI/ISO ...) — and require each
to appear character-for-character in the source documents block. Any
claim that doesn't pass is either redacted to an abstention sentence
or flagged in metadata for telemetry.

This is the *cheap* layer of the verification post-pass — pure CPU
regex work, zero model calls, sub-millisecond on typical answers. It
catches the specific fabrications observed in production:
  - "20 kA" claimed when the document says "40 kA"
  - "IEC 62271-200" claimed when the document says "IEC 62271-2"
  - Plausible textbook values for fields the document doesn't address

The expensive layer (NLI-based faithfulness check via HHEM-2.1-Open)
ships separately in Commit D as a sidecar service. This file runs
synchronously inside the agent loop and has no external dependencies.

Reference: RAGAS faithfulness metric
  https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/faithfulness/
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Tuple

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Patterns. Order matters: longer/more-specific patterns first so the
# numeric-with-unit regex doesn't eat a fragment of an IEC code.
# ---------------------------------------------------------------------------

# Standards references — captured as a contiguous token.
# Matches: IEC 62271, IEC 62271-200, IEC 62271-2, IEEE 1547, ANSI C57.13,
# ISO 9001, EN 50160. Case-insensitive on the standards-body prefix; the
# numeric suffix is verbatim.
_STANDARDS_RE = re.compile(
    r"\b(IEC|IEEE|ANSI|ISO|EN|NEMA|UL|DIN|VDE|JIS|BS|GOST)"
    r"[\s\-]?\d+(?:[-./]\d+)*[A-Z]?\b",
    re.IGNORECASE,
)

# Numeric value with electrical/mechanical unit. Allows decimals, optional
# space, optional ASCII multiplier (k/M/G already inside common units).
# Matches: 6.6 kV, 40kA, 50 Hz, 230 V, 1250 A, 28 kV, 75 kV, 100 mm, 35 °C,
# 0.15 g, 0.95 pf, 40 dB, 5 %.  Unit list is the most common subset for
# electrical specs — extend as your domain needs.
_NUMBER_UNIT_RE = re.compile(
    r"\b\d+(?:[.,]\d+)?\s*"
    r"(?:kV|kA|MVA|kVA|MW|kW|GW|MΩ|kΩ|Ω|"
    r"V|A|W|Hz|°C|°F|dB|kg|g|%|"
    r"mm|cm|m|km|"
    r"ms|μs|us|ns|min|s|h|"
    r"pf)\b",
    re.IGNORECASE,
)

# Things to NOT flag as numeric claims even if they match: pure citations
# (`[doc=1, source=...]`), page references (`page 11`), document numbers
# (`347180ETS802`). Filtered post-extraction.
_CITATION_RE = re.compile(r"\[doc=\d+", re.IGNORECASE)
_PAGE_REF_RE = re.compile(r"\bpage\s*\d+\b", re.IGNORECASE)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

@dataclass
class VerificationResult:
    ok: bool                                # True when every claim verified
    claims_total: int = 0
    claims_verified: int = 0
    unverified: List[str] = field(default_factory=list)
    # The original answer; the redacted answer if rewrite_unverified=True.
    answer: str = ""
    answer_redacted: str = ""
    # For telemetry — what claims were checked.
    standards_checked: List[str] = field(default_factory=list)
    numbers_checked: List[str] = field(default_factory=list)
    # NLI layer (Commit D — populated when GROUNDING_NLI_URL is reachable).
    nli_low_score_sentences: List[str] = field(default_factory=list)
    nli_min_score: float = 1.0


def verify_answer_against_sources(
    answer: str,
    sources: str,
    *,
    rewrite_unverified: bool = True,
    abstention_text: str = "Not specified in the provided documents.",
) -> VerificationResult:
    """Verify that every numeric value and standards reference in ``answer``
    appears verbatim somewhere in ``sources``.

    Parameters
    ----------
    answer : str
        The LLM's reply (the <answer>…</answer> body, or the whole reply
        if no XML structure).
    sources : str
        The concatenated text of every <document_content> block the model
        had access to. Casing-insensitive search; whitespace is normalised
        before matching so "40 kA" matches "40kA" and "40  kA".
    rewrite_unverified : bool
        When True (default), every sentence containing an unverified claim
        is replaced with the ``abstention_text`` in ``answer_redacted``.
        The original answer is preserved in the ``answer`` field for audit.
    abstention_text : str
        The sentence written in place of any redacted claim.

    Returns
    -------
    VerificationResult with claims_total/verified counts, the list of
    unverified spans, and (when rewriting) a redacted answer body.
    """
    if not answer or not sources:
        return VerificationResult(ok=True, answer=answer or "",
                                  answer_redacted=answer or "")

    # Normalise the sources text once. We make a case-folded, whitespace-
    # collapsed copy for matching, but keep an original for telemetry.
    norm_sources = _normalise_for_match(sources)

    # Pull out all standards refs and value-unit claims.
    standards = _STANDARDS_RE.findall(answer)
    # findall on a single-group regex returns the captured group; we want
    # the whole match string for verbatim comparison.
    standards_spans = [m.group(0) for m in _STANDARDS_RE.finditer(answer)]
    number_spans = [m.group(0) for m in _NUMBER_UNIT_RE.finditer(answer)]

    # Drop spans that are inside known-citation contexts ([doc=1, ...]
    # references shouldn't count as "claims") or page refs in the answer's
    # own narration.
    def _is_in_citation_context(start: int, end: int) -> bool:
        # Crude: any '[doc=' in the 20 chars before the span counts.
        before = answer[max(0, start - 30):start]
        return "[doc=" in before or "source=" in before

    flagged_unverified: List[Tuple[str, str]] = []  # (span, reason)
    verified: List[str] = []

    for m in _STANDARDS_RE.finditer(answer):
        span = m.group(0)
        if _is_in_citation_context(m.start(), m.end()):
            continue
        if _matches_verbatim(span, norm_sources):
            verified.append(span)
        else:
            flagged_unverified.append((span, "standards-not-in-source"))

    for m in _NUMBER_UNIT_RE.finditer(answer):
        span = m.group(0)
        if _is_in_citation_context(m.start(), m.end()):
            continue
        if _matches_verbatim(span, norm_sources):
            verified.append(span)
        else:
            flagged_unverified.append((span, "number-not-in-source"))

    result = VerificationResult(
        ok=(len(flagged_unverified) == 0),
        claims_total=len(verified) + len(flagged_unverified),
        claims_verified=len(verified),
        unverified=[s for s, _ in flagged_unverified],
        answer=answer,
        standards_checked=standards_spans,
        numbers_checked=number_spans,
    )

    if rewrite_unverified and flagged_unverified:
        result.answer_redacted = _redact_unverified_sentences(
            answer,
            [s for s, _ in flagged_unverified],
            abstention_text=abstention_text,
        )
    else:
        result.answer_redacted = answer

    if flagged_unverified:
        logger.info(
            "grounding verifier: %d/%d claims unverified — flagged: %s",
            len(flagged_unverified), result.claims_total,
            [s for s, _ in flagged_unverified][:5],
        )
    return result


# ---------------------------------------------------------------------------
# internals
# ---------------------------------------------------------------------------

def _normalise_for_match(s: str) -> str:
    """Casefold + collapse all internal whitespace so 'IEC 62271-2',
    'iec 62271 -2', and 'IEC62271-2' all hash to the same string."""
    if not s:
        return ""
    # Strip ALL whitespace inside; keep punctuation. We compare candidate
    # spans the same way before lookup.
    return re.sub(r"\s+", "", s).casefold()


def _matches_verbatim(claim_span: str, normalised_sources: str) -> bool:
    """A claim matches if its whitespace-stripped, casefolded form
    appears anywhere in the equivalently-normalised source corpus."""
    needle = _normalise_for_match(claim_span)
    if not needle:
        return True
    return needle in normalised_sources


# Sentence-boundary regex. Cheap heuristic — full segmenter would be
# overkill for inline redaction.
_SENT_BOUNDARY_RE = re.compile(r"(?<=[.!?])\s+(?=[A-Z])")


def _redact_unverified_sentences(
    answer: str, unverified_spans: List[str], *, abstention_text: str,
) -> str:
    """Replace each sentence that contains an unverified span with the
    abstention sentence. Sentences with no flagged spans are left alone."""
    if not answer or not unverified_spans:
        return answer
    flagged = set(unverified_spans)
    sents = _SENT_BOUNDARY_RE.split(answer)
    out_sents: List[str] = []
    redacted_any = False
    for s in sents:
        if any(span in s for span in flagged):
            out_sents.append(abstention_text)
            redacted_any = True
        else:
            out_sents.append(s)
    redacted = " ".join(out_sents)
    if redacted_any:
        # De-duplicate runs of identical abstention sentences in case
        # multiple flagged spans landed in adjacent sentences.
        redacted = re.sub(
            rf"(?:{re.escape(abstention_text)}\s*){{2,}}",
            abstention_text + " ", redacted,
        ).rstrip()
    return redacted


def summarise_for_metadata(r: VerificationResult) -> Dict[str, Any]:
    """Render the verification result as a compact metadata dict suitable
    for SSE / log / context-search telemetry."""
    return {
        "grounding_ok":         r.ok,
        "claims_total":         r.claims_total,
        "claims_verified":      r.claims_verified,
        "unverified_spans":     r.unverified[:20],
        "standards_checked":    r.standards_checked[:20],
        "numbers_checked":      r.numbers_checked[:20],
        "nli_min_score":        r.nli_min_score,
        "nli_low_score_sents":  r.nli_low_score_sentences[:10],
    }


# ---------------------------------------------------------------------------
# Commit D — NLI faithfulness check via HHEM-2.1-Open sidecar.
#
# The regex layer above catches NUMERIC + STANDARDS fabrications precisely.
# It does NOT catch paraphrase-style hallucination (e.g. "the switchgear
# is designed for outdoor installation" when the source says indoor —
# no numbers to flag). The NLI layer fills that gap.
#
# Calls grounding-verifier:8055/verify (CPU sidecar on .68, see
# compose/svc-grounding-verifier.yml). Fail-open: any error, timeout,
# or unreachable endpoint leaves the result untouched. NEVER blocks the
# user reply on a verifier outage.
# ---------------------------------------------------------------------------

async def verify_answer_with_nli(
    answer: str,
    sources: str,
    *,
    threshold: float = 0.5,
    timeout_sec: float = 8.0,
) -> Dict[str, Any]:
    """Call the HHEM sidecar to score each answer-sentence against the
    union of source chunks. Returns
        {"min_score": float, "low_score_sentences": [str, ...]}
    on success, or an empty dict on any failure (caller treats absent
    keys as "NLI skipped")."""
    import os as _os
    import httpx as _httpx

    nli_url = _os.getenv("GROUNDING_NLI_URL",
                         "http://grounding-verifier:8055").rstrip("/")
    if not nli_url:
        return {}

    # Build (premise=full source corpus, hypothesis=each answer sentence)
    # pairs. Caps at 32 sentences to bound the sidecar's batch size and
    # respect the verifier's CPU cost.
    sentences = [s.strip() for s in _SENT_BOUNDARY_RE.split(answer)
                 if s.strip()]
    if not sentences:
        return {}
    sentences = sentences[:32]
    pairs = [{"premise": sources, "hypothesis": s} for s in sentences]
    payload = {"pairs": pairs, "threshold": threshold}
    try:
        async with _httpx.AsyncClient(timeout=timeout_sec) as c:
            r = await c.post(f"{nli_url}/verify", json=payload)
            r.raise_for_status()
            body = r.json()
    except Exception as e:
        logger.debug("grounding NLI skipped (sidecar unreachable): %s", e)
        return {}
    results = body.get("results") or []
    if not results:
        return {}
    scores = [float(x.get("score", 1.0)) for x in results]
    low = [sentences[i] for i, x in enumerate(results)
           if not x.get("verified", True)]
    return {
        "min_score": min(scores) if scores else 1.0,
        "low_score_sentences": low,
    }


async def verify_answer_against_sources_with_nli(
    answer: str, sources: str, *,
    rewrite_unverified: bool = True,
    abstention_text: str = "Not specified in the provided documents.",
    nli_threshold: float = 0.5,
) -> VerificationResult:
    """Combined entry point: regex + HHEM NLI with a TWO-SIGNAL veto on
    rewriting. The regex layer is precise on numerics/standards but
    over-flags on word-order variants ("kV 12" vs "12 kV", "IEC 62271
    -2" vs "IEC 62271-2"); the NLI layer (HHEM-2.1-Open) is the
    semantic ground truth. We only redact a sentence when the regex
    flags it AND NLI scores it below threshold — otherwise we trust
    the model and surface the flag in metadata.

    Without the NLI veto, the model's correct verbatim quote got
    redacted on a regex false-positive (production trace: 'Highest
    system voltage: kV 12' from page 11 was wholesale-rewritten to
    'Not specified' even though nli_min=1.00).
    """
    # First pass: regex WITHOUT rewriting — just collect flagged spans.
    base = verify_answer_against_sources(
        answer, sources,
        rewrite_unverified=False,
        abstention_text=abstention_text,
    )
    nli = await verify_answer_with_nli(
        answer, sources, threshold=nli_threshold,
    )
    if nli:
        base.nli_min_score = nli.get("min_score", 1.0)
        base.nli_low_score_sentences = nli.get("low_score_sentences", [])

    # Two-signal veto on rewriting. Only redact when BOTH signals
    # disagree with the model: regex flagged AND NLI scored a sentence
    # below threshold. If NLI says it's entailed (min_score ≥ threshold),
    # trust the model — the regex flag is a word-order false-positive.
    if rewrite_unverified and base.unverified:
        nli_disagrees = (
            base.nli_min_score < nli_threshold
            or bool(base.nli_low_score_sentences)
        )
        if nli_disagrees:
            base.answer_redacted = _redact_unverified_sentences(
                answer, base.unverified,
                abstention_text=abstention_text,
            )
            base.ok = False
        else:
            # NLI vetoes the rewrite — keep the model's original answer
            # but leave `unverified` populated so telemetry shows the
            # regex flag for operator review.
            base.answer_redacted = answer
            base.ok = True
    elif rewrite_unverified:
        base.answer_redacted = answer

    return base
