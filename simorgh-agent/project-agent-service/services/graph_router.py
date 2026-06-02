"""
graph_router.py — Apache AGE graph-as-router for chat queries.

The 2024-2026 consensus on coupling a knowledge graph to retrieval is
"graph-as-router, not graph-as-retriever": don't try to answer questions
from the graph, use the graph to TELL YOU WHICH SUB-CORPUS to search.
For an engineering-expert chatbot whose corpus mixes:

    • uploaded spec PDFs (Qdrant chunks tagged by document_id)
    • TPMS structured rows (panel / feeder DB rows by tpms_oenum)
    • GitLab files (chunks tagged by repo_path)
    • datasheets (Qdrant chunks tagged with doc_type="datasheet")

…the dominant retrieval failure is searching the WRONG SUB-CORPUS
("which panel is L11B in?" hits spec-PDF chunks that mention L11B in
prose and misses the TPMS row that holds the actual answer).

How this module works
=====================
The existing graph populator (`context-search-service` Phase 4) already
writes a small property graph into AGE:

    (:Project)-[:CONTAINS]->(:Document)-[:MENTIONS]->(:Entity)

with `Entity.type ∈ {standard, oenum, url, email, currency, topic}`.
The router:

  1. Extracts entities from the user query with the SAME regex
     patterns the populator used — so query keys match graph keys
     consistently.
  2. Looks up matching Entity vertices in AGE for the active project.
  3. Walks 1 hop back to the Documents that mention each entity →
     returns `routed_document_ids` (subset of doc_ids worth searching).
  4. Returns `sources_to_hit` flags telling the chat retrieval which
     sub-corpora are likely-relevant.

Result shape
------------
    {
      "entities":             [{"type": ..., "key": ..., "name": ...}],
      "routed_document_ids":  ["doc-uuid-1", "doc-uuid-2"],
      "sources_to_hit":       ["uploads", "tpms", "gitlab"],
      "rationale":            "free-text explanation for the trace",
      "fallback":             bool,   # true if no entities resolved
    }

If the graph returns nothing (sparse project, brand-new upload), the
router degrades to `fallback=True` with `sources_to_hit` = ALL sources
— the chat path then behaves exactly like it does today (no routing).

Why this is bounded
-------------------
The router NEVER answers user questions and NEVER short-circuits
retrieval. It's a hint to the chat path. Every entry point catches and
logs; on any failure the caller treats the router as absent.
"""
from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

AGE_DSN = os.getenv("AGE_DSN", "")
AGE_GRAPH_NAME = os.getenv("AGE_GRAPH_NAME", "simorgh")
GRAPH_ROUTER_MAX_DOCS = int(os.getenv("GRAPH_ROUTER_MAX_DOCS", "20"))


# ---------------------------------------------------------------------------
# Entity extraction (MUST match the patterns context-search-service uses
# to populate the graph — otherwise query keys never match graph keys).
# ---------------------------------------------------------------------------
def _spaceless_upper(s: str) -> str:
    return re.sub(r"\s+", "", s).upper()


_QUERY_PATTERNS: List[Tuple[str, re.Pattern[str], Optional[Any]]] = [
    ("standard", re.compile(r"\bIEC[\s\-]?\d{4,5}(?:[\s\-]\d+)?\b", re.IGNORECASE),
     _spaceless_upper),
    ("standard", re.compile(r"\bISO[\s\-]?\d{4,5}(?:[\s\-]\d+)?\b", re.IGNORECASE),
     _spaceless_upper),
    ("standard", re.compile(r"\bIEEE[\s\-]?\d{2,4}(?:[\s\-]\d+)?\b", re.IGNORECASE),
     _spaceless_upper),
    ("oenum",    re.compile(r"\bOE[\s\-]?\d{3,7}\b", re.IGNORECASE),
     _spaceless_upper),
    ("oenum",    re.compile(r"\b\d{2}A\d{4,6}\b"),
     _spaceless_upper),  # naked "04A12065" form
    # Tags / feeder / panel identifiers — common engineering shorthand:
    # L11B, L01, INC 2, COUPLING 2/1, Panel 36133, T2C/CO, TF7/EX.
    ("feeder",   re.compile(r"\bL\d{1,3}[A-Z]?\b"), _spaceless_upper),
    ("feeder",   re.compile(r"\bINCOMING\s*\d\b|\bINC\s*\d\b", re.IGNORECASE),
     _spaceless_upper),
    ("feeder",   re.compile(r"\bCOUPLING\s*\d(?:/\d)?\b", re.IGNORECASE),
     _spaceless_upper),
    ("panel",    re.compile(r"\bPanel\s*\d{3,6}\b", re.IGNORECASE),
     _spaceless_upper),
    # Tech-class tags that often appear in queries: TYPE T1, METERING.
    ("tag",      re.compile(r"\bT\d[A-Z]?/[A-Z0-9.]+\b"), _spaceless_upper),
]


@dataclass
class Entity:
    type: str
    key: str        # "type:::normalised" — matches AGE's Entity.key shape
    name: str       # original surface form from the query


@dataclass
class RoutingDecision:
    entities: List[Entity] = field(default_factory=list)
    routed_document_ids: List[str] = field(default_factory=list)
    sources_to_hit: List[str] = field(default_factory=list)
    rationale: str = ""
    fallback: bool = False

    def to_dict(self) -> Dict[str, Any]:
        return {
            "entities": [
                {"type": e.type, "key": e.key, "name": e.name}
                for e in self.entities
            ],
            "routed_document_ids": list(self.routed_document_ids),
            "sources_to_hit":      list(self.sources_to_hit),
            "rationale":           self.rationale,
            "fallback":            bool(self.fallback),
        }


def extract_entities(query: str) -> List[Entity]:
    """Pull every entity matching one of the populator's patterns. Cheap,
    deterministic, runs in microseconds — no LLM call. The LLM-side
    enrichment (free-text concept extraction) lives in `graph_extract_entities`
    in context-search-service for queries the agent decides to escalate."""
    if not query:
        return []
    seen: Dict[Tuple[str, str], Entity] = {}
    for etype, rx, norm in _QUERY_PATTERNS:
        for m in rx.finditer(query):
            raw = m.group(0).strip()
            key = (norm(raw) if norm else raw)
            if not key:
                continue
            full = f"{etype}:::{key}"
            seen.setdefault((etype, full), Entity(type=etype, key=full, name=raw))
    return list(seen.values())


# ---------------------------------------------------------------------------
# AGE access
# ---------------------------------------------------------------------------
_age_client = None


def _age():
    """Lazy AgeClient. Returns None if AGE isn't configured."""
    global _age_client
    if not AGE_DSN:
        return None
    if _age_client is None:
        try:
            from simorgh_graph import AgeClient
            _age_client = AgeClient(dsn=AGE_DSN, graph_name=AGE_GRAPH_NAME)
        except Exception as e:  # noqa: BLE001
            logger.warning("graph_router: AgeClient init failed: %s", e)
            return None
    return _age_client


def _routed_documents(project_id: str,
                      entity_keys: List[str]) -> Tuple[List[str], List[str]]:
    """For every entity key the graph has a vertex for, find the
    documents that MENTION it within the active project. Returns
    (document_ids, document_paths)."""
    ac = _age()
    if ac is None or not entity_keys:
        return [], []
    cypher = """
    MATCH (p:Project {project_id: $project_id})
          -[:CONTAINS]->(d:Document)
          -[:MENTIONS]->(e:Entity)
    WHERE e.key IN $keys
    RETURN DISTINCT d.path AS path, d.document_id AS document_id
    LIMIT $limit
    """
    try:
        rows = ac.cypher(
            cypher,
            params={
                "project_id": str(project_id),
                "keys":       entity_keys,
                "limit":      GRAPH_ROUTER_MAX_DOCS,
            },
            columns=[("path", "agtype"), ("document_id", "agtype")],
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("graph_router: cypher %s", e)
        return [], []
    paths: List[str] = []
    docs:  List[str] = []
    for r in rows or []:
        p = r.get("path")
        d = r.get("document_id")
        if isinstance(p, str) and p:
            paths.append(p)
        if isinstance(d, str) and d:
            docs.append(d)
    return docs, paths


def _infer_sources(entities: List[Entity], has_routed_docs: bool) -> List[str]:
    """Map entity types → likely sub-corpora to query. The chat path's
    hybrid retrieval then constrains each branch by these flags."""
    out: List[str] = []
    types = {e.type for e in entities}
    # Spec / datasheet uploads — always worth hitting if we found any
    # document edges in the graph, OR if the query mentions standards.
    if has_routed_docs or "standard" in types:
        out.append("uploads")
    # TPMS is canonical for panel / feeder / tag references.
    if {"panel", "feeder", "tag"} & types:
        out.append("tpms")
    # OE numbers can come from either TPMS or the spec title block.
    if "oenum" in types:
        if "tpms" not in out:
            out.append("tpms")
        if "uploads" not in out:
            out.append("uploads")
    # Email / URL → no targeted sub-corpus; let general chat handle it.
    return out


def route_query(query: str, project_id: str) -> RoutingDecision:
    """Run the full router. Returns a RoutingDecision; on any failure
    returns a fallback decision (sources_to_hit = ALL known, no document
    constraint) so the chat path behaves as it does today."""
    entities = extract_entities(query)
    if not entities:
        return RoutingDecision(
            entities=[],
            routed_document_ids=[],
            sources_to_hit=["uploads", "tpms", "gitlab"],
            rationale="no regex-recognisable entities in the query",
            fallback=True,
        )
    keys = [e.key for e in entities]
    doc_ids, paths = _routed_documents(project_id, keys)
    sources = _infer_sources(entities, has_routed_docs=bool(doc_ids or paths))
    if not sources:
        sources = ["uploads", "tpms", "gitlab"]
    rationale_bits = [
        f"entities=[{', '.join(e.name for e in entities)}]",
        f"routed_docs={len(doc_ids)}",
        f"sources={','.join(sources) if sources else 'all'}",
    ]
    return RoutingDecision(
        entities=entities,
        routed_document_ids=doc_ids,
        sources_to_hit=sources,
        rationale=" · ".join(rationale_bits),
        fallback=False,
    )


# ---------------------------------------------------------------------------
# Agent-facing helpers
# ---------------------------------------------------------------------------
def cypher_query(query: str, params: Optional[Dict[str, Any]] = None,
                 limit: int = 20) -> Dict[str, Any]:
    """Run an arbitrary openCypher query against the project graph and
    return the rows. Used by the `cypher_query` ReAct tool when the
    agent wants to explore the graph directly (e.g. "what other docs
    mention IEC 62271-200?"). Caps the row count and never lets a
    failing query break the chat loop."""
    ac = _age()
    if ac is None:
        return {"ok": False, "rows": [], "error": "AGE not configured"}
    # Defensive: append LIMIT if the query doesn't already cap.
    capped = query.strip()
    if "limit" not in capped.lower():
        capped = f"{capped}\nLIMIT {int(limit)}"
    try:
        rows = ac.cypher(capped, params=params or {})
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "rows": [], "error": str(e)[:240]}
    return {"ok": True, "rows": rows[:limit]}
