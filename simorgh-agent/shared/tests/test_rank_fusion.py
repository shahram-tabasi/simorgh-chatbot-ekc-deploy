"""Tests for simorgh_rank_fusion.

The fuser is pure-python with no live deps — these tests pin its
behavior so we don't break the merged_search MCP tool downstream.
"""

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))

from simorgh_rank_fusion import DEFAULT_K, labeled_rrf, rrf  # noqa: E402


def _h(doc_id, **extra):
    return {"id": doc_id, **extra}


def test_rrf_empty_input():
    assert rrf([]) == []
    assert rrf([[], [], []]) == []


def test_rrf_single_ranker_preserves_order():
    ranked = [_h("a"), _h("b"), _h("c")]
    out = rrf([ranked])
    assert [d["id"] for d in out] == ["a", "b", "c"]
    # Scores are strictly decreasing.
    assert out[0]["rrf_score"] > out[1]["rrf_score"] > out[2]["rrf_score"]


def test_rrf_unanimous_winner_first():
    bm25 = [_h("alpha"), _h("beta"),  _h("gamma")]
    qdr  = [_h("alpha"), _h("gamma"), _h("beta")]
    graph = [_h("alpha"), _h("delta")]
    out = rrf([bm25, qdr, graph])
    assert out[0]["id"] == "alpha"
    # alpha appears in all three so its rrf_sources has length 3.
    assert len(out[0]["rrf_sources"]) == 3


def test_rrf_top_n_caps_output():
    out = rrf([[_h(str(i)) for i in range(10)]], top_n=3)
    assert len(out) == 3
    assert [d["id"] for d in out] == ["0", "1", "2"]


def test_rrf_weights_demote_a_retriever():
    bm25 = [_h("x")]
    graph = [_h("y")]
    # Equal weights → bm25 wins by tie-break (added first).
    eq = rrf([bm25, graph])
    assert eq[0]["id"] == "x"
    # Crush bm25's weight → graph wins.
    weighted = rrf([bm25, graph], weights=[0.01, 1.0])
    assert weighted[0]["id"] == "y"


def test_rrf_zero_weight_excludes_retriever():
    bm25 = [_h("x")]
    graph = [_h("y")]
    out = rrf([bm25, graph], weights=[0.0, 1.0])
    assert {d["id"] for d in out} == {"y"}, "zero-weighted retriever should not contribute"


def test_rrf_preserves_first_payload():
    bm25 = [_h("doc", title="from-bm25", source="es")]
    qdr  = [_h("doc", title="from-qdr",  source="qdrant")]
    out = rrf([bm25, qdr])
    assert out[0]["title"] == "from-bm25"
    assert out[0]["source"] == "es"


def test_rrf_missing_id_keys_are_dropped():
    bm25 = [{"title": "no id"}, _h("ok")]
    out = rrf([bm25])
    assert [d["id"] for d in out] == ["ok"]


def test_labeled_rrf_attaches_names_to_sources():
    out = labeled_rrf({
        "bm25":   [_h("a"), _h("b")],
        "vector": [_h("b"), _h("a")],
        "graph":  [_h("a")],
    })
    assert out[0]["id"] == "a"
    src_names = {s["retriever"] for s in out[0]["rrf_sources"]}
    assert src_names == {"bm25", "vector", "graph"}


def test_labeled_rrf_weights_lookup_by_name():
    out_balanced = labeled_rrf({
        "bm25":  [_h("x")],
        "graph": [_h("y")],
    })
    assert out_balanced[0]["id"] == "x"
    out_skewed = labeled_rrf({
        "bm25":  [_h("x")],
        "graph": [_h("y")],
    }, weights={"bm25": 0.01, "graph": 1.0})
    assert out_skewed[0]["id"] == "y"


def test_default_k_is_60():
    assert DEFAULT_K == 60
