"""
TPMS Data Fetcher Service
===========================
Standalone FastAPI microservice that fetches project data from TPMS MySQL,
stores snapshots in PostgreSQL, and exposes REST endpoints for the agent.

Endpoints:
  POST /fetch/{oenum}          - Fetch + store complete project data
  GET  /project/{oenum}        - Get cached project data
  GET  /project/{oenum}/text   - Get project data as agent-readable text
  GET  /health                 - Health check
  /mcp                         - MCP Streamable HTTP endpoint
"""

import json
import logging
import os
from datetime import datetime
from typing import Optional, List, Dict, Any

import pymysql
import pymysql.cursors
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from mcp.server.fastmcp import FastMCP

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="TPMS Data Fetcher Service", version="1.0.0")

# MySQL TPMS connection
MYSQL_HOST = os.getenv("MYSQL_HOST", "192.168.1.148")
MYSQL_PORT = int(os.getenv("MYSQL_PORT", "3306"))
MYSQL_USER = os.getenv("MYSQL_USER", "technical")
MYSQL_PASSWORD = os.getenv("MYSQL_PASSWORD", "")
MYSQL_DATABASE = os.getenv("MYSQL_DATABASE", "TPMS")


def get_mysql_connection():
    return pymysql.connect(
        host=MYSQL_HOST, port=MYSQL_PORT,
        user=MYSQL_USER, password=MYSQL_PASSWORD,
        database=MYSQL_DATABASE, charset="utf8mb4",
        connect_timeout=10, read_timeout=30,
        cursorclass=pymysql.cursors.DictCursor,
    )


# In-memory cache (will be replaced with PostgreSQL in production)
_project_cache: Dict[str, Dict] = {}


class ProjectMainResponse(BaseModel):
    id_project_main: int
    oenum: str
    project_name: str
    order_category: str = ""
    oe_date: str = ""
    project_name_fa: str = ""
    project_expert_label: str = ""
    technical_supervisor_label: str = ""
    technical_expert_label: str = ""


class PanelResponse(BaseModel):
    id: int
    scope_name: str = ""
    plane_name: str = ""
    plane_type: str = ""
    height: Optional[str] = None
    width: Optional[str] = None
    depth: Optional[str] = None
    voltage_rate: Optional[str] = None
    main_busbar_size: Optional[str] = None
    cell_count: Optional[int] = None


class FeederResponse(BaseModel):
    id: int
    scope_name: str = ""
    feeder_no: str = ""
    tag: str = ""
    designation: str = ""
    wiring_type: str = ""
    rating_power: str = ""
    flc: str = ""
    cb_rating: str = ""
    cable_size: str = ""


class FetchResponse(BaseModel):
    oenum: str
    project: Optional[ProjectMainResponse] = None
    panels: List[PanelResponse] = []
    feeders: List[FeederResponse] = []
    equipment_count: int = 0
    fetched_at: str
    status: str = "ok"


def _fetch_project_main(conn, oenum: str) -> Optional[Dict]:
    with conn.cursor() as cur:
        cur.execute("""
            SELECT IDProjectMain as id_project_main, OENUM as oenum,
                   IFNULL(Project_Name,'') as project_name,
                   IFNULL(Order_Category,'') as order_category,
                   IFNULL(OEDATE,'') as oe_date,
                   IFNULL(Project_Name_Fa,'') as project_name_fa,
                   IFNULL(Project_Expert_Label,'') as project_expert_label,
                   IFNULL(Technical_Supervisor_Label,'') as technical_supervisor_label,
                   IFNULL(Technical_Expert_Label,'') as technical_expert_label
            FROM View_Project_Main WHERE OENUM = %s LIMIT 1
        """, (oenum,))
        row = cur.fetchone()
        if not row:
            oenum_suffix = oenum[-5:] if len(oenum) >= 5 else oenum
            cur.execute("""
                SELECT IDProjectMain as id_project_main, OENUM as oenum,
                       IFNULL(Project_Name,'') as project_name,
                       IFNULL(Order_Category,'') as order_category,
                       IFNULL(OEDATE,'') as oe_date,
                       IFNULL(Project_Name_Fa,'') as project_name_fa,
                       IFNULL(Project_Expert_Label,'') as project_expert_label,
                       IFNULL(Technical_Supervisor_Label,'') as technical_supervisor_label,
                       IFNULL(Technical_Expert_Label,'') as technical_expert_label
                FROM View_Project_Main WHERE RIGHT(OENUM, 5) = %s
                ORDER BY IDProjectMain DESC LIMIT 1
            """, (oenum_suffix,))
            row = cur.fetchone()
        return row


def _fetch_panels(conn, id_project_main: int) -> List[Dict]:
    with conn.cursor() as cur:
        cur.execute("""
            SELECT ID as id,
                   IFNULL(Plane_Name1,'') as scope_name,
                   IFNULL(Plane_Name1,'') as plane_name,
                   IFNULL(Plane_Type,'') as plane_type,
                   Height as height, Width as width, Depth as depth,
                   Voltage_Rate as voltage_rate,
                   Main_Busbar_Size as main_busbar_size,
                   Cell_Count as cell_count
            FROM technical_panel_identity
            WHERE IDProjectMain = %s ORDER BY ID
        """, (id_project_main,))
        return cur.fetchall()


def _fetch_feeders(conn, id_project_main: int) -> List[Dict]:
    with conn.cursor() as cur:
        cur.execute("""
            SELECT ID as id,
                   IFNULL(scopeName,'') as scope_name,
                   IFNULL(feeder_no,'') as feeder_no,
                   IFNULL(tag,'') as tag,
                   IFNULL(Designation,'') as designation,
                   IFNULL(wiring_type,'') as wiring_type,
                   IFNULL(rating_power,'') as rating_power,
                   IFNULL(flc,'') as flc,
                   IFNULL(cb_rating,'') as cb_rating,
                   IFNULL(cable_size,'') as cable_size
            FROM View_draft
            WHERE Project_ID = %s ORDER BY Tablo_ID, ordering, ID
        """, (id_project_main,))
        return cur.fetchall()


def _fetch_equipment_count(conn, id_project_main: int) -> int:
    with conn.cursor() as cur:
        cur.execute("""
            SELECT COUNT(*) as cnt
            FROM View_draft_Equipment e
            INNER JOIN View_draft d ON e.draftId = d.ID
            WHERE d.Project_ID = %s
        """, (id_project_main,))
        row = cur.fetchone()
        return row["cnt"] if row else 0


def _project_to_text(data: Dict) -> str:
    """Convert project data to agent-readable text format."""
    lines = []
    proj = data.get("project")
    if proj:
        lines.append(f"# Project: {proj['project_name']} (OENUM: {proj['oenum']})")
        lines.append(f"- Category: {proj['order_category']}")
        lines.append(f"- Date: {proj['oe_date']}")
        lines.append(f"- Persian Name: {proj['project_name_fa']}")
        lines.append(f"- Project Expert: {proj['project_expert_label']}")
        lines.append(f"- Technical Supervisor: {proj['technical_supervisor_label']}")
        lines.append(f"- Technical Expert: {proj['technical_expert_label']}")
        lines.append("")

    panels = data.get("panels", [])
    if panels:
        lines.append(f"## Panels ({len(panels)} total)")
        for p in panels:
            lines.append(f"### {p.get('plane_name', 'Panel')} (Type: {p.get('plane_type', 'N/A')})")
            dims = f"{p.get('height','?')} x {p.get('width','?')} x {p.get('depth','?')} mm"
            lines.append(f"  Dimensions: {dims}")
            lines.append(f"  Voltage Rate: {p.get('voltage_rate', 'N/A')}")
            lines.append(f"  Main Busbar: {p.get('main_busbar_size', 'N/A')}")
            lines.append(f"  Cells: {p.get('cell_count', 'N/A')}")
            lines.append("")

    feeders = data.get("feeders", [])
    if feeders:
        lines.append(f"## Feeders ({len(feeders)} total)")
        for f in feeders:
            lines.append(f"- Feeder {f.get('feeder_no','?')}: {f.get('designation','')}")
            lines.append(f"  Tag: {f.get('tag','')}, Type: {f.get('wiring_type','')}")
            lines.append(f"  Power: {f.get('rating_power','')} | FLC: {f.get('flc','')}")
            lines.append(f"  CB: {f.get('cb_rating','')} | Cable: {f.get('cable_size','')}")

    lines.append(f"\nEquipment items: {data.get('equipment_count', 0)}")
    lines.append(f"Fetched at: {data.get('fetched_at', 'N/A')}")
    return "\n".join(lines)


@app.get("/health")
async def health():
    """Health check - lightweight, never blocks on external connections.
    Docker healthcheck must pass quickly regardless of MySQL availability.
    Use /health/mysql for detailed MySQL connectivity status."""
    return {"status": "healthy", "service": "tpms-fetcher"}


@app.get("/health/mysql")
async def health_mysql():
    """Detailed MySQL connectivity check (not used by docker healthcheck)."""
    try:
        conn = get_mysql_connection()
        conn.ping()
        conn.close()
        return {"status": "healthy", "mysql": "connected"}
    except Exception as e:
        return {"status": "degraded", "mysql": "unavailable", "error": str(e)}


@app.post("/fetch/{oenum}", response_model=FetchResponse)
async def fetch_project(oenum: str):
    """Fetch complete project data from TPMS and cache it."""
    try:
        conn = get_mysql_connection()
        project = _fetch_project_main(conn, oenum)
        if not project:
            conn.close()
            raise HTTPException(status_code=404, detail=f"Project {oenum} not found in TPMS")

        id_pm = project["id_project_main"]
        panels = _fetch_panels(conn, id_pm)
        feeders = _fetch_feeders(conn, id_pm)
        eq_count = _fetch_equipment_count(conn, id_pm)
        conn.close()

        now = datetime.utcnow().isoformat()
        data = {
            "oenum": oenum,
            "project": project,
            "panels": panels,
            "feeders": feeders,
            "equipment_count": eq_count,
            "fetched_at": now,
            "status": "ok",
        }
        _project_cache[oenum] = data

        logger.info(f"Fetched TPMS data: {oenum} - {len(panels)} panels, {len(feeders)} feeders")
        return FetchResponse(**data)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"TPMS fetch error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/project/{oenum}", response_model=FetchResponse)
async def get_project(oenum: str):
    """Get cached project data (or fetch if not cached)."""
    if oenum not in _project_cache:
        return await fetch_project(oenum)
    return FetchResponse(**_project_cache[oenum])


@app.get("/project/{oenum}/text")
async def get_project_text(oenum: str):
    """Get project data as agent-readable plain text."""
    if oenum not in _project_cache:
        await fetch_project(oenum)
    data = _project_cache.get(oenum)
    if not data:
        raise HTTPException(status_code=404, detail="Project not found")
    return {"oenum": oenum, "text": _project_to_text(data)}


# =============================================================================
# MCP Server - Exposes TPMS tools via Model Context Protocol
# =============================================================================
mcp = FastMCP("tpms-fetcher", instructions="Fetch project data from TPMS MySQL")


@mcp.tool()
def tpms_fetch(oenum: str) -> str:
    """Fetch complete project data from TPMS by OENUM. Returns JSON with project, panels, feeders."""
    try:
        conn = get_mysql_connection()
        project = _fetch_project_main(conn, oenum)
        if not project:
            conn.close()
            return json.dumps({"error": f"Project {oenum} not found in TPMS"})

        id_pm = project["id_project_main"]
        panels = _fetch_panels(conn, id_pm)
        feeders = _fetch_feeders(conn, id_pm)
        eq_count = _fetch_equipment_count(conn, id_pm)
        conn.close()

        now = datetime.utcnow().isoformat()
        data = {
            "oenum": oenum, "project": project, "panels": panels,
            "feeders": feeders, "equipment_count": eq_count,
            "fetched_at": now, "status": "ok",
        }
        _project_cache[oenum] = data
        return json.dumps(data, default=str)
    except Exception as e:
        return json.dumps({"error": str(e)})


@mcp.tool()
def tpms_get_text(oenum: str) -> str:
    """Get project data as agent-readable plain text by OENUM. Fetches from TPMS if not cached."""
    try:
        if oenum not in _project_cache:
            # Fetch first
            conn = get_mysql_connection()
            project = _fetch_project_main(conn, oenum)
            if not project:
                conn.close()
                return f"Project {oenum} not found in TPMS"
            id_pm = project["id_project_main"]
            panels = _fetch_panels(conn, id_pm)
            feeders = _fetch_feeders(conn, id_pm)
            eq_count = _fetch_equipment_count(conn, id_pm)
            conn.close()
            _project_cache[oenum] = {
                "oenum": oenum, "project": project, "panels": panels,
                "feeders": feeders, "equipment_count": eq_count,
                "fetched_at": datetime.utcnow().isoformat(),
            }
        return _project_to_text(_project_cache[oenum])
    except Exception as e:
        return f"TPMS fetch error: {e}"


app.mount("/mcp", mcp.streamable_http_app())

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8021)
