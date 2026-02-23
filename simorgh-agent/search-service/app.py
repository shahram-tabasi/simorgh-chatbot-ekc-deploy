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

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from duckduckgo_search import DDGS
from mcp.server.fastmcp import FastMCP

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Simorgh Search Service", version="1.0.0")

MAX_RESULTS = int(os.getenv("MAX_RESULTS", "10"))


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
    return {"status": "healthy", "service": "search-service"}


@app.post("/search", response_model=SearchResponse)
async def web_search(req: SearchRequest):
    """Perform a web search using DuckDuckGo."""
    try:
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
    """Search recent news using DuckDuckGo."""
    try:
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
    """Shared search logic for REST and MCP."""
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
    """Shared news search logic for REST and MCP."""
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
app.mount("/mcp", mcp.streamable_http_app())

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8020)
