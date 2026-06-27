"""
soft_value_filter.py — reject NON-VALUES so abstentions never become proposals.

The grounding contract asks the analysis model to write "not specified in the
provided documents" rather than invent a value (good for the chat answer). But
when those abstentions are mined into the Design Suite proposals they become
fake parameters: the review list fills with "not specified", and the source
viewer then searches the PDF for that phrase and highlights the word
"specified" on a random page.

Information-extraction best practice (ExtractBench / KBP slot-filling) treats a
field three ways — PRESENT, NULL, MISSING — and an abstention is a NULL that
should be reported as MISSING, not as a populated value: "a system that
produces extraneous values is more problematic than one that leaves entries
unspecified." So we drop abstentions/null-likes at the proposal boundary and
keep only genuinely populated values.
"""
from __future__ import annotations

import re
from typing import Any

# Exact (after normalization) null-likes.
_NONVALUE_EXACT = {
    "", "-", "--", "—", "–", "n/a", "n.a", "n.a.", "na", "none", "null",
    "nil", "tbd", "tba", "unknown", "unspecified", "?", "??", "...", "…",
    "x", "xx", "void", "empty", "blank", "no", "yes/no", "value", "tbc",
}

# Phrases an abstaining extractor emits — match as a PREFIX after stripping
# surrounding punctuation/quotes, so the whole verbose contract phrasing
# ("not specified in the provided documents.") is caught too.
_NONVALUE_PREFIX = (
    "not specified", "not found", "not provided", "not mentioned",
    "not stated", "not indicated", "not available", "not applicable",
    "not given", "not defined", "not present", "not listed", "not explicitly",
    "not directly", "not described", "no value", "no data", "no information",
    "no specific", "no mention", "cannot be determined", "could not find",
    "could not be", "to be determined", "to be confirmed", "to be advised",
    "see drawing", "see above", "see note", "refer to", "as per drawing",
)

# Persian / Arabic letter range so non-latin real values still count.
_ALNUM = re.compile(r"[A-Za-z0-9؀-ۿ]")


def is_meaningful_value(value: Any) -> bool:
    """True when `value` is a genuinely populated value worth proposing.

    Numbers/bools are always meaningful. Containers are meaningful when they
    hold at least one meaningful child. Strings are rejected when they are a
    null-like token or an abstention phrase, or carry no alphanumeric content.
    """
    if value is None:
        return False
    if isinstance(value, bool):
        return True
    if isinstance(value, (int, float)):
        return True
    if isinstance(value, dict):
        return any(is_meaningful_value(v) for v in value.values()) if value else False
    if isinstance(value, (list, tuple, set)):
        return any(is_meaningful_value(v) for v in value) if value else False

    s = re.sub(r"\s+", " ", str(value)).strip()
    if not s:
        return False
    # Strip surrounding quotes/punctuation for the token/prefix tests.
    low = s.lower().strip(" \t.:;,!-–—\"'`“”()[]{}")
    if not low:
        return False
    if low in _NONVALUE_EXACT:
        return False
    for p in _NONVALUE_PREFIX:
        if low.startswith(p):
            return False
    # The full contract phrasing can be embedded mid-string.
    if "not specified in the provided" in low:
        return False
    if "not specified in the document" in low:
        return False
    # Must contain at least one alphanumeric (latin/persian) glyph.
    if not _ALNUM.search(s):
        return False
    return True
