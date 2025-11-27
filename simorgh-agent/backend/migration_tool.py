"""
Migration Utility: MongoDB → Graph RAG System
Converts existing MongoDB documents to knowledge graph format

This allows gradual migration without losing existing data.
"""

import logging
from typing import Dict, List, Optional, Any
from datetime import datetime
from pymongo import MongoClient
import os

from graph_rag_system import GraphRAGSystem

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class MigrationManager:
    """
    Manages migration from old MongoDB-based system to new Graph RAG system.
    
    Two modes:
    1. **Parallel Mode**: Both systems run simultaneously, new docs → graph
    2. **Migration Mode**: Convert existing MongoDB docs → graph
    """
    
    def __init__(self,
                 mongodb_url: str,
                 graph_rag_system: GraphRAGSystem):
        """
        Initialize migration manager.
        
        Args:
            mongodb_url: MongoDB connection URL
            graph_rag_system: Initialized GraphRAGSystem instance
        """
        self.mongo_client = MongoClient(mongodb_url)
        self.graph_rag = graph_rag_system
        
        logger.info("🔄 Migration Manager initialized")
    
    def migrate_project(self,
                       pid: str,
                       oe_number: str,
                       mode: str = "latest") -> Dict[str, Any]:
        """
        Migrate a project from MongoDB to Graph RAG.
        
        Args:
            pid: Project ID
            oe_number: OE number
            mode: "latest" (only latest revision) or "all" (all revisions)
        
        Returns:
            Migration statistics
        """
        logger.info(f"\n🔄 Starting migration for project {pid}/{oe_number}")
        logger.info(f"   Mode: {mode}")
        
        stats = {
            "documents_migrated": 0,
            "entities_created": 0,
            "relationships_created": 0,
            "errors": []
        }
        
        try:
            db = self.mongo_client[pid]
            
            # Get all document types (collections)
            collection_names = [
                name for name in db.list_collection_names()
                if not name.startswith('_')
            ]
            
            logger.info(f"   Found {len(collection_names)} document types")
            
            for collection_name in collection_names:
                logger.info(f"\n   Processing collection: {collection_name}")
                collection = db[collection_name]
                
                # Query for documents
                if mode == "latest":
                    # Get only latest revision
                    query = {"project_details.oe_number": oe_number}
                    sort = [("revision", -1)]
                    limit = 1
                else:
                    # Get all revisions
                    query = {"project_details.oe_number": oe_number}
                    sort = [("revision", 1)]
                    limit = 0
                
                cursor = collection.find(query).sort(sort)
                if limit > 0:
                    cursor = cursor.limit(limit)
                
                docs = list(cursor)
                logger.info(f"      Found {len(docs)} document(s)")
                
                for doc in docs:
                    try:
                        # Extract data from MongoDB document
                        result = self._migrate_document(
                            pid=pid,
                            oe_number=oe_number,
                            doc_type=collection_name,
                            mongo_doc=doc
                        )
                        
                        stats["documents_migrated"] += 1
                        stats["entities_created"] += result.get("entities_created", 0)
                        stats["relationships_created"] += result.get("relationships_created", 0)
                        
                        logger.info(f"      ✅ Migrated revision {doc.get('revision', '??')}")
                        
                    except Exception as e:
                        logger.error(f"      ❌ Failed to migrate document: {e}")
                        stats["errors"].append({
                            "collection": collection_name,
                            "revision": doc.get("revision"),
                            "error": str(e)
                        })
            
            logger.info(f"\n✅ Migration complete!")
            logger.info(f"   Documents migrated: {stats['documents_migrated']}")
            logger.info(f"   Entities created: {stats['entities_created']}")
            logger.info(f"   Relationships created: {stats['relationships_created']}")
            logger.info(f"   Errors: {len(stats['errors'])}")
            
            return stats
            
        except Exception as e:
            logger.error(f"❌ Migration failed: {e}", exc_info=True)
            return {
                "error": str(e),
                "stats": stats
            }
    
    def _migrate_document(self,
                         pid: str,
                         oe_number: str,
                         doc_type: str,
                         mongo_doc: Dict) -> Dict[str, Any]:
        """
        Migrate a single MongoDB document to graph format.
        
        Strategy:
        1. If document has 'hierarchical_structure' → process sections
        2. If document has 'ai_extracted' data → convert to entities/relations
        3. If document is old format → log warning, skip
        """
        stats = {
            "entities_created": 0,
            "relationships_created": 0
        }
        
        # Check if document has structure
        if "hierarchical_structure" not in mongo_doc:
            logger.warning(f"      ⚠️ No hierarchical structure found, skipping")
            return stats
        
        structure = mongo_doc["hierarchical_structure"]
        document_hash = mongo_doc.get("pdf_hash", "unknown")
        
        # Check if AI extraction was done
        if not mongo_doc.get("ai_extracted", False):
            logger.info(f"      ℹ️ Document has no AI extraction, extracting now...")
            
            # Re-process with graph extraction
            # (This would require the original PDF, which might not be available)
            logger.warning(f"      ⚠️ Cannot extract entities without original PDF")
            return stats
        
        # Extract entities and relationships from AI-extracted data
        entities, relationships = self._convert_ai_data_to_graph(structure)
        
        logger.info(f"      Converted: {len(entities)} entities, {len(relationships)} relationships")
        
        # Store in graph
        if entities or relationships:
            store_result = self.graph_rag.graph_manager.store_entities_and_relationships(
                project_id=pid,
                document_hash=document_hash,
                entities=entities,
                relationships=relationships,
                source_section=f"migrated_from_mongodb_{doc_type}"
            )
            
            stats["entities_created"] = store_result["nodes_created"]
            stats["relationships_created"] = store_result["edges_created"]
            
            # Store edge vectors
            if relationships:
                edges_with_embedding = []
                
                for rel in relationships:
                    edge_doc = {
                        "_key": f"{pid}_{rel['from']}_{rel['type']}_{rel['to']}",
                        "relation_type": rel["type"],
                        "embedding_text": self._create_edge_text(rel),
                        "attributes": rel.get("attributes", {}),
                        "confidence": rel.get("confidence", 0.7),
                        "sources": [{
                            "document_hash": document_hash,
                            "timestamp": mongo_doc.get("timestamp", datetime.utcnow()).isoformat()
                        }]
                    }
                    edges_with_embedding.append(edge_doc)
                
                self.graph_rag.vector_store.store_edge_embeddings(
                    project_id=pid,
                    edges=edges_with_embedding
                )
        
        return stats
    
    def _convert_ai_data_to_graph(self, structure: Dict) -> tuple:
        """
        Convert AI-extracted data from MongoDB hierarchical structure
        to entities and relationships format.
        
        This is a HEURISTIC conversion since old format didn't have
        explicit entity/relationship structure.
        
        Strategy:
        - Switchboard variables → CircuitBreaker/Panel entities
        - Look for keywords like "connects", "feeds", "protects"
        - Create relationships based on proximity and context
        """
        entities = []
        relationships = []
        entity_counter = 0
        
        def process_section(section_dict: Dict, path: str = ""):
            nonlocal entity_counter
            
            for key, value in section_dict.items():
                if not isinstance(value, dict):
                    continue
                
                ai_data = value.get("_ai_extracted")
                
                if ai_data:
                    switchboard_vars = ai_data.get("switchboard", {})
                    
                    # Try to identify entities from variable names
                    # Example: "circuit_breaker_rated_current" → CircuitBreaker entity
                    
                    equipment_keywords = {
                        "circuit_breaker": "CircuitBreaker",
                        "breaker": "CircuitBreaker",
                        "transformer": "Transformer",
                        "cable": "Cable",
                        "busbar": "Busbar",
                        "panel": "Panel"
                    }
                    
                    detected_equipment = {}
                    
                    for var_name, var_value in switchboard_vars.items():
                        var_lower = var_name.lower()
                        
                        for keyword, entity_type in equipment_keywords.items():
                            if keyword in var_lower:
                                if entity_type not in detected_equipment:
                                    detected_equipment[entity_type] = {}
                                
                                # Extract attribute name
                                attr_name = var_lower.replace(keyword, "").strip("_")
                                detected_equipment[entity_type][attr_name] = var_value
                    
                    # Create entities
                    for entity_type, attributes in detected_equipment.items():
                        entity_counter += 1
                        entity_id = f"{entity_type}_{entity_counter}"
                        
                        entity = {
                            "id": entity_id,
                            "type": entity_type,
                            "name": f"{entity_type} from {key}",
                            "attributes": attributes,
                            "confidence": 0.7,  # Lower confidence for migrated data
                            "source": "migrated_from_mongodb"
                        }
                        
                        entities.append(entity)
                    
                    # Try to infer relationships from section content
                    # (This is very basic - real extraction would need LLM)
                    content = value.get("_raw_content", "").lower()
                    
                    if "feeds" in content and len(entities) >= 2:
                        relationships.append({
                            "from": entities[-2]["id"],
                            "to": entities[-1]["id"],
                            "type": "feeds",
                            "attributes": {},
                            "confidence": 0.6
                        })
                
                # Recurse
                process_section(value, f"{path}/{key}" if path else key)
        
        process_section(structure)
        
        logger.info(f"      Heuristic conversion: {len(entities)} entities, {len(relationships)} relationships")
        
        return entities, relationships
    
    def _create_edge_text(self, relationship: Dict) -> str:
        """Create embedding text for a relationship"""
        from_id = relationship.get("from", "Unknown")
        to_id = relationship.get("to", "Unknown")
        rel_type = relationship.get("type", "relates_to")
        
        return f"{from_id} {rel_type.replace('_', ' ')} {to_id}"
    
    def verify_migration(self, pid: str) -> Dict[str, Any]:
        """
        Verify that migration was successful.
        
        Compares MongoDB document count with graph entity count.
        """
        logger.info(f"\n🔍 Verifying migration for project {pid}")
        
        # Get MongoDB stats
        db = self.mongo_client[pid]
        mongo_stats = {
            "collections": {},
            "total_documents": 0
        }
        
        for collection_name in db.list_collection_names():
            if not collection_name.startswith('_'):
                count = db[collection_name].count_documents({})
                mongo_stats["collections"][collection_name] = count
                mongo_stats["total_documents"] += count
        
        # Get graph stats
        graph_stats = self.graph_rag.get_project_graph_stats(pid)
        
        report = {
            "project_id": pid,
            "mongodb": mongo_stats,
            "graph": graph_stats,
            "migration_complete": graph_stats["graph_database"]["total_nodes"] > 0
        }
        
        logger.info(f"\n📊 Migration Verification Report:")
        logger.info(f"   MongoDB Documents: {mongo_stats['total_documents']}")
        logger.info(f"   Graph Entities: {graph_stats['graph_database']['total_nodes']}")
        logger.info(f"   Graph Relationships: {graph_stats['graph_database']['total_edges']}")
        
        if report["migration_complete"]:
            logger.info(f"   ✅ Migration appears successful")
        else:
            logger.warning(f"   ⚠️ No entities found in graph - migration may have failed")
        
        return report


# ============================================================================
# CLI Tool for Migration
# ============================================================================

def run_migration_cli():
    """
    Command-line interface for running migrations.
    
    Usage:
        python migration_tool.py --project PROJECT_ID --oe OE_NUMBER [--mode latest]
    """
    import argparse
    
    parser = argparse.ArgumentParser(description="Migrate MongoDB documents to Graph RAG")
    parser.add_argument("--project", required=True, help="Project ID (PID)")
    parser.add_argument("--oe", required=True, help="OE Number")
    parser.add_argument("--mode", default="latest", choices=["latest", "all"], 
                       help="Migration mode (default: latest)")
    parser.add_argument("--mongodb-url", default="mongodb://192.168.1.68:27017/",
                       help="MongoDB URL")
    parser.add_argument("--verify", action="store_true",
                       help="Only verify migration (don't migrate)")
    
    args = parser.parse_args()
    
    # Initialize Graph RAG System
    logger.info("🚀 Initializing Graph RAG System...")
    
    graph_rag = GraphRAGSystem(
        ai_url=os.getenv("AI_API_URL_1", "http://192.168.1.61/ai"),
        arango_url=os.getenv("ARANGODB_URL", "http://192.168.1.68:8529"),
        arango_username=os.getenv("ARANGODB_USERNAME", "root"),
        arango_password=os.getenv("ARANGODB_PASSWORD", "changeme"),
        qdrant_url=os.getenv("QDRANT_URL", "http://192.168.1.68:6333"),
        thinking_level="medium"
    )
    
    # Initialize Migration Manager
    migration_manager = MigrationManager(
        mongodb_url=args.mongodb_url,
        graph_rag_system=graph_rag
    )
    
    if args.verify:
        # Just verify
        result = migration_manager.verify_migration(args.project)
    else:
        # Run migration
        result = migration_manager.migrate_project(
            pid=args.project,
            oe_number=args.oe,
            mode=args.mode
        )
        
        # Verify after migration
        logger.info("\n🔍 Verifying migration...")
        verification = migration_manager.verify_migration(args.project)
    
    logger.info("\n✅ Done!")


if __name__ == "__main__":
    run_migration_cli()


# Export
__all__ = ['MigrationManager', 'run_migration_cli']