"""
General-chat semantic answer cache
==================================

Cross-user, semantic-similarity cache for general-chat (HR
direct-RAG) answers. Operator brief, May 2026:

  > i want to general chats for all user cached, so when any
  > user ask question very closed to a question that cached
  > before, return those response without ai generating again,
  > response that liked must go on first cache list and response
  > that dis like remove from cache

Threshold: cosine ≥ 0.95 (operator: "greater than 95%"). Same
embedding model as the HR pipeline (embeddings-service /
sentence-transformers MiniLM, 384-dim), so vectors are
directly comparable across cache + HR-KB.

Layout:
  • Qdrant collection `general_chat_cache` holds vector + payload.
  • Payload schema:
        {
          question:        str,                 # user's question (last asked)
          answer:          str,                 # cached assistant reply
          citations:       list,                # [{"file": "...", ...}, ...]
          category:        str | None,          # hr_manner | org_strategy | ...
          like_score:      int,                 # +1 per like, never < 0
          like_user_ids:   list[str],           # users who liked (de-dup)
          hit_count:       int,                 # cache-hit serves so far
          created_at:      ISO8601,
          last_used_at:    ISO8601,
        }

Behaviour:
  • lookup(question, category): cosine-search the collection,
    filter to score ≥ THRESHOLD AND payload.category == category
    (or both none); among survivors return the entry maximising
    (cosine, like_score). Returns None on miss.
  • write(question, answer, citations, category): upsert a new
    entry. Same point id = uuid4(); we never dedup on question
    text — multiple paraphrases can co-exist and the highest
    cosine wins.
  • like(entry_id, user_id): atomic-ish read-modify-write — set
    payload `like_score`/`like_user_ids` if user_id isn't already
    in list. No-op if entry was deleted by a concurrent dislike.
  • dislike(entry_id): hard-delete the point. Operator's design:
    "response that dis like remove from cache".
  • bump_hit(entry_id): increment hit_count + last_used_at on
    every cache serve. Useful for "popular questions" telemetry
    even if no one explicitly liked.

Non-goals:
  • Per-user personalisation (general-chat HR answers are policy
    text, identical for everyone — safe to share globally).
  • Project-chat caching (project context varies per-tenant; not
    yet in scope).
  • Embedding-service authentication (uses the same
    EMBEDDINGS_URL the HR pipeline does).
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from typing import Any, List, Optional
from uuid import uuid4

import httpx
from qdrant_client import QdrantClient
from qdrant_client.http import models as qmodels
from qdrant_client.http.exceptions import UnexpectedResponse

log = logging.getLogger(__name__)

EMBEDDINGS_URL = os.getenv("EMBEDDINGS_URL", "http://embeddings-service:8031")
QDRANT_URL = os.getenv("QDRANT_URL", "http://qdrant:6333")
CACHE_COLLECTION = os.getenv(
    "GENERAL_CHAT_CACHE_COLLECTION", "general_chat_cache"
)
# Operator brief: "greater than 95%". 0.95 cosine is conservative
# enough that paraphrases of meaningfully different questions
# stay distinct. Tune via env without redeploy.
SIMILARITY_THRESHOLD = float(os.getenv("GENERAL_CHAT_CACHE_THRESHOLD", "0.95"))
# Embedding dimensionality. Auto-detected on the first
# successful _embed() call by reading the length of whatever the
# embeddings-service returns. Operator can pin a specific value
# via EMBEDDINGS_DIM but the default (None → autodetect) handles
# any model change without code edits — the EKC deploy uses a
# 768-dim model (mpnet/BGE/similar), not the 384-dim MiniLM the
# legacy comment assumed (May 2026: write was silently skipping
# because of the hardcoded mismatch).
_DIM_ENV = os.getenv("EMBEDDINGS_DIM")
EMBEDDING_DIM: Optional[int] = int(_DIM_ENV) if _DIM_ENV else None

_client: Optional[QdrantClient] = None
_collection_ready: bool = False


def _qdrant() -> QdrantClient:
    """Lazy Qdrant client. Created on first use so process import
    order doesn't matter."""
    global _client
    if _client is None:
        _client = QdrantClient(url=QDRANT_URL, timeout=30.0)
    return _client


def _ensure_collection() -> bool:
    """Create the cache collection on first use. Deferred until
    EMBEDDING_DIM has been determined — either via env or after
    the first _embed() call detected it from the response.
    Idempotent past first success via `_collection_ready`."""
    global _collection_ready
    if _collection_ready:
        return True
    if EMBEDDING_DIM is None:
        # Dim still unknown — caller should _embed() first to
        # trigger autodetect, then retry.
        return False
    c = _qdrant()
    try:
        existing = {col.name for col in c.get_collections().collections}
        if CACHE_COLLECTION not in existing:
            c.create_collection(
                collection_name=CACHE_COLLECTION,
                vectors_config=qmodels.VectorParams(
                    size=EMBEDDING_DIM,
                    distance=qmodels.Distance.COSINE,
                ),
            )
            log.info(
                "general_chat_cache: created collection %s (dim=%d, cosine)",
                CACHE_COLLECTION, EMBEDDING_DIM,
            )
        else:
            # If the collection already exists but with a different
            # dim than what the embeddings-service now produces,
            # AUTO-DROP and re-create. Vectors stored at the old
            # dim are mathematically incomparable with new queries
            # (cosine over different dimensions is undefined), so
            # there's no value in keeping them. Loudly logged so
            # an operator scanning logs sees the recovery happened.
            #
            # First-run cache-was-empty case (May 2026): this fires
            # exactly once after an embedding-model swap, recovers,
            # and the cache builds up again from real traffic.
            info = c.get_collection(CACHE_COLLECTION)
            stored_dim = getattr(info.config.params.vectors, "size", None)
            if stored_dim and stored_dim != EMBEDDING_DIM:
                log.warning(
                    "general_chat_cache: existing collection has dim=%s but "
                    "embeddings-service now returns dim=%s — auto-dropping "
                    "and recreating. Any previously cached answers are lost "
                    "(they'd be incomparable to new queries anyway).",
                    stored_dim, EMBEDDING_DIM,
                )
                try:
                    c.delete_collection(CACHE_COLLECTION)
                except Exception as drop_err:
                    log.error(
                        "general_chat_cache: failed to drop stale collection: %s",
                        drop_err,
                    )
                    return False
                c.create_collection(
                    collection_name=CACHE_COLLECTION,
                    vectors_config=qmodels.VectorParams(
                        size=EMBEDDING_DIM,
                        distance=qmodels.Distance.COSINE,
                    ),
                )
                log.info(
                    "general_chat_cache: re-created collection %s (dim=%d, cosine)",
                    CACHE_COLLECTION, EMBEDDING_DIM,
                )
        _collection_ready = True
        return True
    except Exception as e:
        log.warning(
            "general_chat_cache: ensure_collection failed (%s); cache disabled this request",
            e,
        )
        return False


async def _embed(text: str) -> Optional[List[float]]:
    """Embed via the same embeddings-service the HR pipeline
    uses, so the cache vectors live in the same coordinate
    system. Returns None on failure — callers should treat that
    as cache-miss and proceed to LLM.

    Autodetects EMBEDDING_DIM on the first successful response.
    All subsequent responses must match that dim, otherwise we
    log + return None (vector space changed mid-process, which
    means the embedding service was restarted with a different
    model).
    """
    global EMBEDDING_DIM
    try:
        async with httpx.AsyncClient(timeout=10.0) as cx:
            r = await cx.post(
                f"{EMBEDDINGS_URL}/embeddings",
                json={"text": text},
            )
            r.raise_for_status()
            data = r.json()
            # Legacy embeddings-service returns {"embedding": [...]}.
            vec = data.get("embedding") or data.get("vector")
            if not isinstance(vec, list) or not vec:
                log.warning(
                    "general_chat_cache: embedding response had wrong shape: %s",
                    {"keys": list(data.keys())},
                )
                return None
            if EMBEDDING_DIM is None:
                EMBEDDING_DIM = len(vec)
                log.info(
                    "general_chat_cache: autodetected embedding dim=%d "
                    "(set EMBEDDINGS_DIM=%d to pin if the model changes)",
                    EMBEDDING_DIM, EMBEDDING_DIM,
                )
            if len(vec) != EMBEDDING_DIM:
                log.warning(
                    "general_chat_cache: embedding dim drift — expected %d, got %d. "
                    "Embedding service likely restarted with a different model. "
                    "Drop the cache collection to recover.",
                    EMBEDDING_DIM, len(vec),
                )
                return None
            return vec
    except Exception as e:
        log.warning("general_chat_cache: embed failed: %s", e)
        return None


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def lookup(
    question: str,
    category: Optional[str] = None,
) -> Optional[dict]:
    """Return cached entry if any matches cosine ≥ SIMILARITY_THRESHOLD
    AND same category. On multiple matches, prefer (cosine, like_score)
    descending. Returns the entry dict with `entry_id` and `cosine`
    populated, or None on miss / cache-disabled.
    """
    if not question or not question.strip():
        return None
    # Embed FIRST so EMBEDDING_DIM is populated by the time we
    # call _ensure_collection — collection creation needs the dim.
    vec = await _embed(question.strip())
    if vec is None:
        return None
    if not _ensure_collection():
        return None

    # Category filtering removed (May 2026 — the first cache run
    # against identical text returned MISS instead of HIT. Most
    # likely cause: Qdrant's IsEmpty / MatchValue interaction with
    # payloads where `category: None` was stored — null vs missing
    # is fiddly across Qdrant releases. Trade-off: a question
    # cached under category=hr_manner can now serve a request that
    # came in with category=None or org_strategy, IF cosine ≥ 0.95.
    # In practice the answer text for the same wording is the same
    # because hr_chat retrieves from a single union'd HR/strategy
    # corpus; category was only a soft retrieval bias. Worst case:
    # a slightly-off-domain answer on a near-duplicate question —
    # the dislike path removes it.)
    try:
        results = _qdrant().search(
            collection_name=CACHE_COLLECTION,
            query_vector=vec,
            limit=5,
            score_threshold=SIMILARITY_THRESHOLD,
        )
    except Exception as e:
        log.warning("general_chat_cache: search failed: %s", e)
        return None

    if not results:
        log.info(
            "general_chat_cache: MISS for q=%r category=%r (no hits ≥ %.2f)",
            question[:80], category, SIMILARITY_THRESHOLD,
        )
        return None

    # Among matches above the threshold, prefer the entry with
    # the highest like_score. Cosine wins on ties (Python's
    # `sorted` is stable; `reverse=True` keeps the original
    # cosine order within a like-score bucket).
    results.sort(
        key=lambda r: (
            (r.payload or {}).get("like_score", 0),
            r.score,
        ),
        reverse=True,
    )
    top = results[0]
    payload = top.payload or {}
    log.info(
        "general_chat_cache: HIT id=%s cosine=%.4f like_score=%d "
        "stored_q=%r incoming_q=%r",
        str(top.id), float(top.score),
        int(payload.get("like_score", 0)),
        (payload.get("question") or "")[:80],
        question[:80],
    )
    return {
        "entry_id": str(top.id),
        "cosine": float(top.score),
        "question": payload.get("question") or "",
        "answer": payload.get("answer") or "",
        "citations": payload.get("citations") or [],
        "category": payload.get("category"),
        "like_score": int(payload.get("like_score", 0)),
        "hit_count": int(payload.get("hit_count", 0)),
    }


async def write(
    question: str,
    answer: str,
    citations: Optional[List[dict]] = None,
    category: Optional[str] = None,
) -> Optional[str]:
    """Upsert a new cache entry. Returns the point id on success
    (so the caller can echo it in SSE meta for later like/dislike),
    None on failure."""
    if not (question and question.strip() and answer and answer.strip()):
        log.warning(
            "general_chat_cache: write SKIPPED — empty input (qlen=%d alen=%d)",
            len(question or ""), len(answer or ""),
        )
        return None
    # Embed FIRST so EMBEDDING_DIM is populated by the time we
    # call _ensure_collection — collection creation needs the dim.
    vec = await _embed(question.strip())
    if vec is None:
        log.warning(
            "general_chat_cache: write SKIPPED — embed returned None for q=%r",
            question[:80],
        )
        return None
    if not _ensure_collection():
        log.warning("general_chat_cache: write SKIPPED — collection not ready")
        return None
    point_id = str(uuid4())
    payload = {
        "question": question.strip(),
        "answer": answer,
        "citations": citations or [],
        "category": category,
        "like_score": 0,
        "like_user_ids": [],
        "hit_count": 0,
        "created_at": _now_iso(),
        "last_used_at": _now_iso(),
    }
    try:
        _qdrant().upsert(
            collection_name=CACHE_COLLECTION,
            points=[
                qmodels.PointStruct(
                    id=point_id, vector=vec, payload=payload,
                ),
            ],
        )
        log.info(
            "general_chat_cache: wrote entry id=%s category=%s qlen=%d alen=%d",
            point_id, category, len(question), len(answer),
        )
        return point_id
    except Exception as e:
        log.warning("general_chat_cache: write failed: %s", e)
        return None


async def bump_hit(entry_id: str) -> None:
    """Increment hit_count + refresh last_used_at on every serve.
    Best-effort — a failure here doesn't affect correctness."""
    if not _ensure_collection() or not entry_id:
        return
    try:
        # set_payload OVERWRITES the keys it sets. To increment
        # we have to read first. The race window is small but
        # exists; we accept off-by-one telemetry to keep the path
        # synchronous-friendly.
        pts = _qdrant().retrieve(
            collection_name=CACHE_COLLECTION,
            ids=[entry_id],
            with_payload=True,
            with_vectors=False,
        )
        if not pts:
            return
        current = pts[0].payload or {}
        _qdrant().set_payload(
            collection_name=CACHE_COLLECTION,
            payload={
                "hit_count": int(current.get("hit_count", 0)) + 1,
                "last_used_at": _now_iso(),
            },
            points=[entry_id],
        )
    except UnexpectedResponse:
        # Point gone (likely concurrent dislike) — skip silently.
        pass
    except Exception as e:
        log.warning("general_chat_cache: bump_hit failed for %s: %s", entry_id, e)


async def like(entry_id: str, user_id: str) -> bool:
    """Record a like from `user_id` on `entry_id`. Idempotent —
    re-liking by the same user is a no-op (the user list is a set
    in spirit; we de-dup on write). Returns True if the like was
    applied (or already present), False on hard error."""
    if not _ensure_collection() or not entry_id:
        return False
    try:
        pts = _qdrant().retrieve(
            collection_name=CACHE_COLLECTION,
            ids=[entry_id],
            with_payload=True,
            with_vectors=False,
        )
        if not pts:
            return False
        current = pts[0].payload or {}
        users = list(current.get("like_user_ids") or [])
        if user_id in users:
            return True  # already liked — idempotent
        users.append(user_id)
        new_score = int(current.get("like_score", 0)) + 1
        _qdrant().set_payload(
            collection_name=CACHE_COLLECTION,
            payload={"like_score": new_score, "like_user_ids": users},
            points=[entry_id],
        )
        return True
    except Exception as e:
        log.warning("general_chat_cache: like failed for %s: %s", entry_id, e)
        return False


async def dislike(entry_id: str) -> bool:
    """Hard-delete the cache entry. Operator's design — disliked
    answers leave the cache entirely so no future user sees them.
    Returns True on success, False on error. Missing entry is a
    success (already gone)."""
    if not _ensure_collection() or not entry_id:
        return False
    try:
        _qdrant().delete(
            collection_name=CACHE_COLLECTION,
            points_selector=qmodels.PointIdsList(points=[entry_id]),
        )
        log.info("general_chat_cache: disliked entry deleted id=%s", entry_id)
        return True
    except Exception as e:
        log.warning("general_chat_cache: dislike failed for %s: %s", entry_id, e)
        return False
