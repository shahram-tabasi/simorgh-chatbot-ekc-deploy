"""
intent_classifier.py — embedding-based intent router for the Design Suite
bridge (and easy to extend to other intents).

Why embeddings over keyword matching:
  The previous substring router ("create design suite" in user_input) was
  brittle to phrasing ("build my switchgear project in simorgh-soft",
  Persian "پروژه سیمرغ دیزاین رو بساز", "submit the design", "ready to
  hand off to design") — none of which contain the literal phrase. The
  research consensus (Patronus, Arize) is to embed user input and route
  by max-cosine against a small set of intent prototypes.

Design:
  - Prototypes are pre-embedded ONCE at module load, by hitting the same
    embeddings-service the rest of the stack uses (768-dim, embedded
    consistency with documents).
  - score(user_input) returns max cosine across all prototypes for a
    given intent name; the caller compares against a threshold.
  - Safe defaults: if the embeddings-service is unreachable at module
    load, the cache stays empty and score() returns 0.0 — callers must
    fall back to keyword matching or skip the intent. No crash on
    transient infra issues.
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import threading
import urllib.request
from typing import Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

EMBEDDINGS_URL = os.getenv("EMBEDDINGS_URL", "http://embeddings-service:8031")

# Each intent maps to a small set of paraphrases (mix of English + Persian)
# that cover the realistic ways a user might phrase it. KEEP THIS LIST
# SHORT and CANONICAL — embedding search degrades with too many similar
# prototypes; 4-8 paraphrases per intent is enough.
_INTENT_PROTOTYPES: Dict[str, List[str]] = {
    "design_suite_create": [
        "create my simorgh design suite project",
        "build the design suite project for me",
        "submit my design suite project",
        "create the project in simorgh-soft",
        "open my project in design suite",
        "I'm ready, please create the design suite project",
        "finalise the project and create it in design suite",
        "پروژه سیمرغ دیزاین رو بساز",
        "پروژه را در سیمرغ دیزاین ایجاد کن",
    ],
    "design_suite_update": [
        "add templates and devices to my design suite project",
        "update my existing design suite project",
        "populate the device selection tab from this document",
        "add the equipment and device list to my project",
        "fill the create template tab in design suite",
        "extract templates and devices and add them to my project",
        "update the design suite project with this data",
        "تمپلیت و دیوایس‌ها رو به پروژه اضافه کن",
        "پروژه سیمرغ دیزاین رو آپدیت کن",
    ],
}

# Cache: intent name -> list of vectors. Populated once at first use.
_VECTORS: Dict[str, List[List[float]]] = {}
_INIT_LOCK = threading.Lock()
_INITIALISED = False


def _embed_sync(text: str, timeout: float = 8.0) -> Optional[List[float]]:
    try:
        req = urllib.request.Request(
            f"{EMBEDDINGS_URL}/embeddings",
            data=json.dumps({"text": text}).encode(),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.load(r).get("embedding")
    except Exception as e:
        logger.warning("intent_classifier embed failed for %r: %s", text[:40], e)
        return None


def _ensure_initialised() -> None:
    """Lazy one-shot load of intent prototype embeddings."""
    global _INITIALISED
    if _INITIALISED:
        return
    with _INIT_LOCK:
        if _INITIALISED:
            return
        for intent, prototypes in _INTENT_PROTOTYPES.items():
            vecs: List[List[float]] = []
            for p in prototypes:
                v = _embed_sync(p)
                if v:
                    vecs.append(v)
            _VECTORS[intent] = vecs
            logger.info("intent_classifier: cached %d prototype vectors for '%s'",
                        len(vecs), intent)
        _INITIALISED = True


def _cosine(a: List[float], b: List[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    num = sum(x*y for x, y in zip(a, b))
    da = math.sqrt(sum(x*x for x in a))
    db = math.sqrt(sum(y*y for y in b))
    if da == 0 or db == 0:
        return 0.0
    return num / (da * db)


def score(user_input: str, intent: str = "design_suite_create",
          *, fallback_keywords: Optional[List[str]] = None) -> float:
    """Return a 0..1 confidence that `user_input` matches `intent`.
    Max-cosine across the intent's prototype vectors. If embeddings are
    unavailable AND fallback_keywords is provided, returns 0.85 when ANY
    keyword substring is present (so callers always get a usable signal)."""
    if not user_input:
        return 0.0
    _ensure_initialised()
    vecs = _VECTORS.get(intent) or []
    if not vecs:
        # Embeddings unreachable / disabled. Keyword fallback if provided.
        if fallback_keywords:
            low = user_input.lower()
            if any(k.lower() in low for k in fallback_keywords):
                return 0.85
        return 0.0
    q = _embed_sync(user_input)
    if not q:
        if fallback_keywords:
            low = user_input.lower()
            if any(k.lower() in low for k in fallback_keywords):
                return 0.85
        return 0.0
    return max((_cosine(q, v) for v in vecs), default=0.0)


def is_design_suite_create(user_input: str, threshold: float = 0.65) -> bool:
    """Convenience wrapper. The threshold was picked empirically — paraphrases
    of the intent come back ≥0.70; unrelated chat ≤0.50; the gap is wide so
    0.65 is forgiving but precise. Keyword fallback covers the offline case."""
    s = score(user_input, "design_suite_create", fallback_keywords=[
        "design suite", "design-suite", "simorgh-soft", "simorgh soft",
        "سیمرغ دیزاین",
    ])
    return s >= threshold


def is_design_suite_update(user_input: str, threshold: float = 0.62) -> bool:
    """Match 'add templates/devices to / update my EXISTING design suite
    project'. Distinct from create: this PUTs tier-2 data (templates,
    deviceLibrary, equipments) into an already-created project rather
    than building a new one. Keyword fallback keys on the update verbs +
    the tab names so the offline path still fires."""
    s = score(user_input, "design_suite_update", fallback_keywords=[
        "add template", "add device", "device selection", "create template",
        "update my design suite", "update the design suite",
        "add to my design suite", "populate the device",
        "تمپلیت", "دیوایس",
    ])
    return s >= threshold
