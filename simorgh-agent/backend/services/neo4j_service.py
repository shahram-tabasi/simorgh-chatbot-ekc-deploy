"""
Neo4j Service with Project Isolation
=====================================
Manages knowledge graph with strict project isolation using BELONGS_TO_PROJECT relationships.
Each project has a root Project node, and all entities must connect to it.

Author: Simorgh Industrial Assistant
"""

import os
import logging
import json
from typing import List, Dict, Any, Optional, Tuple
from datetime import datetime
from neo4j import GraphDatabase, Driver, Session
from neo4j.exceptions import ServiceUnavailable, Neo4jError

logger = logging.getLogger(__name__)


class Neo4jService:
    """
    Neo4j Graph Database Service with Project Isolation

    Key Features:
    - Every entity MUST have [:BELONGS_TO_PROJECT] relationship
    - Project-scoped queries automatically filter by project_number
    - Cypher query helpers for common patterns
    - Connection pooling and health checks
    """

    def __init__(
        self,
        uri: str = None,
        user: str = None,
        password: str = None
    ):
        """Initialize Neo4j connection"""
        self.uri = uri or os.getenv("NEO4J_URI", "bolt://localhost:7687")
        self.user = user or os.getenv("NEO4J_USER", "neo4j")
        self.password = password or os.getenv("NEO4J_PASSWORD", "password")

        self.driver: Optional[Driver] = None
        self._connect()

    def _connect(self):
        """Establish connection to Neo4j"""
        try:
            self.driver = GraphDatabase.driver(
                self.uri,
                auth=(self.user, self.password),
                max_connection_lifetime=3600,
                max_connection_pool_size=50,
                connection_acquisition_timeout=60
            )
            # Verify connectivity
            self.driver.verify_connectivity()
            logger.info(f"✅ Connected to Neo4j at {self.uri}")
        except ServiceUnavailable as e:
            logger.error(f"❌ Neo4j connection failed: {e}")
            raise

    def close(self):
        """Close driver connection"""
        if self.driver:
            self.driver.close()
            logger.info("Neo4j connection closed")

    def health_check(self) -> Dict[str, Any]:
        """Check Neo4j health and return statistics"""
        try:
            with self.driver.session() as session:
                result = session.run("CALL dbms.components() YIELD name, versions, edition")
                component = result.single()

                # Get database stats
                stats_result = session.run("""
                    MATCH (n)
                    RETURN count(n) as node_count
                """)
                node_count = stats_result.single()["node_count"]

                return {
                    "status": "healthy",
                    "neo4j_version": component["versions"][0],
                    "edition": component["edition"],
                    "node_count": node_count,
                    "uri": self.uri
                }
        except Exception as e:
            logger.error(f"Health check failed: {e}")
            return {
                "status": "unhealthy",
                "error": str(e)
            }

    # =========================================================================
    # PROJECT MANAGEMENT
    # =========================================================================

    def create_project(
        self,
        project_number: str,
        project_name: str,
        owner_id: str,
        client: str = "",
        contract_number: str = "",
        contract_date: str = "",
        description: str = "",
        metadata: Dict[str, Any] = None
    ) -> Dict[str, Any]:
        """
        Create a new Project node - the root of all project entities

        Args:
            project_number: Unique project identifier (e.g., "P-2024-001")
            project_name: Human-readable project name
            owner_id: Username of the project owner
            client: Client company name
            contract_number: Contract reference
            contract_date: Contract signing date (ISO format)
            description: Project description
            metadata: Additional project metadata (will be stored as JSON string)

        Returns:
            Created project node properties
        """
        with self.driver.session() as session:
            # Convert metadata dict to JSON string (Neo4j doesn't support Map{} as property)
            metadata_json = json.dumps(metadata) if metadata else "{}"

            query = """
            MERGE (p:Project {project_number: $project_number})
            ON CREATE SET
                p.project_name = $project_name,
                p.owner_id = $owner_id,
                p.client = $client,
                p.contract_number = $contract_number,
                p.contract_date = $contract_date,
                p.description = $description,
                p.created_at = datetime(),
                p.updated_at = datetime(),
                p.metadata_json = $metadata_json
            ON MATCH SET
                p.updated_at = datetime()
            RETURN p
            """

            result = session.run(query, {
                "project_number": project_number,
                "project_name": project_name,
                "owner_id": owner_id,
                "client": client,
                "contract_number": contract_number,
                "contract_date": contract_date,
                "description": description,
                "metadata_json": metadata_json
            })

            project = result.single()["p"]
            logger.info(f"✅ Project created/updated: {project_number} (owner: {owner_id})")

            # Initialize full project graph structure (categories, document types, etc.)
            from services.project_graph_init import ProjectGraphInitializer
            graph_init = ProjectGraphInitializer(self.driver)
            init_result = graph_init.initialize_project_structure(
                project_oenum=project_number,
                project_name=project_name
            )
            logger.info(f"📊 Graph structure initialized: {init_result}")

            # Convert result to dict and parse metadata_json back to dict for response
            project_dict = dict(project)
            if 'metadata_json' in project_dict and project_dict['metadata_json']:
                try:
                    project_dict['metadata'] = json.loads(project_dict['metadata_json'])
                    del project_dict['metadata_json']
                except json.JSONDecodeError:
                    project_dict['metadata'] = {}

            return project_dict

    def get_project(self, project_number: str) -> Optional[Dict[str, Any]]:
        """Get project node by project_number"""
        with self.driver.session() as session:
            query = """
            MATCH (p:Project {project_number: $project_number})
            RETURN p
            """
            result = session.run(query, {"project_number": project_number})
            record = result.single()

            if record:
                return dict(record["p"])
            return None

    def get_project_stats(self, project_number: str) -> Dict[str, Any]:
        """Get statistics for a project's knowledge graph"""
        with self.driver.session() as session:
            query = """
            MATCH (p:Project {project_number: $project_number})
            OPTIONAL MATCH (p)<-[:BELONGS_TO_PROJECT]-(entity)
            WITH p, count(entity) as entity_count, labels(entity) as entity_labels
            UNWIND entity_labels as label
            RETURN
                p.project_number as project_number,
                p.project_name as project_name,
                entity_count,
                collect(DISTINCT label) as entity_types
            """
            result = session.run(query, {"project_number": project_number})
            record = result.single()

            if record:
                return {
                    "project_number": record["project_number"],
                    "project_name": record["project_name"],
                    "total_entities": record["entity_count"],
                    "entity_types": [t for t in record["entity_types"] if t != "Project"]
                }
            return {}

    def list_all_projects(self, owner_id: Optional[str] = None) -> List[Dict[str, Any]]:
        """
        List all projects in the database

        Args:
            owner_id: If provided, filter projects by owner. If None, return all projects.

        Returns:
            List of project dictionaries with entity counts
        """
        with self.driver.session() as session:
            if owner_id:
                query = """
                MATCH (p:Project {owner_id: $owner_id})
                OPTIONAL MATCH (p)<-[:BELONGS_TO_PROJECT]-(entity)
                WITH p, count(entity) as entity_count
                RETURN p, entity_count
                ORDER BY p.created_at DESC
                """
                result = session.run(query, {"owner_id": owner_id})
            else:
                query = """
                MATCH (p:Project)
                OPTIONAL MATCH (p)<-[:BELONGS_TO_PROJECT]-(entity)
                WITH p, count(entity) as entity_count
                RETURN p, entity_count
                ORDER BY p.created_at DESC
                """
                result = session.run(query)

            projects = []
            for record in result:
                project = dict(record["p"])
                project["entity_count"] = record["entity_count"]
                projects.append(project)

            return projects

    def check_duplicate_project(self, owner_id: str, project_name: str) -> bool:
        """
        Check if a project with the same name already exists for this owner

        Args:
            owner_id: Username of the project owner
            project_name: Project name to check

        Returns:
            True if duplicate exists, False otherwise
        """
        with self.driver.session() as session:
            query = """
            MATCH (p:Project {owner_id: $owner_id})
            WHERE toLower(p.project_name) = toLower($project_name)
            RETURN count(p) > 0 as exists
            """
            result = session.run(query, {
                "owner_id": owner_id,
                "project_name": project_name
            })
            record = result.single()
            return record["exists"] if record else False

    def delete_project(self, project_number: str, owner_id: str) -> bool:
        """
        Delete a project and all its related entities

        Args:
            project_number: Project identifier to delete
            owner_id: Username of the project owner (for authorization)

        Returns:
            True if project was deleted, False if not found or not authorized
        """
        with self.driver.session() as session:
            # First verify ownership
            verify_query = """
            MATCH (p:Project {project_number: $project_number, owner_id: $owner_id})
            RETURN p
            """
            result = session.run(verify_query, {
                "project_number": project_number,
                "owner_id": owner_id
            })

            if not result.single():
                logger.warning(f"⚠️ Project {project_number} not found or access denied for user {owner_id}")
                return False

            # Delete project and all related entities
            delete_query = """
            MATCH (p:Project {project_number: $project_number, owner_id: $owner_id})
            OPTIONAL MATCH (p)<-[:BELONGS_TO_PROJECT]-(entity)
            DETACH DELETE entity, p
            RETURN count(p) as deleted_count
            """

            result = session.run(delete_query, {
                "project_number": project_number,
                "owner_id": owner_id
            })

            record = result.single()
            deleted = record["deleted_count"] > 0 if record else False

            if deleted:
                logger.info(f"✅ Project deleted: {project_number} (owner: {owner_id})")

            return deleted

    # =========================================================================
    # ENTITY MANAGEMENT (with Project Isolation)
    # =========================================================================

    def create_entity(
        self,
        project_number: str,
        entity_type: str,
        entity_id: str,
        properties: Dict[str, Any]
    ) -> Dict[str, Any]:
        """
        Create an entity and link it to its project

        Args:
            project_number: Project this entity belongs to
            entity_type: Node label (Panel, Transformer, Load, etc.)
            entity_id: Unique identifier for this entity
            properties: Entity properties

        Returns:
            Created entity properties
        """
        with self.driver.session() as session:
            # Ensure project exists
            self.create_project(project_number, f"Project {project_number}")

            query = f"""
            MATCH (proj:Project {{project_number: $project_number}})
            MERGE (e:{entity_type} {{entity_id: $entity_id, project_number: $project_number}})
            ON CREATE SET
                e += $properties,
                e.created_at = datetime()
            ON MATCH SET
                e += $properties,
                e.updated_at = datetime()
            MERGE (e)-[:BELONGS_TO_PROJECT]->(proj)
            RETURN e
            """

            result = session.run(query, {
                "project_number": project_number,
                "entity_id": entity_id,
                "properties": properties
            })

            entity = result.single()["e"]
            logger.info(f"✅ Entity created: {entity_type}:{entity_id} in project {project_number}")
            return dict(entity)

    def get_entity(
        self,
        project_number: str,
        entity_id: str
    ) -> Optional[Dict[str, Any]]:
        """Get an entity by ID within a project"""
        with self.driver.session() as session:
            query = """
            MATCH (e {entity_id: $entity_id, project_number: $project_number})
            RETURN e, labels(e) as labels
            """
            result = session.run(query, {
                "project_number": project_number,
                "entity_id": entity_id
            })
            record = result.single()

            if record:
                entity = dict(record["e"])
                entity["labels"] = record["labels"]
                return entity
            return None

    def create_relationship(
        self,
        project_number: str,
        from_entity_id: str,
        to_entity_id: str,
        relationship_type: str,
        properties: Dict[str, Any] = None
    ) -> bool:
        """
        Create a relationship between two entities in the same project

        Args:
            project_number: Project context
            from_entity_id: Source entity ID
            to_entity_id: Target entity ID
            relationship_type: Relationship label (SUPPLIES, FEEDS, PROTECTS, etc.)
            properties: Optional relationship properties

        Returns:
            True if successful
        """
        with self.driver.session() as session:
            query = f"""
            MATCH (from {{entity_id: $from_id, project_number: $project_number}})
            MATCH (to {{entity_id: $to_id, project_number: $project_number}})
            MERGE (from)-[r:{relationship_type}]->(to)
            SET r += $properties,
                r.created_at = coalesce(r.created_at, datetime())
            RETURN r
            """

            result = session.run(query, {
                "project_number": project_number,
                "from_id": from_entity_id,
                "to_id": to_entity_id,
                "properties": properties or {}
            })

            if result.single():
                logger.info(f"✅ Relationship created: {from_entity_id} -[{relationship_type}]-> {to_entity_id}")
                return True
            return False

    def get_entity_neighborhood(
        self,
        project_number: str,
        entity_id: str,
        depth: int = 1
    ) -> Dict[str, Any]:
        """
        Get entity with its connected neighbors up to specified depth

        Args:
            project_number: Project context
            entity_id: Entity to explore
            depth: How many hops to traverse (1-3 recommended)

        Returns:
            Graph structure with nodes and relationships
        """
        with self.driver.session() as session:
            query = """
            MATCH path = (e {entity_id: $entity_id, project_number: $project_number})
                         -[*1..{depth}]-(neighbor)
            WHERE neighbor.project_number = $project_number
            RETURN
                nodes(path) as nodes,
                relationships(path) as relationships
            LIMIT 100
            """.replace("{depth}", str(depth))

            result = session.run(query, {
                "project_number": project_number,
                "entity_id": entity_id
            })

            nodes = []
            relationships = []

            for record in result:
                for node in record["nodes"]:
                    node_dict = dict(node)
                    node_dict["labels"] = list(node.labels)
                    if node_dict not in nodes:
                        nodes.append(node_dict)

                for rel in record["relationships"]:
                    rel_dict = {
                        "type": rel.type,
                        "properties": dict(rel),
                        "start_node": rel.start_node["entity_id"],
                        "end_node": rel.end_node["entity_id"]
                    }
                    if rel_dict not in relationships:
                        relationships.append(rel_dict)

            return {
                "center_entity": entity_id,
                "nodes": nodes,
                "relationships": relationships,
                "depth": depth
            }

    # =========================================================================
    # GRAPH QUERIES
    # =========================================================================

    def find_power_path(
        self,
        project_number: str,
        from_entity_id: str,
        to_entity_id: str
    ) -> List[Dict[str, Any]]:
        """
        Find power flow path between two entities (e.g., Transformer -> Panel -> Load)

        Returns:
            List of paths with nodes and relationships
        """
        with self.driver.session() as session:
            query = """
            MATCH path = shortestPath(
                (from {entity_id: $from_id, project_number: $project_number})
                -[:SUPPLIES|FEEDS*1..10]-
                (to {entity_id: $to_id, project_number: $project_number})
            )
            RETURN
                [node IN nodes(path) | {
                    id: node.entity_id,
                    type: labels(node),
                    properties: properties(node)
                }] as nodes,
                [rel IN relationships(path) | {
                    type: type(rel),
                    properties: properties(rel)
                }] as relationships
            LIMIT 5
            """

            result = session.run(query, {
                "project_number": project_number,
                "from_id": from_entity_id,
                "to_id": to_entity_id
            })

            paths = []
            for record in result:
                paths.append({
                    "nodes": record["nodes"],
                    "relationships": record["relationships"]
                })

            return paths

    def semantic_search(
        self,
        project_number: str,
        entity_type: Optional[str] = None,
        filters: Dict[str, Any] = None,
        limit: int = 20
    ) -> List[Dict[str, Any]]:
        """
        Search entities within a project with optional filters

        Args:
            project_number: Project context
            entity_type: Filter by entity type (e.g., "Panel", "Transformer")
            filters: Property filters (e.g., {"voltage": 400, "current_rating__gte": 100})
            limit: Max results

        Returns:
            List of matching entities
        """
        with self.driver.session() as session:
            # Build dynamic query
            type_filter = f":{entity_type}" if entity_type else ""

            where_clauses = ["e.project_number = $project_number"]
            params = {"project_number": project_number, "limit": limit}

            if filters:
                for key, value in filters.items():
                    if "__gte" in key:
                        prop = key.replace("__gte", "")
                        where_clauses.append(f"e.{prop} >= ${prop}")
                        params[prop] = value
                    elif "__lte" in key:
                        prop = key.replace("__lte", "")
                        where_clauses.append(f"e.{prop} <= ${prop}")
                        params[prop] = value
                    else:
                        where_clauses.append(f"e.{key} = ${key}")
                        params[key] = value

            where_clause = " AND ".join(where_clauses)

            query = f"""
            MATCH (e{type_filter})
            WHERE {where_clause}
            RETURN e, labels(e) as labels
            LIMIT $limit
            """

            result = session.run(query, params)

            entities = []
            for record in result:
                entity = dict(record["e"])
                entity["labels"] = record["labels"]
                entities.append(entity)

            return entities

    def get_full_project_graph(
        self,
        project_number: str,
        include_relationships: bool = True
    ) -> Dict[str, Any]:
        """
        Export complete knowledge graph for a project

        Args:
            project_number: Project to export
            include_relationships: Include relationship data

        Returns:
            Full graph with all nodes and edges
        """
        with self.driver.session() as session:
            # Get all entities
            nodes_query = """
            MATCH (p:Project {project_number: $project_number})<-[:BELONGS_TO_PROJECT]-(e)
            RETURN e, labels(e) as labels
            """
            nodes_result = session.run(nodes_query, {"project_number": project_number})

            nodes = []
            for record in nodes_result:
                node = dict(record["e"])
                node["labels"] = record["labels"]
                nodes.append(node)

            relationships = []
            if include_relationships:
                rels_query = """
                MATCH (from {project_number: $project_number})
                      -[r]-
                      (to {project_number: $project_number})
                WHERE type(r) <> 'BELONGS_TO_PROJECT'
                RETURN
                    type(r) as rel_type,
                    properties(r) as properties,
                    from.entity_id as from_id,
                    to.entity_id as to_id
                """
                rels_result = session.run(rels_query, {"project_number": project_number})

                for record in rels_result:
                    relationships.append({
                        "type": record["rel_type"],
                        "properties": record["properties"],
                        "from": record["from_id"],
                        "to": record["to_id"]
                    })

            return {
                "project_number": project_number,
                "node_count": len(nodes),
                "relationship_count": len(relationships),
                "nodes": nodes,
                "relationships": relationships
            }

    # =========================================================================
    # BATCH OPERATIONS
    # =========================================================================

    def batch_create_entities(
        self,
        project_number: str,
        entities: List[Dict[str, Any]],
        batch_size: int = 100
    ) -> int:
        """
        Efficiently create multiple entities in batches

        Args:
            project_number: Project context
            entities: List of {entity_type, entity_id, properties} dicts
            batch_size: Number of entities per transaction

        Returns:
            Total number of entities created
        """
        total = 0

        with self.driver.session() as session:
            # Ensure project exists
            self.create_project(project_number, f"Project {project_number}")

            for i in range(0, len(entities), batch_size):
                batch = entities[i:i + batch_size]

                def create_batch(tx, batch_data):
                    count = 0
                    for entity in batch_data:
                        entity_type = entity["entity_type"]
                        entity_id = entity["entity_id"]
                        props = entity.get("properties", {})

                        query = f"""
                        MATCH (proj:Project {{project_number: $project_number}})
                        MERGE (e:{entity_type} {{entity_id: $entity_id, project_number: $project_number}})
                        ON CREATE SET e += $properties, e.created_at = datetime()
                        MERGE (e)-[:BELONGS_TO_PROJECT]->(proj)
                        """

                        tx.run(query, {
                            "project_number": project_number,
                            "entity_id": entity_id,
                            "properties": props
                        })
                        count += 1
                    return count

                total += session.execute_write(create_batch, batch)
                logger.info(f"Batch {i // batch_size + 1}: Created {len(batch)} entities")

        logger.info(f"✅ Total entities created: {total}")
        return total

    def batch_create_relationships(
        self,
        project_number: str,
        relationships: List[Dict[str, Any]],
        batch_size: int = 100
    ) -> int:
        """
        Efficiently create multiple relationships in batches

        Args:
            project_number: Project context
            relationships: List of {from_id, to_id, type, properties} dicts
            batch_size: Number of relationships per transaction

        Returns:
            Total number of relationships created
        """
        total = 0

        with self.driver.session() as session:
            for i in range(0, len(relationships), batch_size):
                batch = relationships[i:i + batch_size]

                def create_batch(tx, batch_data):
                    count = 0
                    for rel in batch_data:
                        rel_type = rel["type"]
                        from_id = rel["from_id"]
                        to_id = rel["to_id"]
                        props = rel.get("properties", {})

                        query = f"""
                        MATCH (from {{entity_id: $from_id, project_number: $project_number}})
                        MATCH (to {{entity_id: $to_id, project_number: $project_number}})
                        MERGE (from)-[r:{rel_type}]->(to)
                        SET r += $properties
                        """

                        tx.run(query, {
                            "project_number": project_number,
                            "from_id": from_id,
                            "to_id": to_id,
                            "properties": props
                        })
                        count += 1
                    return count

                total += session.execute_write(create_batch, batch)
                logger.info(f"Batch {i // batch_size + 1}: Created {len(batch)} relationships")

        logger.info(f"✅ Total relationships created: {total}")
        return total

    # =========================================================================
    # UTILITIES
    # =========================================================================

    def delete_project(self, project_number: str) -> bool:
        """
        Delete a project and ALL its entities (CASCADE)
        ⚠️ WARNING: This is irreversible!
        """
        with self.driver.session() as session:
            query = """
            MATCH (p:Project {project_number: $project_number})
            OPTIONAL MATCH (p)<-[:BELONGS_TO_PROJECT]-(entity)
            DETACH DELETE entity, p
            """
            session.run(query, {"project_number": project_number})
            logger.warning(f"⚠️ Project {project_number} and all entities DELETED")
            return True

    def execute_custom_query(
        self,
        query: str,
        parameters: Dict[str, Any] = None
    ) -> List[Dict[str, Any]]:
        """
        Execute a custom Cypher query

        Args:
            query: Cypher query string
            parameters: Query parameters

        Returns:
            Query results as list of dicts
        """
        with self.driver.session() as session:
            result = session.run(query, parameters or {})
            return [dict(record) for record in result]


# =============================================================================
# SINGLETON INSTANCE
# =============================================================================

_neo4j_instance: Optional[Neo4jService] = None


def get_neo4j_service() -> Neo4jService:
    """Get or create Neo4j service singleton"""
    global _neo4j_instance

    if _neo4j_instance is None:
        _neo4j_instance = Neo4jService()

    return _neo4j_instance


def close_neo4j_service():
    """Close Neo4j service connection"""
    global _neo4j_instance

    if _neo4j_instance:
        _neo4j_instance.close()
        _neo4j_instance = None
