"""
Project Sync Service
====================
Orchestrates real-time synchronization of project data from TPMS
to project-specific PostgreSQL databases and Neo4j graphs.

Called when a project is selected to ensure data is up-to-date.

Author: Simorgh Industrial Assistant
"""

import logging
from typing import Optional, Dict, Any, List
from datetime import datetime

import psycopg2
from psycopg2 import sql

from models.tpms_project_models import (
    TPMSProjectData,
    TechnicalPropertyType,
    ResolvedProperty,
)
from services.tpms_project_data_service import (
    TPMSProjectDataService,
    get_tpms_project_data_service,
)
from services.project_database_manager import (
    ProjectDatabaseManager,
    get_project_database_manager,
)
from services.property_resolver import (
    PropertyResolver,
    get_property_resolver,
)
from services.redis_service import get_redis_service, RedisService

logger = logging.getLogger(__name__)


class ProjectSyncService:
    """
    Orchestrates synchronization of project data.

    Flow:
    1. Fetch data from TPMS
    2. Resolve property codes to values
    3. Store in PostgreSQL (project-specific DB)
    4. Build/Update Neo4j graph
    5. Track missing data for LLM resolution
    """

    def __init__(
        self,
        tpms_service: TPMSProjectDataService = None,
        db_manager: ProjectDatabaseManager = None,
        property_resolver: PropertyResolver = None,
        neo4j_service=None,
        redis_service: RedisService = None,
    ):
        """
        Initialize sync service.

        Args:
            tpms_service: TPMS data service
            db_manager: Project database manager
            property_resolver: Property code resolver
            neo4j_service: Neo4j service for graph operations
            redis_service: Redis service for cache invalidation
        """
        self.tpms = tpms_service or get_tpms_project_data_service()
        self.db_manager = db_manager or get_project_database_manager()
        self.resolver = property_resolver or get_property_resolver()
        self.neo4j = neo4j_service
        self.redis = redis_service

        logger.info("ProjectSyncService initialized")

    def set_neo4j_service(self, neo4j_service):
        """Set Neo4j service (for late initialization)."""
        self.neo4j = neo4j_service
        self.db_manager.neo4j = neo4j_service

    def set_redis_service(self, redis_service: RedisService):
        """Set Redis service (for late initialization)."""
        self.redis = redis_service

    # ==========================================================================
    # MAIN SYNC METHOD
    # ==========================================================================

    async def sync_project(self, oenum: str) -> Dict[str, Any]:
        """
        Synchronize project data from TPMS.

        This is the main entry point called when a project is selected.

        Args:
            oenum: Project OENUM

        Returns:
            Dict with sync results
        """
        logger.info(f"Starting sync for project: {oenum}")
        start_time = datetime.utcnow()

        result = {
            "oenum": oenum,
            "started_at": start_time,
            "completed_at": None,
            "status": "in_progress",
            "steps": {},
            "errors": [],
            "warnings": [],
            "missing_data": [],
        }

        try:
            # Step 1: Fetch from TPMS
            logger.info(f"[{oenum}] Step 1: Fetching data from TPMS")
            tpms_data = self.tpms.fetch_complete_project_data(oenum)

            if not tpms_data:
                result["status"] = "failed"
                result["errors"].append(f"Project {oenum} not found in TPMS")
                return result

            result["steps"]["tpms_fetch"] = {
                "status": "success",
                "panels": len(tpms_data.panels),
                "feeders": len(tpms_data.drafts),
                "equipment": len(tpms_data.draft_equipment),
            }

            # Step 2: Initialize project databases if needed
            logger.info(f"[{oenum}] Step 2: Initializing databases")
            project_name = tpms_data.project_main.project_name
            db_status = self.db_manager.select_project(oenum, project_name)

            result["steps"]["db_init"] = db_status

            if not db_status.get("all_ready"):
                result["warnings"].append("Some databases failed to initialize")

            # Step 3: Resolve property codes
            logger.info(f"[{oenum}] Step 3: Resolving property codes")
            resolved_data, missing = self._resolve_properties(tpms_data)
            result["missing_data"] = missing
            result["steps"]["property_resolution"] = {
                "status": "success",
                "missing_count": len(missing),
            }

            # Step 4: Store in PostgreSQL
            logger.info(f"[{oenum}] Step 4: Storing in PostgreSQL")
            pg_result = self._store_in_postgresql(oenum, tpms_data, resolved_data)
            result["steps"]["postgresql_store"] = pg_result

            # Step 5: Build Neo4j graph
            logger.info(f"[{oenum}] Step 5: Building Neo4j graph")
            neo4j_result = await self._build_neo4j_graph(oenum, tpms_data, resolved_data)
            result["steps"]["neo4j_graph"] = neo4j_result

            # Step 6: Track missing data
            if missing:
                logger.info(f"[{oenum}] Step 6: Recording {len(missing)} missing data items")
                self._record_missing_data(oenum, missing)

            # Step 7: Invalidate Redis cache (ensures fresh data for LLM context)
            logger.info(f"[{oenum}] Step 7: Invalidating Redis cache")
            if self.redis:
                self.redis.invalidate_project_cache(oenum)
                result["steps"]["cache_invalidation"] = {"status": "success"}
            else:
                # Try to get redis service if not set
                try:
                    redis = get_redis_service()
                    redis.invalidate_project_cache(oenum)
                    result["steps"]["cache_invalidation"] = {"status": "success"}
                except Exception as cache_err:
                    logger.warning(f"Cache invalidation skipped: {cache_err}")
                    result["steps"]["cache_invalidation"] = {"status": "skipped", "reason": str(cache_err)}

            # Complete
            result["status"] = "success"
            result["completed_at"] = datetime.utcnow()
            result["duration_seconds"] = (
                result["completed_at"] - start_time
            ).total_seconds()

            logger.info(f"✅ Sync completed for {oenum} in {result['duration_seconds']:.2f}s")

        except Exception as e:
            logger.error(f"Sync failed for {oenum}: {e}", exc_info=True)
            result["status"] = "failed"
            result["errors"].append(str(e))
            result["completed_at"] = datetime.utcnow()

        return result

    # ==========================================================================
    # PROPERTY RESOLUTION
    # ==========================================================================

    def _resolve_properties(
        self,
        data: TPMSProjectData
    ) -> tuple[Dict[str, Any], List[Dict[str, Any]]]:
        """
        Resolve all property codes to values.

        Returns:
            Tuple of (resolved_data dict, list of missing data items)
        """
        resolved = {
            "project_identity": {},
            "panels": {},
        }
        missing = []

        # Resolve project identity properties
        if data.project_identity:
            pi = data.project_identity
            identity_resolved = {}

            # Project group
            identity_resolved["project_group"] = self.resolver.resolve(
                TechnicalPropertyType.PROJECT_GROUP,
                pi.project_group,
                None
            )

            # Packing & Isolation
            identity_resolved["packing_type"] = self.resolver.resolve(
                TechnicalPropertyType.PACKING_TYPE,
                pi.packing_type,
                pi.packing_type_remark
            )
            identity_resolved["isolation"] = self.resolver.resolve(
                TechnicalPropertyType.ISOLATION,
                pi.isolation,
                pi.isolation_remark
            )
            identity_resolved["isolation_type"] = self.resolver.resolve(
                TechnicalPropertyType.ISOLATION_TYPE,
                pi.isolation_type,
                pi.isolation_type_remark
            )

            # Plating & Color
            identity_resolved["plating_type"] = self.resolver.resolve(
                TechnicalPropertyType.PLATING_TYPE,
                pi.plating_type,
                pi.plating_type_remark
            )
            identity_resolved["how_to_plating"] = self.resolver.resolve(
                TechnicalPropertyType.HOW_TO_PLATING,
                pi.how_to_plating,
                pi.how_to_plating_remark
            )
            identity_resolved["color_type"] = self.resolver.resolve(
                TechnicalPropertyType.COLOR_TYPE,
                pi.color_type,
                pi.color_type_remark
            )
            identity_resolved["color_thickness"] = self.resolver.resolve(
                TechnicalPropertyType.COLOR_THICKNESS,
                pi.color_thickness,
                pi.color_thickness_remark
            )

            # Wire sizes
            identity_resolved["control_wire_size"] = self.resolver.resolve(
                TechnicalPropertyType.CONTROL_WIRE_SIZE,
                pi.control_wire_size,
                pi.control_wire_size_remark
            )
            identity_resolved["ct_wire_size"] = self.resolver.resolve(
                TechnicalPropertyType.CT_WIRE_SIZE,
                pi.ct_wire_size,
                pi.ct_wire_size_remark
            )
            identity_resolved["pt_wire_size"] = self.resolver.resolve(
                TechnicalPropertyType.PT_WIRE_SIZE,
                pi.pt_wire_size,
                pi.pt_wire_size_remark
            )

            # Wire colors
            identity_resolved["phase_wire_color"] = self.resolver.resolve(
                TechnicalPropertyType.PHASE_WIRE_COLOR_AC,
                pi.phase_wire_color,
                pi.phase_wire_color_remark
            )
            identity_resolved["neutral_wire_color"] = self.resolver.resolve(
                TechnicalPropertyType.NEUTRAL_WIRE_COLOR_AC,
                pi.natural_wire_color,
                pi.natural_wire_color_remark
            )
            identity_resolved["dc_plus_wire_color"] = self.resolver.resolve(
                TechnicalPropertyType.DC_PLUS_WIRE_COLOR,
                pi.dc_plus_wire_color,
                pi.dc_plus_wire_color_remark
            )
            identity_resolved["dc_minus_wire_color"] = self.resolver.resolve(
                TechnicalPropertyType.DC_MINUS_WIRE_COLOR,
                pi.dc_minus_wire_color,
                pi.dc_minus_wire_color_remark
            )

            resolved["project_identity"] = identity_resolved

            # Track missing required fields
            required_fields = [
                "isolation", "isolation_type", "plating_type",
                "control_wire_size", "phase_wire_color"
            ]
            for field in required_fields:
                prop = identity_resolved.get(field)
                if prop and not prop.resolved and prop.code is None:
                    missing.append({
                        "table": "project_identity",
                        "field": field,
                        "description": f"Missing {field.replace('_', ' ')}"
                    })

        # Resolve panel properties
        for panel in data.panels:
            panel_id = panel.id_project_scope or panel.id
            panel_resolved = {}

            panel_resolved["layout_type"] = self.resolver.resolve(
                TechnicalPropertyType.MV_PANEL_LAYOUT,
                panel.layout_type,
                panel.layout_type_remark
            )
            panel_resolved["ip"] = self.resolver.resolve(
                TechnicalPropertyType.IP_PROTECTION,
                panel.ip,
                panel.ip_remark
            )
            panel_resolved["access_from"] = self.resolver.resolve(
                TechnicalPropertyType.ACCESS_FROM,
                panel.access_from,
                panel.access_from_remark
            )
            panel_resolved["inlet_contact"] = self.resolver.resolve(
                TechnicalPropertyType.INLET_CONTACT,
                panel.inlet_contact,
                panel.inlet_contact_remark
            )
            panel_resolved["outlet_contact"] = self.resolver.resolve(
                TechnicalPropertyType.OUTLET_CONTACT,
                panel.outlet_contact,
                panel.outlet_contact_remark
            )
            panel_resolved["color_real"] = self.resolver.resolve(
                TechnicalPropertyType.COLOR_REAL,
                panel.color_real,
                panel.color_real_remark
            )
            panel_resolved["isolation"] = self.resolver.resolve(
                TechnicalPropertyType.ISOLATION,
                panel.isolation,
                panel.isolation_remark
            )
            panel_resolved["isolation_type"] = self.resolver.resolve(
                TechnicalPropertyType.ISOLATION_TYPE,
                panel.isolation_type,
                panel.isolation_type_remark
            )
            panel_resolved["plating_type"] = self.resolver.resolve(
                TechnicalPropertyType.PLATING_TYPE,
                panel.plating_type,
                panel.plating_type_remark
            )

            resolved["panels"][panel_id] = panel_resolved

            # Track missing required panel fields
            required_panel = ["ip", "voltage_rate", "rated_voltage"]
            for field in required_panel:
                if field in panel_resolved:
                    prop = panel_resolved[field]
                    if prop and not prop.resolved and prop.code is None:
                        missing.append({
                            "table": "panel_identity",
                            "record_id": panel_id,
                            "field": field,
                            "description": f"Panel {panel.plane_name_1}: Missing {field}"
                        })
                else:
                    # Direct field check
                    value = getattr(panel, field.replace('_', ''), None)
                    if not value:
                        missing.append({
                            "table": "panel_identity",
                            "record_id": panel_id,
                            "field": field,
                            "description": f"Panel {panel.plane_name_1}: Missing {field}"
                        })

        return resolved, missing

    # ==========================================================================
    # POSTGRESQL STORAGE
    # ==========================================================================

    def _store_in_postgresql(
        self,
        oenum: str,
        data: TPMSProjectData,
        resolved: Dict[str, Any]
    ) -> Dict[str, Any]:
        """Store project data in PostgreSQL."""
        result = {
            "status": "pending",
            "records_inserted": 0,
            "records_updated": 0,
        }

        try:
            conn = self.db_manager._get_project_connection(oenum)
            cursor = conn.cursor()

            # Store project main
            cursor.execute("""
                INSERT INTO project_main (
                    id_project_main, oenum, order_category, oe_date,
                    project_name, project_name_fa, project_expert_label,
                    technical_supervisor_label, technical_expert_label,
                    updated_at, sync_status
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (id_project_main) DO UPDATE SET
                    oenum = EXCLUDED.oenum,
                    order_category = EXCLUDED.order_category,
                    project_name = EXCLUDED.project_name,
                    project_name_fa = EXCLUDED.project_name_fa,
                    project_expert_label = EXCLUDED.project_expert_label,
                    technical_supervisor_label = EXCLUDED.technical_supervisor_label,
                    technical_expert_label = EXCLUDED.technical_expert_label,
                    updated_at = EXCLUDED.updated_at,
                    sync_status = EXCLUDED.sync_status
            """, (
                data.project_main.id_project_main,
                data.project_main.oenum,
                data.project_main.order_category,
                data.project_main.oe_date,
                data.project_main.project_name,
                data.project_main.project_name_fa,
                data.project_main.project_expert_label,
                data.project_main.technical_supervisor_label,
                data.project_main.technical_expert_label,
                datetime.utcnow(),
                'synced'
            ))
            result["records_inserted"] += 1

            # Store project identity with resolved values
            if data.project_identity:
                pi = data.project_identity
                pi_resolved = resolved.get("project_identity", {})

                cursor.execute("""
                    INSERT INTO technical_project_identity (
                        tpms_id, id_project_main, delivery_date,
                        above_sea_level, average_temperature,
                        project_group_code, project_group_value, project_group_resolved,
                        packing_type_code, packing_type_value, packing_type_resolved,
                        isolation_code, isolation_value, isolation_resolved,
                        isolation_type_code, isolation_type_value, isolation_type_resolved,
                        plating_type_code, plating_type_value, plating_type_resolved,
                        color_type_code, color_type_value, color_type_resolved,
                        control_wire_size_code, control_wire_size_value, control_wire_size_resolved,
                        phase_wire_color_code, phase_wire_color_value, phase_wire_color_resolved,
                        wire_brand, control_wire_brand,
                        updated_at
                    ) VALUES (
                        %s, %s, %s, %s, %s,
                        %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                        %s, %s, %s, %s, %s, %s, %s, %s, %s
                    )
                    ON CONFLICT (tpms_id) DO UPDATE SET
                        delivery_date = EXCLUDED.delivery_date,
                        above_sea_level = EXCLUDED.above_sea_level,
                        project_group_value = EXCLUDED.project_group_value,
                        project_group_resolved = EXCLUDED.project_group_resolved,
                        packing_type_value = EXCLUDED.packing_type_value,
                        packing_type_resolved = EXCLUDED.packing_type_resolved,
                        isolation_value = EXCLUDED.isolation_value,
                        isolation_resolved = EXCLUDED.isolation_resolved,
                        updated_at = EXCLUDED.updated_at
                """, (
                    pi.id, pi.id_project_main, pi.delivery_date,
                    pi.above_sea_level, pi.average_temperature,
                    pi_resolved.get("project_group", ResolvedProperty()).code,
                    pi_resolved.get("project_group", ResolvedProperty()).value,
                    pi_resolved.get("project_group", ResolvedProperty()).resolved,
                    pi_resolved.get("packing_type", ResolvedProperty()).code,
                    pi_resolved.get("packing_type", ResolvedProperty()).value,
                    pi_resolved.get("packing_type", ResolvedProperty()).resolved,
                    pi_resolved.get("isolation", ResolvedProperty()).code,
                    pi_resolved.get("isolation", ResolvedProperty()).value,
                    pi_resolved.get("isolation", ResolvedProperty()).resolved,
                    pi_resolved.get("isolation_type", ResolvedProperty()).code,
                    pi_resolved.get("isolation_type", ResolvedProperty()).value,
                    pi_resolved.get("isolation_type", ResolvedProperty()).resolved,
                    pi_resolved.get("plating_type", ResolvedProperty()).code,
                    pi_resolved.get("plating_type", ResolvedProperty()).value,
                    pi_resolved.get("plating_type", ResolvedProperty()).resolved,
                    pi_resolved.get("color_type", ResolvedProperty()).code,
                    pi_resolved.get("color_type", ResolvedProperty()).value,
                    pi_resolved.get("color_type", ResolvedProperty()).resolved,
                    pi_resolved.get("control_wire_size", ResolvedProperty()).code,
                    pi_resolved.get("control_wire_size", ResolvedProperty()).value,
                    pi_resolved.get("control_wire_size", ResolvedProperty()).resolved,
                    pi_resolved.get("phase_wire_color", ResolvedProperty()).code,
                    pi_resolved.get("phase_wire_color", ResolvedProperty()).value,
                    pi_resolved.get("phase_wire_color", ResolvedProperty()).resolved,
                    pi.wire_brand, pi.control_wire_brand,
                    datetime.utcnow()
                ))
                result["records_inserted"] += 1

            # Store panels
            for panel in data.panels:
                panel_id = panel.id_project_scope or panel.id
                panel_resolved = resolved.get("panels", {}).get(panel_id, {})

                cursor.execute("""
                    INSERT INTO technical_panel_identity (
                        tpms_id, id_project_main, id_project_scope,
                        plane_name, plane_type, cell_count,
                        height, width, depth,
                        voltage_rate, rated_voltage, switch_amperage, frequency,
                        kabus, abus, main_busbar_size, earth_size, neutral_size,
                        scm, cpcts,
                        ip_code, ip_value, ip_resolved,
                        access_from_code, access_from_value, access_from_resolved,
                        color_real_code, color_real_value, color_real_resolved,
                        updated_at
                    ) VALUES (
                        %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                        %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s
                    )
                    ON CONFLICT (tpms_id) DO UPDATE SET
                        plane_name = EXCLUDED.plane_name,
                        voltage_rate = EXCLUDED.voltage_rate,
                        ip_value = EXCLUDED.ip_value,
                        ip_resolved = EXCLUDED.ip_resolved,
                        updated_at = EXCLUDED.updated_at
                """, (
                    panel.id, panel.id_project_main, panel.id_project_scope,
                    panel.plane_name_1, panel.plane_type, panel.cell_count,
                    panel.height, panel.width, panel.depth,
                    panel.voltage_rate, panel.rated_voltage, panel.switch_amperage, panel.frequency,
                    panel.kabus, panel.abus, panel.main_busbar_size, panel.earth_size, panel.neutral_size,
                    panel.scm, panel.cpcts,
                    panel_resolved.get("ip", ResolvedProperty()).code,
                    panel_resolved.get("ip", ResolvedProperty()).value,
                    panel_resolved.get("ip", ResolvedProperty()).resolved,
                    panel_resolved.get("access_from", ResolvedProperty()).code,
                    panel_resolved.get("access_from", ResolvedProperty()).value,
                    panel_resolved.get("access_from", ResolvedProperty()).resolved,
                    panel_resolved.get("color_real", ResolvedProperty()).code,
                    panel_resolved.get("color_real", ResolvedProperty()).value,
                    panel_resolved.get("color_real", ResolvedProperty()).resolved,
                    datetime.utcnow()
                ))
                result["records_inserted"] += 1

            # Store feeders/drafts
            for draft in data.drafts:
                cursor.execute("""
                    INSERT INTO view_draft (
                        tpms_id, project_id, tablo_id, scope_name,
                        bus_section, feeder_no, tag, designation,
                        wiring_type, rating_power, flc, module, module_type,
                        size, cable_size, cb_rating, overload_rating, contactor_rating,
                        description, revision, ordering, updated_at
                    ) VALUES (
                        %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                        %s, %s, %s, %s, %s, %s, %s, %s, %s
                    )
                    ON CONFLICT (tpms_id) DO UPDATE SET
                        feeder_no = EXCLUDED.feeder_no,
                        tag = EXCLUDED.tag,
                        rating_power = EXCLUDED.rating_power,
                        flc = EXCLUDED.flc,
                        cb_rating = EXCLUDED.cb_rating,
                        updated_at = EXCLUDED.updated_at
                """, (
                    draft.id, draft.project_id, draft.tablo_id, draft.scope_name,
                    draft.bus_section, draft.feeder_no, draft.tag, draft.designation,
                    draft.wiring_type, draft.rating_power, draft.flc, draft.module, draft.module_type,
                    draft.size, draft.cable_size, draft.cb_rating, draft.overload_rating, draft.contactor_rating,
                    draft.description, draft.revision, draft.ordering, datetime.utcnow()
                ))
                result["records_inserted"] += 1

            # Store equipment
            for equip in data.draft_equipment:
                cursor.execute("""
                    INSERT INTO view_draft_equipment (
                        draft_id, label, ecode, equipment, qty, priority, color,
                        sec_des, type_des, brand_des, shr_des, shr_des_2, scode, eng_des
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """, (
                    equip.draft_id, equip.label, equip.ecode, equip.equipment,
                    equip.qty, equip.priority, equip.color,
                    equip.sec_des, equip.type_des, equip.brand_des,
                    equip.shr_des, equip.shr_des_2, equip.scode, equip.eng_des
                ))
                result["records_inserted"] += 1

            conn.commit()
            cursor.close()
            conn.close()

            result["status"] = "success"
            logger.info(f"PostgreSQL sync: {result['records_inserted']} records")

        except Exception as e:
            logger.error(f"PostgreSQL storage failed: {e}", exc_info=True)
            result["status"] = "failed"
            result["error"] = str(e)

        return result

    # ==========================================================================
    # NEO4J GRAPH BUILDING
    # ==========================================================================

    async def _build_neo4j_graph(
        self,
        oenum: str,
        data: TPMSProjectData,
        resolved: Dict[str, Any]
    ) -> Dict[str, Any]:
        """Build Neo4j graph for the project."""
        result = {
            "status": "pending",
            "nodes_created": 0,
            "relationships_created": 0,
        }

        if not self.neo4j:
            result["status"] = "skipped"
            result["message"] = "Neo4j service not configured"
            return result

        try:
            with self.neo4j.driver.session() as session:
                # Update project node with full data
                pm = data.project_main
                session.run("""
                    MERGE (p:Project {oenum: $oenum})
                    SET p.id_project_main = $id_project_main,
                        p.project_name = $project_name,
                        p.project_name_fa = $project_name_fa,
                        p.order_category = $order_category,
                        p.oe_date = $oe_date,
                        p.project_expert = $project_expert,
                        p.technical_supervisor = $technical_supervisor,
                        p.technical_expert = $technical_expert,
                        p.sync_status = 'synced',
                        p.synced_at = datetime()
                """, {
                    "oenum": oenum,
                    "id_project_main": pm.id_project_main,
                    "project_name": pm.project_name,
                    "project_name_fa": pm.project_name_fa,
                    "order_category": pm.order_category,
                    "oe_date": pm.oe_date,
                    "project_expert": pm.project_expert_label,
                    "technical_supervisor": pm.technical_supervisor_label,
                    "technical_expert": pm.technical_expert_label,
                })
                result["nodes_created"] += 1

                # Create/Update project identity node
                if data.project_identity:
                    pi = data.project_identity
                    pi_resolved = resolved.get("project_identity", {})

                    session.run("""
                        MATCH (p:Project {oenum: $oenum})
                        MERGE (p)-[:HAS_IDENTITY]->(pi:ProjectIdentity {oenum: $oenum})
                        SET pi.delivery_date = $delivery_date,
                            pi.above_sea_level = $above_sea_level,
                            pi.average_temperature = $average_temperature,
                            pi.isolation_code = $isolation_code,
                            pi.isolation_value = $isolation_value,
                            pi.isolation_resolved = $isolation_resolved,
                            pi.plating_type_value = $plating_type_value,
                            pi.color_type_value = $color_type_value,
                            pi.wire_brand = $wire_brand,
                            pi.control_wire_brand = $control_wire_brand,
                            pi.phase_wire_color = $phase_wire_color,
                            pi.updated_at = datetime()
                    """, {
                        "oenum": oenum,
                        "delivery_date": str(pi.delivery_date) if pi.delivery_date else None,
                        "above_sea_level": pi.above_sea_level,
                        "average_temperature": pi.average_temperature,
                        "isolation_code": pi_resolved.get("isolation", ResolvedProperty()).code,
                        "isolation_value": pi_resolved.get("isolation", ResolvedProperty()).value,
                        "isolation_resolved": pi_resolved.get("isolation", ResolvedProperty()).resolved,
                        "plating_type_value": pi_resolved.get("plating_type", ResolvedProperty()).value,
                        "color_type_value": pi_resolved.get("color_type", ResolvedProperty()).value,
                        "wire_brand": pi.wire_brand,
                        "control_wire_brand": pi.control_wire_brand,
                        "phase_wire_color": pi_resolved.get("phase_wire_color", ResolvedProperty()).value,
                    })
                    result["nodes_created"] += 1

                # Create panel nodes
                for panel in data.panels:
                    panel_id = panel.id_project_scope or panel.id
                    panel_resolved = resolved.get("panels", {}).get(panel_id, {})

                    session.run("""
                        MATCH (p:Project {oenum: $oenum})
                        MERGE (p)-[:HAS_PANEL]->(panel:Panel {
                            oenum: $oenum,
                            panel_id: $panel_id
                        })
                        SET panel.plane_name = $plane_name,
                            panel.plane_type = $plane_type,
                            panel.cell_count = $cell_count,
                            panel.height = $height,
                            panel.width = $width,
                            panel.depth = $depth,
                            panel.voltage_rate = $voltage_rate,
                            panel.rated_voltage = $rated_voltage,
                            panel.frequency = $frequency,
                            panel.switch_amperage = $switch_amperage,
                            panel.main_busbar_size = $main_busbar_size,
                            panel.kabus = $kabus,
                            panel.abus = $abus,
                            panel.scm = $scm,
                            panel.ip_code = $ip_code,
                            panel.ip_value = $ip_value,
                            panel.ip_resolved = $ip_resolved,
                            panel.color_value = $color_value,
                            panel.updated_at = datetime()
                    """, {
                        "oenum": oenum,
                        "panel_id": panel_id,
                        "plane_name": panel.plane_name_1,
                        "plane_type": panel.plane_type,
                        "cell_count": panel.cell_count,
                        "height": panel.height,
                        "width": panel.width,
                        "depth": panel.depth,
                        "voltage_rate": panel.voltage_rate,
                        "rated_voltage": panel.rated_voltage,
                        "frequency": panel.frequency,
                        "switch_amperage": panel.switch_amperage,
                        "main_busbar_size": panel.main_busbar_size,
                        "kabus": panel.kabus,
                        "abus": panel.abus,
                        "scm": panel.scm,
                        "ip_code": panel_resolved.get("ip", ResolvedProperty()).code,
                        "ip_value": panel_resolved.get("ip", ResolvedProperty()).value,
                        "ip_resolved": panel_resolved.get("ip", ResolvedProperty()).resolved,
                        "color_value": panel_resolved.get("color_real", ResolvedProperty()).value,
                    })
                    result["nodes_created"] += 1
                    result["relationships_created"] += 1

                    # Create feeder nodes for this panel
                    panel_feeders = data.get_feeders_for_panel(panel_id)
                    for feeder in panel_feeders:
                        session.run("""
                            MATCH (panel:Panel {oenum: $oenum, panel_id: $panel_id})
                            MERGE (panel)-[:HAS_FEEDER]->(f:Feeder {
                                oenum: $oenum,
                                feeder_id: $feeder_id
                            })
                            SET f.feeder_no = $feeder_no,
                                f.bus_section = $bus_section,
                                f.tag = $tag,
                                f.designation = $designation,
                                f.wiring_type = $wiring_type,
                                f.rating_power = $rating_power,
                                f.flc = $flc,
                                f.cable_size = $cable_size,
                                f.cb_rating = $cb_rating,
                                f.module = $module,
                                f.module_type = $module_type,
                                f.updated_at = datetime()
                        """, {
                            "oenum": oenum,
                            "panel_id": panel_id,
                            "feeder_id": feeder.id,
                            "feeder_no": feeder.feeder_no,
                            "bus_section": feeder.bus_section,
                            "tag": feeder.tag,
                            "designation": feeder.designation,
                            "wiring_type": feeder.wiring_type,
                            "rating_power": feeder.rating_power,
                            "flc": feeder.flc,
                            "cable_size": feeder.cable_size,
                            "cb_rating": feeder.cb_rating,
                            "module": feeder.module,
                            "module_type": feeder.module_type,
                        })
                        result["nodes_created"] += 1
                        result["relationships_created"] += 1

                        # Create equipment nodes
                        feeder_equipment = data.get_equipment_for_draft(feeder.id)
                        for equip in feeder_equipment:
                            session.run("""
                                MATCH (f:Feeder {oenum: $oenum, feeder_id: $feeder_id})
                                MERGE (f)-[:HAS_EQUIPMENT]->(e:Equipment {
                                    oenum: $oenum,
                                    feeder_id: $feeder_id,
                                    ecode: $ecode
                                })
                                SET e.label = $label,
                                    e.qty = $qty,
                                    e.brand = $brand,
                                    e.eng_des = $eng_des,
                                    e.scode = $scode,
                                    e.updated_at = datetime()
                            """, {
                                "oenum": oenum,
                                "feeder_id": feeder.id,
                                "ecode": equip.ecode or f"equip_{equip.equipment}",
                                "label": equip.label,
                                "qty": equip.qty,
                                "brand": equip.brand_des,
                                "eng_des": equip.eng_des,
                                "scode": equip.scode,
                            })
                            result["nodes_created"] += 1
                            result["relationships_created"] += 1

            result["status"] = "success"
            logger.info(
                f"Neo4j sync: {result['nodes_created']} nodes, "
                f"{result['relationships_created']} relationships"
            )

        except Exception as e:
            logger.error(f"Neo4j graph building failed: {e}", exc_info=True)
            result["status"] = "failed"
            result["error"] = str(e)

        return result

    # ==========================================================================
    # MISSING DATA TRACKING
    # ==========================================================================

    def _record_missing_data(self, oenum: str, missing: List[Dict[str, Any]]):
        """Record missing data items for later resolution."""
        try:
            conn = self.db_manager._get_project_connection(oenum)
            cursor = conn.cursor()

            for item in missing:
                cursor.execute("""
                    INSERT INTO missing_data (
                        table_name, field_name, record_id, description, created_at
                    ) VALUES (%s, %s, %s, %s, %s)
                    ON CONFLICT DO NOTHING
                """, (
                    item.get("table"),
                    item.get("field"),
                    item.get("record_id"),
                    item.get("description"),
                    datetime.utcnow()
                ))

            conn.commit()
            cursor.close()
            conn.close()

            logger.info(f"Recorded {len(missing)} missing data items")

        except Exception as e:
            logger.error(f"Failed to record missing data: {e}")


# =============================================================================
# SINGLETON INSTANCE
# =============================================================================

_sync_service: Optional[ProjectSyncService] = None


def get_project_sync_service(neo4j_service=None) -> ProjectSyncService:
    """Get or create ProjectSyncService singleton."""
    global _sync_service

    if _sync_service is None:
        _sync_service = ProjectSyncService(neo4j_service=neo4j_service)
    elif neo4j_service:
        _sync_service.set_neo4j_service(neo4j_service)

    return _sync_service
