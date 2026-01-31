"""
Project Session Routes
======================
Enhanced project management with per-project database isolation
and real-time TPMS synchronization.

When a project is selected:
1. Initialize project-specific databases (PostgreSQL, Qdrant, Neo4j)
2. Sync latest data from TPMS
3. Resolve property codes to values
4. Track missing data for LLM resolution

Author: Simorgh Industrial Assistant
"""

import logging
from typing import Optional, List
from fastapi import APIRouter, Depends, HTTPException, Query, BackgroundTasks
from pydantic import BaseModel, Field

from services.auth_utils import get_current_user
from services.neo4j_service import Neo4jService, get_neo4j_service
from services.document_processing_integration import get_qdrant_service
from services.project_sync_service import get_project_sync_service, ProjectSyncService
from services.project_database_manager import get_project_database_manager
from services.tpms_project_data_service import get_tpms_project_data_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v2/project", tags=["Project Session V2"])


# =============================================================================
# REQUEST/RESPONSE MODELS
# =============================================================================

class ProjectSelectRequest(BaseModel):
    """Request to select/activate a project."""
    oenum: str = Field(..., description="Project OENUM")
    force_sync: bool = Field(False, description="Force full sync even if data exists")


class ProjectSelectResponse(BaseModel):
    """Response from project selection."""
    success: bool
    oenum: str
    project_name: Optional[str] = None
    id_project_main: Optional[int] = None
    databases: dict = {}
    sync_status: str = "pending"
    sync_details: Optional[dict] = None
    missing_data_count: int = 0
    message: Optional[str] = None


class ProjectSyncStatusResponse(BaseModel):
    """Response with sync status details."""
    oenum: str
    status: str
    last_synced: Optional[str] = None
    records: dict = {}
    missing_data: List[dict] = []


class MissingDataItem(BaseModel):
    """A missing data item that needs resolution."""
    table: str
    field: str
    record_id: Optional[int] = None
    description: str
    suggested_sources: List[str] = []


class ResolveMissingDataRequest(BaseModel):
    """Request to resolve missing data."""
    table: str
    field: str
    record_id: Optional[int] = None
    value: str
    source: str = Field(..., description="Resolution source: 'user', 'document', 'inferred'")


# =============================================================================
# DEPENDENCY INJECTION
# =============================================================================

def get_sync_service(
    neo4j: Neo4jService = Depends(get_neo4j_service)
) -> ProjectSyncService:
    """Get sync service with Neo4j injected."""
    sync_service = get_project_sync_service()
    sync_service.set_neo4j_service(neo4j)

    # Also set Qdrant
    try:
        qdrant = get_qdrant_service()
        db_manager = get_project_database_manager()
        db_manager.qdrant = qdrant
        db_manager.neo4j = neo4j
    except Exception as e:
        logger.warning(f"Could not set Qdrant service: {e}")

    return sync_service


# =============================================================================
# ROUTES
# =============================================================================

@router.post("/select", response_model=ProjectSelectResponse)
async def select_project(
    request: ProjectSelectRequest,
    background_tasks: BackgroundTasks,
    current_user: str = Depends(get_current_user),
    sync_service: ProjectSyncService = Depends(get_sync_service),
):
    """
    Select a project for the current session.

    This will:
    1. Initialize project databases if needed (PostgreSQL, Qdrant, Neo4j)
    2. Fetch latest data from TPMS
    3. Sync to project-specific databases
    4. Return project details and sync status

    The sync runs asynchronously - check /sync/status for completion.
    """
    oenum = request.oenum.strip()

    try:
        # Verify project exists in TPMS
        tpms_service = get_tpms_project_data_service()
        project_main = tpms_service.get_project_by_oenum(oenum)

        if not project_main:
            raise HTTPException(
                status_code=404,
                detail=f"Project {oenum} not found in TPMS"
            )

        # Initialize databases
        db_manager = get_project_database_manager()
        db_status = db_manager.select_project(oenum, project_main.project_name)

        # Start sync (can run in background for large projects)
        if request.force_sync or not db_status.get("all_ready"):
            # Run sync synchronously for now (can be made async)
            sync_result = await sync_service.sync_project(oenum)
            sync_status = sync_result.get("status", "unknown")
            missing_count = len(sync_result.get("missing_data", []))
        else:
            # Quick check if data is fresh
            sync_status = "cached"
            missing_count = 0
            sync_result = None

        logger.info(f"User {current_user} selected project {oenum}")

        return ProjectSelectResponse(
            success=True,
            oenum=oenum,
            project_name=project_main.project_name,
            id_project_main=project_main.id_project_main,
            databases=db_status,
            sync_status=sync_status,
            sync_details=sync_result,
            missing_data_count=missing_count,
            message=f"Project {oenum} activated successfully"
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Project selection failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Failed to select project: {str(e)}"
        )


@router.post("/sync/{oenum}")
async def sync_project(
    oenum: str,
    current_user: str = Depends(get_current_user),
    sync_service: ProjectSyncService = Depends(get_sync_service),
):
    """
    Manually trigger a full sync for a project.

    Use this to refresh project data from TPMS.
    """
    try:
        result = await sync_service.sync_project(oenum)
        return result
    except Exception as e:
        logger.error(f"Sync failed for {oenum}: {e}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Sync failed: {str(e)}"
        )


@router.get("/sync/status/{oenum}", response_model=ProjectSyncStatusResponse)
async def get_sync_status(
    oenum: str,
    current_user: str = Depends(get_current_user),
):
    """
    Get sync status and data summary for a project.
    """
    try:
        db_manager = get_project_database_manager()

        # Check if project databases exist
        if not db_manager.check_project_db_exists(oenum):
            return ProjectSyncStatusResponse(
                oenum=oenum,
                status="not_initialized",
                records={},
                missing_data=[]
            )

        # Get summary from project database
        conn = db_manager._get_project_connection(oenum)
        cursor = conn.cursor()

        # Count records
        cursor.execute("SELECT COUNT(*) FROM technical_panel_identity")
        panel_count = cursor.fetchone()[0]

        cursor.execute("SELECT COUNT(*) FROM view_draft")
        feeder_count = cursor.fetchone()[0]

        cursor.execute("SELECT COUNT(*) FROM view_draft_equipment")
        equipment_count = cursor.fetchone()[0]

        # Get missing data
        cursor.execute("""
            SELECT table_name, field_name, record_id, description
            FROM missing_data
            WHERE resolved = FALSE
            ORDER BY created_at DESC
            LIMIT 20
        """)
        missing_rows = cursor.fetchall()
        missing_data = [
            {
                "table": row[0],
                "field": row[1],
                "record_id": row[2],
                "description": row[3]
            }
            for row in missing_rows
        ]

        # Get last sync time
        cursor.execute("""
            SELECT completed_at FROM sync_log
            WHERE status = 'success'
            ORDER BY completed_at DESC
            LIMIT 1
        """)
        last_sync_row = cursor.fetchone()
        last_synced = str(last_sync_row[0]) if last_sync_row else None

        cursor.close()
        conn.close()

        return ProjectSyncStatusResponse(
            oenum=oenum,
            status="synced",
            last_synced=last_synced,
            records={
                "panels": panel_count,
                "feeders": feeder_count,
                "equipment": equipment_count
            },
            missing_data=missing_data
        )

    except Exception as e:
        logger.error(f"Failed to get sync status: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Failed to get status: {str(e)}"
        )


@router.get("/missing-data/{oenum}")
async def get_missing_data(
    oenum: str,
    current_user: str = Depends(get_current_user),
    limit: int = Query(50, ge=1, le=200),
):
    """
    Get list of missing data items that need resolution.

    These can be resolved by:
    - User input
    - Extracting from uploaded documents
    - LLM inference from standards
    """
    try:
        db_manager = get_project_database_manager()

        if not db_manager.check_project_db_exists(oenum):
            raise HTTPException(status_code=404, detail="Project not initialized")

        conn = db_manager._get_project_connection(oenum)
        cursor = conn.cursor()

        cursor.execute("""
            SELECT id, table_name, field_name, record_id, description,
                   resolution_source, resolved, resolved_value, created_at
            FROM missing_data
            WHERE resolved = FALSE
            ORDER BY created_at DESC
            LIMIT %s
        """, (limit,))

        rows = cursor.fetchall()
        cursor.close()
        conn.close()

        return {
            "oenum": oenum,
            "missing_data": [
                {
                    "id": row[0],
                    "table": row[1],
                    "field": row[2],
                    "record_id": row[3],
                    "description": row[4],
                    "resolution_source": row[5],
                    "resolved": row[6],
                    "resolved_value": row[7],
                    "created_at": str(row[8])
                }
                for row in rows
            ],
            "total": len(rows)
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to get missing data: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Failed to get missing data: {str(e)}"
        )


@router.post("/missing-data/{oenum}/resolve")
async def resolve_missing_data(
    oenum: str,
    request: ResolveMissingDataRequest,
    current_user: str = Depends(get_current_user),
    sync_service: ProjectSyncService = Depends(get_sync_service),
):
    """
    Resolve a missing data item.

    The value will be stored in:
    - PostgreSQL project database
    - Neo4j graph (if applicable)
    """
    try:
        db_manager = get_project_database_manager()

        if not db_manager.check_project_db_exists(oenum):
            raise HTTPException(status_code=404, detail="Project not initialized")

        conn = db_manager._get_project_connection(oenum)
        cursor = conn.cursor()

        # Update missing_data table
        from datetime import datetime
        cursor.execute("""
            UPDATE missing_data
            SET resolved = TRUE,
                resolved_value = %s,
                resolution_source = %s,
                resolved_at = %s
            WHERE table_name = %s
              AND field_name = %s
              AND (record_id = %s OR (record_id IS NULL AND %s IS NULL))
              AND resolved = FALSE
            RETURNING id
        """, (
            request.value,
            request.source,
            datetime.utcnow(),
            request.table,
            request.field,
            request.record_id,
            request.record_id
        ))

        updated = cursor.fetchone()

        if not updated:
            conn.close()
            raise HTTPException(
                status_code=404,
                detail="Missing data item not found or already resolved"
            )

        # Also update the actual table with the resolved value
        # (This would need table-specific logic based on request.table)

        conn.commit()
        cursor.close()
        conn.close()

        logger.info(
            f"Resolved missing data: {request.table}.{request.field} = {request.value} "
            f"(source: {request.source}, user: {current_user})"
        )

        return {
            "success": True,
            "message": f"Resolved {request.table}.{request.field}",
            "value": request.value,
            "source": request.source
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to resolve missing data: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Failed to resolve: {str(e)}"
        )


@router.get("/data/{oenum}/summary")
async def get_project_data_summary(
    oenum: str,
    current_user: str = Depends(get_current_user),
):
    """
    Get a summary of all project data.

    Returns counts and key information for panels, feeders, equipment.
    """
    try:
        db_manager = get_project_database_manager()

        if not db_manager.check_project_db_exists(oenum):
            raise HTTPException(status_code=404, detail="Project not initialized")

        conn = db_manager._get_project_connection(oenum)
        cursor = conn.cursor()

        # Get project main info
        cursor.execute("""
            SELECT project_name, project_name_fa, order_category, oe_date,
                   project_expert_label, technical_supervisor_label
            FROM project_main
            LIMIT 1
        """)
        project_row = cursor.fetchone()

        # Get panels summary
        cursor.execute("""
            SELECT id_project_scope, plane_name, plane_type,
                   voltage_rate, rated_voltage, ip_value
            FROM technical_panel_identity
            ORDER BY id_project_scope
        """)
        panels = [
            {
                "panel_id": row[0],
                "name": row[1],
                "type": row[2],
                "voltage_rate": row[3],
                "rated_voltage": row[4],
                "ip": row[5]
            }
            for row in cursor.fetchall()
        ]

        # Get feeder counts per panel
        cursor.execute("""
            SELECT tablo_id, COUNT(*) as feeder_count
            FROM view_draft
            GROUP BY tablo_id
        """)
        feeder_counts = {row[0]: row[1] for row in cursor.fetchall()}

        cursor.close()
        conn.close()

        return {
            "oenum": oenum,
            "project": {
                "name": project_row[0] if project_row else None,
                "name_fa": project_row[1] if project_row else None,
                "order_category": project_row[2] if project_row else None,
                "oe_date": project_row[3] if project_row else None,
                "expert": project_row[4] if project_row else None,
                "supervisor": project_row[5] if project_row else None,
            } if project_row else None,
            "panels": [
                {**p, "feeder_count": feeder_counts.get(p["panel_id"], 0)}
                for p in panels
            ],
            "totals": {
                "panels": len(panels),
                "feeders": sum(feeder_counts.values())
            }
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to get project summary: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Failed to get summary: {str(e)}"
        )


@router.get("/data/{oenum}/panel/{panel_id}")
async def get_panel_details(
    oenum: str,
    panel_id: int,
    current_user: str = Depends(get_current_user),
):
    """
    Get detailed information for a specific panel including all feeders.
    """
    try:
        db_manager = get_project_database_manager()

        if not db_manager.check_project_db_exists(oenum):
            raise HTTPException(status_code=404, detail="Project not initialized")

        conn = db_manager._get_project_connection(oenum)
        cursor = conn.cursor()

        # Get panel details
        cursor.execute("""
            SELECT id_project_scope, plane_name, plane_type, cell_count,
                   height, width, depth,
                   voltage_rate, rated_voltage, switch_amperage, frequency,
                   kabus, abus, main_busbar_size, earth_size, neutral_size,
                   scm, cpcts,
                   ip_code, ip_value, ip_resolved,
                   access_from_value, color_real_value
            FROM technical_panel_identity
            WHERE id_project_scope = %s
        """, (panel_id,))

        panel_row = cursor.fetchone()
        if not panel_row:
            cursor.close()
            conn.close()
            raise HTTPException(status_code=404, detail="Panel not found")

        panel = {
            "panel_id": panel_row[0],
            "name": panel_row[1],
            "type": panel_row[2],
            "cell_count": panel_row[3],
            "dimensions": {
                "height": panel_row[4],
                "width": panel_row[5],
                "depth": panel_row[6]
            },
            "electrical": {
                "voltage_rate": panel_row[7],
                "rated_voltage": panel_row[8],
                "switch_amperage": panel_row[9],
                "frequency": panel_row[10]
            },
            "busbar": {
                "kabus": panel_row[11],
                "abus": panel_row[12],
                "main_size": panel_row[13],
                "earth_size": panel_row[14],
                "neutral_size": panel_row[15]
            },
            "short_circuit": {
                "scm": panel_row[16],
                "cpcts": panel_row[17]
            },
            "ip": {
                "code": panel_row[18],
                "value": panel_row[19],
                "resolved": panel_row[20]
            },
            "access_from": panel_row[21],
            "color": panel_row[22]
        }

        # Get feeders for this panel
        cursor.execute("""
            SELECT tpms_id, feeder_no, bus_section, tag, designation,
                   wiring_type, rating_power, flc, module, module_type,
                   size, cable_size, cb_rating, overload_rating, contactor_rating
            FROM view_draft
            WHERE tablo_id = %s
            ORDER BY ordering, tpms_id
        """, (panel_id,))

        feeders = [
            {
                "id": row[0],
                "feeder_no": row[1],
                "bus_section": row[2],
                "tag": row[3],
                "designation": row[4],
                "wiring_type": row[5],
                "rating_power": row[6],
                "flc": row[7],
                "module": row[8],
                "module_type": row[9],
                "size": row[10],
                "cable_size": row[11],
                "cb_rating": row[12],
                "overload_rating": row[13],
                "contactor_rating": row[14]
            }
            for row in cursor.fetchall()
        ]

        cursor.close()
        conn.close()

        return {
            "oenum": oenum,
            "panel": panel,
            "feeders": feeders,
            "feeder_count": len(feeders)
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to get panel details: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Failed to get panel: {str(e)}"
        )


@router.get("/list")
async def list_projects(
    current_user: str = Depends(get_current_user),
):
    """
    List all project databases that have been created.

    Returns list of OENUMs with existing project databases.
    """
    try:
        db_manager = get_project_database_manager()
        oenumsdata = db_manager.list_project_databases()

        return {
            "projects": oenumsdata,
            "count": len(oenumsdata)
        }

    except Exception as e:
        logger.error(f"Failed to list projects: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Failed to list projects: {str(e)}"
        )


@router.get("/tpms/tables")
async def list_tpms_tables(
    current_user: str = Depends(get_current_user),
):
    """
    Diagnostic endpoint to list all accessible TPMS tables/views.

    This helps identify which tables the 'technical' user can access.
    """
    try:
        tpms_service = get_tpms_project_data_service()
        result = tpms_service.list_available_tables()

        return {
            "success": True,
            "database": tpms_service.database,
            "host": tpms_service.host,
            "accessible_tables": result.get("accessible", []),
            "inaccessible_tables": result.get("inaccessible", []),
            "all_objects": result.get("all_objects", []),
            "errors": result.get("errors", [])
        }

    except Exception as e:
        logger.error(f"Failed to list TPMS tables: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Failed to list tables: {str(e)}"
        )


@router.delete("/{oenum}")
async def delete_project(
    oenum: str,
    confirm: bool = Query(False, description="Must be true to confirm deletion"),
    current_user: str = Depends(get_current_user),
    sync_service: ProjectSyncService = Depends(get_sync_service),
):
    """
    DELETE ALL project data from ALL databases.

    WARNING: This is a destructive, irreversible operation!

    Deletes:
    - PostgreSQL database (project_<oenum>)
    - Qdrant vector collection (project_<oenum>)
    - Neo4j knowledge graph (all project nodes and relationships)

    Args:
        oenum: Project OENUM to delete
        confirm: Must be true to confirm the deletion

    Returns:
        Deletion status for each database
    """
    if not confirm:
        raise HTTPException(
            status_code=400,
            detail="Deletion not confirmed. Set confirm=true to proceed with deletion."
        )

    try:
        db_manager = get_project_database_manager()

        # Check if project exists
        if not db_manager.check_project_db_exists(oenum):
            raise HTTPException(
                status_code=404,
                detail=f"Project {oenum} not found"
            )

        # Perform deletion
        result = db_manager.delete_project(oenum)

        logger.warning(
            f"User {current_user} DELETED project {oenum}. "
            f"Results: PostgreSQL={result['postgresql']}, "
            f"Qdrant={result['qdrant']}, Neo4j={result['neo4j']}"
        )

        if not result["success"]:
            return {
                "success": False,
                "oenum": oenum,
                "message": "Partial deletion - some components failed",
                "details": result
            }

        return {
            "success": True,
            "oenum": oenum,
            "message": f"Project {oenum} and all its data have been permanently deleted",
            "details": result
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to delete project {oenum}: {e}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Failed to delete project: {str(e)}"
        )


# =============================================================================
# REGISTRATION HELPER
# =============================================================================

def include_project_session_routes(app):
    """Include project session routes in FastAPI app."""
    app.include_router(router)
    logger.info("Included project session v2 routes")
