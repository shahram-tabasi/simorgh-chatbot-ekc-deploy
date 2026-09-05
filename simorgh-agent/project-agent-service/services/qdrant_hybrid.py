"""
qdrant_hybrid.py — Qdrant native hybrid retrieval (dense bge-m3 + sparse
BM25) with RRF fusion and optional cross-encoder reranking.

Why this exists
===============
The legacy `qdrant_service.QdrantService.semantic_search` runs ONE dense
top-k call against a single 768-dim `all-MiniLM-L6-v2` vector. That has
two problems against an engineering-spec corpus:

  1. **Identifiers** like "L11B", "INC 2", "OE-04A12065", "IEC 62271-200"
     don't embed well — semantic search collapses them. BM25 retrieves
     them exactly. Hybrid (dense ∪ sparse) catches both kinds of query.

  2. **Persian-language content** (project descriptions, client names in
     Persian, mixed Persian-English paragraphs) is largely invisible to
     `all-MiniLM-L6-v2`, which is English-only. bge-m3 is multilingual
     across 100+ languages including Persian and Arabic.

Qdrant ≥1.10 supports both natively via the Query API with `prefetch`:
fan out dense + sparse retrieval in a single server-side call and fuse
with Reciprocal Rank Fusion. RRF over weighted score fusion is the
2026 production default — weighted fusion is the single most common
cause of broken hybrid pipelines (incompatible score scales).

After fusion, a cross-encoder reranker (bge-reranker-v2-m3) re-scores
the fused top-50 and returns top-k. This is the "two-stage funnel" all
the 2026 production write-ups converge on.

Operational notes
=================
* New collection schema: NAMED VECTORS with `dense` (1024-dim cosine)
  and `sparse` (BM25). Existing dense-only collections must be migrated
  via `scripts/migrate_qdrant_hybrid.py` — the helpers here detect the
  old schema and raise a clear error rather than silently writing into
  a half-broken state.

* Model footprint: bge-m3 ~2.2 GB, bge-reranker-v2-m3 ~600 MB, BM25
  encoder ~50 MB. All run on CPU; GPU optional. Pre-download into a
  shared HF cache mount so the offline boxes don't try to fetch.

* All entry points fall back gracefully: any failure in encoding /
  search / rerank returns []; callers should treat hybrid as a
  best-effort lift over the existing dense path, not a hard dependency.
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Tunables (env-driven so ops can flex without redeploying code)
# ---------------------------------------------------------------------------
QDRANT_HYBRID_ENABLED = os.getenv("QDRANT_HYBRID", "1").lower() in (
    "1", "true", "yes", "on",
)
DENSE_MODEL_NAME = os.getenv("EMBEDDING_MODEL", "BAAI/bge-m3")
DENSE_DIM = int(os.getenv("QDRANT_COLLECTION_SIZE", "1024"))
SPARSE_MODEL_NAME = os.getenv("QDRANT_SPARSE_MODEL", "Qdrant/bm25")
RERANKER_MODEL_NAME = os.getenv("QDRANT_RERANKER_MODEL", "BAAI/bge-reranker-v2-m3")
RERANK_ENABLED = os.getenv("QDRANT_RERANK", "1").lower() in (
    "1", "true", "yes", "on",
)

# Vector NAMES inside the named-vectors collection. Match these everywhere.
DENSE_VEC_NAME = "dense"
SPARSE_VEC_NAME = "sparse"

# Retrieval breadth: prefetch top-N from each branch, fuse, then take
# fused top-K, then rerank to final top-M.
PREFETCH_DENSE = int(os.getenv("QDRANT_PREFETCH_DENSE", "60"))
PREFETCH_SPARSE = int(os.getenv("QDRANT_PREFETCH_SPARSE", "60"))
FUSE_TOP_K = int(os.getenv("QDRANT_FUSE_TOP_K", "30"))


# ---------------------------------------------------------------------------
# Encoder loaders — lazy + cached so importing the module is free
# ---------------------------------------------------------------------------
_dense_model = None
_sparse_model = None
_reranker_model = None


def _load_dense():
    """Sentence-transformers bge-m3, cached. Returns None on import error
    so callers can fall back to the legacy dense path."""
    global _dense_model
    if _dense_model is not None:
        return _dense_model
    try:
        from sentence_transformers import SentenceTransformer
    except Exception as e:  # noqa: BLE001
        logger.warning("qdrant_hybrid: sentence_transformers missing: %s", e)
        return None
    try:
        _dense_model = SentenceTransformer(DENSE_MODEL_NAME, device="cpu")
        logger.info("qdrant_hybrid: dense encoder %s loaded", DENSE_MODEL_NAME)
        return _dense_model
    except Exception as e:  # noqa: BLE001
        logger.warning("qdrant_hybrid: failed to load %s: %s",
                       DENSE_MODEL_NAME, e)
        return None


def _load_sparse():
    """FastEmbed BM25 sparse encoder. Single dependency (fastembed)."""
    global _sparse_model
    if _sparse_model is not None:
        return _sparse_model
    try:
        from fastembed import SparseTextEmbedding
    except Exception as e:  # noqa: BLE001
        logger.warning("qdrant_hybrid: fastembed missing: %s", e)
        return None
    try:
        _sparse_model = SparseTextEmbedding(model_name=SPARSE_MODEL_NAME)
        logger.info("qdrant_hybrid: sparse encoder %s loaded", SPARSE_MODEL_NAME)
        return _sparse_model
    except Exception as e:  # noqa: BLE001
        logger.warning("qdrant_hybrid: failed to load %s: %s",
                       SPARSE_MODEL_NAME, e)
        return None


def _load_reranker():
    """Cross-encoder reranker (bge-reranker-v2-m3). Optional; rerank
    silently no-ops if the encoder isn't available."""
    global _reranker_model
    if _reranker_model is not None:
        return _reranker_model
    if not RERANK_ENABLED:
        return None
    try:
        from sentence_transformers import CrossEncoder
    except Exception as e:  # noqa: BLE001
        logger.warning("qdrant_hybrid: CrossEncoder missing: %s", e)
        return None
    try:
        _reranker_model = CrossEncoder(RERANKER_MODEL_NAME, device="cpu")
        logger.info("qdrant_hybrid: reranker %s loaded", RERANKER_MODEL_NAME)
        return _reranker_model
    except Exception as e:  # noqa: BLE001
        logger.warning("qdrant_hybrid: failed to load %s: %s",
                       RERANKER_MODEL_NAME, e)
        return None


# ---------------------------------------------------------------------------
# Encoding helpers
# ---------------------------------------------------------------------------
def encode_dense(text: str) -> Optional[List[float]]:
    m = _load_dense()
    if m is None:
        return None
    try:
        v = m.encode(text, convert_to_numpy=True, normalize_embeddings=True)
        return v.tolist()
    except Exception as e:  # noqa: BLE001
        logger.warning("qdrant_hybrid.encode_dense: %s", e)
        return None


def encode_sparse(text: str) -> Optional[Tuple[List[int], List[float]]]:
    """Return (indices, values) suitable for Qdrant's SparseVector."""
    m = _load_sparse()
    if m is None:
        return None
    try:
        result = next(m.query_embed([text]))
        # fastembed returns a SparseEmbedding with .indices and .values
        indices = [int(i) for i in result.indices.tolist()]
        values = [float(v) for v in result.values.tolist()]
        return indices, values
    except Exception as e:  # noqa: BLE001
        logger.warning("qdrant_hybrid.encode_sparse: %s", e)
        return None


def encode_sparse_doc(text: str) -> Optional[Tuple[List[int], List[float]]]:
    """Document-side sparse encoding. BM25 uses different statistics for
    query vs document; fastembed exposes `embed` for the doc side."""
    m = _load_sparse()
    if m is None:
        return None
    try:
        result = next(m.embed([text]))
        indices = [int(i) for i in result.indices.tolist()]
        values = [float(v) for v in result.values.tolist()]
        return indices, values
    except Exception as e:  # noqa: BLE001
        logger.warning("qdrant_hybrid.encode_sparse_doc: %s", e)
        return None


# ---------------------------------------------------------------------------
# Collection lifecycle
# ---------------------------------------------------------------------------
def ensure_hybrid_collection(client, collection_name: str,
                             tenant_field: str = "tenant_id") -> bool:
    """Create the hybrid collection if it doesn't exist; verify schema
    if it does. Returns True on success, False on any failure.

    Raises a SchemaMismatchError (subclass of RuntimeError) if a
    collection with that name exists but is dense-only — callers must
    run the migration script before this can succeed."""
    try:
        from qdrant_client.models import (
            VectorParams, SparseVectorParams, Distance, KeywordIndexParams,
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("qdrant_hybrid: qdrant-client models import: %s", e)
        return False

    try:
        existing = {c.name for c in client.get_collections().collections}
    except Exception as e:  # noqa: BLE001
        logger.warning("qdrant_hybrid: list_collections: %s", e)
        return False

    if collection_name in existing:
        # Verify it's already a named-vector hybrid collection.
        try:
            info = client.get_collection(collection_name)
            vectors_cfg = getattr(info.config.params, "vectors", None)
            sparse_cfg = getattr(info.config.params, "sparse_vectors", None)
            is_named = isinstance(vectors_cfg, dict) and DENSE_VEC_NAME in vectors_cfg
            has_sparse = isinstance(sparse_cfg, dict) and SPARSE_VEC_NAME in sparse_cfg
            if not (is_named and has_sparse):
                raise SchemaMismatchError(
                    f"Qdrant collection {collection_name!r} exists with the "
                    "legacy dense-only schema. Run "
                    "`python scripts/migrate_qdrant_hybrid.py "
                    f"--collection {collection_name}` before enabling "
                    "QDRANT_HYBRID=1."
                )
        except SchemaMismatchError:
            raise
        except Exception as e:  # noqa: BLE001
            logger.warning("qdrant_hybrid: get_collection: %s", e)
            return False
        return True

    # Fresh collection — create with named vectors.
    try:
        client.create_collection(
            collection_name=collection_name,
            vectors_config={
                DENSE_VEC_NAME: VectorParams(size=DENSE_DIM,
                                             distance=Distance.COSINE),
            },
            sparse_vectors_config={
                SPARSE_VEC_NAME: SparseVectorParams(),
            },
        )
        logger.info("qdrant_hybrid: created hybrid collection %s "
                    "(dense=%dd %s, sparse=%s)",
                    collection_name, DENSE_DIM, DENSE_MODEL_NAME,
                    SPARSE_MODEL_NAME)
        # Tenant index (same as dense-only path).
        try:
            client.create_payload_index(
                collection_name=collection_name,
                field_name=tenant_field,
                field_schema=KeywordIndexParams(type="keyword", is_tenant=True),
            )
        except Exception:
            try:
                client.create_payload_index(
                    collection_name=collection_name,
                    field_name=tenant_field,
                    field_schema="keyword",
                )
            except Exception as idx_e:  # noqa: BLE001
                logger.debug("qdrant_hybrid: tenant index ensure: %s", idx_e)
        return True
    except Exception as e:  # noqa: BLE001
        logger.warning("qdrant_hybrid: create_collection: %s", e)
        return False


class SchemaMismatchError(RuntimeError):
    """Raised when the existing collection is dense-only and the
    hybrid path tries to read/write through it."""


# ---------------------------------------------------------------------------
# Indexing
# ---------------------------------------------------------------------------
def build_point(*, point_id: str, text: str, payload: Dict[str, Any]
                ) -> Optional[Dict[str, Any]]:
    """Construct a Qdrant point with BOTH dense and sparse vectors. Returns
    None if either encoder fails — the caller should drop the chunk
    rather than write a half-vector point."""
    dense = encode_dense(text)
    if dense is None:
        return None
    sparse = encode_sparse_doc(text)
    if sparse is None:
        return None
    indices, values = sparse
    try:
        from qdrant_client.models import PointStruct, SparseVector
    except Exception:  # noqa: BLE001
        return None
    return PointStruct(
        id=point_id,
        vector={
            DENSE_VEC_NAME: dense,
            SPARSE_VEC_NAME: SparseVector(indices=indices, values=values),
        },
        payload=payload,
    )


# ---------------------------------------------------------------------------
# Hybrid search
# ---------------------------------------------------------------------------
@dataclass
class HybridResult:
    chunk_id: str
    score: float
    text: str
    section_title: str
    chunk_index: int
    document_id: str
    metadata: Dict[str, Any]


def hybrid_search(client, *, collection_name: str, query: str,
                  tenant_id: str, limit: int = 8,
                  score_threshold: float = 0.0,
                  document_id: Optional[str] = None,
                  rerank: bool = True) -> List[HybridResult]:
    """Native Qdrant hybrid search: dense + sparse prefetch → RRF fusion
    → optional cross-encoder rerank. Returns at most `limit` results.

    The Query API does dense + sparse in ONE server-side call, fuses
    via RRF, and respects the tenant filter on both branches."""
    try:
        from qdrant_client.models import (
            FusionQuery, Fusion, Prefetch, NamedVector, NamedSparseVector,
            SparseVector, Filter, FieldCondition, MatchValue,
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("qdrant_hybrid.hybrid_search models import: %s", e)
        return []

    dense_q = encode_dense(query)
    sparse_q = encode_sparse(query)
    if dense_q is None and sparse_q is None:
        return []

    must = [FieldCondition(key="tenant_id", match=MatchValue(value=tenant_id))]
    if document_id:
        must.append(FieldCondition(key="document_id",
                                   match=MatchValue(value=document_id)))
    qfilter = Filter(must=must)

    prefetches = []
    if dense_q is not None:
        prefetches.append(Prefetch(
            query=dense_q, using=DENSE_VEC_NAME,
            limit=PREFETCH_DENSE, filter=qfilter,
        ))
    if sparse_q is not None:
        indices, values = sparse_q
        prefetches.append(Prefetch(
            query=SparseVector(indices=indices, values=values),
            using=SPARSE_VEC_NAME,
            limit=PREFETCH_SPARSE, filter=qfilter,
        ))

    try:
        # Take a wider top-K from fusion than the final limit, so the
        # reranker has something to do.
        fuse_k = max(FUSE_TOP_K, limit * 4)
        response = client.query_points(
            collection_name=collection_name,
            prefetch=prefetches,
            query=FusionQuery(fusion=Fusion.RRF),
            limit=fuse_k,
            with_payload=True,
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("qdrant_hybrid.query_points: %s", e)
        return []

    points = getattr(response, "points", []) or []
    out: List[HybridResult] = []
    for p in points:
        if score_threshold and (p.score or 0.0) < score_threshold:
            continue
        payload = p.payload or {}
        out.append(HybridResult(
            chunk_id=str(p.id),
            score=float(p.score or 0.0),
            text=payload.get("text", ""),
            section_title=payload.get("section_title", ""),
            chunk_index=payload.get("chunk_index", 0),
            document_id=payload.get("document_id", ""),
            metadata=payload.get("metadata", {}),
        ))

    if rerank and out:
        out = rerank_results(query, out, top_k=limit)
    else:
        out = out[:limit]
    return out


def rerank_results(query: str, hits: List[HybridResult],
                   *, top_k: int) -> List[HybridResult]:
    """Cross-encoder rerank with bge-reranker-v2-m3. Falls back to the
    fusion ranking when the encoder isn't available."""
    if not hits:
        return hits
    m = _load_reranker()
    if m is None:
        return hits[:top_k]
    try:
        pairs = [(query, h.text or "") for h in hits]
        scores = m.predict(pairs)
        rescored = sorted(
            zip(hits, scores), key=lambda x: float(x[1]), reverse=True,
        )
        # Overwrite the score with the reranker's (so callers can see how
        # confident the final ranking is, not the fusion-rank artifact).
        out: List[HybridResult] = []
        for h, s in rescored[:top_k]:
            h.score = float(s)
            out.append(h)
        return out
    except Exception as e:  # noqa: BLE001
        logger.warning("qdrant_hybrid.rerank: %s", e)
        return hits[:top_k]
