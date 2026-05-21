"""
Eplan SQL Service — MSSQL / SQL Server gateway
==============================================
Sole entry point in the simorgh stack to the legacy Microsoft SQL Server
at ${EPLAN_SQL_HOST} (default 192.168.1.39, database `Eplan_n2`). Per the
no-direct-external-access policy, NO other service in the stack may
import pymssql / pyodbc to talk to that DB.

Why this is a separate service from `tpms-fetcher` and `org-data-service`:
those two go to MySQL @ .148; this one goes to MSSQL @ .39. Different
driver, different credentials, different blast radius — keep them
isolated.

Auth:
  EPLAN_SQL_USER / EPLAN_SQL_PASSWORD — read-only SQL Server user with
  grants only on the tables we actually need.

Surfaces:
  - REST   /parts, /parts/{id}, /designs, /designs/{id}   (other services)
  - MCP    search_eplan_parts, get_eplan_part             (AI / COT)
  - REST   /query  (parameterised SELECT, allow-listed templates)

This is a SKELETON: each endpoint contains a `# TODO(eplan-sql)` with
the SQL stub to fill in once the schema is confirmed.
"""
import logging
import os
from contextlib import asynccontextmanager
from typing import Any, Dict, List, Optional

import pymssql
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from mcp.server.fastmcp import FastMCP

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("eplan-sql-service")

EPLAN_SQL_HOST     = os.getenv("EPLAN_SQL_HOST",     "192.168.1.39")
EPLAN_SQL_PORT     = int(os.getenv("EPLAN_SQL_PORT", "1433"))
EPLAN_SQL_USER     = os.getenv("EPLAN_SQL_USER")
EPLAN_SQL_PASSWORD = os.getenv("EPLAN_SQL_PASSWORD")
EPLAN_SQL_DATABASE = os.getenv("EPLAN_SQL_DATABASE", "Eplan_n2")


def conn():
    """Open a per-request MSSQL connection. pymssql is sync."""
    if not EPLAN_SQL_USER or not EPLAN_SQL_PASSWORD:
        raise HTTPException(status_code=503, detail="EPLAN_SQL credentials not set")
    return pymssql.connect(
        server=EPLAN_SQL_HOST, port=EPLAN_SQL_PORT,
        user=EPLAN_SQL_USER, password=EPLAN_SQL_PASSWORD,
        database=EPLAN_SQL_DATABASE,
        as_dict=True, timeout=10, login_timeout=5,
    )


# ---------------------------------------------------------------------------
# FastAPI
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        with conn() as c:
            with c.cursor() as cur:
                cur.execute("SELECT 1 AS ok")
                cur.fetchone()
        logger.info("MSSQL reachable at %s:%d/%s", EPLAN_SQL_HOST, EPLAN_SQL_PORT, EPLAN_SQL_DATABASE)
    except Exception as e:
        logger.warning("MSSQL unreachable at startup: %s", e)
    yield


app = FastAPI(title="Simorgh Eplan SQL Gateway", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ALLOW_ORIGINS", "*").split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> Dict[str, Any]:
    try:
        with conn() as c, c.cursor() as cur:
            cur.execute("SELECT 1 AS ok")
            cur.fetchone()
        return {"status": "healthy", "service": "eplan-sql-service", "mssql": "up",
                "database": EPLAN_SQL_DATABASE}
    except HTTPException:
        return {"status": "degraded", "service": "eplan-sql-service",
                "mssql": "credentials missing"}
    except Exception as e:
        return {"status": "degraded", "service": "eplan-sql-service",
                "mssql": str(e)[:200]}


# ---------------------------------------------------------------------------
# REST — typed endpoints (preferred over /query)
# ---------------------------------------------------------------------------
@app.get("/parts")
def search_parts(
    q: Optional[str] = Query(None, description="free-text search"),
    limit: int = 50,
) -> Dict[str, Any]:
    """Search the eplan parts table. Used by simorgh-soft."""
    # TODO(eplan-sql): replace with real SELECT against the parts table.
    # Example pattern (adjust table/column names):
    #   WITH res AS (
    #     SELECT TOP (%d) part_no, description, manufacturer, ...
    #       FROM dbo.eplan_parts
    #      WHERE (%s IS NULL OR description LIKE '%%' + %s + '%%' OR part_no LIKE '%%' + %s + '%%')
    #     ORDER BY part_no
    #   ) SELECT * FROM res
    return {"results": [], "limit": limit}


@app.get("/parts/{part_no}")
def get_part(part_no: str) -> Dict[str, Any]:
    """Single part by part number."""
    # TODO(eplan-sql)
    raise HTTPException(status_code=404, detail="not found")


# ---------------------------------------------------------------------------
# Generic query (locked-down)
# ---------------------------------------------------------------------------
class QueryRequest(BaseModel):
    sql: str
    params: Optional[List[Any]] = None


@app.post("/query")
def run_query(req: QueryRequest) -> Dict[str, Any]:
    """
    Execute a SELECT-only query. SQL must start with SELECT (case-insensitive)
    after stripping; anything else is rejected. Use parameter substitution,
    never concatenate untrusted input.
    """
    sql = req.sql.lstrip()
    if not sql[:6].upper().startswith("SELECT"):
        raise HTTPException(status_code=400, detail="only SELECT queries allowed")
    try:
        with conn() as c, c.cursor() as cur:
            cur.execute(sql, tuple(req.params or []))
            rows = cur.fetchall()
        return {"rows": rows, "count": len(rows)}
    except Exception as e:
        logger.exception("query failed")
        raise HTTPException(status_code=500, detail=str(e)[:500])


# ---------------------------------------------------------------------------
# MCP
# ---------------------------------------------------------------------------
mcp = FastMCP(
    "eplan-sql-service",
    instructions=(
        "Read-only access to the Eplan_n2 SQL Server (parts catalogue, "
        "designs, manufacturer references). Use this when answering "
        "questions about specific electrical parts and their attributes."
    ),
)


@mcp.tool()
async def search_eplan_parts(q: str, limit: int = 20) -> Dict[str, Any]:
    """Search the Eplan parts catalogue."""
    return search_parts(q=q, limit=limit)


@mcp.tool()
async def get_eplan_part(part_no: str) -> Dict[str, Any]:
    """Look up a single Eplan part by part number."""
    try:
        return get_part(part_no=part_no)
    except HTTPException:
        return {"found": False, "part_no": part_no}


# FastMCP's streamable_http_app exposes route /mcp internally. Mount at
# "/" so its public path is /mcp (mounting at "/mcp" would produce /mcp/mcp).
app.mount("/", mcp.streamable_http_app())
