"""
Organization Data Service
=========================
Read-only gateway over the **organization-wide / HR** MySQL tables —
distinct from `tpms-fetcher`, which only handles TPMS *project* data.
This service exists so the chatbot's *general* session can answer
questions like:

  - When are this month's holidays?
  - What's the maximum corporate loan I can request?
  - When are the next hiring periods?
  - Who's the manager of the production department?
  - What's my expected attendance balance?

without ever talking to project tables. Blast radius is limited to the
HR / org schema by using a separate read-only DB user (env
ORG_MYSQL_USER) with grants only on the relevant tables.

Per the agreed convention "AI/COT clients use MCP", this service is
**MCP-only** for normal use. A small REST surface exists for health +
debug.

This is a SKELETON — the actual table names + column names depend on
your HR system. Each tool below has a TODO with the SQL you need to fill
in. Once you put real queries in, the chat-service general session can
discover these tools through MCP and use them without backend changes.
"""
import logging
import os
from contextlib import asynccontextmanager
from typing import Any, Dict, List, Optional

import pymysql
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from mcp.server.fastmcp import FastMCP

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("org-data-service")

MYSQL_HOST     = os.getenv("ORG_MYSQL_HOST",     os.getenv("MYSQL_HOST", "192.168.1.148"))
MYSQL_PORT     = int(os.getenv("ORG_MYSQL_PORT", os.getenv("MYSQL_PORT", "3306")))
MYSQL_USER     = os.getenv("ORG_MYSQL_USER")     # READ-ONLY user, scoped to HR/org schema
MYSQL_PASSWORD = os.getenv("ORG_MYSQL_PASSWORD")
MYSQL_DATABASE = os.getenv("ORG_MYSQL_DATABASE", "TPMS")  # adjust to actual HR DB name


def db():
    """Open a per-request MySQL connection. PyMySQL is sync; that's fine here."""
    return pymysql.connect(
        host=MYSQL_HOST, port=MYSQL_PORT,
        user=MYSQL_USER, password=MYSQL_PASSWORD,
        database=MYSQL_DATABASE,
        cursorclass=pymysql.cursors.DictCursor,
        connect_timeout=5, read_timeout=10,
    )


# ---------------------------------------------------------------------------
# FastAPI
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    # FastAPI ignores @app.on_event when lifespan= is set, so the MCP
    # streamable-http session manager has to be started here.
    async with mcp.session_manager.run():
        # Sanity-check connection at startup; don't fail boot if DB is briefly down.
        try:
            with db() as c, c.cursor() as cur:
                cur.execute("SELECT 1")
            logger.info("MySQL reachable at %s:%d", MYSQL_HOST, MYSQL_PORT)
        except Exception as e:
            logger.warning("MySQL unreachable at startup: %s", e)
        yield


app = FastAPI(title="Simorgh Organization Data", version="0.1.0", lifespan=lifespan)
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
        with db() as c, c.cursor() as cur:
            cur.execute("SELECT 1 AS ok")
            cur.fetchone()
        return {"status": "healthy", "service": "org-data-service", "mysql": "up"}
    except Exception as e:
        return {"status": "degraded", "service": "org-data-service", "mysql": str(e)}


# ---------------------------------------------------------------------------
# MCP tools — fill in real SQL per your HR schema.
# Naming is descriptive so the COT engine can pick the right tool.
# ---------------------------------------------------------------------------
mcp = FastMCP(
    "org-data-service",
    instructions=(
        "Read-only access to organization / HR data: monthly holidays, "
        "corporate loan rules, hiring periods, company directory, "
        "attendance balances. Use these tools when answering questions "
        "about company policies and personnel data during general chat sessions."
    ),
)


@mcp.tool()
async def get_holidays(year: int, month: Optional[int] = None) -> List[Dict[str, Any]]:
    """List company holidays for a year (optionally filtered to a single month)."""
    # TODO(org-data): replace with real SQL against your holidays table, e.g.
    #   SELECT date, name, type FROM hr_holidays
    #    WHERE YEAR(date) = %s AND (%s IS NULL OR MONTH(date) = %s)
    #    ORDER BY date
    return []


@mcp.tool()
async def get_corporate_loan_info(employee_id: Optional[str] = None) -> Dict[str, Any]:
    """
    Return company-wide loan policy + (optionally) the calling employee's
    eligibility / current balance.
    """
    # TODO(org-data): replace with real SQL.
    return {"policy": {}, "employee": None}


@mcp.tool()
async def get_hiring_periods() -> List[Dict[str, Any]]:
    """List upcoming or recent recruitment / hiring window announcements."""
    # TODO(org-data)
    return []


@mcp.tool()
async def get_company_directory(department: Optional[str] = None) -> List[Dict[str, Any]]:
    """List employees + roles, optionally filtered to one department."""
    # TODO(org-data)
    return []


@mcp.tool()
async def get_employee_attendance(employee_id: str, year: int, month: int) -> Dict[str, Any]:
    """Return attendance summary (worked hours, absences, leave balance) for a month."""
    # TODO(org-data)
    return {"employee_id": employee_id, "year": year, "month": month, "summary": None}


@mcp.tool()
async def lookup_employee_by_id(employee_id: str) -> Dict[str, Any]:
    """Resolve an employee id to {name, role, department, manager_id, hire_date}."""
    # TODO(org-data)
    return {}


@mcp.tool()
async def list_departments() -> List[Dict[str, Any]]:
    """Return all departments and their managers."""
    # TODO(org-data)
    return []


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
