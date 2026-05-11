"""
context-search-service
======================
Hybrid (BM25 + kNN) search across the Elasticsearch indices the simorgh
stack writes to. The agent calls this BEFORE generation to assemble a
"high-quality context" block.

REST:
  POST /search/content     — hybrid search across project docs, GitLab,
                             TPMS, technical-knowledge, emails
  POST /search/logs        — BM25 over simorgh-logs-*
  POST /search/cot         — BM25 over simorgh-cot-* (prior agent traces)
  POST /index/content      — index a single document (called by ingestors)
  POST /index/content/bulk — bulk index
  GET  /health

MCP:
  search_context(query, project_id?, k?)
  search_past_cot(query, project_id?, k?)
  search_logs(query, time_range?, k?)
"""
import os
from datetime import datetime, timezone
from typing import Any

import httpx
from elasticsearch import Elasticsearch, helpers
from fastapi import FastAPI, HTTPException
from mcp.server.fastmcp import FastMCP
from pydantic import BaseModel, Field

from simorgh_logging import configure, get_logger, request_id_middleware

from index_setup import ensure_templates

configure(service="context-search")
log = get_logger(__name__)

ES_URL          = os.getenv("ELASTICSEARCH_URL", "http://elasticsearch:9200")
ES_USER         = os.getenv("ELASTIC_USER", "")
ES_PASSWORD     = os.getenv("ELASTIC_PASSWORD", "")
EMBEDDINGS_URL  = os.getenv("EMBEDDINGS_URL", "http://embeddings:8037")
EMBED_DIMS      = int(os.getenv("EMBED_DIMS", "768"))


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
# Models
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


# ---------------------------------------------------------------------------
# FastAPI
# ---------------------------------------------------------------------------
app = FastAPI(title="context-search", version="0.1.0")
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
def search_cot(req: SearchRequest):
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
    r = es().search(index="simorgh-cot-*", body=body)
    return {"hits": [h["_source"] | {"_id": h["_id"]} for h in r["hits"]["hits"]],
            "took_ms": r["took"]}


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


# ---------------------------------------------------------------------------
# MCP
# ---------------------------------------------------------------------------
mcp = FastMCP(
    "context-search",
    instructions=(
        "Hybrid (BM25 + vector) search across project docs, GitLab "
        "blobs, TPMS rows, technical-knowledge, and prior agent traces. "
        "Use BEFORE generating a response to assemble high-quality context."
    ),
)


@mcp.tool()
async def search_context(query: str, project_id: str = "", oenum: str = "", k: int = 8) -> dict:
    """Hybrid search across all indexed simorgh content. Returns up to k hits."""
    req = SearchRequest(query=query, project_id=project_id or None,
                        oenum=oenum or None, k=k)
    resp = await search_content(req)
    return resp.model_dump()


@mcp.tool()
async def search_past_cot(query: str, project_id: str = "", k: int = 5) -> dict:
    """Search prior chain-of-thought traces. Useful for 'have I solved this before?'"""
    return search_cot(SearchRequest(query=query, project_id=project_id or None, k=k))


@mcp.tool()
async def search_logs_mcp(query: str, k: int = 10) -> dict:
    """Search service logs. Use sparingly — for debugging context only."""
    return search_logs(SearchRequest(query=query, k=k))


app.mount("/mcp", mcp.streamable_http_app())
