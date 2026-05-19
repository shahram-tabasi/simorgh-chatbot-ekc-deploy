"""
tpms-context-agent
==================
Replaces the legacy "copy tpms_project_data.md into the shell workspace"
step. The CoT engine calls one MCP tool here and gets a freshly-rendered
TPMS context string back — no filesystem write, no shell-service.

Tool:
  get_project_context(oenum, sections=None) -> {"oenum", "rendered", "sections"}

Cached in Redis for CONTEXT_TTL_SEC seconds to absorb burst traffic from
multi-step CoT chains.
"""
import json
import os
from typing import Any

import httpx
import redis.asyncio as redis
from fastapi import FastAPI, HTTPException
from mcp.server.fastmcp import FastMCP
from pydantic import BaseModel, Field

from simorgh_logging import configure, get_logger, request_id_middleware

configure(service="tpms-context-agent")
log = get_logger(__name__)

TPMS_FETCHER_URL = os.getenv("TPMS_FETCHER_URL", "http://tpms-fetcher:8021")
REDIS_URL        = os.getenv("REDIS_URL", "redis://redis:6379/4")
TTL              = int(os.getenv("CONTEXT_TTL_SEC", "300"))

_r: redis.Redis | None = None


def _redis() -> redis.Redis:
    global _r
    if _r is None:
        _r = redis.from_url(REDIS_URL, encoding="utf-8", decode_responses=True)
    return _r


app = FastAPI(title="tpms-context-agent", version="0.1.0")
app.middleware("http")(request_id_middleware)


@app.get("/health")
def health():
    return {"status": "ok", "service": "tpms-context-agent"}


class TpmsAuth(BaseModel):
    user: str
    password: str = Field(..., alias="pass")

    class Config:
        populate_by_name = True


class ContextRequest(BaseModel):
    oenum: str = Field(..., min_length=1)
    sections: list[str] | None = None
    refresh: bool = False
    # Per-user TPMS credentials, forwarded from the wizard when the user
    # ticked tpms / techserver. Reserved for future per-OE entitlement
    # enforcement against the technical_users table. Today it is accepted
    # and threaded through to /fetch but not yet used as a gate — when
    # the entitlement endpoint lands in tpms-fetcher this becomes the
    # auth check point.
    auth: TpmsAuth | None = None


class ContextResponse(BaseModel):
    oenum: str
    rendered: str
    sections: list[str]
    cached: bool


def _cache_key(oenum: str, sections: list[str] | None) -> str:
    s = ",".join(sorted(sections)) if sections else "*"
    return f"tpms-ctx:{oenum}:{s}"


async def _render(oenum: str, sections: list[str] | None) -> tuple[str, list[str]]:
    async with httpx.AsyncClient(timeout=30) as c:
        # Pull-or-cache on the upstream fetcher first to ensure data exists.
        await c.post(f"{TPMS_FETCHER_URL}/fetch/{oenum}")
        r = await c.get(f"{TPMS_FETCHER_URL}/project/{oenum}/text")
        r.raise_for_status()
        data: dict[str, Any] = r.json()
    text = data.get("text", "")
    available_sections = data.get("sections", [])
    if sections:
        # Naive section-filter: keep only blocks whose heading matches.
        kept: list[str] = []
        cur: list[str] = []
        keep = False
        for line in text.splitlines():
            if line.startswith("## "):
                if keep and cur:
                    kept.extend(cur)
                heading = line[3:].strip()
                keep = heading in sections
                cur = [line]
            else:
                cur.append(line)
        if keep and cur:
            kept.extend(cur)
        text = "\n".join(kept) if kept else text
    return text, available_sections


async def _check_entitlement(oenum: str, auth: "TpmsAuth") -> None:
    """Forward per-user TPMS credentials to tpms-fetcher's entitlement
    endpoint. Raises HTTPException(403) on auth/entitlement failure,
    HTTPException(502) if the fetcher is unreachable."""
    try:
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.post(
                f"{TPMS_FETCHER_URL}/projects/{oenum}/check-access",
                json={"user": auth.user, "pass": auth.password},
            )
            r.raise_for_status()
            body = r.json()
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502,
                            detail=f"tpms-fetcher unavailable: {e}")
    if not body.get("ok"):
        raise HTTPException(status_code=403,
                            detail=body.get("reason") or "not entitled")


@app.post("/context", response_model=ContextResponse)
async def get_context(req: ContextRequest):
    # Per-OE entitlement gate. When the wizard forwards per-user TPMS
    # credentials we MUST verify the user is entitled for this oenum
    # before returning any project data (draft_permission table). Without
    # auth we keep the existing service-level behaviour for backward compat.
    if req.auth is not None:
        await _check_entitlement(req.oenum, req.auth)

    key = _cache_key(req.oenum, req.sections)
    if not req.refresh:
        cached = await _redis().get(key)
        if cached:
            log.info("cache_hit", oenum=req.oenum)
            payload = json.loads(cached)
            return ContextResponse(oenum=req.oenum, rendered=payload["rendered"],
                                   sections=payload["sections"], cached=True)
    try:
        rendered, available = await _render(req.oenum, req.sections)
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"tpms-fetcher unavailable: {e}")
    await _redis().set(key, json.dumps({"rendered": rendered, "sections": available}), ex=TTL)
    log.info("rendered", oenum=req.oenum, chars=len(rendered))
    return ContextResponse(oenum=req.oenum, rendered=rendered,
                           sections=available, cached=False)


# ---------------------------------------------------------------------------
# MCP
# ---------------------------------------------------------------------------
mcp = FastMCP(
    "tpms-context-agent",
    instructions=(
        "Get rendered TPMS project context for chain-of-thought. Pass the "
        "oenum and (optionally) the sections you actually need. Output is "
        "markdown ready to inline into the LLM prompt."
    ),
)


@mcp.tool()
async def get_project_context(oenum: str, sections: list = None,
                              refresh: bool = False) -> dict:
    """Return rendered TPMS context for a project as markdown.

    sections: optional list of section names to filter (empty = all).
    """
    resp = await get_context(ContextRequest(
        oenum=oenum, sections=sections or None, refresh=refresh))
    return resp.model_dump()


app.mount("/mcp", mcp.streamable_http_app())
