"""
Project Database Manager
========================
Manages per-project database isolation:
- PostgreSQL: One database per project (project_<oenum>)
- Qdrant: One collection per project (project_<oenum>)
- Neo4j: Subgraph per project (labeled with oenum)

Author: Simorgh Industrial Assistant
"""

import logging
import os
import re
from typing import Optional, Dict, Any, List
from datetime import datetime

import psycopg2
from psycopg2 import sql, errors as pg_errors
from psycopg2.extensions import ISOLATION_LEVEL_AUTOCOMMIT

logger = logging.getLogger(__name__)


class ProjectDatabaseManager:
    """
    Manages database isolation per project.

    Creates and manages:
    - PostgreSQL databases (one per project)
    - Qdrant collections (one per project)
    - Neo4j project subgraphs (using labels/properties)
    """

    def __init__(
        self,
        pg_host: str = None,
        pg_port: int = None,
        pg_user: str = None,
        pg_password: str = None,
        pg_admin_db: str = None,
        qdrant_service=None,
        neo4j_service=None,
    ):
        """
        Initialize with database connection parameters.

        Args:
            pg_host: PostgreSQL host
            pg_port: PostgreSQL port
            pg_user: PostgreSQL user (needs CREATE DATABASE privilege)
            pg_password: PostgreSQL password
            pg_admin_db: Admin database for creating new DBs (usually 'postgres')
            qdrant_service: Qdrant service instance
            neo4j_service: Neo4j service instance
        """
        # Use POSTGRES_AUTH_* env vars to match docker-compose postgres_auth service
        self.pg_host = pg_host or os.getenv("POSTGRES_AUTH_HOST", os.getenv("POSTGRES_HOST", "postgres_auth"))
        self.pg_port = pg_port or int(os.getenv("POSTGRES_AUTH_PORT", os.getenv("POSTGRES_PORT", "5432")))
        self.pg_user = pg_user or os.getenv("POSTGRES_AUTH_USER", os.getenv("POSTGRES_USER", "simorgh"))
        self.pg_password = pg_password or os.getenv("POSTGRES_AUTH_PASSWORD", os.getenv("POSTGRES_PASSWORD", "simorgh_secure_2024"))
        self.pg_admin_db = pg_admin_db or os.getenv("POSTGRES_AUTH_DATABASE", os.getenv("POSTGRES_ADMIN_DB", "simorgh_auth"))

        self.qdrant = qdrant_service
        self.neo4j = neo4j_service

        # Track active project databases
        self._active_projects: Dict[str, Dict[str, Any]] = {}

        logger.info("ProjectDatabaseManager initialized")

    def _sanitize_oenum(self, oenum: str) -> str:
        """
        Sanitize OENUM for use in database/collection names.
        Only allows alphanumeric and underscores.
        """
        # Remove any non-alphanumeric characters except underscore
        sanitized = re.sub(r'[^a-zA-Z0-9_]', '_', oenum.lower())
        # Ensure it doesn't start with a number
        if sanitized[0].isdigit():
            sanitized = 'p_' + sanitized
        return sanitized

    def _get_project_db_name(self, oenum: str) -> str:
        """Get PostgreSQL database name for a project."""
        return f"project_{self._sanitize_oenum(oenum)}"

    def _get_project_collection_name(self, oenum: str) -> str:
        """Get Qdrant collection name for a project."""
        return f"project_{self._sanitize_oenum(oenum)}"

    # ==========================================================================
    # POSTGRESQL DATABASE MANAGEMENT
    # ==========================================================================

    def _get_admin_connection(self):
        """Get connection to admin database for creating new databases."""
        conn = psycopg2.connect(
            host=self.pg_host,
            port=self.pg_port,
            user=self.pg_user,
            password=self.pg_password,
            dbname=self.pg_admin_db
        )
        conn.set_isolation_level(ISOLATION_LEVEL_AUTOCOMMIT)
        return conn

    def _get_project_connection(self, oenum: str):
        """Get connection to a specific project database."""
        db_name = self._get_project_db_name(oenum)
        return psycopg2.connect(
            host=self.pg_host,
            port=self.pg_port,
            user=self.pg_user,
            password=self.pg_password,
            dbname=db_name
        )

    def check_project_db_exists(self, oenum: str) -> bool:
        """Check if project database exists."""
        db_name = self._get_project_db_name(oenum)
        try:
            conn = self._get_admin_connection()
            cursor = conn.cursor()
            cursor.execute(
                "SELECT 1 FROM pg_database WHERE datname = %s",
                (db_name,)
            )
            exists = cursor.fetchone() is not None
            cursor.close()
            conn.close()
            return exists
        except Exception as e:
            logger.error(f"Error checking database existence: {e}")
            return False

    def create_project_database(self, oenum: str) -> bool:
        """
        Create a new PostgreSQL database for a project.

        Args:
            oenum: Project OENUM

        Returns:
            True if created (or already exists), False on error
        """
        db_name = self._get_project_db_name(oenum)

        try:
            # Check if already exists
            if self.check_project_db_exists(oenum):
                logger.info(f"Database {db_name} already exists")
                return True

            # Create database
            conn = self._get_admin_connection()
            cursor = conn.cursor()

            # Use sql.Identifier for safe database name
            cursor.execute(
                sql.SQL("CREATE DATABASE {} WITH ENCODING 'UTF8'").format(
                    sql.Identifier(db_name)
                )
            )

            cursor.close()
            conn.close()

            logger.info(f"Created PostgreSQL database: {db_name}")

            # Initialize schema
            self._initialize_project_schema(oenum)

            return True

        except pg_errors.DuplicateDatabase:
            logger.info(f"Database {db_name} already exists")
            return True
        except Exception as e:
            logger.error(f"Failed to create database {db_name}: {e}")
            return False

    def _initialize_project_schema(self, oenum: str):
        """Create tables in project database."""
        try:
            conn = self._get_project_connection(oenum)
            cursor = conn.cursor()

            # Create project data tables
            schema_sql = """
            -- Project main info
            CREATE TABLE IF NOT EXISTS project_main (
                id SERIAL PRIMARY KEY,
                id_project_main INTEGER UNIQUE NOT NULL,
                oenum VARCHAR(50) UNIQUE NOT NULL,
                order_category VARCHAR(100),
                oe_date VARCHAR(50),
                project_name VARCHAR(255),
                project_name_fa VARCHAR(255),
                project_expert_label VARCHAR(255),
                technical_supervisor_label VARCHAR(255),
                technical_expert_label VARCHAR(255),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                sync_status VARCHAR(20) DEFAULT 'synced'
            );

            -- Technical project identity
            CREATE TABLE IF NOT EXISTS technical_project_identity (
                id SERIAL PRIMARY KEY,
                tpms_id INTEGER UNIQUE,
                id_project_main INTEGER REFERENCES project_main(id_project_main),
                project_group_code INTEGER,
                project_group_value VARCHAR(255),
                project_group_resolved BOOLEAN DEFAULT FALSE,
                delivery_date DATE,
                above_sea_level VARCHAR(255),
                average_temperature VARCHAR(255),

                -- Packing & Isolation (code, value, resolved pattern)
                packing_type_code INTEGER,
                packing_type_value VARCHAR(255),
                packing_type_resolved BOOLEAN DEFAULT FALSE,
                isolation_code INTEGER,
                isolation_value VARCHAR(255),
                isolation_resolved BOOLEAN DEFAULT FALSE,
                isolation_type_code INTEGER,
                isolation_type_value VARCHAR(255),
                isolation_type_resolved BOOLEAN DEFAULT FALSE,

                -- Plating & Color
                plating_type_code INTEGER,
                plating_type_value VARCHAR(255),
                plating_type_resolved BOOLEAN DEFAULT FALSE,
                how_to_plating_code INTEGER,
                how_to_plating_value VARCHAR(255),
                how_to_plating_resolved BOOLEAN DEFAULT FALSE,
                color_type_code INTEGER,
                color_type_value VARCHAR(255),
                color_type_resolved BOOLEAN DEFAULT FALSE,
                color_thickness_code INTEGER,
                color_thickness_value VARCHAR(255),
                color_thickness_resolved BOOLEAN DEFAULT FALSE,

                -- Wire sizes (code, value, resolved)
                control_wire_size_code INTEGER,
                control_wire_size_value VARCHAR(255),
                control_wire_size_resolved BOOLEAN DEFAULT FALSE,
                ct_wire_size_code INTEGER,
                ct_wire_size_value VARCHAR(255),
                ct_wire_size_resolved BOOLEAN DEFAULT FALSE,
                pt_wire_size_code INTEGER,
                pt_wire_size_value VARCHAR(255),
                pt_wire_size_resolved BOOLEAN DEFAULT FALSE,

                -- Wire colors (code, value, resolved)
                phase_wire_color_code INTEGER,
                phase_wire_color_value VARCHAR(255),
                phase_wire_color_resolved BOOLEAN DEFAULT FALSE,
                neutral_wire_color_code INTEGER,
                neutral_wire_color_value VARCHAR(255),
                neutral_wire_color_resolved BOOLEAN DEFAULT FALSE,
                dc_plus_wire_color_code INTEGER,
                dc_plus_wire_color_value VARCHAR(255),
                dc_plus_wire_color_resolved BOOLEAN DEFAULT FALSE,
                dc_minus_wire_color_code INTEGER,
                dc_minus_wire_color_value VARCHAR(255),
                dc_minus_wire_color_resolved BOOLEAN DEFAULT FALSE,

                -- Brands
                wire_brand VARCHAR(255),
                control_wire_brand VARCHAR(255),

                -- Metadata
                type INTEGER,
                finished INTEGER,
                usr_username VARCHAR(255),
                date_created TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- Technical project identity additional fields
            CREATE TABLE IF NOT EXISTS technical_project_identity_additional_field (
                id SERIAL PRIMARY KEY,
                tpms_id INTEGER UNIQUE,
                id_technical_project_identity INTEGER,
                id_project_main INTEGER,
                field_title VARCHAR(255),
                field_descriptions TEXT,
                date_u TIMESTAMP,
                status INTEGER,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- Technical panel identity
            CREATE TABLE IF NOT EXISTS technical_panel_identity (
                id SERIAL PRIMARY KEY,
                tpms_id INTEGER UNIQUE,
                id_project_main INTEGER REFERENCES project_main(id_project_main),
                id_project_scope INTEGER,  -- Panel ID
                product_type_label VARCHAR(255),

                -- Panel basic info
                plane_name VARCHAR(500),
                plane_type VARCHAR(255),
                cell_count INTEGER,

                -- Dimensions (increased to handle longer descriptions)
                height VARCHAR(255),
                width VARCHAR(255),
                depth VARCHAR(255),

                -- Electrical ratings (increased to handle remark descriptions)
                voltage_rate VARCHAR(255),
                rated_voltage VARCHAR(255),
                switch_amperage VARCHAR(255),
                frequency INTEGER DEFAULT 50,

                -- Busbar (increased to handle longer values)
                kabus VARCHAR(255),
                abus VARCHAR(255),
                main_busbar_size VARCHAR(255),
                earth_size VARCHAR(255),
                neutral_size VARCHAR(255),
                type_busbar INTEGER,

                -- Short circuit
                scm VARCHAR(255),
                cpcts VARCHAR(255),
                plsh VARCHAR(255),
                msh VARCHAR(255),

                -- Resolved properties (code, value, resolved pattern)
                layout_type_code INTEGER,
                layout_type_value VARCHAR(255),
                layout_type_resolved BOOLEAN DEFAULT FALSE,
                ip_code INTEGER,
                ip_value VARCHAR(255),
                ip_resolved BOOLEAN DEFAULT FALSE,
                access_from_code INTEGER,
                access_from_value VARCHAR(255),
                access_from_resolved BOOLEAN DEFAULT FALSE,
                inlet_contact_code INTEGER,
                inlet_contact_value VARCHAR(255),
                inlet_contact_resolved BOOLEAN DEFAULT FALSE,
                outlet_contact_code INTEGER,
                outlet_contact_value VARCHAR(255),
                outlet_contact_resolved BOOLEAN DEFAULT FALSE,
                color_real_code INTEGER,
                color_real_value VARCHAR(255),
                color_real_resolved BOOLEAN DEFAULT FALSE,
                isolation_code INTEGER,
                isolation_value VARCHAR(255),
                isolation_resolved BOOLEAN DEFAULT FALSE,
                isolation_type_code INTEGER,
                isolation_type_value VARCHAR(255),
                isolation_type_resolved BOOLEAN DEFAULT FALSE,
                plating_type_code INTEGER,
                plating_type_value VARCHAR(255),
                plating_type_resolved BOOLEAN DEFAULT FALSE,

                -- Metadata
                revision INTEGER DEFAULT 0,
                usr_username VARCHAR(255),
                date_created TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- Technical panel identity additional fields
            CREATE TABLE IF NOT EXISTS technical_panel_identity_additional_field (
                id SERIAL PRIMARY KEY,
                tpms_id INTEGER UNIQUE,
                id_technical_panel_identity INTEGER,
                id_project_main INTEGER,
                id_project_scope INTEGER,
                field_title VARCHAR(255),
                field_descriptions TEXT,
                date_u TIMESTAMP,
                status INTEGER,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- Feeder/Draft list
            CREATE TABLE IF NOT EXISTS view_draft (
                id SERIAL PRIMARY KEY,
                tpms_id INTEGER UNIQUE,
                project_id INTEGER,
                tablo_id INTEGER,  -- Panel ID (id_project_scope)
                tmp_id INTEGER,
                scope_name VARCHAR(500),

                -- Feeder identification
                bus_section VARCHAR(255),
                feeder_no VARCHAR(255),
                tag VARCHAR(255),
                designation VARCHAR(500),

                -- Feeder specifications
                wiring_type VARCHAR(255),
                rating_power VARCHAR(255),
                flc VARCHAR(255),  -- Full Load Current
                module VARCHAR(255),
                module_type VARCHAR(255),
                size VARCHAR(255),
                cable_size VARCHAR(255),

                -- Protection
                cb_rating VARCHAR(255),
                overload_rating VARCHAR(255),
                contactor_rating VARCHAR(255),

                -- Additional
                sfd_hfd VARCHAR(255),
                template_name VARCHAR(255),
                description TEXT,
                revision INTEGER,
                ordering INTEGER DEFAULT 0,

                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- Draft equipment
            CREATE TABLE IF NOT EXISTS view_draft_equipment (
                id SERIAL PRIMARY KEY,
                draft_id INTEGER REFERENCES view_draft(tpms_id),
                label VARCHAR(500),
                ecode VARCHAR(255),
                equipment INTEGER,
                qty INTEGER,
                priority INTEGER,
                color VARCHAR(255),

                -- Equipment details
                sec_des VARCHAR(500),
                type_des VARCHAR(500),
                brand_des VARCHAR(500),
                shr_des TEXT,
                shr_des_2 TEXT,
                scode VARCHAR(255),
                eng_des TEXT,

                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- Draft columns (brand mapping)
            CREATE TABLE IF NOT EXISTS view_draft_column (
                id SERIAL PRIMARY KEY,
                tpms_id INTEGER UNIQUE,
                level INTEGER,
                name VARCHAR(255),
                project_id INTEGER,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- Project documents
            CREATE TABLE IF NOT EXISTS project_documents (
                id SERIAL PRIMARY KEY,
                document_id VARCHAR(100) UNIQUE,
                filename VARCHAR(255),
                category VARCHAR(100),
                content_hash VARCHAR(64),
                upload_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                processed BOOLEAN DEFAULT FALSE,
                chunks_created INTEGER DEFAULT 0,
                entities_extracted INTEGER DEFAULT 0
            );

            -- Missing data tracking
            CREATE TABLE IF NOT EXISTS missing_data (
                id SERIAL PRIMARY KEY,
                table_name VARCHAR(100),
                field_name VARCHAR(100),
                record_id INTEGER,
                description TEXT,
                resolution_source VARCHAR(50),  -- 'user', 'document', 'inferred'
                resolved BOOLEAN DEFAULT FALSE,
                resolved_value TEXT,
                resolved_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- Sync log
            CREATE TABLE IF NOT EXISTS sync_log (
                id SERIAL PRIMARY KEY,
                sync_type VARCHAR(50),  -- 'full', 'incremental'
                started_at TIMESTAMP,
                completed_at TIMESTAMP,
                records_synced INTEGER DEFAULT 0,
                records_updated INTEGER DEFAULT 0,
                errors TEXT[],
                status VARCHAR(20)  -- 'success', 'partial', 'failed'
            );

            -- Create indexes
            CREATE INDEX IF NOT EXISTS idx_project_main_oenum ON project_main(oenum);
            CREATE INDEX IF NOT EXISTS idx_panel_project_scope ON technical_panel_identity(id_project_scope);
            CREATE INDEX IF NOT EXISTS idx_draft_tablo ON view_draft(tablo_id);
            CREATE INDEX IF NOT EXISTS idx_equipment_draft ON view_draft_equipment(draft_id);
            """

            cursor.execute(schema_sql)
            conn.commit()

            cursor.close()
            conn.close()

            logger.info(f"Initialized schema for project {oenum}")

        except Exception as e:
            logger.error(f"Failed to initialize schema: {e}")
            raise

    def delete_project_database(self, oenum: str) -> bool:
        """Delete a project database (USE WITH CAUTION)."""
        db_name = self._get_project_db_name(oenum)

        try:
            conn = self._get_admin_connection()
            cursor = conn.cursor()

            # Terminate existing connections
            cursor.execute("""
                SELECT pg_terminate_backend(pg_stat_activity.pid)
                FROM pg_stat_activity
                WHERE pg_stat_activity.datname = %s
                AND pid <> pg_backend_pid()
            """, (db_name,))

            # Drop database
            cursor.execute(
                sql.SQL("DROP DATABASE IF EXISTS {}").format(
                    sql.Identifier(db_name)
                )
            )

            cursor.close()
            conn.close()

            logger.warning(f"Deleted PostgreSQL database: {db_name}")
            return True

        except Exception as e:
            logger.error(f"Failed to delete database {db_name}: {e}")
            return False

    # ==========================================================================
    # QDRANT COLLECTION MANAGEMENT
    # ==========================================================================

    def check_project_collection_exists(self, oenum: str) -> bool:
        """Check if Qdrant collection exists for project."""
        if not self.qdrant:
            logger.warning("Qdrant service not configured")
            return False

        collection_name = self._get_project_collection_name(oenum)
        try:
            collections = self.qdrant.client.get_collections()
            return any(c.name == collection_name for c in collections.collections)
        except Exception as e:
            logger.error(f"Error checking Qdrant collection: {e}")
            return False

    def create_project_collection(self, oenum: str, vector_size: int = 1536) -> bool:
        """
        Create Qdrant collection for a project.

        Args:
            oenum: Project OENUM
            vector_size: Embedding dimension (default: 1536 for OpenAI)

        Returns:
            True if created, False on error
        """
        if not self.qdrant:
            logger.warning("Qdrant service not configured")
            return False

        collection_name = self._get_project_collection_name(oenum)

        try:
            # Check if exists
            if self.check_project_collection_exists(oenum):
                logger.info(f"Qdrant collection {collection_name} already exists")
                return True

            # Create collection
            from qdrant_client.models import Distance, VectorParams

            self.qdrant.client.create_collection(
                collection_name=collection_name,
                vectors_config=VectorParams(
                    size=vector_size,
                    distance=Distance.COSINE
                )
            )

            logger.info(f"Created Qdrant collection: {collection_name}")
            return True

        except Exception as e:
            logger.error(f"Failed to create Qdrant collection: {e}")
            return False

    def delete_project_collection(self, oenum: str) -> bool:
        """Delete Qdrant collection for a project."""
        if not self.qdrant:
            return False

        collection_name = self._get_project_collection_name(oenum)

        try:
            self.qdrant.client.delete_collection(collection_name)
            logger.warning(f"Deleted Qdrant collection: {collection_name}")
            return True
        except Exception as e:
            logger.error(f"Failed to delete Qdrant collection: {e}")
            return False

    # ==========================================================================
    # NEO4J SUBGRAPH MANAGEMENT
    # ==========================================================================

    def check_project_graph_exists(self, oenum: str) -> bool:
        """Check if Neo4j project node exists."""
        if not self.neo4j:
            logger.warning("Neo4j service not configured")
            return False

        try:
            with self.neo4j.driver.session() as session:
                result = session.run(
                    "MATCH (p:Project {oenum: $oenum}) RETURN p",
                    oenum=oenum
                )
                return result.single() is not None
        except Exception as e:
            logger.error(f"Error checking Neo4j project: {e}")
            return False

    def create_project_graph(self, oenum: str, project_name: str) -> bool:
        """
        Create Neo4j project root node and base structure.

        Args:
            oenum: Project OENUM
            project_name: Project name

        Returns:
            True if created, False on error
        """
        if not self.neo4j:
            logger.warning("Neo4j service not configured")
            return False

        try:
            with self.neo4j.driver.session() as session:
                # Create project node with comprehensive structure
                session.run("""
                    MERGE (p:Project {oenum: $oenum})
                    ON CREATE SET
                        p.project_name = $project_name,
                        p.created_at = datetime(),
                        p.sync_status = 'pending'
                    ON MATCH SET
                        p.updated_at = datetime()

                    // Create Identity container
                    MERGE (p)-[:HAS_IDENTITY]->(pi:ProjectIdentity {oenum: $oenum})
                    ON CREATE SET pi.created_at = datetime()

                    // Create Panels container
                    MERGE (p)-[:HAS_PANELS]->(panels:PanelsContainer {oenum: $oenum})
                    ON CREATE SET panels.created_at = datetime()

                    // Create Documents container
                    MERGE (p)-[:HAS_DOCUMENTS]->(docs:DocumentsContainer {oenum: $oenum})
                    ON CREATE SET docs.created_at = datetime()

                    // Create Missing Data tracker
                    MERGE (p)-[:HAS_MISSING_DATA]->(md:MissingDataTracker {oenum: $oenum})
                    ON CREATE SET md.created_at = datetime()
                """, oenum=oenum, project_name=project_name)

            logger.info(f"Created Neo4j project graph for: {oenum}")
            return True

        except Exception as e:
            logger.error(f"Failed to create Neo4j project graph: {e}")
            return False

    def delete_project_graph(self, oenum: str) -> bool:
        """Delete all Neo4j nodes for a project (USE WITH CAUTION)."""
        if not self.neo4j:
            return False

        try:
            with self.neo4j.driver.session() as session:
                # Delete all nodes connected to project
                session.run("""
                    MATCH (p:Project {oenum: $oenum})
                    OPTIONAL MATCH (p)-[*]->(n)
                    DETACH DELETE n, p
                """, oenum=oenum)

            logger.warning(f"Deleted Neo4j project graph for: {oenum}")
            return True

        except Exception as e:
            logger.error(f"Failed to delete Neo4j project graph: {e}")
            return False

    # ==========================================================================
    # UNIFIED PROJECT MANAGEMENT
    # ==========================================================================

    def initialize_project(self, oenum: str, project_name: str) -> Dict[str, bool]:
        """
        Initialize all databases for a project.

        Creates:
        - PostgreSQL database with schema
        - Qdrant collection
        - Neo4j project graph

        Args:
            oenum: Project OENUM
            project_name: Project name

        Returns:
            Dict with status for each database type
        """
        results = {
            "postgresql": False,
            "qdrant": False,
            "neo4j": False
        }

        # Create PostgreSQL database
        try:
            results["postgresql"] = self.create_project_database(oenum)
        except Exception as e:
            logger.error(f"PostgreSQL initialization failed: {e}")

        # Create Qdrant collection
        try:
            results["qdrant"] = self.create_project_collection(oenum)
        except Exception as e:
            logger.error(f"Qdrant initialization failed: {e}")

        # Create Neo4j graph
        try:
            results["neo4j"] = self.create_project_graph(oenum, project_name)
        except Exception as e:
            logger.error(f"Neo4j initialization failed: {e}")

        # Track active project
        self._active_projects[oenum] = {
            "initialized_at": datetime.utcnow(),
            "status": results
        }

        logger.info(f"Project {oenum} initialization: {results}")
        return results

    def select_project(self, oenum: str, project_name: str = None) -> Dict[str, Any]:
        """
        Select/activate a project, initializing if needed.

        Args:
            oenum: Project OENUM
            project_name: Project name (needed if creating new)

        Returns:
            Dict with project status and connection info
        """
        # Check if already initialized
        pg_exists = self.check_project_db_exists(oenum)
        qdrant_exists = self.check_project_collection_exists(oenum)
        neo4j_exists = self.check_project_graph_exists(oenum)

        # Initialize if any component is missing
        if not all([pg_exists, qdrant_exists, neo4j_exists]):
            logger.info(f"Initializing missing components for project {oenum}")
            init_results = self.initialize_project(oenum, project_name or oenum)
        else:
            init_results = {
                "postgresql": True,
                "qdrant": True,
                "neo4j": True
            }

        return {
            "oenum": oenum,
            "project_name": project_name,
            "postgresql_db": self._get_project_db_name(oenum),
            "qdrant_collection": self._get_project_collection_name(oenum),
            "status": init_results,
            "all_ready": all(init_results.values())
        }

    def delete_project(self, oenum: str) -> Dict[str, Any]:
        """
        Delete ALL project data from ALL databases.

        WARNING: This is a destructive operation that cannot be undone!

        Deletes:
        - PostgreSQL database (project_<oenum>)
        - Qdrant collection (project_<oenum>)
        - Neo4j project subgraph (all nodes connected to project)

        Args:
            oenum: Project OENUM to delete

        Returns:
            Dict with deletion status for each database type
        """
        results = {
            "postgresql": False,
            "qdrant": False,
            "neo4j": False,
            "errors": []
        }

        logger.warning(f"DELETING ALL DATA for project {oenum}")

        # Delete PostgreSQL database
        try:
            results["postgresql"] = self.delete_project_database(oenum)
            if results["postgresql"]:
                logger.info(f"Deleted PostgreSQL database for {oenum}")
        except Exception as e:
            error_msg = f"PostgreSQL deletion failed: {e}"
            logger.error(error_msg)
            results["errors"].append(error_msg)

        # Delete Qdrant collection
        try:
            results["qdrant"] = self.delete_project_collection(oenum)
            if results["qdrant"]:
                logger.info(f"Deleted Qdrant collection for {oenum}")
        except Exception as e:
            error_msg = f"Qdrant deletion failed: {e}"
            logger.error(error_msg)
            results["errors"].append(error_msg)

        # Delete Neo4j graph
        try:
            results["neo4j"] = self.delete_project_graph(oenum)
            if results["neo4j"]:
                logger.info(f"Deleted Neo4j graph for {oenum}")
        except Exception as e:
            error_msg = f"Neo4j deletion failed: {e}"
            logger.error(error_msg)
            results["errors"].append(error_msg)

        # Remove from active projects tracking
        if oenum in self._active_projects:
            del self._active_projects[oenum]

        # Determine overall success
        results["success"] = all([
            results["postgresql"],
            results["qdrant"] or not self.qdrant,  # OK if Qdrant not configured
            results["neo4j"] or not self.neo4j     # OK if Neo4j not configured
        ])

        logger.warning(f"Project {oenum} deletion results: {results}")
        return results

    def list_project_databases(self) -> List[str]:
        """
        List all project databases in PostgreSQL.

        Returns:
            List of OENUM values for existing project databases
        """
        try:
            conn = self._get_admin_connection()
            cursor = conn.cursor()

            cursor.execute("""
                SELECT datname FROM pg_database
                WHERE datname LIKE 'project_%'
                ORDER BY datname
            """)

            databases = [row[0] for row in cursor.fetchall()]
            cursor.close()
            conn.close()

            # Extract OENUM from database names
            oenumsdata = []
            for db_name in databases:
                # Remove 'project_' prefix and handle 'p_' prefix for numeric OENUMs
                oenum = db_name.replace('project_', '')
                if oenum.startswith('p_'):
                    oenum = oenum[2:]
                oenumsdata.append(oenum)

            return oenumsdata

        except Exception as e:
            logger.error(f"Error listing project databases: {e}")
            return []


# =============================================================================
# SINGLETON INSTANCE
# =============================================================================

_db_manager: Optional[ProjectDatabaseManager] = None


def get_project_database_manager(
    qdrant_service=None,
    neo4j_service=None
) -> ProjectDatabaseManager:
    """Get or create ProjectDatabaseManager singleton."""
    global _db_manager

    if _db_manager is None:
        _db_manager = ProjectDatabaseManager(
            qdrant_service=qdrant_service,
            neo4j_service=neo4j_service
        )
    elif qdrant_service or neo4j_service:
        # Update services if provided
        if qdrant_service:
            _db_manager.qdrant = qdrant_service
        if neo4j_service:
            _db_manager.neo4j = neo4j_service

    return _db_manager
