"""
CoCoIndex Neo4j Adapter
========================
Unified Neo4j access layer for all CoCoIndex flows.
All Neo4j operations for project chats MUST go through this adapter.

This adapter provides:
- Abstracted entity CRUD operations
- Relationship management
- Query helpers with project isolation
- No direct Cypher exposure to callers

Author: Simorgh Industrial Assistant
"""

import os
import logging
import json
from typing import List, Dict, Any, Optional
from datetime import datetime
from neo4j import GraphDatabase, Driver
from neo4j.exceptions import ServiceUnavailable, Neo4jError

logger = logging.getLogger(__name__)


class CoCoIndexAdapter:
    """
    Unified Neo4j access layer for CoCoIndex flows.

    All project chat Neo4j operations go through this adapter.
    Ensures consistent project isolation and data structure.
    """

    def __init__(
        self,
        uri: str = None,
        user: str = None,
        password: str = None,
        driver: Driver = None
    ):
        """
        Initialize adapter with Neo4j connection.

        Args:
            uri: Neo4j connection URI
            user: Neo4j username
            password: Neo4j password
            driver: Existing Neo4j driver (optional, for sharing connections)
        """
        if driver:
            self.driver = driver
            self._owns_driver = False
        else:
            self.uri = uri or os.getenv("NEO4J_URI", "bolt://localhost:7687")
            self.user = user or os.getenv("NEO4J_USER", "neo4j")
            self.password = password or os.getenv("NEO4J_PASSWORD", "password")
            self._connect()
            self._owns_driver = True

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
            self.driver.verify_connectivity()
            logger.info(f"CoCoIndex Adapter connected to Neo4j at {self.uri}")
        except ServiceUnavailable as e:
            logger.error(f"Neo4j connection failed: {e}")
            raise

    def close(self):
        """Close driver connection if owned"""
        if self._owns_driver and self.driver:
            self.driver.close()
            logger.info("CoCoIndex Adapter connection closed")

    # =========================================================================
    # PROJECT OPERATIONS
    # =========================================================================

    def create_project(
        self,
        project_number: str,
        project_name: str,
        owner_id: str = None,
        metadata: Dict[str, Any] = None
    ) -> Dict[str, Any]:
        """
        Create or update a project node.

        Args:
            project_number: Unique project identifier
            project_name: Human-readable name
            owner_id: Owner username
            metadata: Additional project metadata

        Returns:
            Created project properties
        """
        with self.driver.session() as session:
            metadata_json = json.dumps(metadata) if metadata else "{}"

            result = session.execute_write(
                self._create_project_tx,
                project_number,
                project_name,
                owner_id or "",
                metadata_json
            )

            logger.info(f"Project created/updated: {project_number}")
            return result

    @staticmethod
    def _create_project_tx(tx, project_number, project_name, owner_id, metadata_json):
        query = """
        MERGE (p:Project {project_number: $project_number})
        ON CREATE SET
            p.project_name = $project_name,
            p.owner_id = $owner_id,
            p.created_at = datetime(),
            p.updated_at = datetime(),
            p.metadata_json = $metadata_json
        ON MATCH SET
            p.updated_at = datetime()
        RETURN p {.*, labels: labels(p)} as project
        """
        result = tx.run(query, {
            "project_number": project_number,
            "project_name": project_name,
            "owner_id": owner_id,
            "metadata_json": metadata_json
        })
        record = result.single()
        return dict(record["project"]) if record else {}

    def get_project(self, project_number: str) -> Optional[Dict[str, Any]]:
        """Get project by project_number"""
        with self.driver.session() as session:
            result = session.execute_read(
                self._get_project_tx,
                project_number
            )
            return result

    @staticmethod
    def _get_project_tx(tx, project_number):
        query = """
        MATCH (p:Project {project_number: $project_number})
        RETURN p {.*, labels: labels(p)} as project
        """
        result = tx.run(query, {"project_number": project_number})
        record = result.single()
        return dict(record["project"]) if record else None

    def delete_project(self, project_number: str) -> int:
        """
        Delete project and all related entities.

        Args:
            project_number: Project to delete

        Returns:
            Number of deleted nodes
        """
        with self.driver.session() as session:
            deleted_count = session.execute_write(
                self._delete_project_tx,
                project_number
            )
            logger.warning(f"Project {project_number} deleted: {deleted_count} nodes")
            return deleted_count

    @staticmethod
    def _delete_project_tx(tx, project_number):
        query = """
        MATCH (p:Project {project_number: $project_number})
        OPTIONAL MATCH (p)<-[:BELONGS_TO_PROJECT]-(entity)
        WITH p, collect(entity) as entities
        UNWIND entities + [p] as node
        DETACH DELETE node
        RETURN count(*) as deleted_count
        """
        result = tx.run(query, {"project_number": project_number})
        record = result.single()
        return record["deleted_count"] if record else 0

    # =========================================================================
    # ENTITY OPERATIONS
    # =========================================================================

    def create_entity(
        self,
        project_number: str,
        entity_type: str,
        entity_id: str,
        properties: Dict[str, Any]
    ) -> Dict[str, Any]:
        """
        Create an entity node linked to project.

        Args:
            project_number: Project context
            entity_type: Node label (e.g., SpecificationDocument, SpecCategory)
            entity_id: Unique entity identifier
            properties: Entity properties

        Returns:
            Created entity properties
        """
        with self.driver.session() as session:
            result = session.execute_write(
                self._create_entity_tx,
                project_number,
                entity_type,
                entity_id,
                properties
            )
            logger.debug(f"Entity created: {entity_type}:{entity_id}")
            return result

    @staticmethod
    def _create_entity_tx(tx, project_number, entity_type, entity_id, properties):
        # Sanitize properties for Neo4j (convert complex types to JSON strings)
        safe_props = {}
        for k, v in properties.items():
            if isinstance(v, (dict, list)):
                safe_props[k] = json.dumps(v)
            else:
                safe_props[k] = v

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
        RETURN e {{.*, labels: labels(e)}} as entity
        """

        result = tx.run(query, {
            "project_number": project_number,
            "entity_id": entity_id,
            "properties": safe_props
        })
        record = result.single()
        return dict(record["entity"]) if record else {}

    def get_entity(
        self,
        project_number: str,
        entity_id: str
    ) -> Optional[Dict[str, Any]]:
        """Get entity by ID within project"""
        with self.driver.session() as session:
            result = session.execute_read(
                self._get_entity_tx,
                project_number,
                entity_id
            )
            return result

    @staticmethod
    def _get_entity_tx(tx, project_number, entity_id):
        query = """
        MATCH (e {entity_id: $entity_id, project_number: $project_number})
        RETURN e {.*, labels: labels(e)} as entity
        """
        result = tx.run(query, {
            "project_number": project_number,
            "entity_id": entity_id
        })
        record = result.single()
        return dict(record["entity"]) if record else None

    def get_entities_by_type(
        self,
        project_number: str,
        entity_type: str,
        filters: Dict[str, Any] = None,
        limit: int = 100
    ) -> List[Dict[str, Any]]:
        """
        Get entities of a specific type within project.

        Args:
            project_number: Project context
            entity_type: Entity type/label
            filters: Optional property filters
            limit: Max results

        Returns:
            List of matching entities
        """
        with self.driver.session() as session:
            result = session.execute_read(
                self._get_entities_by_type_tx,
                project_number,
                entity_type,
                filters or {},
                limit
            )
            return result

    @staticmethod
    def _get_entities_by_type_tx(tx, project_number, entity_type, filters, limit):
        where_clauses = ["e.project_number = $project_number"]
        params = {"project_number": project_number, "limit": limit}

        for key, value in filters.items():
            param_name = f"filter_{key}"
            where_clauses.append(f"e.{key} = ${param_name}")
            params[param_name] = value

        where_clause = " AND ".join(where_clauses)

        query = f"""
        MATCH (e:{entity_type})
        WHERE {where_clause}
        RETURN e {{.*, labels: labels(e)}} as entity
        LIMIT $limit
        """

        result = tx.run(query, params)
        return [dict(record["entity"]) for record in result]

    def delete_entity(
        self,
        project_number: str,
        entity_id: str
    ) -> bool:
        """Delete a single entity"""
        with self.driver.session() as session:
            deleted = session.execute_write(
                self._delete_entity_tx,
                project_number,
                entity_id
            )
            return deleted

    @staticmethod
    def _delete_entity_tx(tx, project_number, entity_id):
        query = """
        MATCH (e {entity_id: $entity_id, project_number: $project_number})
        DETACH DELETE e
        RETURN count(e) > 0 as deleted
        """
        result = tx.run(query, {
            "project_number": project_number,
            "entity_id": entity_id
        })
        record = result.single()
        return record["deleted"] if record else False

    # =========================================================================
    # RELATIONSHIP OPERATIONS
    # =========================================================================

    def create_relationship(
        self,
        project_number: str,
        from_entity_id: str,
        to_entity_id: str,
        relationship_type: str,
        properties: Dict[str, Any] = None
    ) -> bool:
        """
        Create relationship between two entities.

        Args:
            project_number: Project context
            from_entity_id: Source entity ID
            to_entity_id: Target entity ID
            relationship_type: Relationship type (e.g., HAS_SPEC_CATEGORY)
            properties: Optional relationship properties

        Returns:
            True if created
        """
        with self.driver.session() as session:
            created = session.execute_write(
                self._create_relationship_tx,
                project_number,
                from_entity_id,
                to_entity_id,
                relationship_type,
                properties or {}
            )
            return created

    @staticmethod
    def _create_relationship_tx(tx, project_number, from_id, to_id, rel_type, properties):
        # Sanitize relationship type to be valid Cypher identifier
        safe_rel_type = rel_type.replace(" ", "_").replace("-", "_").upper()

        query = f"""
        MATCH (from {{entity_id: $from_id, project_number: $project_number}})
        MATCH (to {{entity_id: $to_id, project_number: $project_number}})
        MERGE (from)-[r:{safe_rel_type}]->(to)
        SET r += $properties,
            r.created_at = coalesce(r.created_at, datetime())
        RETURN r IS NOT NULL as created
        """

        result = tx.run(query, {
            "project_number": project_number,
            "from_id": from_id,
            "to_id": to_id,
            "properties": properties
        })
        record = result.single()
        return record["created"] if record else False

    def get_entity_relationships(
        self,
        project_number: str,
        entity_id: str,
        direction: str = "both",
        relationship_type: str = None
    ) -> List[Dict[str, Any]]:
        """
        Get relationships for an entity.

        Args:
            project_number: Project context
            entity_id: Entity to get relationships for
            direction: "outgoing", "incoming", or "both"
            relationship_type: Optional filter by relationship type

        Returns:
            List of relationship details
        """
        with self.driver.session() as session:
            result = session.execute_read(
                self._get_entity_relationships_tx,
                project_number,
                entity_id,
                direction,
                relationship_type
            )
            return result

    @staticmethod
    def _get_entity_relationships_tx(tx, project_number, entity_id, direction, rel_type):
        rel_pattern = f"[r:{rel_type}]" if rel_type else "[r]"

        if direction == "outgoing":
            pattern = f"(e)-{rel_pattern}->(other)"
        elif direction == "incoming":
            pattern = f"(e)<-{rel_pattern}-(other)"
        else:
            pattern = f"(e)-{rel_pattern}-(other)"

        query = f"""
        MATCH (e {{entity_id: $entity_id, project_number: $project_number}})
        MATCH {pattern}
        WHERE other.project_number = $project_number
        RETURN
            type(r) as relationship_type,
            properties(r) as properties,
            other.entity_id as other_entity_id,
            labels(other) as other_labels,
            CASE WHEN startNode(r) = e THEN 'outgoing' ELSE 'incoming' END as direction
        """

        result = tx.run(query, {
            "project_number": project_number,
            "entity_id": entity_id
        })

        return [dict(record) for record in result]

    # =========================================================================
    # GRAPH TRAVERSAL
    # =========================================================================

    def get_entity_neighborhood(
        self,
        project_number: str,
        entity_id: str,
        depth: int = 1
    ) -> Dict[str, Any]:
        """
        Get entity with connected neighbors up to specified depth.

        Args:
            project_number: Project context
            entity_id: Center entity
            depth: Traversal depth (1-3 recommended)

        Returns:
            Subgraph with nodes and relationships
        """
        with self.driver.session() as session:
            result = session.execute_read(
                self._get_neighborhood_tx,
                project_number,
                entity_id,
                min(depth, 3)  # Cap at 3 to prevent performance issues
            )
            return result

    @staticmethod
    def _get_neighborhood_tx(tx, project_number, entity_id, depth):
        query = f"""
        MATCH (center {{entity_id: $entity_id, project_number: $project_number}})
        OPTIONAL MATCH path = (center)-[*1..{depth}]-(neighbor)
        WHERE neighbor.project_number = $project_number
        WITH center, collect(DISTINCT path) as paths
        UNWIND paths as p
        UNWIND nodes(p) as node
        UNWIND relationships(p) as rel
        WITH center,
             collect(DISTINCT node {{.*, labels: labels(node)}}) as nodes,
             collect(DISTINCT {{
                 type: type(rel),
                 properties: properties(rel),
                 start_id: startNode(rel).entity_id,
                 end_id: endNode(rel).entity_id
             }}) as relationships
        RETURN
            center {{.*, labels: labels(center)}} as center,
            nodes,
            relationships
        """

        result = tx.run(query, {
            "project_number": project_number,
            "entity_id": entity_id
        })

        record = result.single()
        if not record:
            return {"center": None, "nodes": [], "relationships": []}

        return {
            "center": dict(record["center"]),
            "nodes": [dict(n) for n in record["nodes"]],
            "relationships": [dict(r) for r in record["relationships"]]
        }

    # =========================================================================
    # SPECIFICATION-SPECIFIC OPERATIONS
    # =========================================================================

    def get_spec_categories(
        self,
        project_number: str,
        document_id: str
    ) -> List[Dict[str, Any]]:
        """
        Get all specification categories for a document.

        Args:
            project_number: Project context
            document_id: Specification document ID

        Returns:
            List of category nodes
        """
        with self.driver.session() as session:
            result = session.execute_read(
                self._get_spec_categories_tx,
                project_number,
                document_id
            )
            return result

    @staticmethod
    def _get_spec_categories_tx(tx, project_number, document_id):
        query = """
        MATCH (doc:SpecificationDocument {entity_id: $document_id, project_number: $project_number})
              -[:HAS_SPEC_CATEGORY]->(cat:SpecCategory)
        RETURN cat {.*, labels: labels(cat)} as category
        ORDER BY cat.name
        """
        result = tx.run(query, {
            "project_number": project_number,
            "document_id": document_id
        })
        return [dict(record["category"]) for record in result]

    def get_category_fields(
        self,
        project_number: str,
        document_id: str,
        category_name: str
    ) -> List[Dict[str, Any]]:
        """
        Get all fields and values for a specification category.

        Args:
            project_number: Project context
            document_id: Document ID
            category_name: Category name

        Returns:
            List of field details with values
        """
        with self.driver.session() as session:
            result = session.execute_read(
                self._get_category_fields_tx,
                project_number,
                document_id,
                category_name
            )
            return result

    @staticmethod
    def _get_category_fields_tx(tx, project_number, document_id, category_name):
        query = """
        MATCH (cat:SpecCategory {name: $category_name, project_number: $project_number})
        WHERE cat.document_id = $document_id OR cat.entity_id STARTS WITH $document_id
        MATCH (cat)-[:HAS_FIELD]->(field:SpecField)
        OPTIONAL MATCH (field)-[:HAS_VALUE]->(value:ActualValue)
        RETURN
            field.name as field_name,
            field {.*, labels: labels(field)} as field,
            value {.*, labels: labels(value)} as value
        ORDER BY field.name
        """
        result = tx.run(query, {
            "project_number": project_number,
            "document_id": document_id,
            "category_name": category_name
        })

        fields = []
        for record in result:
            field_data = dict(record["field"]) if record["field"] else {}
            value_data = dict(record["value"]) if record["value"] else {}
            fields.append({
                "field_name": record["field_name"],
                "field": field_data,
                "value": value_data.get("extracted_value") or value_data.get("value"),
                "confidence": value_data.get("confidence"),
                "source_text": value_data.get("source_text")
            })
        return fields

    def get_full_specification(
        self,
        project_number: str,
        document_id: str
    ) -> Dict[str, Dict[str, Any]]:
        """
        Get complete specification data for a document.

        Args:
            project_number: Project context
            document_id: Document ID

        Returns:
            Nested dict: {category_name: {field_name: value, ...}, ...}
        """
        categories = self.get_spec_categories(project_number, document_id)

        spec_data = {}
        for cat in categories:
            cat_name = cat.get("name", "Unknown")
            fields = self.get_category_fields(project_number, document_id, cat_name)

            spec_data[cat_name] = {}
            for field in fields:
                spec_data[cat_name][field["field_name"]] = {
                    "value": field.get("value"),
                    "confidence": field.get("confidence"),
                    "source_text": field.get("source_text")
                }

        return spec_data

    # =========================================================================
    # BATCH OPERATIONS
    # =========================================================================

    def batch_create_entities(
        self,
        project_number: str,
        entities: List[Dict[str, Any]]
    ) -> int:
        """
        Create multiple entities in a single transaction.

        Args:
            project_number: Project context
            entities: List of {entity_type, entity_id, properties}

        Returns:
            Number of entities created
        """
        with self.driver.session() as session:
            count = session.execute_write(
                self._batch_create_entities_tx,
                project_number,
                entities
            )
            logger.info(f"Batch created {count} entities")
            return count

    @staticmethod
    def _batch_create_entities_tx(tx, project_number, entities):
        count = 0
        for entity in entities:
            entity_type = entity.get("entity_type", "Entity")
            entity_id = entity.get("entity_id")
            properties = entity.get("properties", {})

            if not entity_id:
                continue

            # Sanitize properties
            safe_props = {}
            for k, v in properties.items():
                if isinstance(v, (dict, list)):
                    safe_props[k] = json.dumps(v)
                else:
                    safe_props[k] = v

            query = f"""
            MATCH (proj:Project {{project_number: $project_number}})
            MERGE (e:{entity_type} {{entity_id: $entity_id, project_number: $project_number}})
            ON CREATE SET e += $properties, e.created_at = datetime()
            ON MATCH SET e += $properties, e.updated_at = datetime()
            MERGE (e)-[:BELONGS_TO_PROJECT]->(proj)
            """

            tx.run(query, {
                "project_number": project_number,
                "entity_id": entity_id,
                "properties": safe_props
            })
            count += 1

        return count

    def batch_create_relationships(
        self,
        project_number: str,
        relationships: List[Dict[str, Any]]
    ) -> int:
        """
        Create multiple relationships in a single transaction.

        Args:
            project_number: Project context
            relationships: List of {from_id, to_id, type, properties}

        Returns:
            Number of relationships created
        """
        with self.driver.session() as session:
            count = session.execute_write(
                self._batch_create_relationships_tx,
                project_number,
                relationships
            )
            logger.info(f"Batch created {count} relationships")
            return count

    @staticmethod
    def _batch_create_relationships_tx(tx, project_number, relationships):
        count = 0
        for rel in relationships:
            from_id = rel.get("from_id")
            to_id = rel.get("to_id")
            rel_type = rel.get("type", "RELATED_TO")
            properties = rel.get("properties", {})

            if not from_id or not to_id:
                continue

            safe_rel_type = rel_type.replace(" ", "_").replace("-", "_").upper()

            query = f"""
            MATCH (from {{entity_id: $from_id, project_number: $project_number}})
            MATCH (to {{entity_id: $to_id, project_number: $project_number}})
            MERGE (from)-[r:{safe_rel_type}]->(to)
            SET r += $properties, r.created_at = coalesce(r.created_at, datetime())
            """

            tx.run(query, {
                "project_number": project_number,
                "from_id": from_id,
                "to_id": to_id,
                "properties": properties
            })
            count += 1

        return count

    # =========================================================================
    # DOCUMENT OPERATIONS (Special handling for Document nodes)
    # =========================================================================

    def get_project_documents(
        self,
        project_number: str,
        doc_type: str = None,
        limit: int = 50
    ) -> List[Dict[str, Any]]:
        """
        Get documents for a project with optional type filter.

        Documents are stored differently from other entities - they use
        'filename' as identifier and 'id' as UUID, not 'entity_id'.

        Args:
            project_number: Project identifier
            doc_type: Optional document type filter (e.g., 'Spec', 'DataSheet')
            limit: Max results

        Returns:
            List of document dictionaries
        """
        with self.driver.session() as session:
            if doc_type:
                query = """
                MATCH (doc:Document {project_number: $project_number})
                WHERE doc.doc_type = $doc_type OR doc.category = $doc_type
                RETURN doc {.*, labels: labels(doc)} as document
                ORDER BY doc.indexed_at DESC
                LIMIT $limit
                """
                params = {
                    "project_number": project_number,
                    "doc_type": doc_type,
                    "limit": limit
                }
            else:
                query = """
                MATCH (doc:Document {project_number: $project_number})
                RETURN doc {.*, labels: labels(doc)} as document
                ORDER BY doc.indexed_at DESC
                LIMIT $limit
                """
                params = {
                    "project_number": project_number,
                    "limit": limit
                }

            try:
                result = session.run(query, params)
                return [dict(record["document"]) for record in result]
            except Exception as e:
                logger.error(f"Failed to get project documents: {e}")
                return []

    def get_document_by_filename(
        self,
        project_number: str,
        filename: str
    ) -> Optional[Dict[str, Any]]:
        """
        Get a specific document by filename.

        Args:
            project_number: Project identifier
            filename: Document filename

        Returns:
            Document dictionary or None
        """
        with self.driver.session() as session:
            query = """
            MATCH (doc:Document {project_number: $project_number, filename: $filename})
            RETURN doc {.*, labels: labels(doc)} as document
            """

            try:
                result = session.run(query, {
                    "project_number": project_number,
                    "filename": filename
                })
                record = result.single()
                return dict(record["document"]) if record else None
            except Exception as e:
                logger.error(f"Failed to get document by filename: {e}")
                return None

    def get_spec_documents(
        self,
        project_number: str,
        limit: int = 20
    ) -> List[Dict[str, Any]]:
        """
        Get specification documents for a project.

        Filters for documents with type 'Spec' or containing 'spec' in filename.

        Args:
            project_number: Project identifier
            limit: Max results

        Returns:
            List of spec document dictionaries
        """
        with self.driver.session() as session:
            query = """
            MATCH (doc:Document {project_number: $project_number})
            WHERE doc.doc_type = 'Spec'
                OR doc.category = 'Spec'
                OR toLower(doc.filename) CONTAINS 'spec'
                OR toLower(doc.name) CONTAINS 'spec'
            RETURN doc {.*, labels: labels(doc)} as document
            ORDER BY doc.indexed_at DESC
            LIMIT $limit
            """

            try:
                result = session.run(query, {
                    "project_number": project_number,
                    "limit": limit
                })
                return [dict(record["document"]) for record in result]
            except Exception as e:
                logger.error(f"Failed to get spec documents: {e}")
                return []


# =============================================================================
# SINGLETON INSTANCE
# =============================================================================

_adapter_instance: Optional[CoCoIndexAdapter] = None


def get_cocoindex_adapter() -> CoCoIndexAdapter:
    """Get or create CoCoIndex adapter singleton"""
    global _adapter_instance

    if _adapter_instance is None:
        _adapter_instance = CoCoIndexAdapter()

    return _adapter_instance


def close_cocoindex_adapter():
    """Close adapter connection"""
    global _adapter_instance

    if _adapter_instance:
        _adapter_instance.close()
        _adapter_instance = None
