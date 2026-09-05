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

import hashlib
import json
import logging
import os
import re
from datetime import datetime
from typing import Optional, List, Dict, Any, Tuple

import pymysql
import pymysql.cursors
from fastapi import FastAPI, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field
from mcp.server.fastmcp import FastMCP

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Optional fire-and-forget index of project metadata into context-search-service.
# Importable even when shared/ isn't installed (e.g. in unit tests).
# ---------------------------------------------------------------------------
try:
    from simorgh_clients import context_search as _csc
except Exception:
    _csc = None


async def _ship_project_meta(oenum, project, panels, feeders, eq_count):
    """Upsert structured project metadata into simorgh-projects ES index.
    Best-effort — never blocks the fetch response."""
    if _csc is None:
        return
    try:
        await _csc.index_project_meta({
            "oenum":             oenum,
            "project_id":        str(project.get("id_project_main") or ""),
            "name":              project.get("name") or project.get("project_name") or "",
            "status":            project.get("status"),
            "customer":          project.get("customer") or project.get("client"),
            "voltage_class":     project.get("voltage_class"),
            "motor_type":        project.get("motor_type"),
            "year":              project.get("year"),
            "panel_count":       len(panels or []),
            "feeder_count":      len(feeders or []),
            "equipment_count":   eq_count,
            "raw_text":          _project_to_text({
                "oenum": oenum, "project": project, "panels": panels,
                "feeders": feeders, "equipment_count": eq_count,
            }),
            "tags":              [],
        })
    except Exception:
        logger.debug("ship_project_meta_failed", exc_info=True)


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
    # extra="allow" lets us widen the SELECT list (e.g. extra electrical /
    # busbar / provenance columns from technical_panel_identity) without
    # having to redeclare every field here.
    model_config = ConfigDict(extra="allow")

    id: int
    id_project_scope: Optional[int] = None
    scope_name: str = ""
    plane_name: str = ""
    plane_type: str = ""
    height: Optional[str] = None
    width: Optional[str] = None
    depth: Optional[str] = None
    voltage_rate: Optional[str] = None
    main_busbar_size: Optional[str] = None
    cell_count: Optional[int] = None
    revision: Optional[int] = None


class FeederResponse(BaseModel):
    model_config = ConfigDict(extra="allow")

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
    revision: Optional[int] = None


class ProjectIdentityResponse(BaseModel):
    """Project-level identity record (overall data shared by all switchgears
    in the project — wire colors, plating, brands, climate). The matching
    row in TPMS is `technical_project_identity_`; custom k/v rows live in
    TECHNICAL_PROJECT_IDENTITY_ADDITIONAL_FIELDS."""
    model_config = ConfigDict(extra="allow")

    id: int
    id_project_main: int
    revision: Optional[int] = None
    additional_fields: List[Dict[str, Any]] = []


class FetchResponse(BaseModel):
    oenum: str
    project: Optional[ProjectMainResponse] = None
    project_identity: Optional[ProjectIdentityResponse] = None
    panels: List[PanelResponse] = []
    feeders: List[FeederResponse] = []
    equipment_count: int = 0
    fetched_at: str
    status: str = "ok"
    # Revision filter applied to this snapshot. None / "latest" = current
    # state only (default); "all" = every revision; otherwise the specific
    # revision number requested.
    revision: Optional[str] = "latest"


# ---------------------------------------------------------------------------
# Revision filter parsing
# ---------------------------------------------------------------------------
# TPMS keeps every revision of every panel / feeder side-by-side. The
# default behaviour everywhere is "latest revision only" — the chatbot
# user always wants current state unless they explicitly ask for history.
#
# Three modes:
#   None | "latest"  -> latest revision per (panel | feeder)
#   "all"            -> every revision row
#   "<int>"          -> only rows with that exact Revision value
def _parse_revision(rev: Optional[str]) -> Any:
    if rev is None or rev == "" or rev == "latest":
        return "latest"
    if rev == "all":
        return "all"
    try:
        return int(rev)
    except (TypeError, ValueError):
        return "latest"


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


# Common SELECT lists. Kept in module scope so we don't repeat ~25 columns
# across the per-revision-mode branches.
_PANEL_COLS = """
    p.ID                       AS id,
    p.IDProjectScope           AS id_project_scope,
    IFNULL(p.Plane_Name1,'')   AS scope_name,
    IFNULL(p.Plane_Name1,'')   AS plane_name,
    IFNULL(p.Plane_Type,'')    AS plane_type,
    IFNULL(p.ProductType_label,'') AS product_type,
    p.Height                   AS height,
    p.Width                    AS width,
    p.Depth                    AS depth,
    p.Voltage_Rate             AS voltage_rate,
    p.Switch_Amperage          AS switch_amperage,
    p.rated_voltage            AS rated_voltage,
    p.KABUS                    AS kabus,
    p.ABUS                     AS abus,
    p.Main_Busbar_Size         AS main_busbar_size,
    p.Earth_Size               AS earth_size,
    p.Neutral_Size             AS neutral_size,
    p.frequency                AS frequency,
    p.IP                       AS ip_rating,
    p.Cell_Count               AS cell_count,
    p.Revision                 AS revision,
    p.USR_USERNAME             AS updated_by,
    p.Date_Created             AS updated_at
"""

_FEEDER_COLS = """
    v.ID                       AS id,
    v.Tablo_ID                 AS tablo_id,
    IFNULL(v.scopeName,'')     AS scope_name,
    IFNULL(v.feeder_no,'')     AS feeder_no,
    IFNULL(v.tag,'')           AS tag,
    IFNULL(v.Designation,'')   AS designation,
    IFNULL(v.wiring_type,'')   AS wiring_type,
    IFNULL(v.rating_power,'')  AS rating_power,
    IFNULL(v.flc,'')           AS flc,
    IFNULL(v.cb_rating,'')     AS cb_rating,
    IFNULL(v.cable_size,'')    AS cable_size,
    IFNULL(v.module_type,'')   AS module_type,
    IFNULL(v.Module,'')        AS module,
    IFNULL(v.Size,'')          AS size,
    IFNULL(v.description,'')   AS description,
    IFNULL(v.bus_section,'')   AS bus_section,
    IFNULL(v.templateName,'')  AS template_name,
    IFNULL(v.sfd_hfd,'')       AS sfd_hfd,
    v.overLoad_rating          AS overload_rating,
    v.contactor_rating         AS contactor_rating,
    v.revision                 AS revision,
    v.ordering                 AS ordering
"""


def _fetch_panels(conn, id_project_main: int,
                  revision: Any = "latest") -> List[Dict]:
    """Read switchgear/panel identity rows for the project.

    technical_panel_identity stores every revision of every panel side by
    side (project 1730 has 97 rows for 11 distinct IDProjectScope values).
    Default: return only the latest revision per IDProjectScope so the
    chatbot sees current state. Pass revision="all" for full history, or
    an int to pin a specific revision number."""
    if revision == "all":
        sql = f"""
            SELECT {_PANEL_COLS}
            FROM technical_panel_identity p
            WHERE p.IDProjectMain = %s
            ORDER BY p.IDProjectScope, p.Revision
        """
        args: tuple = (id_project_main,)
    elif isinstance(revision, int):
        sql = f"""
            SELECT {_PANEL_COLS}
            FROM technical_panel_identity p
            WHERE p.IDProjectMain = %s AND p.Revision = %s
            ORDER BY p.IDProjectScope
        """
        args = (id_project_main, revision)
    else:
        # default: latest revision per panel
        sql = f"""
            SELECT {_PANEL_COLS}
            FROM technical_panel_identity p
            JOIN (
                SELECT IDProjectMain, IDProjectScope, MAX(Revision) AS max_rev
                FROM technical_panel_identity
                WHERE IDProjectMain = %s
                GROUP BY IDProjectMain, IDProjectScope
            ) lp ON lp.IDProjectMain = p.IDProjectMain
                AND lp.IDProjectScope = p.IDProjectScope
                AND lp.max_rev       = p.Revision
            WHERE p.IDProjectMain = %s
            ORDER BY p.IDProjectScope
        """
        args = (id_project_main, id_project_main)
    with conn.cursor() as cur:
        cur.execute(sql, args)
        return cur.fetchall()


def _fetch_feeders(conn, id_project_main: int,
                   revision: Any = "latest") -> List[Dict]:
    """Read feeders (View_draft) for the project.

    View_draft keeps every revision of every feeder. `revision` is nullable
    (NULL is the initial draft) and goes NULL → 1 → 2 → … so we treat
    COALESCE(revision,-1) as the ordering. Default returns the latest row
    per (Tablo_ID, feeder_no); for project 1730 this collapses 3292 rows
    → ~268, which matches what the technical user sees in HeidiSQL."""
    if revision == "all":
        sql = f"""
            SELECT {_FEEDER_COLS}
            FROM View_draft v
            WHERE v.Project_ID = %s
            ORDER BY v.Tablo_ID, v.ordering, v.feeder_no, v.revision
        """
        args: tuple = (id_project_main,)
    elif isinstance(revision, int):
        sql = f"""
            SELECT {_FEEDER_COLS}
            FROM View_draft v
            WHERE v.Project_ID = %s AND v.revision = %s
            ORDER BY v.Tablo_ID, v.ordering, v.feeder_no
        """
        args = (id_project_main, revision)
    else:
        sql = f"""
            SELECT {_FEEDER_COLS}
            FROM View_draft v
            JOIN (
                SELECT Tablo_ID, feeder_no,
                       MAX(COALESCE(revision,-1)) AS max_rev
                FROM View_draft
                WHERE Project_ID = %s
                GROUP BY Tablo_ID, feeder_no
            ) lx ON lx.Tablo_ID = v.Tablo_ID
                AND lx.feeder_no = v.feeder_no
                AND lx.max_rev   = COALESCE(v.revision,-1)
            WHERE v.Project_ID = %s
            ORDER BY v.Tablo_ID, v.ordering, v.feeder_no
        """
        args = (id_project_main, id_project_main)
    with conn.cursor() as cur:
        cur.execute(sql, args)
        return cur.fetchall()


def _fetch_equipment_count(conn, id_project_main: int,
                           revision: Any = "latest") -> int:
    """Count equipment rows whose parent feeder is in the requested
    revision scope. View_draft_Equipment carries neither Project_ID nor
    Tablo_ID — it links only via draftId → View_draft.ID, so we must
    intersect against the same revision-filtered set used for feeders."""
    if revision == "all":
        sql = """
            SELECT COUNT(*) AS cnt
            FROM View_draft_Equipment e
            JOIN View_draft v ON v.ID = e.draftId
            WHERE v.Project_ID = %s
        """
        args: tuple = (id_project_main,)
    elif isinstance(revision, int):
        sql = """
            SELECT COUNT(*) AS cnt
            FROM View_draft_Equipment e
            JOIN View_draft v ON v.ID = e.draftId
            WHERE v.Project_ID = %s AND v.revision = %s
        """
        args = (id_project_main, revision)
    else:
        sql = """
            SELECT COUNT(*) AS cnt
            FROM View_draft_Equipment e
            JOIN View_draft v ON v.ID = e.draftId
            JOIN (
                SELECT Tablo_ID, feeder_no,
                       MAX(COALESCE(revision,-1)) AS max_rev
                FROM View_draft
                WHERE Project_ID = %s
                GROUP BY Tablo_ID, feeder_no
            ) lx ON lx.Tablo_ID = v.Tablo_ID
                AND lx.feeder_no = v.feeder_no
                AND lx.max_rev   = COALESCE(v.revision,-1)
            WHERE v.Project_ID = %s
        """
        args = (id_project_main, id_project_main)
    with conn.cursor() as cur:
        cur.execute(sql, args)
        row = cur.fetchone()
        return row["cnt"] if row else 0


def _fetch_project_identity(conn, id_project_main: int) -> Optional[Dict]:
    """Project-level identity (overall data shared across all switchgears).

    `technical_project_identity_.Revision` is often 0 across all rows for
    the same project — TPMS users overwrite by inserting a new row instead
    of incrementing Revision. So MAX(Revision) alone would tie; we tiebreak
    on ID DESC (most recently inserted wins) which matches how the TPMS UI
    shows the "current" project identity. Custom k/v fields come from
    TECHNICAL_PROJECT_IDENTITY_ADDITIONAL_FIELDS scoped by that latest ID."""
    with conn.cursor() as cur:
        cur.execute("""
            SELECT * FROM technical_project_identity_
            WHERE IDProjectMain = %s
            ORDER BY Revision DESC, ID DESC
            LIMIT 1
        """, (id_project_main,))
        row = cur.fetchone()
        if not row:
            return None
        cur.execute("""
            SELECT field_title, field_descriptions, Status, date_u
            FROM TECHNICAL_PROJECT_IDENTITY_ADDITIONAL_FIELDS
            WHERE IDProjectMain = %s
              AND IDTechnicalProjectIdentity = %s
            ORDER BY ID
        """, (id_project_main, row["ID"]))
        row["additional_fields"] = cur.fetchall()
        # Snake-case the FK column the response model expects so
        # ProjectIdentityResponse(..., id_project_main=...) works.
        row["id_project_main"] = row.get("IDProjectMain")
        row["id"] = row.get("ID")
        return row


# Fields from `technical_project_identity_` worth rendering in the agent
# text. Skips the dozens of numeric FK columns (Isolation, Color_Type,
# wire colors, etc.) whose values are opaque without joining lookup tables
# — those still come through the JSON payload, just not the markdown.
_PROJECT_IDENTITY_TEXT_FIELDS: List[tuple] = [
    ("Above_Sea_Level",     "Altitude"),
    ("Average_Temperature", "Avg. Temperature"),
    ("Delivery_Date",       "Delivery Date"),
    ("Project_Group",       "Project Group"),
    ("Wire_Brand",          "Wire Brand"),
    ("Control_Wire_Brand",  "Control Wire Brand"),
    ("USR_USERNAME",        "Last Updated By"),
    ("Date_Created",        "Last Updated At"),
    ("Revision",            "Revision"),
]


def _project_to_text(data: Dict) -> str:
    """Convert project data to agent-readable text format."""
    lines: List[str] = []
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

    pid = data.get("project_identity")
    if pid:
        lines.append("## Project Identity (overall — shared by all switchgears)")
        for col, label in _PROJECT_IDENTITY_TEXT_FIELDS:
            val = pid.get(col)
            if val in (None, "", 0):
                continue
            lines.append(f"- {label}: {val}")
        for af in pid.get("additional_fields") or []:
            title = af.get("field_title") or ""
            desc  = af.get("field_descriptions") or ""
            if title or desc:
                lines.append(f"- {title}: {desc}")
        lines.append("")

    panels = data.get("panels", [])
    if panels:
        lines.append(f"## Panels ({len(panels)} total — latest revision only)")
        for p in panels:
            head = p.get("plane_name") or f"Panel {p.get('id_project_scope') or p.get('id')}"
            lines.append(f"### {head} (Type: {p.get('plane_type', 'N/A')})")
            dims = f"{p.get('height','?')} x {p.get('width','?')} x {p.get('depth','?')}"
            lines.append(f"  Dimensions: {dims}")
            lines.append(f"  Voltage Rate: {p.get('voltage_rate', 'N/A')} | Rated: {p.get('rated_voltage') or 'N/A'}")
            lines.append(f"  Switch Amperage: {p.get('switch_amperage','N/A')} | KABUS: {p.get('kabus','N/A')} | ABUS: {p.get('abus','N/A')}")
            lines.append(f"  Main Busbar: {p.get('main_busbar_size', 'N/A')} | Earth: {p.get('earth_size','N/A')} | Neutral: {p.get('neutral_size','N/A')}")
            lines.append(f"  Cells: {p.get('cell_count', 'N/A')} | IP: {p.get('ip_rating','N/A')}")
            if p.get("revision") is not None:
                lines.append(f"  Revision: {p['revision']} (updated {p.get('updated_at','?')} by {p.get('updated_by','?')})")
            lines.append("")

    feeders = data.get("feeders", [])
    if feeders:
        lines.append(f"## Feeders ({len(feeders)} total — latest revision only)")
        for f in feeders:
            lines.append(f"- Feeder {f.get('feeder_no','?')}: {f.get('designation','')}")
            lines.append(f"  Tag: {f.get('tag','')}, Type: {f.get('wiring_type','')}, Module: {f.get('module_type','') or f.get('module','')}")
            lines.append(f"  Power: {f.get('rating_power','')} | FLC: {f.get('flc','')}")
            lines.append(f"  CB: {f.get('cb_rating','')} | Cable: {f.get('cable_size','')} | OL: {f.get('overload_rating','') or '-'}")
            if f.get("template_name"):
                lines.append(f"  Template: {f['template_name']}")

    lines.append(f"\nEquipment items: {data.get('equipment_count', 0)}")
    lines.append(f"Revision filter: {data.get('revision', 'latest')}")
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


def _cache_key(oenum: str, revision: Any) -> str:
    return f"{oenum}::{revision}"


@app.post("/fetch/{oenum}", response_model=FetchResponse)
async def fetch_project(
    oenum: str,
    revision: Optional[str] = Query(
        None,
        description="Revision filter: 'latest' (default), 'all', or a specific Revision integer.",
    ),
):
    """Fetch complete project data from TPMS and cache it.

    By default returns the current state only (latest revision per panel
    / feeder / project-identity). Pass ?revision=all to include history or
    ?revision=<n> to pin a specific revision number."""
    rev = _parse_revision(revision)
    try:
        conn = get_mysql_connection()
        project = _fetch_project_main(conn, oenum)
        if not project:
            conn.close()
            raise HTTPException(status_code=404, detail=f"Project {oenum} not found in TPMS")

        id_pm = project["id_project_main"]
        project_identity = _fetch_project_identity(conn, id_pm)
        panels = _fetch_panels(conn, id_pm, revision=rev)
        feeders = _fetch_feeders(conn, id_pm, revision=rev)
        eq_count = _fetch_equipment_count(conn, id_pm, revision=rev)
        conn.close()

        now = datetime.utcnow().isoformat()
        data = {
            "oenum": oenum,
            "project": project,
            "project_identity": project_identity,
            "panels": panels,
            "feeders": feeders,
            "equipment_count": eq_count,
            "fetched_at": now,
            "status": "ok",
            "revision": str(rev),
        }
        _project_cache[_cache_key(oenum, rev)] = data

        logger.info(
            "Fetched TPMS data: %s rev=%s - %d panels, %d feeders, %d equipment",
            oenum, rev, len(panels), len(feeders), eq_count,
        )

        # Fire-and-forget: upsert into the simorgh-projects ES index so
        # the COT agent can search structured project metadata + aggregate
        # by status / voltage_class / customer / year etc.
        await _ship_project_meta(oenum, project, panels, feeders, eq_count)

        return FetchResponse(**data)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"TPMS fetch error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/project/{oenum}", response_model=FetchResponse)
async def get_project(
    oenum: str,
    revision: Optional[str] = Query(None),
):
    """Get cached project data (or fetch if not cached)."""
    rev = _parse_revision(revision)
    key = _cache_key(oenum, rev)
    if key not in _project_cache:
        return await fetch_project(oenum, revision=revision)
    return FetchResponse(**_project_cache[key])


@app.get("/project/{oenum}/text")
async def get_project_text(
    oenum: str,
    revision: Optional[str] = Query(None),
):
    """Get project data as agent-readable plain text."""
    rev = _parse_revision(revision)
    key = _cache_key(oenum, rev)
    if key not in _project_cache:
        await fetch_project(oenum, revision=revision)
    data = _project_cache.get(key)
    if not data:
        raise HTTPException(status_code=404, detail="Project not found")
    return {"oenum": oenum, "text": _project_to_text(data)}


# =============================================================================
# Per-OE entitlement and existence checks. Used by tpms-context-agent
# before serving project data to a per-user request from the wizard.
# =============================================================================
class AccessCheckRequest(BaseModel):
    user: str
    password: str = Field(..., alias="pass")

    class Config:
        populate_by_name = True


# ---------------------------------------------------------------------------
# TPMS password verification.
#
# `technical_users.DraftPassword` is hashed (usually SHA-256 stored as the
# 64-hex / dashed-binary "Microsoft SQL Server" format, sometimes MD5, very
# rarely bcrypt). The legacy login (auth-service/services/hash_detector.py)
# auto-detects which one and verifies — we mirror that logic here instead
# of importing the shared package because this service has no path to it.
#
# bcrypt is detected but only verifies when passlib is installed; SHA-256 /
# MD5 work on pure stdlib. If the production DB ever migrates to bcrypt we
# can drop passlib into requirements.txt at that point.
# ---------------------------------------------------------------------------
def _normalize_hex_hash(h: str) -> str:
    return h.replace("-", "").replace(" ", "").lower()


def _detect_hash_type(stored: str) -> str:
    s = stored.strip()
    if re.match(r"^\$2[aby]\$\d+\$", s):
        return "bcrypt"
    no_sep = _normalize_hex_hash(s)
    if re.fullmatch(r"[0-9a-f]{64}", no_sep): return "sha256"
    if re.fullmatch(r"[0-9a-f]{32}", no_sep): return "md5"
    if re.fullmatch(r"[0-9a-f]{40}", no_sep): return "sha1"
    return "unknown"


def _verify_tpms_password(plain: str, stored: Any) -> Tuple[bool, str]:
    """Verify a TPMS DraftPassword. Returns (is_valid, hash_type).
    `stored` may arrive as bytes (BINARY column) or str."""
    if stored is None:
        return False, "missing"
    if isinstance(stored, (bytes, bytearray)):
        stored = stored.hex()
    stored = str(stored)
    ht = _detect_hash_type(stored)
    if ht == "sha256":
        digest = hashlib.sha256(plain.encode("utf-8")).hexdigest().lower()
        return digest == _normalize_hex_hash(stored), "sha256"
    if ht == "md5":
        digest = hashlib.md5(plain.encode("utf-8")).hexdigest().lower()
        return digest == _normalize_hex_hash(stored), "md5"
    if ht == "bcrypt":
        try:
            from passlib.context import CryptContext
            return (CryptContext(schemes=["bcrypt"]).verify(plain, stored),
                    "bcrypt")
        except Exception as e:
            logger.error("bcrypt verify failed (passlib not installed?): %s", e)
            return False, "bcrypt_error"
    # Last-resort: plaintext compare. Some very old TPMS installs stored
    # the password directly in DraftPassword without hashing.
    return plain == stored, "plaintext"


@app.post("/projects/{oenum}/check-access")
def check_oenum_access(oenum: str, req: AccessCheckRequest):
    """Verify that `user` exists in TPMS' `technical_users` table with the
    given password, AND that they hold a `draft_permission` row for the
    project whose OENUM is `oenum`. Used by tpms-context-agent / project-init
    before exposing a legacy project's data to the chatbot.

    Returns {ok, reason} — never raises 401/403 directly so the caller can
    surface a friendly message; HTTP 5xx is reserved for genuine errors.
    """
    try:
        conn = get_mysql_connection()
        try:
            with conn.cursor() as cur:
                # 1. Auth. technical_users stores the hashed password in
                # `DraftPassword` (NOT `EMPPASSWORD` — that column doesn't
                # exist; the previous code here failed for every user).
                cur.execute(
                    "SELECT EMPUSERNAME, DraftPassword FROM technical_users "
                    "WHERE EMPUSERNAME = %s LIMIT 1",
                    (req.user,),
                )
                u = cur.fetchone()
                if not u:
                    return {"ok": False, "reason": "user not found"}
                ok, hash_type = _verify_tpms_password(
                    req.password, u.get("DraftPassword"))
                if not ok:
                    logger.warning("tpms_auth_fail user=%s hash_type=%s",
                                   req.user, hash_type)
                    return {"ok": False, "reason": "bad password"}

                # 2. Resolve the project's IDProjectMain.
                project = _fetch_project_main(conn, oenum)
                if not project:
                    return {"ok": False, "reason": "oenum not in TPMS"}
                id_pm = project["id_project_main"]

                # 3. Entitlement: user must have a draft_permission row.
                # draft_permission.Project_ID is BIGINT — pass the int and a
                # stringified copy to tolerate either column type.
                cur.execute(
                    "SELECT 1 FROM draft_permission "
                    "WHERE user = %s "
                    "  AND (Project_ID = %s OR Project_ID = CAST(%s AS CHAR)) "
                    "LIMIT 1",
                    (req.user, id_pm, id_pm),
                )
                if cur.fetchone() is None:
                    return {"ok": False,
                            "reason": "user not entitled for this oenum"}
        finally:
            conn.close()
        logger.info("tpms_auth_ok user=%s oenum=%s hash_type=%s",
                    req.user, oenum, hash_type)
        return {"ok": True, "oenum": oenum, "id_project_main": id_pm}
    except Exception as e:
        logger.error("check_oenum_access error: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/projects/{oenum}/exists")
def project_exists(oenum: str):
    """Cheap precheck endpoint: does this OE-number resolve in TPMS?"""
    try:
        conn = get_mysql_connection()
        try:
            row = _fetch_project_main(conn, oenum)
            return {"exists": bool(row), "oenum": oenum}
        finally:
            conn.close()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# /projects/{oenum}/import used to dump TPMS tables to a tarball and POST
# them to the .69 shell-service. Both the tarball path and shell-service
# are retired (2026-05): project-init-service now writes rendered TPMS
# context straight into the per-project runtime-broker container via the
# /sessions/{pid}/write_file endpoint. This endpoint is gone — callers
# should hit /context on tpms-context-agent (with optional per-OE auth)
# or /project/{oenum} on this service directly.


# =============================================================================
# MCP Server - Exposes TPMS tools via Model Context Protocol
# =============================================================================
mcp = FastMCP("tpms-fetcher", instructions="Fetch project data from TPMS MySQL")


def _fetch_into_cache(oenum: str, revision: Optional[str]) -> Optional[Dict]:
    """Shared helper for the MCP tools — populate `_project_cache` for the
    (oenum, revision) pair and return the cached dict. Returns None if the
    OE-number could not be resolved against View_Project_Main."""
    rev = _parse_revision(revision)
    key = _cache_key(oenum, rev)
    if key in _project_cache:
        return _project_cache[key]
    conn = get_mysql_connection()
    try:
        project = _fetch_project_main(conn, oenum)
        if not project:
            return None
        id_pm = project["id_project_main"]
        data = {
            "oenum": oenum,
            "project": project,
            "project_identity": _fetch_project_identity(conn, id_pm),
            "panels":          _fetch_panels(conn, id_pm, revision=rev),
            "feeders":         _fetch_feeders(conn, id_pm, revision=rev),
            "equipment_count": _fetch_equipment_count(conn, id_pm, revision=rev),
            "fetched_at":      datetime.utcnow().isoformat(),
            "status":          "ok",
            "revision":        str(rev),
        }
    finally:
        conn.close()
    _project_cache[key] = data
    return data


@mcp.tool()
def tpms_fetch(oenum: str, revision: Optional[str] = None) -> str:
    """Fetch complete project data from TPMS by OENUM. Returns JSON with
    project, project_identity, panels, feeders, equipment_count.

    revision: 'latest' (default) returns only current state — each panel /
    feeder collapsed to its newest revision row, matching what a technical
    user sees in the TPMS UI. Pass 'all' to include every revision, or an
    integer to pin a specific revision number."""
    try:
        data = _fetch_into_cache(oenum, revision)
        if data is None:
            return json.dumps({"error": f"Project {oenum} not found in TPMS"})
        return json.dumps(data, default=str)
    except Exception as e:
        return json.dumps({"error": str(e)})


@mcp.tool()
def tpms_get_text(oenum: str, revision: Optional[str] = None) -> str:
    """Get project data as agent-readable plain text by OENUM. Default is
    latest-revision-only (current state); pass revision='all' for history
    or an integer for a specific revision."""
    try:
        data = _fetch_into_cache(oenum, revision)
        if data is None:
            return f"Project {oenum} not found in TPMS"
        return _project_to_text(data)
    except Exception as e:
        return f"TPMS fetch error: {e}"


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
    uvicorn.run(app, host="0.0.0.0", port=8021)
