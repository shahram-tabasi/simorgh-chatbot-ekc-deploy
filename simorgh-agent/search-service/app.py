"""
Search Service - Internet Search via DuckDuckGo
=================================================
FastAPI microservice providing web search capabilities
using DuckDuckGo (no API key required).

Endpoints:
  POST /search       - General web search
  POST /search/news  - News search
  GET  /health       - Health check
  /mcp               - MCP Streamable HTTP endpoint
"""

import json
import logging
import os
from typing import Optional, List, Dict, Any

import httpx
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from duckduckgo_search import DDGS
from mcp.server.fastmcp import FastMCP

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Simorgh Search Service", version="1.0.0")

MAX_RESULTS = int(os.getenv("MAX_RESULTS", "10"))

# ------------------------------------------------------------------
# SearXNG feature flag
# ------------------------------------------------------------------
# When USE_SEARXNG=1 and SEARXNG_URL is reachable, route every web_search
# call through the self-hosted SearXNG instance (aggregates 70+ engines,
# more reliable than DDG alone — DuckDuckGo's rate-limiting hits Iranian
# IPs hard, and the duckduckgo-search Python package breaks every few
# months when DDG ships an HTML change).
#
# Silent fallback to DDG on any failure: HTTP error, timeout, malformed
# JSON, empty results. A misconfigured SearXNG cannot take this service
# offline — flipping the flag is risk-free.
USE_SEARXNG = os.getenv("USE_SEARXNG", "0").lower() in ("1", "true", "yes")
SEARXNG_URL = os.getenv("SEARXNG_URL", "http://searxng:8080").rstrip("/")
SEARXNG_TIMEOUT_SEC = float(os.getenv("SEARXNG_TIMEOUT_SEC", "20"))


def _searxng_query(query: str, max_results: int, region: str,
                   time_range: Optional[str], categories: str = "general"
                   ) -> Optional[List[Dict[str, str]]]:
    """Hit SearXNG /search?format=json. Returns DDG-shaped result dicts on
    success, or None on ANY failure (so the caller can fall back to DDG).

    Sync — uses httpx.Client. Both REST and MCP paths call this.
    """
    if not USE_SEARXNG:
        return None
    params = {
        "q": query,
        "format": "json",
        "safesearch": "0",
        "categories": categories,
    }
    # SearXNG region codes are like "fa-IR"; DDG uses "wt-wt" for worldwide.
    # Map only the non-default; the rest pass through unchanged.
    if region and region != "wt-wt":
        params["language"] = region
    if time_range:
        # SearXNG: time_range=day|week|month|year; DDG: d|w|m|y. Translate.
        params["time_range"] = {"d": "day", "w": "week",
                                "m": "month", "y": "year"}.get(time_range, time_range)
    try:
        with httpx.Client(timeout=SEARXNG_TIMEOUT_SEC) as c:
            r = c.get(f"{SEARXNG_URL}/search", params=params)
        if r.status_code != 200:
            logger.warning(
                "searxng: HTTP %s on query=%r (body[:200]=%r); falling back to DDG",
                r.status_code, query, r.text[:200],
            )
            return None
        payload = r.json()
        results = payload.get("results") or []
        # Map SearXNG shape → DDG shape so callers don't care which backend ran.
        return [{
            "title": x.get("title", ""),
            "href": x.get("url", ""),
            "body": x.get("content", ""),
        } for x in results[:max_results]]
    except Exception as e:
        logger.warning(
            "searxng: failed for query=%r (%s: %s); falling back to DDG",
            query, type(e).__name__, e,
        )
        return None


class SearchRequest(BaseModel):
    query: str = Field(..., min_length=1, max_length=500)
    max_results: int = Field(5, ge=1, le=20)
    region: str = Field("wt-wt", description="Region code (wt-wt=worldwide)")
    time_range: Optional[str] = Field(None, description="d=day, w=week, m=month, y=year")


class SearchResult(BaseModel):
    title: str
    url: str
    snippet: str


class SearchResponse(BaseModel):
    query: str
    results: List[SearchResult]
    total: int


@app.get("/health")
async def health():
    return {
        "status": "healthy",
        "service": "search-service",
        "searxng": {
            "enabled": USE_SEARXNG,
            "url": SEARXNG_URL if USE_SEARXNG else None,
        },
    }


@app.post("/search", response_model=SearchResponse)
async def web_search(req: SearchRequest):
    """Perform a web search. Prefers SearXNG when USE_SEARXNG=1; otherwise
    (or on SearXNG failure) falls back to DuckDuckGo."""
    try:
        raw = _searxng_query(
            req.query, min(req.max_results, MAX_RESULTS),
            req.region, req.time_range, categories="general",
        )
        if raw is None:
            with DDGS() as ddgs:
                raw = list(ddgs.text(
                    keywords=req.query,
                    region=req.region,
                    timelimit=req.time_range,
                    max_results=min(req.max_results, MAX_RESULTS),
                ))

        results = [
            SearchResult(
                title=r.get("title", ""),
                url=r.get("href", r.get("link", "")),
                snippet=r.get("body", r.get("snippet", "")),
            )
            for r in raw
        ]

        return SearchResponse(query=req.query, results=results, total=len(results))

    except Exception as e:
        logger.error(f"Search failed: {e}")
        raise HTTPException(status_code=502, detail=f"Search error: {str(e)}")


@app.post("/search/news", response_model=SearchResponse)
async def news_search(req: SearchRequest):
    """Search recent news. Prefers SearXNG news category when USE_SEARXNG=1;
    falls back to DuckDuckGo news on any failure."""
    try:
        raw = _searxng_query(
            req.query, min(req.max_results, MAX_RESULTS),
            req.region, req.time_range or "w", categories="news",
        )
        if raw is None:
            with DDGS() as ddgs:
                raw = list(ddgs.news(
                    keywords=req.query,
                    region=req.region,
                    timelimit=req.time_range or "w",
                    max_results=min(req.max_results, MAX_RESULTS),
                ))

        results = [
            SearchResult(
                title=r.get("title", ""),
                url=r.get("url", r.get("link", "")),
                snippet=r.get("body", r.get("excerpt", "")),
            )
            for r in raw
        ]

        return SearchResponse(query=req.query, results=results, total=len(results))

    except Exception as e:
        logger.error(f"News search failed: {e}")
        raise HTTPException(status_code=502, detail=f"News search error: {str(e)}")


# =============================================================================
# MCP Server - Exposes search tools via Model Context Protocol
# =============================================================================
mcp = FastMCP("search-service", instructions="Web search via DuckDuckGo")


def _do_web_search(query: str, max_results: int, region: str,
                   time_range: Optional[str]) -> str:
    """Shared search logic for REST and MCP. SearXNG-first, DDG fallback."""
    raw = _searxng_query(query, min(max_results, MAX_RESULTS),
                         region, time_range, categories="general")
    if raw is None:
        with DDGS() as ddgs:
            raw = list(ddgs.text(
                keywords=query, region=region, timelimit=time_range,
                max_results=min(max_results, MAX_RESULTS),
            ))
    results = [
        {"title": r.get("title", ""),
         "url": r.get("href", r.get("link", "")),
         "snippet": r.get("body", r.get("snippet", ""))}
        for r in raw
    ]
    return json.dumps({"query": query, "results": results, "total": len(results)})


def _do_news_search(query: str, max_results: int, region: str,
                    time_range: Optional[str]) -> str:
    """Shared news search logic. SearXNG-first, DDG fallback."""
    raw = _searxng_query(query, min(max_results, MAX_RESULTS),
                         region, time_range or "w", categories="news")
    if raw is None:
        with DDGS() as ddgs:
            raw = list(ddgs.news(
                keywords=query, region=region,
                timelimit=time_range or "w",
                max_results=min(max_results, MAX_RESULTS),
            ))
    results = [
        {"title": r.get("title", ""),
         "url": r.get("url", r.get("link", "")),
         "snippet": r.get("body", r.get("excerpt", ""))}
        for r in raw
    ]
    return json.dumps({"query": query, "results": results, "total": len(results)})


@mcp.tool()
def web_search(query: str, max_results: int = 5, region: str = "wt-wt",
               time_range: str = None) -> str:
    """Search the web using DuckDuckGo. Returns JSON with title, url, snippet for each result."""
    try:
        return _do_web_search(query, max_results, region, time_range)
    except Exception as e:
        return json.dumps({"error": str(e)})


@mcp.tool()
def web_search_news(query: str, max_results: int = 5, region: str = "wt-wt",
                    time_range: str = None) -> str:
    """Search recent news using DuckDuckGo. Returns JSON with title, url, snippet for each result."""
    try:
        return _do_news_search(query, max_results, region, time_range)
    except Exception as e:
        return json.dumps({"error": str(e)})


# Mount MCP on the existing FastAPI app
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

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8020)
