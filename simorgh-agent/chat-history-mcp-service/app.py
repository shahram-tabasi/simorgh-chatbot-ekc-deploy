"""
chat-history-mcp
================
Standalone MCP surface for retrieving a user's past conversation history
via HYBRID search (Elasticsearch BM25 + kNN dense vectors) with metadata
filtering — the long-term-memory layer the CoT planner calls when the
user references something older than the last few turns ("we discussed…",
"you said earlier", "last time", "the X we agreed on").

Why a dedicated service (not the existing memory_query)? memory_query is
Qdrant-only (pure semantic) and lacks BM25 keyword recall (exact names,
OE numbers, standards codes) and metadata filtering (this user / project /
time window). Per 2026 agent-memory best practice, chat memory is a
first-class HYBRID retrieval layer: semantic + keyword + metadata, ranked,
injected only when relevant. This service provides exactly that, modelled
on context-search's simorgh-content hybrid search.

Indexing: the agent POSTs each stored message to /index (fire-and-forget).
We embed via embeddings-service and write to the `simorgh-chat` ES index.

Endpoints (REST + MCP at /mcp):
  GET  /health
  POST /index            — index one message {chat_id,user_id,project_id,role,content,ts?}
  POST /search           — hybrid search with metadata filters
"""

import os
import logging
from datetime import datetime, timezone, timedelta
from typing import Any, Optional

import httpx
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from elasticsearch import Elasticsearch
from mcp.server.fastmcp import FastMCP

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
log = logging.getLogger("chat-history-mcp")

ES_URL         = os.getenv("ELASTICSEARCH_URL", "http://elasticsearch:9200")
ES_USER        = os.getenv("ELASTIC_USER", "")
ES_PASSWORD    = os.getenv("ELASTIC_PASSWORD", "")
EMBEDDINGS_URL = os.getenv("EMBEDDINGS_URL", "http://embeddings-service:8031").rstrip("/")
EMBED_DIM      = int(os.getenv("CHAT_EMBED_DIM", "768"))
INDEX          = os.getenv("CHAT_INDEX", "simorgh-chat")

_es: Optional[Elasticsearch] = None


def es() -> Elasticsearch:
    global _es
    if _es is None:
        auth = (ES_USER, ES_PASSWORD) if ES_USER else None
        _es = Elasticsearch(ES_URL, basic_auth=auth, request_timeout=30)
    return _es


_CHAT_MAPPING = {
    "settings": {
        "number_of_shards": 1,
        "number_of_replicas": 0,
        "index.refresh_interval": "5s",
    },
    "mappings": {
        "properties": {
            "@timestamp":  {"type": "date"},
            "message_id":  {"type": "keyword"},
            "chat_id":     {"type": "keyword"},
            "user_id":     {"type": "keyword"},
            "project_id":  {"type": "keyword"},
            "role":        {"type": "keyword"},   # user | assistant
            "content":     {"type": "text"},
            "embedding":   {
                "type": "dense_vector",
                "dims": EMBED_DIM,
                "index": True,
                "similarity": "cosine",
            },
        },
    },
}


def _ensure_index() -> None:
    try:
        if not es().indices.exists(index=INDEX):
            es().indices.create(index=INDEX, body=_CHAT_MAPPING)
            log.info("created index %s", INDEX)
    except Exception as e:
        log.warning("ensure_index failed (%s); will retry on first use", e)


async def _embed(text: str) -> Optional[list]:
    """Embed via embeddings-service. Returns None on failure (search then
    degrades to BM25-only, which still works)."""
    try:
        async with httpx.AsyncClient(timeout=20.0) as c:
            r = await c.post(f"{EMBEDDINGS_URL}/embeddings", json={"text": text})
        if r.status_code == 200:
            v = r.json().get("embedding") or r.json().get("vector")
            if isinstance(v, list) and v:
                return v
    except Exception as e:
        log.debug("embed failed: %s", e)
    return None


# ---------------------------------------------------------------------------
app = FastAPI(title="chat-history-mcp", version="0.1.0")


@app.on_event("startup")
def _startup():
    _ensure_index()


@app.get("/health")
def health() -> dict:
    ok = False
    try:
        ok = es().ping()
    except Exception:
        ok = False
    return {"status": "healthy", "service": "chat-history-mcp",
            "es_reachable": ok, "index": INDEX, "embeddings": EMBEDDINGS_URL}


class IndexMessage(BaseModel):
    chat_id:    str
    user_id:    str = ""
    project_id: str = ""
    role:       str = "user"
    content:    str
    message_id: str = ""
    ts:         Optional[str] = None


@app.post("/index")
async def index_message(msg: IndexMessage) -> dict:
    """Index one chat message for future hybrid retrieval. Fire-and-forget
    from the agent's store_message path. Skips empties + trivially short
    system noise."""
    content = (msg.content or "").strip()
    if len(content) < 3:
        return {"indexed": False, "reason": "too_short"}
    doc: dict[str, Any] = {
        "@timestamp": msg.ts or datetime.now(timezone.utc).isoformat(),
        "message_id": msg.message_id or "",
        "chat_id": msg.chat_id,
        "user_id": msg.user_id,
        "project_id": msg.project_id,
        "role": msg.role,
        "content": content[:8000],
    }
    vec = await _embed(content[:2000])
    if vec is not None:
        doc["embedding"] = vec
    try:
        _ensure_index()
        es().index(index=INDEX, document=doc)
        return {"indexed": True, "embedded": vec is not None}
    except Exception as e:
        log.warning("index failed: %s", e)
        raise HTTPException(status_code=502, detail=f"es index error: {e}")


class SearchRequest(BaseModel):
    query:      str
    user_id:    str = ""
    project_id: str = ""
    chat_id:    str = ""
    k:          int = 8
    days:       int = 0          # 0 = no time filter
    exclude_chat_id: str = ""    # skip the current chat (it's already in context)
    use_knn:    bool = True


def _filter(req: SearchRequest) -> list:
    f: list = []
    if req.user_id:
        f.append({"term": {"user_id": req.user_id}})
    if req.project_id:
        f.append({"term": {"project_id": req.project_id}})
    if req.chat_id:
        f.append({"term": {"chat_id": req.chat_id}})
    if req.exclude_chat_id:
        f.append({"bool": {"must_not": {"term": {"chat_id": req.exclude_chat_id}}}})
    if req.days and req.days > 0:
        since = (datetime.now(timezone.utc) - timedelta(days=req.days)).isoformat()
        f.append({"range": {"@timestamp": {"gte": since}}})
    return f


async def search_impl(req: SearchRequest) -> dict:
    filt = _filter(req)
    body: dict[str, Any] = {
        "query": {
            "bool": {
                "must": [{"match": {"content": {"query": req.query}}}],
                "filter": filt,
            }
        },
        "size": req.k,
        "_source": ["@timestamp", "chat_id", "user_id", "project_id",
                    "role", "content"],
        "highlight": {"fields": {"content": {"fragment_size": 220,
                                             "number_of_fragments": 1}}},
    }
    if req.use_knn:
        vec = await _embed(req.query)
        if vec is not None:
            body["knn"] = {
                "field": "embedding",
                "query_vector": vec,
                "k": req.k,
                "num_candidates": max(req.k * 5, 50),
                "filter": filt,
            }
    try:
        r = es().search(index=INDEX, body=body)
    except Exception as e:
        # Index may not exist yet (no chats indexed) — return empty, not 500.
        log.debug("search failed: %s", e)
        return {"query": req.query, "hits": [], "hit_count": 0}
    hits = []
    for h in r["hits"]["hits"]:
        src = h.get("_source", {})
        snippet = ""
        if "highlight" in h and "content" in h["highlight"]:
            snippet = " … ".join(h["highlight"]["content"])
        hits.append({
            "score": h["_score"],
            "role": src.get("role"),
            "chat_id": src.get("chat_id"),
            "timestamp": src.get("@timestamp"),
            "snippet": snippet or (src.get("content") or "")[:220],
            "content": (src.get("content") or "")[:1500],
        })
    return {"query": req.query, "hits": hits, "hit_count": len(hits),
            "took_ms": r.get("took")}


@app.post("/search")
async def search(req: SearchRequest) -> dict:
    return await search_impl(req)


# ---------------------------------------------------------------------------
# MCP surface
# ---------------------------------------------------------------------------
mcp = FastMCP(
    "chat-history-mcp",
    instructions=(
        "Retrieve a user's PAST conversation history via hybrid (keyword + "
        "semantic) search with metadata filters. Call chat_history_search "
        "when the user references something older than the last few turns "
        "already in context — 'we discussed', 'you said earlier', 'last "
        "time', 'the X we agreed on'."
    ),
)


@mcp.tool()
async def chat_history_search(
    query: str, user_id: str = "", project_id: str = "", chat_id: str = "",
    exclude_chat_id: str = "", days: int = 0, k: int = 8,
) -> dict:
    """Search the user's PAST chat history (hybrid BM25 + semantic) for
    turns relevant to `query`. Scope with user_id / project_id / chat_id and
    an optional `days` time window. Use exclude_chat_id to skip the current
    conversation (its recent turns are already in context). Returns
    {hits:[{role,timestamp,snippet,content,score}], hit_count}. Use when the
    user refers to an earlier discussion not in the recent-turns window.
    """
    return await search_impl(SearchRequest(
        query=query, user_id=user_id, project_id=project_id, chat_id=chat_id,
        exclude_chat_id=exclude_chat_id, days=days, k=k,
    ))


_mcp_app = mcp.streamable_http_app()


@app.on_event("startup")
async def _mcp_start():
    cm = mcp.session_manager.run()
    app.state._mcp_cm = cm
    await cm.__aenter__()


@app.on_event("shutdown")
async def _mcp_stop():
    cm = getattr(app.state, "_mcp_cm", None)
    if cm is not None:
        await cm.__aexit__(None, None, None)


app.mount("/", _mcp_app)
