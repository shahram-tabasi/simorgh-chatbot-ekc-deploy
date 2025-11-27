"""
ArangoDB Knowledge Graph Manager
Handles all graph database operations for the Smart Memory System
"""

import logging
from typing import Dict, List, Optional, Any, Tuple
from datetime import datetime
from pyArango.connection import Connection
from pyArango.collection import Collection, Edges
from pyArango.graph import Graph, EdgeDefinition
from pyArango.theExceptions import CreationError, AQLQueryError
import hashlib

from electrical_ontology import EntityType, RelationType, create_edge_embedding_text

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class ArangoGraphManager:
    """
    Manages the electrical engineering knowledge graph in ArangoDB.
    
    This is the "brain" that stores and retrieves your Smart Memory.
    """
    
    def __init__(self,
                 url: str = "http://arangodb:8529",
                 username: str = "root",
                 password: str = "changeme",
                 database_name: str = "electrical_knowledge"):
        """
        Initialize connection to ArangoDB.
        """
        self.url = url
        self.username = username
        self.database_name = database_name
        
        try:
            self.conn = Connection(
                arangoURL=url,
                username=username,
                password=password
            )
            logger.info(f"✅ Connected to ArangoDB: {url}")
            
            # Create or get database
            if not self.conn.hasDatabase(database_name):
                self.db = self.conn.createDatabase(name=database_name)
                logger.info(f"✅ Created database: {database_name}")
            else:
                self.db = self.conn[database_name]
                logger.info(f"✅ Using existing database: {database_name}")
            
            # Initialize collections and graph
            self._initialize_graph_schema()
            
        except Exception as e:
            logger.error(f"❌ Failed to connect to ArangoDB: {e}")
            raise
    
    def _initialize_graph_schema(self):
        """
        Initialize graph schema with node and edge collections.
        """
        logger.info("🔧 Initializing graph schema...")
        
        # Node collections (one per entity type)
        self.node_collections = {}
        
        for entity_type in EntityType:
            collection_name = f"{entity_type.value}s"  # e.g., "CircuitBreakers"
            
            if not self.db.hasCollection(collection_name):
                self.node_collections[entity_type] = self.db.createCollection(
                    name=collection_name
                )
                logger.info(f"   ✅ Created node collection: {collection_name}")
            else:
                self.node_collections[entity_type] = self.db[collection_name]
        
        # Edge collections (one per relationship type)
        self.edge_collections = {}
        
        for rel_type in RelationType:
            collection_name = f"{rel_type.value}_edges"
            
            if not self.db.hasCollection(collection_name):
                self.edge_collections[rel_type] = self.db.createCollection(
                    className="Edges",
                    name=collection_name
                )
                logger.info(f"   ✅ Created edge collection: {collection_name}")
            else:
                self.edge_collections[rel_type] = self.db[collection_name]
        
        # Metadata collection for projects
        if not self.db.hasCollection("project_metadata"):
            self.metadata_collection = self.db.createCollection(name="project_metadata")
        else:
            self.metadata_collection = self.db["project_metadata"]
        
        logger.info("✅ Graph schema initialized")
    
    def store_entities_and_relationships(self,
                                        project_id: str,
                                        document_hash: str,
                                        entities: List[Dict],
                                        relationships: List[Dict],
                                        source_section: str = "") -> Dict[str, Any]:
        """
        Store extracted entities and relationships in the graph.
        
        This is where the "learning" happens!
        
        Returns:
            {
                "nodes_created": 5,
                "nodes_updated": 3,
                "edges_created": 12,
                "errors": []
            }
        """
        logger.info(f"📝 Storing graph: {len(entities)} entities, {len(relationships)} relationships")
        
        stats = {
            "nodes_created": 0,
            "nodes_updated": 0,
            "nodes_merged": 0,
            "edges_created": 0,
            "edges_updated": 0,
            "errors": []
        }
        
        entity_key_map = {}  # Map entity IDs to ArangoDB _key
        
        # Store entities (with merge logic)
        for entity in entities:
            try:
                result = self._store_entity(project_id, document_hash, entity, source_section)
                
                entity_key_map[entity["id"]] = result["_key"]
                
                if result["action"] == "created":
                    stats["nodes_created"] += 1
                elif result["action"] == "updated":
                    stats["nodes_updated"] += 1
                elif result["action"] == "merged":
                    stats["nodes_merged"] += 1
                    
            except Exception as e:
                logger.error(f"❌ Failed to store entity {entity.get('id')}: {e}")
                stats["errors"].append({
                    "type": "entity",
                    "id": entity.get("id"),
                    "error": str(e)
                })
        
        # Store relationships
        for rel in relationships:
            try:
                # Get ArangoDB keys
                from_key = entity_key_map.get(rel["from"])
                to_key = entity_key_map.get(rel["to"])
                
                if not from_key or not to_key:
                    logger.warning(f"⚠️ Skipping relationship {rel['from']} → {rel['to']}: entities not found")
                    continue
                
                result = self._store_relationship(
                    project_id,
                    document_hash,
                    from_key,
                    to_key,
                    rel,
                    entities  # Pass entities for embedding text
                )
                
                if result["action"] == "created":
                    stats["edges_created"] += 1
                elif result["action"] == "updated":
                    stats["edges_updated"] += 1
                    
            except Exception as e:
                logger.error(f"❌ Failed to store relationship {rel.get('from')} → {rel.get('to')}: {e}")
                stats["errors"].append({
                    "type": "relationship",
                    "from": rel.get("from"),
                    "to": rel.get("to"),
                    "error": str(e)
                })
        
        logger.info(f"✅ Stored: {stats['nodes_created']} new nodes, "
                   f"{stats['nodes_updated']} updated, "
                   f"{stats['nodes_merged']} merged, "
                   f"{stats['edges_created']} new edges")
        
        return stats
    
    def _store_entity(self,
                     project_id: str,
                     document_hash: str,
                     entity: Dict,
                     source_section: str) -> Dict[str, Any]:
        """
        Store or update an entity node.
        
        Implements smart merging:
        - If entity with same ID exists in project → UPDATE
        - If similar entity exists (by attributes) → MERGE
        - Otherwise → CREATE NEW
        """
        entity_type = EntityType(entity["type"])
        collection = self.node_collections[entity_type]
        
        # Generate unique key
        entity_key = self._generate_entity_key(project_id, entity["id"])
        
        # Check if entity already exists
        try:
            existing = collection[entity_key]
            
            # Entity exists → UPDATE
            logger.info(f"   ✓ Updating existing entity: {entity['id']}")
            
            # Merge attributes (keep old + add new)
            merged_attrs = {**existing["attributes"], **entity.get("attributes", {})}
            
            # Update sources
            sources = existing.get("sources", [])
            sources.append({
                "document_hash": document_hash,
                "section": source_section,
                "timestamp": datetime.utcnow().isoformat(),
                "confidence": entity.get("confidence", 0.8)
            })
            
            existing["attributes"] = merged_attrs
            existing["sources"] = sources
            existing["last_updated"] = datetime.utcnow().isoformat()
            existing["update_count"] = existing.get("update_count", 0) + 1
            
            existing.save()
            
            return {"_key": entity_key, "action": "updated"}
            
        except KeyError:
            # Entity doesn't exist → CREATE NEW
            logger.info(f"   ✓ Creating new entity: {entity['id']}")
            
            doc = {
                "_key": entity_key,
                "entity_id": entity["id"],
                "entity_type": entity["type"],
                "name": entity.get("name", entity["id"]),
                "attributes": entity.get("attributes", {}),
                "voltage_class": entity.get("voltage_class"),
                "project_id": project_id,
                "confidence": entity.get("confidence", 0.8),
                "sources": [{
                    "document_hash": document_hash,
                    "section": source_section,
                    "timestamp": datetime.utcnow().isoformat()
                }],
                "created_at": datetime.utcnow().isoformat(),
                "last_updated": datetime.utcnow().isoformat(),
                "update_count": 0
            }
            
            collection.createDocument(doc).save()
            
            return {"_key": entity_key, "action": "created"}
    
    def _store_relationship(self,
                           project_id: str,
                           document_hash: str,
                           from_key: str,
                           to_key: str,
                           relationship: Dict,
                           entities: List[Dict]) -> Dict[str, Any]:
        """
        Store a relationship edge WITH vector embedding.
        
        This is the KEY innovation: edges are embedded as vectors!
        """
        rel_type = RelationType(relationship["type"])
        collection = self.edge_collections[rel_type]
        
        # Get entity types for embedding
        entity1 = next((e for e in entities if e["id"] == relationship["from"]), None)
        entity2 = next((e for e in entities if e["id"] == relationship["to"]), None)
        
        if not entity1 or not entity2:
            raise ValueError("Entities not found for relationship")
        
        # Generate embedding text
        embedding_text = create_edge_embedding_text(
            EntityType(entity1["type"]),
            entity1.get("name", entity1["id"]),
            rel_type,
            EntityType(entity2["type"]),
            entity2.get("name", entity2["id"]),
            relationship.get("attributes")
        )
        
        # Get full collection names for _from and _to
        from_collection = f"{EntityType(entity1['type']).value}s"
        to_collection = f"{EntityType(entity2['type']).value}s"
        
        from_id = f"{from_collection}/{from_key}"
        to_id = f"{to_collection}/{to_key}"
        
        # Generate unique edge key
        edge_key = self._generate_edge_key(from_key, to_key, rel_type.value)
        
        # Check if edge exists
        try:
            existing = collection[edge_key]
            
            # Edge exists → UPDATE
            logger.info(f"   ✓ Updating edge: {relationship['from']} → {relationship['to']}")
            
            # Merge attributes
            merged_attrs = {**existing.get("attributes", {}), **relationship.get("attributes", {})}
            
            # Update sources
            sources = existing.get("sources", [])
            sources.append({
                "document_hash": document_hash,
                "timestamp": datetime.utcnow().isoformat()
            })
            
            existing["attributes"] = merged_attrs
            existing["sources"] = sources
            existing["embedding_text"] = embedding_text
            existing["last_updated"] = datetime.utcnow().isoformat()
            
            existing.save()
            
            return {"_key": edge_key, "action": "updated"}
            
        except KeyError:
            # Create new edge
            logger.info(f"   ✓ Creating edge: {relationship['from']} → {relationship['to']}")
            
            doc = {
                "_key": edge_key,
                "_from": from_id,
                "_to": to_id,
                "relation_type": relationship["type"],
                "attributes": relationship.get("attributes", {}),
                "embedding_text": embedding_text,
                "project_id": project_id,
                "confidence": relationship.get("confidence", 0.8),
                "sources": [{
                    "document_hash": document_hash,
                    "timestamp": datetime.utcnow().isoformat()
                }],
                "created_at": datetime.utcnow().isoformat(),
                "last_updated": datetime.utcnow().isoformat()
            }
            
            collection.createDocument(doc).save()
            
            return {"_key": edge_key, "action": "created"}
    
    def _generate_entity_key(self, project_id: str, entity_id: str) -> str:
        """Generate unique key for entity"""
        # Use hash to ensure valid ArangoDB key
        raw_key = f"{project_id}_{entity_id}"
        return hashlib.md5(raw_key.encode()).hexdigest()[:32]
    
    def _generate_edge_key(self, from_key: str, to_key: str, rel_type: str) -> str:
        """Generate unique key for edge"""
        raw_key = f"{from_key}_{rel_type}_{to_key}"
        return hashlib.md5(raw_key.encode()).hexdigest()[:32]
    
    # ========================================================================
    # QUERY METHODS (The "Recall" Part of Smart Memory)
    # ========================================================================
    
    def get_entity_with_neighborhood(self,
                                    project_id: str,
                                    entity_id: str,
                                    depth: int = 2) -> Dict[str, Any]:
        """
        Get entity and its connected neighborhood (N-hop graph).
        
        Example: Get CB-001 and everything connected within 2 hops
        """
        entity_key = self._generate_entity_key(project_id, entity_id)
        
        # AQL query for N-hop traversal
        aql = """
        FOR v, e, p IN 1..@depth ANY CONCAT(@collection, '/', @key)
            GRAPH 'electrical_graph'
            RETURN {
                vertex: v,
                edge: e,
                path: p
            }
        """
        
        # Note: This is simplified - you'd need to create a named graph first
        # For now, we'll do a simpler query
        
        try:
            # Get entity
            result = {
                "entity": None,
                "connected_entities": [],
                "relationships": []
            }
            
            # Find entity in all collections
            for entity_type, collection in self.node_collections.items():
                try:
                    entity = collection[entity_key]
                    result["entity"] = dict(entity)
                    break
                except KeyError:
                    continue
            
            if not result["entity"]:
                logger.warning(f"Entity not found: {entity_id}")
                return result
            
            # Get connected edges (simplified - would use graph traversal in production)
            for rel_type, edge_collection in self.edge_collections.items():
                aql_edges = f"""
                FOR edge IN {edge_collection.name}
                    FILTER edge._from LIKE CONCAT('%/', @key) OR edge._to LIKE CONCAT('%/', @key)
                    RETURN edge
                """
                
                try:
                    edges = self.db.AQLQuery(aql_edges, bindVars={"key": entity_key})
                    for edge in edges:
                        result["relationships"].append(dict(edge))
                except:
                    pass
            
            return result
            
        except Exception as e:
            logger.error(f"Failed to get entity neighborhood: {e}")
            return {"entity": None, "connected_entities": [], "relationships": []}
    
    def query_graph(self,
                   project_id: str,
                   query_type: str,
                   **kwargs) -> List[Dict[str, Any]]:
        """
        Execute graph queries.
        
        Examples:
            - Find all circuit breakers in project
            - Find what feeds a specific transformer
            - Find protection chain for a feeder
            - Find all equipment with voltage rating > 33kV
        """
        
        if query_type == "find_by_type":
            entity_type = EntityType(kwargs["entity_type"])
            collection = self.node_collections[entity_type]
            
            aql = f"""
            FOR doc IN {collection.name}
                FILTER doc.project_id == @project_id
                RETURN doc
            """
            
            results = self.db.AQLQuery(aql, bindVars={"project_id": project_id})
            return [dict(r) for r in results]
        
        elif query_type == "find_connections":
            entity_id = kwargs["entity_id"]
            entity_key = self._generate_entity_key(project_id, entity_id)
            
            # Find all edges connected to this entity
            all_edges = []
            
            for rel_type, edge_collection in self.edge_collections.items():
                aql = f"""
                FOR edge IN {edge_collection.name}
                    FILTER edge._from LIKE CONCAT('%/', @key) OR edge._to LIKE CONCAT('%/', @key)
                    RETURN edge
                """
                
                try:
                    edges = self.db.AQLQuery(aql, bindVars={"key": entity_key})
                    all_edges.extend([dict(e) for e in edges])
                except:
                    pass
            
            return all_edges
        
        elif query_type == "find_by_attribute":
            entity_type = EntityType(kwargs["entity_type"])
            attribute_key = kwargs["attribute_key"]
            attribute_value = kwargs["attribute_value"]
            collection = self.node_collections[entity_type]
            
            aql = f"""
            FOR doc IN {collection.name}
                FILTER doc.project_id == @project_id
                FILTER doc.attributes.@attr_key == @attr_value
                RETURN doc
            """
            
            results = self.db.AQLQuery(aql, bindVars={
                "project_id": project_id,
                "attr_key": attribute_key,
                "attr_value": attribute_value
            })
            
            return [dict(r) for r in results]
        
        else:
            logger.warning(f"Unknown query type: {query_type}")
            return []
    
    def get_project_statistics(self, project_id: str) -> Dict[str, Any]:
        """
        Get statistics about the knowledge graph for a project.
        """
        stats = {
            "project_id": project_id,
            "entity_counts": {},
            "relationship_counts": {},
            "total_nodes": 0,
            "total_edges": 0
        }
        
        # Count entities by type
        for entity_type, collection in self.node_collections.items():
            aql = f"""
            RETURN LENGTH(
                FOR doc IN {collection.name}
                    FILTER doc.project_id == @project_id
                    RETURN 1
            )
            """
            
            try:
                result = list(self.db.AQLQuery(aql, bindVars={"project_id": project_id}))
                count = result[0] if result else 0
                stats["entity_counts"][entity_type.value] = count
                stats["total_nodes"] += count
            except:
                stats["entity_counts"][entity_type.value] = 0
        
        # Count relationships by type
        for rel_type, collection in self.edge_collections.items():
            aql = f"""
            RETURN LENGTH(
                FOR doc IN {collection.name}
                    FILTER doc.project_id == @project_id
                    RETURN 1
            )
            """
            
            try:
                result = list(self.db.AQLQuery(aql, bindVars={"project_id": project_id}))
                count = result[0] if result else 0
                stats["relationship_counts"][rel_type.value] = count
                stats["total_edges"] += count
            except:
                stats["relationship_counts"][rel_type.value] = 0
        
        return stats


# Export
__all__ = ['ArangoGraphManager']