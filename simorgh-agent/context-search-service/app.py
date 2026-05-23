"""
context-search-service
======================
Hybrid (BM25 + kNN) search and analytical aggregations across the
Elasticsearch indices the simorgh stack writes to. The agent calls this
BEFORE generation to assemble high-quality context, and DURING reasoning
to ask analytical questions ("how many", "trend of", "p95 latency of").

REST:
  POST /search/content        — hybrid search across project docs, GitLab,
                                TPMS, technical-knowledge, emails
  POST /search/logs           — BM25 over simorgh-logs-*
  POST /search/cot            — hybrid over simorgh-cot-* (prior agent traces)
  POST /search/projects       — hybrid over simorgh-projects (structured project info)
  POST /aggregate             — ES terms aggregation (group_by + metric)
  POST /time_series           — ES date_histogram (interval + metric)
  POST /index/content         — index a single document
  POST /index/content/bulk    — bulk index
  POST /index/cot             — index a completed CoT trace
  POST /index/project_meta    — upsert a structured project record
  GET  /health

MCP tools (preferred surface for the COT agent):
  search_context, search_past_cot, search_logs_mcp,
  search_projects, aggregate_field, time_series_query, index_cot_trace,

  -- priority-4 split surface (parallelizable) --
  bm25_search, vector_search, graph_search, merged_search
"""
import asyncio
import os
import re
from datetime import datetime, timezone
from time import perf_counter
from typing import Any, Literal

import httpx
from elasticsearch import Elasticsearch, helpers
from fastapi import FastAPI, HTTPException
from mcp.server.fastmcp import FastMCP
from pydantic import BaseModel, Field

from simorgh_logging import configure, get_logger, request_id_middleware
from simorgh_rank_fusion import labeled_rrf

from index_setup import ensure_templates

configure(service="context-search")
log = get_logger(__name__)

ES_URL          = os.getenv("ELASTICSEARCH_URL", "http://elasticsearch:9200")
ES_USER         = os.getenv("ELASTIC_USER", "")
ES_PASSWORD     = os.getenv("ELASTIC_PASSWORD", "")
EMBEDDINGS_URL  = os.getenv("EMBEDDINGS_URL", "http://embeddings:8037")
EMBED_DIMS      = int(os.getenv("EMBED_DIMS", "768"))
QDRANT_URL      = os.getenv("QDRANT_URL", "http://qdrant:6333")
AGE_DSN         = os.getenv("AGE_DSN", "")  # empty = graph tools disabled
AGE_GRAPH_NAME  = os.getenv("AGE_GRAPH_NAME", "simorgh")


def _es() -> Elasticsearch:
    auth = (ES_USER, ES_PASSWORD) if ES_USER else None
    return Elasticsearch(ES_URL, basic_auth=auth, request_timeout=30)


_es_client: Elasticsearch | None = None


def es() -> Elasticsearch:
    global _es_client
    if _es_client is None:
        _es_client = _es()
        try:
            ensure_templates(_es_client)
        except Exception as e:
            log.warning("index_setup_failed", error=str(e))
    return _es_client


# ---------------------------------------------------------------------------
# Models — search
# ---------------------------------------------------------------------------
class ContentDoc(BaseModel):
    source: str = Field(..., description="gitlab|tpms|project|tech-kb|email")
    project_id: str | None = None
    oenum: str | None = None
    repo: str | None = None
    ref: str | None = None
    path: str | None = None
    title: str = ""
    body: str
    tags: list[str] = []
    embedding: list[float] | None = None
    id: str | None = None


class SearchRequest(BaseModel):
    query: str = Field(..., min_length=1)
    project_id: str | None = None
    oenum: str | None = None
    sources: list[str] | None = None    # filter by source
    k: int = Field(8, ge=1, le=50)
    use_knn: bool = True


class SearchHit(BaseModel):
    id: str
    score: float
    source: str
    title: str | None = None
    path: str | None = None
    repo: str | None = None
    snippet: str
    metadata: dict[str, Any] = {}


class SearchResponse(BaseModel):
    hits: list[SearchHit]
    took_ms: int


class RegexRequest(BaseModel):
    """Planner-emitted regex search.

    The planner (Ladder B precise-match path) generates a regex from the
    user's intent and asks for matching passages from the auto-indexed
    project chunks. We optionally use a `query_text` to first narrow the
    candidate pool via BM25 + kNN — cheaper than scanning every chunk
    in the repo on every query — then run Python ``re`` over each
    candidate's body.
    """
    pattern: str = Field(..., min_length=1, max_length=512)
    project_id: str | None = None
    oenum: str | None = None
    sources: list[str] | None = None
    # Optional semantic narrowing. When provided, we run search_context
    # first to rank candidates and only regex-scan the top max_scan.
    # When omitted, we regex-scan up to max_scan chunks under the
    # project_id filter, ordered by path (deterministic).
    query_text: str | None = None
    max_matches: int = Field(20, ge=1, le=100)
    max_scan: int = Field(300, ge=1, le=2000)
    context_chars: int = Field(200, ge=0, le=2000)
    case_insensitive: bool = True
    multiline: bool = True


class RegexMatch(BaseModel):
    path: str | None = None
    title: str | None = None
    source: str
    score: float | None = None
    match: str
    context: str
    chunk_id: str


class RegexResponse(BaseModel):
    hits: list[RegexMatch]
    scanned: int
    pattern: str
    took_ms: int
    error: str | None = None


# ---------------------------------------------------------------------------
# Models — CoT trace indexing
# ---------------------------------------------------------------------------
class CotStepRecord(BaseModel):
    """One step in a chain-of-thought trace."""
    step_number: int
    step_type: Literal[
        "plan", "search", "tool_call", "llm", "decision", "reflect", "answer"
    ] = "tool_call"
    title: str = ""
    description: str = ""
    tool: str | None = None
    tool_input: dict | None = None
    tool_output_summary: str | None = None
    latency_ms: int | None = None


class CotTrace(BaseModel):
    """A completed (or in-progress) chain-of-thought reasoning trace.

    Indexed into simorgh-cot-<YYYY.MM>. The question is embedded for
    semantic recall via search_past_cot.
    """
    chain_id: str
    session_id: str = ""
    user_id: str = ""
    project_id: str | None = None
    oenum: str | None = None
    question: str
    reasoning: str = ""
    final_answer: str | None = None
    success: bool = True
    steps: list[CotStepRecord] = []
    total_latency_ms: int | None = None
    tags: list[str] = []


# ---------------------------------------------------------------------------
# Models — structured project metadata
# ---------------------------------------------------------------------------
class ProjectMeta(BaseModel):
    """Structured TPMS project record. Indexed into simorgh-projects with a
    stable id (oenum) so updates upsert. Carries a denormalized text body
    for BM25 + an embedding for semantic ranking."""
    oenum: str = Field(..., description="Stable id — used as ES _id")
    project_id: str | None = None
    name: str = ""
    status: str | None = None
    customer: str | None = None
    voltage_class: str | None = None
    motor_type: str | None = None
    year: int | None = None
    panel_count: int | None = None
    feeder_count: int | None = None
    equipment_count: int | None = None
    raw_text: str = ""
    tags: list[str] = []
    extra: dict[str, Any] = Field(default_factory=dict)


# ---------------------------------------------------------------------------
# Models — analytics
# ---------------------------------------------------------------------------
IndexAlias = Literal["content", "logs", "cot", "projects"]

_INDEX_MAP: dict[str, str] = {
    "content":  "simorgh-content",
    "logs":     "simorgh-logs-*",
    "cot":      "simorgh-cot-*",
    "projects": "simorgh-projects",
}


class AggregateRequest(BaseModel):
    """Group-by aggregation on one of the four indices.

    metric=count       — bucket doc_count
    metric=avg|sum|min|max — numeric stat on metric_field
    metric=p50|p95|p99 — percentile of metric_field
    """
    index: IndexAlias
    group_by: str = Field(..., description="Field, .keyword auto-appended if text")
    metric: Literal["count", "avg", "sum", "min", "max", "p50", "p95", "p99"] = "count"
    metric_field: str = ""
    filter_query: str = ""
    time_field: str = "@timestamp"
    time_range: str = "now-30d"
    top_n: int = Field(20, ge=1, le=500)


class TimeSeriesRequest(BaseModel):
    """Date-histogram time series. Optional group_by splits into multiple series."""
    index: IndexAlias
    interval: str = "1d"
    metric: Literal["count", "avg", "sum", "p50", "p95"] = "count"
    metric_field: str = ""
    filter_query: str = ""
    time_field: str = "@timestamp"
    time_range: str = "now-90d"
    group_by: str | None = None
    top_n: int = Field(5, ge=1, le=20)


# ---------------------------------------------------------------------------
# FastAPI
# ---------------------------------------------------------------------------
app = FastAPI(title="context-search", version="0.2.0")
app.middleware("http")(request_id_middleware)


@app.get("/health")
def health():
    return {"status": "ok", "service": "context-search"}


@app.get("/health/deep")
def health_deep():
    try:
        info = es().info()
        return {"status": "ok", "es_version": info["version"]["number"]}
    except Exception as e:
        raise HTTPException(status_code=503, detail=str(e))


async def _embed(text: str) -> list[float] | None:
    """Call embeddings-service. Returns None if unavailable — caller should
    degrade to BM25-only."""
    try:
        async with httpx.AsyncClient(timeout=10) as c:
            r = await c.post(f"{EMBEDDINGS_URL}/embed", json={"text": text})
            r.raise_for_status()
            v = r.json().get("embedding")
            if isinstance(v, list) and len(v) == EMBED_DIMS:
                return v
    except Exception as e:
        log.warning("embed_failed", error=str(e))
    return None


def _filter_clause(req: SearchRequest) -> list[dict]:
    f: list[dict] = []
    if req.project_id: f.append({"term": {"project_id": req.project_id}})
    if req.oenum:      f.append({"term": {"oenum": req.oenum}})
    if req.sources:    f.append({"terms": {"source": req.sources}})
    return f


@app.post("/search/content", response_model=SearchResponse)
async def search_content(req: SearchRequest):
    bm25 = {
        "query": {
            "bool": {
                "must": [{"multi_match": {
                    "query": req.query,
                    "fields": ["title^2", "body"],
                    "type": "best_fields",
                }}],
                "filter": _filter_clause(req),
            }
        },
        "size": req.k,
        "_source": ["source", "project_id", "oenum", "repo", "ref",
                    "path", "title", "tags"],
        "highlight": {"fields": {"body": {"fragment_size": 200,
                                          "number_of_fragments": 1}}},
    }

    knn_block = None
    if req.use_knn:
        vec = await _embed(req.query)
        if vec is not None:
            knn_block = {
                "field": "embedding",
                "query_vector": vec,
                "k": req.k,
                "num_candidates": max(req.k * 5, 50),
                "filter": _filter_clause(req),
            }

    body: dict[str, Any] = bm25
    if knn_block is not None:
        # ES 8.4+ — knn alongside query for hybrid scoring.
        body["knn"] = knn_block

    r = es().search(index="simorgh-content", body=body)
    hits = []
    for h in r["hits"]["hits"]:
        src = h.get("_source", {})
        snippet = ""
        if "highlight" in h and "body" in h["highlight"]:
            snippet = " … ".join(h["highlight"]["body"])
        hits.append(SearchHit(
            id=h["_id"], score=h["_score"], source=src.get("source", "unknown"),
            title=src.get("title"), path=src.get("path"), repo=src.get("repo"),
            snippet=snippet,
            metadata={k: v for k, v in src.items() if k not in
                      {"source", "title", "path", "repo"}},
        ))
    return SearchResponse(hits=hits, took_ms=r["took"])


@app.post("/search/regex", response_model=RegexResponse)
async def search_regex(req: RegexRequest):
    """Run a precise regex over the auto-indexed project chunks.

    Two-stage to keep CPU bounded:
      1. ES retrieval narrows the candidate set to <= max_scan chunks,
         either by relevance (when `query_text` is provided) or by a
         straight filter (when not).
      2. Python `re` matches each candidate body; up to `max_matches`
         matches are returned with `context_chars` of surrounding
         text.

    Always returns 200 — pattern errors / regex exceptions are surfaced
    via the `error` field so the planner can fall back to
    search_context without paying for an HTTP-level retry."""
    started = perf_counter()

    flags = 0
    if req.case_insensitive: flags |= re.IGNORECASE
    if req.multiline:        flags |= re.MULTILINE
    try:
        pattern = re.compile(req.pattern, flags)
    except re.error as e:
        return RegexResponse(hits=[], scanned=0, pattern=req.pattern,
                             took_ms=int((perf_counter() - started) * 1000),
                             error=f"invalid regex: {e}")

    filter_clauses: list[dict] = []
    if req.project_id: filter_clauses.append({"term": {"project_id": req.project_id}})
    if req.oenum:      filter_clauses.append({"term": {"oenum": req.oenum}})
    if req.sources:    filter_clauses.append({"terms": {"source": req.sources}})

    es_body: dict[str, Any]
    if req.query_text:
        # Semantic narrowing — BM25 on title+body, optional kNN.
        es_body = {
            "query": {"bool": {
                "must":   [{"multi_match": {
                    "query": req.query_text,
                    "fields": ["title^2", "body"],
                    "type": "best_fields",
                }}],
                "filter": filter_clauses,
            }},
            "size": req.max_scan,
            "_source": ["source", "project_id", "oenum", "repo", "ref",
                        "path", "title", "body", "tags"],
        }
        vec = await _embed(req.query_text)
        if vec is not None:
            es_body["knn"] = {
                "field": "embedding",
                "query_vector": vec,
                "k": req.max_scan,
                "num_candidates": max(req.max_scan * 2, 200),
                "filter": filter_clauses,
            }
    else:
        # No semantic ranking — straight filtered scan, deterministic
        # order so repeated runs hit the same chunks. ES warns about
        # deep scrolls past 10k; max_scan caps us at 2000 so we're
        # well below.
        es_body = {
            "query": {"bool": {"filter": filter_clauses or [{"match_all": {}}]}}
                     if filter_clauses else {"match_all": {}},
            "size": req.max_scan,
            "_source": ["source", "project_id", "oenum", "repo", "ref",
                        "path", "title", "body", "tags"],
            "sort": [{"path.keyword": {"order": "asc",
                                       "unmapped_type": "keyword"}},
                     "_doc"],
        }

    try:
        r = es().search(index="simorgh-content", body=es_body)
    except Exception as e:
        return RegexResponse(hits=[], scanned=0, pattern=req.pattern,
                             took_ms=int((perf_counter() - started) * 1000),
                             error=f"es: {e}")

    matches: list[RegexMatch] = []
    scanned = 0
    for h in r["hits"]["hits"]:
        if len(matches) >= req.max_matches:
            break
        scanned += 1
        src = h.get("_source", {})
        body = src.get("body") or ""
        if not body:
            continue
        # Bound per-chunk CPU. Each chunk is already ~2000 chars from
        # the indexer; cap at 20k as belt-and-braces in case an
        # external indexer wrote something huge.
        scan_target = body if len(body) <= 20000 else body[:20000]
        try:
            for m in pattern.finditer(scan_target):
                if len(matches) >= req.max_matches:
                    break
                s, e = m.start(), m.end()
                ctx_s = max(0, s - req.context_chars)
                ctx_e = min(len(scan_target), e + req.context_chars)
                matches.append(RegexMatch(
                    path=src.get("path"),
                    title=src.get("title"),
                    source=src.get("source", "unknown"),
                    score=float(h.get("_score") or 0.0),
                    match=scan_target[s:e],
                    context=scan_target[ctx_s:ctx_e],
                    chunk_id=h["_id"],
                ))
        except Exception as e:
            # finditer can blow up on catastrophic backtracking; log and
            # continue with the next chunk so the rest still returns.
            log.warning("regex_finditer_failed",
                        pattern=req.pattern[:120], error=str(e))
            continue

    return RegexResponse(
        hits=matches, scanned=scanned, pattern=req.pattern,
        took_ms=int((perf_counter() - started) * 1000),
    )


@app.post("/search/logs")
def search_logs(req: SearchRequest):
    body = {
        "query": {
            "bool": {
                "must": [{"query_string": {"query": req.query}}],
                "filter": _filter_clause(req),
            }
        },
        "size": req.k,
        "sort": [{"@timestamp": "desc"}],
    }
    r = es().search(index="simorgh-logs-*", body=body)
    return {"hits": [h["_source"] | {"_id": h["_id"]} for h in r["hits"]["hits"]],
            "took_ms": r["took"]}


@app.post("/search/cot")
async def search_cot(req: SearchRequest):
    """Hybrid (BM25 + kNN) over CoT traces. The question field was embedded
    at index time so semantic recall ("have I solved this before?") works."""
    bm25 = {
        "query": {
            "bool": {
                "must": [{"multi_match": {
                    "query": req.query,
                    "fields": ["question^2", "reasoning", "final_answer", "tags"],
                }}],
                "filter": _filter_clause(req),
            }
        },
        "size": req.k,
        "sort": ["_score", {"@timestamp": "desc"}],
    }
    body: dict[str, Any] = bm25
    if req.use_knn:
        vec = await _embed(req.query)
        if vec is not None:
            body["knn"] = {
                "field": "embedding",
                "query_vector": vec,
                "k": req.k,
                "num_candidates": max(req.k * 5, 50),
                "filter": _filter_clause(req),
            }
    r = es().search(index="simorgh-cot-*", body=body)
    return {"hits": [h["_source"] | {"_id": h["_id"], "_score": h["_score"]}
                     for h in r["hits"]["hits"]],
            "took_ms": r["took"]}


@app.post("/search/projects", response_model=SearchResponse)
async def search_projects(req: SearchRequest):
    """Hybrid search over the structured project index. Useful when the
    user asks about a project by partial name / customer / spec without
    knowing the oenum."""
    bm25 = {
        "query": {
            "bool": {
                "must": [{"multi_match": {
                    "query": req.query,
                    "fields": ["name^3", "customer^2", "raw_text",
                               "voltage_class", "motor_type", "tags"],
                }}],
                "filter": _filter_clause(req),
            }
        },
        "size": req.k,
        "highlight": {"fields": {"raw_text": {"fragment_size": 200,
                                              "number_of_fragments": 1}}},
    }
    body: dict[str, Any] = bm25
    if req.use_knn:
        vec = await _embed(req.query)
        if vec is not None:
            body["knn"] = {
                "field": "embedding",
                "query_vector": vec,
                "k": req.k,
                "num_candidates": max(req.k * 5, 50),
                "filter": _filter_clause(req),
            }
    r = es().search(index="simorgh-projects", body=body, ignore_unavailable=True)
    hits = []
    for h in r["hits"]["hits"]:
        src = h.get("_source", {})
        snippet = ""
        if "highlight" in h and "raw_text" in h["highlight"]:
            snippet = " … ".join(h["highlight"]["raw_text"])
        hits.append(SearchHit(
            id=h["_id"], score=h["_score"], source="project",
            title=src.get("name"), path=src.get("oenum"),
            snippet=snippet or (src.get("raw_text", "")[:200]),
            metadata={k: v for k, v in src.items() if k not in {"name", "raw_text"}},
        ))
    return SearchResponse(hits=hits, took_ms=r["took"])


# ---------------------------------------------------------------------------
# Aggregations (analytical surface)
# ---------------------------------------------------------------------------
def _build_metric_agg(req: AggregateRequest | TimeSeriesRequest) -> dict | None:
    if req.metric == "count":
        return None
    if not req.metric_field:
        raise HTTPException(status_code=400,
                            detail=f"metric={req.metric} requires metric_field")
    if req.metric.startswith("p"):  # p50 / p95 / p99
        pct = float(req.metric[1:])
        return {"percentiles": {"field": req.metric_field, "percents": [pct]}}
    return {req.metric: {"field": req.metric_field}}


def _normalize_field(field: str) -> str:
    """ES 'keyword' subfield is required for terms aggregation on text fields.
    Be lenient: if the user passed a bare 'service', try 'service.keyword'."""
    return field if field.endswith(".keyword") or "." in field else f"{field}.keyword"


@app.post("/aggregate")
def aggregate(req: AggregateRequest):
    index = _INDEX_MAP[req.index]
    metric_agg = _build_metric_agg(req)
    # Try .keyword first; if it 400s, retry with the bare field name.
    for field_candidate in (_normalize_field(req.group_by), req.group_by):
        body: dict[str, Any] = {
            "size": 0,
            "query": {
                "bool": {
                    "must": [{"query_string": {"query": req.filter_query or "*"}}],
                    "filter": [{"range": {req.time_field: {"gte": req.time_range}}}],
                }
            },
            "aggs": {
                "group": {
                    "terms": {"field": field_candidate, "size": req.top_n}
                }
            },
        }
        if metric_agg:
            body["aggs"]["group"]["aggs"] = {"m": metric_agg}
        try:
            r = es().search(index=index, body=body, ignore_unavailable=True)
            break
        except Exception as e:
            if "Fielddata" in str(e) or "Text fields are not optimised" in str(e):
                continue
            raise HTTPException(status_code=500, detail=str(e))
    else:
        raise HTTPException(status_code=400, detail=f"unaggregatable field {req.group_by}")

    out = []
    for b in r["aggregations"]["group"]["buckets"]:
        val = b["doc_count"]
        if metric_agg:
            m = b["m"]
            if req.metric.startswith("p"):
                val = list(m["values"].values())[0]
            else:
                val = m["value"]
        out.append({"key": b["key"], "value": val, "count": b["doc_count"]})
    return {"index": index, "field": req.group_by, "metric": req.metric,
            "time_range": req.time_range, "buckets": out, "took_ms": r["took"]}


@app.post("/time_series")
def time_series(req: TimeSeriesRequest):
    index = _INDEX_MAP[req.index]
    metric_agg = _build_metric_agg(req)
    inner_aggs: dict[str, Any] = {}
    if metric_agg:
        inner_aggs["m"] = metric_agg
    if req.group_by:
        terms_block: dict[str, Any] = {
            "terms": {"field": _normalize_field(req.group_by), "size": req.top_n}
        }
        if metric_agg:
            terms_block["aggs"] = {"m": metric_agg}
        inner_aggs["by"] = terms_block

    body: dict[str, Any] = {
        "size": 0,
        "query": {
            "bool": {
                "must": [{"query_string": {"query": req.filter_query or "*"}}],
                "filter": [{"range": {req.time_field: {"gte": req.time_range}}}],
            }
        },
        "aggs": {
            "ts": {
                "date_histogram": {
                    "field": req.time_field,
                    "fixed_interval": req.interval if req.interval[-1] in "smhd"
                    else None,
                    "calendar_interval": req.interval if req.interval[-1] in "wMy"
                    else None,
                    "min_doc_count": 0,
                },
                "aggs": inner_aggs or {},
            }
        },
    }
    # Drop the None one
    body["aggs"]["ts"]["date_histogram"] = {
        k: v for k, v in body["aggs"]["ts"]["date_histogram"].items() if v is not None
    }
    try:
        r = es().search(index=index, body=body, ignore_unavailable=True)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    series = []
    for b in r["aggregations"]["ts"]["buckets"]:
        point = {"t": b["key_as_string"], "count": b["doc_count"]}
        if metric_agg and "m" in b:
            m = b["m"]
            point["value"] = (list(m["values"].values())[0]
                              if req.metric.startswith("p") else m["value"])
        if req.group_by and "by" in b:
            point["by"] = []
            for ib in b["by"]["buckets"]:
                p = {"key": ib["key"], "count": ib["doc_count"]}
                if metric_agg and "m" in ib:
                    im = ib["m"]
                    p["value"] = (list(im["values"].values())[0]
                                  if req.metric.startswith("p") else im["value"])
                point["by"].append(p)
        series.append(point)
    return {"index": index, "interval": req.interval, "metric": req.metric,
            "series": series, "took_ms": r["took"]}


# ---------------------------------------------------------------------------
# Indexing endpoints
# ---------------------------------------------------------------------------
@app.post("/index/content")
async def index_content(doc: ContentDoc):
    body = doc.model_dump(exclude_none=True)
    body.setdefault("@timestamp", datetime.now(timezone.utc).isoformat())
    if doc.embedding is None:
        v = await _embed(f"{doc.title}\n\n{doc.body}")
        if v is not None:
            body["embedding"] = v
    r = es().index(index="simorgh-content", id=doc.id, document=body)
    return {"id": r["_id"], "result": r["result"]}


@app.post("/index/content/bulk")
async def index_content_bulk(docs: list[ContentDoc]):
    actions = []
    for d in docs:
        body = d.model_dump(exclude_none=True)
        body.setdefault("@timestamp", datetime.now(timezone.utc).isoformat())
        if d.embedding is None:
            v = await _embed(f"{d.title}\n\n{d.body}")
            if v is not None:
                body["embedding"] = v
        action = {"_op_type": "index", "_index": "simorgh-content",
                  "_source": body}
        if d.id: action["_id"] = d.id
        actions.append(action)
    ok, errors = helpers.bulk(es(), actions, raise_on_error=False, stats_only=False)
    return {"indexed": ok, "errors": errors}


@app.post("/index/cot")
async def index_cot(trace: CotTrace):
    """Ingest one completed CoT trace.

    The question is embedded so search_past_cot can do semantic recall.
    Indexed into simorgh-cot-YYYY.MM (one shard per calendar month is
    plenty for office scale, gives nice retention windowing).
    """
    body = trace.model_dump()
    body["@timestamp"] = datetime.now(timezone.utc).isoformat()
    body["steps_count"] = len(trace.steps)
    body["service"] = "cot"
    # Embed question + reasoning prefix for richer semantic recall.
    embed_input = f"{trace.question}\n\n{trace.reasoning[:1500]}"
    v = await _embed(embed_input)
    if v is not None:
        body["embedding"] = v
    idx = "simorgh-cot-" + datetime.now(timezone.utc).strftime("%Y.%m")
    es().index(index=idx, document=body, id=trace.chain_id)
    return {"indexed": True, "index": idx, "chain_id": trace.chain_id}


@app.post("/index/project_meta")
async def index_project_meta(p: ProjectMeta):
    """Upsert one structured project record. Uses oenum as _id so repeat
    calls update in-place rather than duplicating."""
    body = p.model_dump(exclude_none=True)
    body["@timestamp"] = datetime.now(timezone.utc).isoformat()
    body["source"] = "tpms"
    if p.raw_text:
        v = await _embed(p.raw_text[:1500])
        if v is not None:
            body["embedding"] = v
    es().index(index="simorgh-projects", document=body, id=p.oenum)
    return {"indexed": True, "oenum": p.oenum}


# ---------------------------------------------------------------------------
# MCP — the surface the COT agent actually uses
# ---------------------------------------------------------------------------
mcp = FastMCP(
    "context-search",
    instructions=(
        "Hybrid (BM25 + kNN) search and analytical aggregations across "
        "the simorgh knowledge base. Indices: 'content' (docs, GitLab "
        "blobs, TPMS rows, tech-kb), 'projects' (structured project "
        "metadata), 'cot' (prior reasoning traces), 'logs' (runtime "
        "evidence). "
        "USE BEFORE GENERATING: search_context for narrative facts, "
        "search_projects for structured project info, search_past_cot "
        "for 'have I solved this before?'. "
        "USE DURING REASONING: aggregate_field for analytical counts/avg/p95, "
        "time_series_query for trends. "
        "Always prefer aggregate_field over retrieving all docs and counting."
    ),
)


@mcp.tool()
async def search_context(query: str, project_id: str = "", oenum: str = "", k: int = 8) -> dict:
    """Hybrid (BM25 + kNN) search over project docs, GitLab blobs, TPMS rows,
    technical-knowledge, and emails. Returns up to k hits with highlighted
    snippets. Use BEFORE generation for narrative facts."""
    req = SearchRequest(query=query, project_id=project_id or None,
                        oenum=oenum or None, k=k)
    return (await search_content(req)).model_dump()


@mcp.tool()
async def regex_search_project(
    pattern: str,
    project_id: str = "",
    query_text: str = "",
    max_matches: int = 20,
    max_scan: int = 300,
    context_chars: int = 200,
    case_insensitive: bool = True,
    multiline: bool = True,
) -> dict:
    """Precise-match retrieval. Run a Python regex over the project's
    auto-indexed chunks and return matching passages with surrounding
    context. The planner generates `pattern` from the user's intent.

    When to use this over search_context:
      - The user mentions a code, ID, or fixed phrase you want EXACTLY:
        OE numbers, IEC clause numbers ("IEC 61439-2"), part numbers,
        a Persian heading you saw in get_project_tree.
      - You need disjunction / case-insensitivity that a BM25 query
        can't express cleanly: "(transformer|reactor)\\s+ratio".
      - search_context returned high-scoring hits but you need to pull
        the SPECIFIC sentence / cell that mentions X for citation.

    When NOT to use:
      - Fuzzy / conceptual queries ("what does the spec think about
        earthing best practices") — use search_context.
      - The corpus isn't indexed yet (no scan target). The planner
        should always have run search_context once before reaching for
        regex; if that returned no project hits, regex won't help.

    Args:
      pattern: Python re-syntax. Keep < 512 chars. Be careful with
        catastrophic backtracking shapes like (.+)+ or (a|a)*; the
        server caps per-chunk scan length but won't rescue a truly
        pathological pattern.
      project_id: REQUIRED in normal use. Without it you'll scan
        every indexed chunk across all projects, which is slow and
        leaks data across project boundaries.
      query_text: Optional semantic narrowing. If you have a fuzzy
        topic the regex is trying to nail down, pass it here — the
        scan only walks the top max_scan BM25+kNN candidates instead
        of an arbitrary slice. Doubles the precision of the result
        set with no extra planner steps.
      max_matches: Hard cap on returned matches (1-100). Default 20
        is enough for citation-style answers.
      max_scan: Hard cap on chunks examined (1-2000). Default 300
        bounds CPU at ~1s for typical 2kB chunks.
      context_chars: Chars before/after each match in the `context`
        field. Bigger = better synthesis input, smaller = less noise.

    Returns:
      {hits: [{path, title, source, score, match, context, chunk_id}],
       scanned: <int>, pattern: <echoed>, took_ms: <int>,
       error: <str|null>}
      `error` is set (not raised) when the pattern doesn't compile
      or ES is unreachable — surfaces as a usable signal in the
      next planner step instead of an exception.
    """
    req = RegexRequest(
        pattern=pattern,
        project_id=project_id or None,
        query_text=query_text or None,
        max_matches=max_matches,
        max_scan=max_scan,
        context_chars=context_chars,
        case_insensitive=case_insensitive,
        multiline=multiline,
    )
    return (await search_regex(req)).model_dump()


@mcp.tool()
async def search_projects_mcp(query: str, project_id: str = "", k: int = 10) -> dict:
    """Hybrid search over STRUCTURED project metadata (name, customer,
    voltage_class, motor_type, status, year, panel/feeder/equipment counts).
    Use when the user references a project loosely ('the 6kV motor project
    we did for ABC last year') and you need to resolve it to an oenum."""
    req = SearchRequest(query=query, project_id=project_id or None, k=k)
    return (await search_projects(req)).model_dump()


@mcp.tool()
async def search_past_cot(query: str, project_id: str = "", k: int = 5) -> dict:
    """Search prior chain-of-thought traces (hybrid BM25 + kNN over the
    'question' field). Use early in reasoning to ask 'have I solved a
    similar problem before?'. Returned hits include the steps and final
    answer of past sessions — copy what worked, learn from what failed."""
    return await search_cot(SearchRequest(query=query, project_id=project_id or None, k=k))


@mcp.tool()
async def search_logs_mcp(query: str, k: int = 10) -> dict:
    """Search service logs (BM25 over simorgh-logs-*). Use for runtime
    evidence: 'did embeddings-service report any errors when I called it?',
    'what was the last MySQL timeout in auth-service?'. Sparing use — for
    debugging context only."""
    return search_logs(SearchRequest(query=query, k=k))


@mcp.tool()
async def aggregate_field(
    index: str,
    group_by: str,
    metric: str = "count",
    metric_field: str = "",
    filter_query: str = "",
    time_range: str = "now-30d",
    top_n: int = 20,
) -> dict:
    """Run an ES terms aggregation. Use for ANALYTICAL questions ('how many',
    'distribution of', 'top N', 'average per group').

    Examples:
      How many projects per voltage_class:
        aggregate_field(index='projects', group_by='voltage_class')

      Avg LLM latency per service over last 7 days:
        aggregate_field(index='logs', group_by='service',
                        metric='avg', metric_field='latency_ms',
                        time_range='now-7d')

      Count of failed CoT traces per step_type:
        aggregate_field(index='cot', group_by='steps.tool',
                        filter_query='success:false')

    index:        'content' | 'logs' | 'cot' | 'projects'
    metric:       'count' (default) | 'avg' | 'sum' | 'min' | 'max'
                  | 'p50' | 'p95' | 'p99'
    metric_field: required for non-count metrics, the numeric field to compute on
    filter_query: ES query_string syntax, e.g. 'level:ERROR AND service:backend'
    time_range:   'now-7d' | 'now-1M' etc.

    Returns {"buckets": [{"key": ..., "value": ..., "count": ...}, ...]}.
    """
    return aggregate(AggregateRequest(
        index=index, group_by=group_by, metric=metric,
        metric_field=metric_field, filter_query=filter_query,
        time_range=time_range, top_n=top_n,
    ))


@mcp.tool()
async def time_series_query(
    index: str,
    interval: str = "1d",
    metric: str = "count",
    metric_field: str = "",
    filter_query: str = "",
    time_range: str = "now-90d",
    group_by: str | None = None,
    top_n: int = 5,
) -> dict:
    """Get a date-bucketed time series. Use for TREND questions ('is X
    increasing over time?', 'usage by week', 'p95 latency over the last
    month').

    Examples:
      Daily ERROR count per service for last 30d:
        time_series_query(index='logs', interval='1d',
                          filter_query='level:ERROR', group_by='service',
                          time_range='now-30d')

      Weekly project count by voltage_class:
        time_series_query(index='projects', interval='1w',
                          group_by='voltage_class', time_range='now-1y')

      Hourly p95 LLM latency:
        time_series_query(index='logs', interval='1h',
                          metric='p95', metric_field='latency_ms',
                          filter_query='event:llm_call',
                          time_range='now-1d')

    interval: '1m','5m','1h','1d' (fixed) or '1w','1M','1y' (calendar)
    """
    return time_series(TimeSeriesRequest(
        index=index, interval=interval, metric=metric,
        metric_field=metric_field, filter_query=filter_query,
        time_range=time_range, group_by=group_by, top_n=top_n,
    ))


@mcp.tool()
async def index_cot_trace(trace_json: dict) -> dict:
    """Persist a completed CoT trace so future runs can recall it.

    Called by the agent itself at the END of reasoning. The trace_json
    must match the CotTrace model:
      {chain_id, session_id, user_id, project_id?, oenum?, question,
       reasoning, final_answer?, success, steps: [{step_number,
       step_type, title, description, tool?, ...}], total_latency_ms?,
       tags?: [...]}.

    Returns the assigned ES _id and index name. Idempotent on chain_id.
    """
    return await index_cot(CotTrace(**trace_json))


# ---------------------------------------------------------------------------
# Priority-4: separated retrievers + RRF merger
# ---------------------------------------------------------------------------
# Three retriever tools exposed on their own so the agent can fire them
# in parallel via a single tool-call array. ``merged_search`` is the
# reciprocal-rank-fusion combiner — useful when the agent doesn't want
# to think about which retriever to ask.

_age_client = None  # lazy


def _age():
    """Lazy AgeClient. Returns None if AGE isn't configured (no DSN)."""
    global _age_client
    if not AGE_DSN:
        return None
    if _age_client is None:
        try:
            from simorgh_graph import AgeClient
            _age_client = AgeClient(dsn=AGE_DSN, graph_name=AGE_GRAPH_NAME)
        except Exception as e:
            log.warning("age_client_init_failed", error=str(e))
            return None
    return _age_client


@mcp.tool()
async def bm25_search(query: str, project_id: str = "", oenum: str = "",
                      k: int = 8) -> dict:
    """BM25-only search over the content index. Use when you want
    lexical recall — exact part numbers, oenums, identifiers."""
    req = SearchRequest(query=query, project_id=project_id or None,
                        oenum=oenum or None, k=k, use_knn=False)
    return (await search_content(req)).model_dump()


@mcp.tool()
async def vector_search(query: str, project_id: str = "", oenum: str = "",
                        k: int = 8) -> dict:
    """Dense-vector (kNN) search via Qdrant collections. Use when you
    want semantic recall over project document chunks ("the panel
    with overcurrent issue").

    Returns hits in the same shape as bm25_search so the RRF fuser
    can stitch them. Empty result when no Qdrant collection matches.
    """
    if not project_id and not oenum:
        return {"hits": [], "took_ms": 0, "note": "vector_search needs project_id or oenum"}
    try:
        vec = await _embed(query)
        if vec is None:
            return {"hits": [], "took_ms": 0, "note": "embeddings unavailable"}
        # Collection naming follows project-agent-service's convention.
        collection = f"project_{(oenum or project_id).strip().lower()}"
        async with httpx.AsyncClient(timeout=15.0) as c:
            r = await c.post(
                f"{QDRANT_URL}/collections/{collection}/points/search",
                json={"vector": vec, "limit": k, "with_payload": True},
            )
        if r.status_code == 404:
            return {"hits": [], "took_ms": 0, "note": f"no qdrant collection {collection!r}"}
        r.raise_for_status()
        body = r.json()
        hits = []
        for p in body.get("result", []):
            payload = p.get("payload") or {}
            hits.append({
                "id": str(p.get("id", "")),
                "score": float(p.get("score", 0.0)),
                "source": "qdrant",
                "title": payload.get("section_title") or payload.get("filename"),
                "path": payload.get("filename"),
                "snippet": (payload.get("text") or "")[:300],
                "metadata": payload,
            })
        return {"hits": hits, "took_ms": int(body.get("time", 0) * 1000)}
    except Exception as e:
        log.warning("vector_search_failed", error=str(e))
        return {"hits": [], "took_ms": 0, "error": str(e)}


@mcp.tool()
async def graph_search(query: str, project_id: str = "", oenum: str = "",
                       entities: list[str] | None = None,
                       hops: int = 2, limit: int = 20) -> dict:
    """Property-graph traversal over Apache AGE.

    Use when the question is about relationships — "what's connected to
    breaker F-103?", "which components share net BUS-1?", "what
    decisions touched the main transformer?". Pass ``entities`` (a list
    of component tags) to seed the traversal; otherwise the query is
    used as a substring match against component tag and document path.

    Returns up to ``limit`` paths within ``hops`` of any seed vertex.
    Empty result when AGE isn't configured.
    """
    client = _age()
    if client is None:
        return {"hits": [], "note": "AGE not configured (AGE_DSN unset)"}
    seed = (entities or [])[:10]
    if not seed:
        # Fall back to a substring match on the query so the tool is
        # always useful even without entity extraction in the caller.
        seed = [tok for tok in query.split() if len(tok) > 2][:5]
    if not seed:
        return {"hits": [], "note": "no seed entities derived from query"}

    project_filter = ""
    if oenum:
        # Restrict the start vertex to the project's components.
        project_filter = (
            "WITH start MATCH (p:Project {oenum: $oenum})-[:HAS*1..3]->(start) "
        )

    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    try:
        for tag in seed:
            cypher = (
                "MATCH (start:Component {tag: $tag}) "
                + project_filter
                + f"MATCH path = (start)-[*1..{int(hops)}]-(other) "
                f"RETURN start, other, length(path) AS hops LIMIT {int(limit)}"
            )
            params: dict[str, Any] = {"tag": tag}
            if oenum:
                params["oenum"] = oenum
            res = await asyncio.to_thread(client.cypher, cypher, params,
                                          [("start", "agtype"),
                                           ("other", "agtype"),
                                           ("hops", "integer")])
            for r in res:
                other = r.get("other") or {}
                # AGE's vertex agtype is {"id": ..., "label": ..., "properties": {...}}
                props = other.get("properties") if isinstance(other, dict) else {}
                key = f"{other.get('label')}/{(props or {}).get('tag') or other.get('id')}"
                if key in seen:
                    continue
                seen.add(key)
                rows.append({
                    "id": key,
                    "score": 1.0 / max(1, int(r.get("hops") or 1)),
                    "source": "age",
                    "title": (props or {}).get("tag") or (props or {}).get("name") or key,
                    "snippet": "",
                    "metadata": {
                        "label": other.get("label"),
                        "properties": props,
                        "hops": r.get("hops"),
                        "seed": tag,
                    },
                })
    except Exception as e:
        log.warning("graph_search_failed", error=str(e))
        return {"hits": [], "error": str(e)}
    # Already deduplicated; sort by score (closer = higher).
    rows.sort(key=lambda d: d["score"], reverse=True)
    return {"hits": rows[:limit]}


@mcp.tool()
async def merged_search(query: str, project_id: str = "", oenum: str = "",
                        k: int = 8, hops: int = 2) -> dict:
    """Run bm25/vector/graph in parallel and reciprocal-rank-fuse them.

    Use when you want one ranked list without thinking about which
    retriever owns the answer. The response carries per-hit
    ``rrf_sources`` so you can see which retrievers agreed.
    """
    bm25_task = bm25_search(query=query, project_id=project_id, oenum=oenum, k=k)
    vec_task = vector_search(query=query, project_id=project_id, oenum=oenum, k=k)
    graph_task = graph_search(query=query, project_id=project_id, oenum=oenum, hops=hops, limit=k)
    bm25_out, vec_out, graph_out = await asyncio.gather(
        bm25_task, vec_task, graph_task, return_exceptions=True,
    )

    def _hits(r: Any) -> list[dict]:
        if isinstance(r, dict):
            return r.get("hits") or []
        return []

    fused = labeled_rrf(
        {
            "bm25":   _hits(bm25_out),
            "vector": _hits(vec_out),
            "graph":  _hits(graph_out),
        },
        id_key="id",
        top_n=k,
    )
    return {
        "hits": fused,
        "retriever_meta": {
            "bm25_count":   len(_hits(bm25_out)),
            "vector_count": len(_hits(vec_out)),
            "graph_count":  len(_hits(graph_out)),
        },
    }


@app.get("/age/health")
async def age_health():
    """Liveness probe for the AGE side of the search surface."""
    client = _age()
    if client is None:
        return {"status": "disabled", "reason": "AGE_DSN unset"}
    ok = await asyncio.to_thread(client.health_check)
    return {"status": "ok" if ok else "unhealthy"}


# FastMCP's streamable_http_app exposes route /mcp internally. Mount at
# "/" so its public path is /mcp (mounting at "/mcp" would produce /mcp/mcp).
# Its session_manager needs an active TaskGroup; when the inner app is
# mounted under another FastAPI, the inner lifespan never fires — start
# the session manager from the outer app's lifespan instead, otherwise
# every POST returns 500 with "Task group is not initialized".
_mcp_streamable_app = mcp.streamable_http_app()

@app.on_event("startup")
async def _mcp_session_manager_start():
    cm = mcp.session_manager.run()
    app.state._mcp_session_manager_cm = cm
    await cm.__aenter__()

@app.on_event("shutdown")
async def _mcp_session_manager_stop():
    cm = getattr(app.state, "_mcp_session_manager_cm", None)
    if cm is not None:
        await cm.__aexit__(None, None, None)

app.mount("/", _mcp_streamable_app)
