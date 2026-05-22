"""Reciprocal rank fusion across heterogeneous retrievers.

When the agent fires ``bm25_search``, ``vector_search``, and
``graph_search`` in parallel, each retriever returns its own ranked
list with scores that aren't comparable to the others' — kNN cosine
distance, BM25 TF/IDF, and AGE graph hops live on different scales.

RRF (Cormack et al. 2009) sidesteps the scale problem by combining
*ranks* instead of *scores*::

    score(doc) = Σ over retrievers  1 / (k + rank_in_that_retriever)

The constant ``k`` (default 60, the value in the original paper) is a
smoothing parameter — large enough that the difference between rank 1
and rank 2 doesn't dominate, small enough that lower ranks still
contribute.

This module is intentionally tiny and pure-python: no numpy, no
pandas. It runs in the same process as context-search and is called
on every hot-path retrieval, so import cost matters.
"""
from __future__ import annotations

from typing import Any, Dict, Iterable, List, Mapping, Sequence, Tuple

DEFAULT_K = 60


def rrf(
    rankings: Sequence[Sequence[Mapping[str, Any]]],
    *,
    id_key: str = "id",
    k: int = DEFAULT_K,
    weights: Sequence[float] | None = None,
    top_n: int | None = None,
) -> List[Dict[str, Any]]:
    """Fuse ``rankings`` from N retrievers into a single ranked list.

    Args:
        rankings: One ranked list per retriever. Each list is ordered
            best-first; each element is a dict-like with at least
            ``id_key``.
        id_key: Field that uniquely identifies a document across
            retrievers.
        k: RRF smoothing constant. 60 is the canonical default.
        weights: Optional per-retriever weight (same length as
            ``rankings``). Defaults to all-ones.
        top_n: Cap output length. Defaults to "everything".

    Returns:
        List of merged dicts ordered best-first. Each dict carries:
            * the original document fields from the *first* retriever
              that surfaced it (so callers don't lose metadata),
            * ``rrf_score`` — the fused score,
            * ``rrf_sources`` — list of ``{retriever, rank, score}``
              entries showing which retrievers contributed.
    """
    if weights is None:
        weights = [1.0] * len(rankings)
    elif len(weights) != len(rankings):
        raise ValueError("weights must match the number of rankings")

    fused: Dict[Any, Dict[str, Any]] = {}
    for retriever_idx, ranked in enumerate(rankings):
        w = weights[retriever_idx]
        if w == 0 or not ranked:
            continue
        for rank, doc in enumerate(ranked, start=1):
            doc_id = doc.get(id_key)
            if doc_id is None:
                continue
            contrib = w / (k + rank)
            entry = fused.get(doc_id)
            if entry is None:
                # First time we see this doc — keep the original payload
                # so caller still has title/path/snippet/etc.
                entry = dict(doc)
                entry["rrf_score"] = 0.0
                entry["rrf_sources"] = []
                fused[doc_id] = entry
            entry["rrf_score"] += contrib
            entry["rrf_sources"].append({
                "retriever": retriever_idx,
                "rank": rank,
                "score": doc.get("score"),
                "contribution": contrib,
            })

    merged = sorted(fused.values(), key=lambda d: d["rrf_score"], reverse=True)
    if top_n is not None:
        merged = merged[:top_n]
    return merged


def labeled_rrf(
    rankings: Mapping[str, Sequence[Mapping[str, Any]]],
    *,
    id_key: str = "id",
    k: int = DEFAULT_K,
    weights: Mapping[str, float] | None = None,
    top_n: int | None = None,
) -> List[Dict[str, Any]]:
    """Convenience over :func:`rrf` that takes a ``{retriever_name: ranking}``
    mapping. Each entry in ``rrf_sources`` carries the retriever's name
    instead of its index, which is what users actually want to see in
    logs ("bm25 + qdrant agreed on this hit").
    """
    if weights is None:
        weights_seq = None
    else:
        weights_seq = [weights.get(name, 1.0) for name in rankings.keys()]

    names = list(rankings.keys())
    raw = rrf(
        [rankings[n] for n in names],
        id_key=id_key, k=k, weights=weights_seq, top_n=top_n,
    )
    for entry in raw:
        for src in entry.get("rrf_sources", []):
            idx = src.pop("retriever")
            src["retriever"] = names[idx]
    return raw


__all__ = ["rrf", "labeled_rrf", "DEFAULT_K"]
