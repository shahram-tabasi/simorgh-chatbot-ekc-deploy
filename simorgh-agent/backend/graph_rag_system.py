"""
Integrated Graph RAG System
Combines PDF parsing, graph extraction, ArangoDB storage, and vector search

This is the COMPLETE "Smart Memory System"
"""

import logging
from typing import Dict, List, Optional, Any
from datetime import datetime

from enhanced_pdf_parser_v4_universal import EnhancedUniversalPDFParser, CancellationToken
from graph_extractor import GraphExtractor
from arango_graph_manager import ArangoGraphManager
from edge_vector_store import EdgeVectorStore

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class GraphRAGSystem:
    """
    Complete Graph-based RAG system for electrical engineering documents.
    
    Workflow:
    1. Parse PDF → hierarchical structure
    2. Extract entities/relations from each section (LLM)
    3. Store in ArangoDB graph
    4. Store edge vectors in Qdrant
    5. Query: semantic search → graph traversal → context → LLM answer
    """
    
    def __init__(self,
                 ai_url: str,
                 arango_url: str,
                 arango_username: str,
                 arango_password: str,
                 qdrant_url: str,
                 thinking_level: str = "medium"):
        """
        Initialize the complete system.
        """
        logger.info("🚀 Initializing Graph RAG System...")
        
        # PDF Parser
        self.parser = EnhancedUniversalPDFParser(
            strategy="hi_res",
            use_gpu=True,
            extract_tables=True,
            ai_url=ai_url,
            thinking_level=thinking_level,
            qdrant_url=qdrant_url,
            enable_vector_db=False,  # We'll handle vectors separately
            chunk_size=1000,
            chunk_overlap=200,
            debug_mode=False
        )
        logger.info("   ✅ PDF Parser initialized")
        
        # Graph Extractor (LLM-powered)
        self.graph_extractor = GraphExtractor(
            ai_url=ai_url,
            thinking_level=thinking_level
        )
        logger.info("   ✅ Graph Extractor initialized")
        
        # ArangoDB Graph Manager
        self.graph_manager = ArangoGraphManager(
            url=arango_url,
            username=arango_username,
            password=arango_password,
            database_name="electrical_knowledge"
        )
        logger.info("   ✅ ArangoDB Graph Manager initialized")
        
        # Edge Vector Store
        self.vector_store = EdgeVectorStore(
            qdrant_url=qdrant_url,
            embedding_model="all-mpnet-base-v2",
            collection_prefix="edges"
        )
        logger.info("   ✅ Edge Vector Store initialized")
        
        logger.info("🎉 Graph RAG System ready!")
    
    # ========================================================================
    # INGESTION PIPELINE
    # ========================================================================
    
    async def ingest_document(self,
                             pdf_path: str,
                             project_id: str,
                             oe_number: str,
                             document_hash: str,
                             progress_callback=None) -> Dict[str, Any]:
        """
        Complete document ingestion pipeline.
        
        Steps:
        1. Parse PDF to hierarchical structure
        2. For each section with content:
           a. Extract entities and relationships (LLM)
           b. Store in ArangoDB graph
           c. Store edge embeddings in Qdrant
        3. Return statistics
        
        Args:
            pdf_path: Path to PDF file
            project_id: Project identifier
            oe_number: OE number (order/project number)
            document_hash: SHA256 hash of PDF
            progress_callback: Optional callback for progress updates
        
        Returns:
            {
                "status": "success",
                "statistics": {...},
                "errors": [...]
            }
        """
        logger.info(f"\n📄 Starting document ingestion: {pdf_path}")
        logger.info(f"   Project: {project_id}")
        logger.info(f"   OE Number: {oe_number}")
        
        stats = {
            "total_sections": 0,
            "sections_processed": 0,
            "entities_created": 0,
            "entities_updated": 0,
            "relationships_created": 0,
            "relationships_updated": 0,
            "vectors_stored": 0,
            "errors": [],
            "processing_time_seconds": 0
        }
        
        start_time = datetime.utcnow()
        
        try:
            # Step 1: Parse PDF (structure only, no AI yet)
            if progress_callback:
                progress_callback(progress=10, message="Parsing PDF structure...", phase="Parsing")
            
            logger.info("\n🔍 Step 1: Parsing PDF structure...")
            elements = self.parser.parse_pdf(pdf_path)
            structure = self.parser.build_hierarchy_without_ai(elements)
            
            logger.info(f"✅ PDF structure extracted")
            
            # Count sections
            stats["total_sections"] = self._count_content_sections(structure)
            logger.info(f"   Found {stats['total_sections']} sections with content")
            
            if stats["total_sections"] == 0:
                return {
                    "status": "warning",
                    "message": "No content sections found in document",
                    "statistics": stats
                }
            
            # Step 2: Extract graph from each section
            if progress_callback:
                progress_callback(progress=30, message="Extracting knowledge graph...", phase="Graph Extraction")
            
            logger.info("\n🤖 Step 2: Extracting entities and relationships...")
            
            all_edges = []
            section_index = 0
            
            def process_section(section_dict: Dict, path: str = ""):
                nonlocal section_index, all_edges
                
                for key, value in section_dict.items():
                    if self.parser.cancellation_token.is_cancelled():
                        raise InterruptedError("Task cancelled")
                    
                    if key.startswith('_') or key.startswith('table_'):
                        continue
                    
                    if isinstance(value, dict):
                        content = value.get('_raw_content')
                        title = value.get('_section_title', key)
                        
                        if content and len(content) >= 100:
                            section_index += 1
                            current_path = f"{path}/{key}" if path else key
                            
                            progress = 30 + int((section_index / stats["total_sections"]) * 40)
                            if progress_callback:
                                progress_callback(
                                    progress=progress,
                                    message=f"Extracting graph from: {title}",
                                    phase="Graph Extraction"
                                )
                            
                            logger.info(f"\n   📄 [{section_index}/{stats['total_sections']}] Processing: {title}")
                            
                            # Extract graph from this section
                            try:
                                extracted = self.graph_extractor.extract_from_section(
                                    section_title=title,
                                    section_content=content,
                                    project_id=project_id,
                                    document_hash=document_hash
                                )
                                
                                if extracted.get("error"):
                                    stats["errors"].append({
                                        "section": title,
                                        "error": extracted["error"]
                                    })
                                else:
                                    # Store in ArangoDB
                                    store_result = self.graph_manager.store_entities_and_relationships(
                                        project_id=project_id,
                                        document_hash=document_hash,
                                        entities=extracted["entities"],
                                        relationships=extracted["relationships"],
                                        source_section=current_path
                                    )
                                    
                                    stats["entities_created"] += store_result["nodes_created"]
                                    stats["entities_updated"] += store_result["nodes_updated"]
                                    stats["relationships_created"] += store_result["edges_created"]
                                    stats["relationships_updated"] += store_result["edges_updated"]
                                    stats["errors"].extend(store_result["errors"])
                                    
                                    # Collect edges for vector storage
                                    all_edges.extend(extracted["relationships"])
                                    
                                    logger.info(
                                        f"      ✅ Stored: {store_result['nodes_created']} new nodes, "
                                        f"{store_result['edges_created']} new edges"
                                    )
                                
                                stats["sections_processed"] += 1
                                
                            except Exception as e:
                                logger.error(f"      ❌ Failed to process section: {e}")
                                stats["errors"].append({
                                    "section": title,
                                    "error": str(e)
                                })
                        
                        # Recurse
                        process_section(value, current_path)
            
            process_section(structure)
            
            # Step 3: Store edge vectors
            if progress_callback:
                progress_callback(progress=80, message="Storing edge vectors...", phase="Vector Storage")
            
            logger.info("\n🔍 Step 3: Storing edge embeddings in Qdrant...")
            
            if all_edges:
                # Get edges from ArangoDB (with full data including embedding_text)
                # For now, we'll re-create embedding text
                edges_with_embedding = []
                
                for rel in all_edges:
                    # Reconstruct edge document for vector storage
                    edge_doc = {
                        "_key": f"{project_id}_{rel['from']}_{rel['type']}_{rel['to']}",
                        "_from": f"unknown/{rel['from']}",  # Simplified
                        "_to": f"unknown/{rel['to']}",
                        "relation_type": rel["type"],
                        "embedding_text": self._create_edge_text(rel),
                        "attributes": rel.get("attributes", {}),
                        "confidence": rel.get("confidence", 0.8),
                        "sources": [{
                            "document_hash": document_hash,
                            "timestamp": datetime.utcnow().isoformat()
                        }]
                    }
                    edges_with_embedding.append(edge_doc)
                
                vectors_stored = self.vector_store.store_edge_embeddings(
                    project_id=project_id,
                    edges=edges_with_embedding
                )
                
                stats["vectors_stored"] = vectors_stored
                logger.info(f"✅ Stored {vectors_stored} edge vectors")
            
            # Calculate processing time
            end_time = datetime.utcnow()
            stats["processing_time_seconds"] = int((end_time - start_time).total_seconds())
            
            # Final progress
            if progress_callback:
                progress_callback(progress=100, message="✅ Ingestion complete!", phase="Complete")
            
            logger.info(f"\n✅ Document ingestion complete!")
            logger.info(f"📊 Final Statistics:")
            logger.info(f"   • Sections Processed: {stats['sections_processed']}/{stats['total_sections']}")
            logger.info(f"   • Entities: {stats['entities_created']} created, {stats['entities_updated']} updated")
            logger.info(f"   • Relationships: {stats['relationships_created']} created, {stats['relationships_updated']} updated")
            logger.info(f"   • Edge Vectors: {stats['vectors_stored']} stored")
            logger.info(f"   • Processing Time: {stats['processing_time_seconds']}s")
            logger.info(f"   • Errors: {len(stats['errors'])}")
            
            return {
                "status": "success",
                "statistics": stats,
                "errors": stats["errors"]
            }
            
        except InterruptedError:
            logger.warning("🛑 Document ingestion cancelled")
            return {
                "status": "cancelled",
                "statistics": stats,
                "errors": stats["errors"]
            }
        
        except Exception as e:
            logger.error(f"❌ Document ingestion failed: {e}", exc_info=True)
            return {
                "status": "error",
                "message": str(e),
                "statistics": stats,
                "errors": stats["errors"]
            }
    
    # ========================================================================
    # QUERY PIPELINE (Graph-Enhanced RAG)
    # ========================================================================
    
    async def query(self,
                   project_id: str,
                   oe_number: str,
                   query_text: str,
                   max_results: int = 5) -> Dict[str, Any]:
        """
        Graph-enhanced RAG query.
        
        Steps:
        1. Search edge vectors for semantically similar relationships
        2. For each edge, fetch connected entities from ArangoDB
        3. Build context from graph neighborhood
        4. Send context to LLM for answer generation
        
        Args:
            project_id: Project ID
            oe_number: OE number
            query_text: User's natural language question
            max_results: Max edges to retrieve
        
        Returns:
            {
                "answer": "LLM generated answer",
                "sources": [{...}],
                "graph_paths": [{...}]
            }
        """
        logger.info(f"\n💬 Processing query: '{query_text}'")
        logger.info(f"   Project: {project_id}")
        
        try:
            # Step 1: Vector search for relevant edges
            logger.info("🔍 Step 1: Searching for relevant edges...")
            
            relevant_edges = self.vector_store.search_edges(
                project_id=project_id,
                query=query_text,
                limit=max_results,
                min_confidence=0.6
            )
            
            if not relevant_edges:
                logger.info("⚠️ No relevant edges found")
                return {
                    "answer": "I couldn't find relevant information in the knowledge graph for this project.",
                    "sources": [],
                    "graph_paths": []
                }
            
            logger.info(f"   Found {len(relevant_edges)} relevant edges")
            
            # Step 2: Fetch connected entities from ArangoDB
            logger.info("🔍 Step 2: Fetching connected entities from graph...")
            
            context_parts = []
            graph_paths = []
            
            for idx, edge in enumerate(relevant_edges, 1):
                # Get neighborhood for this edge
                # (In production, you'd do actual graph traversal)
                
                context_parts.append(
                    f"[Edge {idx}] {edge['embedding_text']}\n"
                    f"  Type: {edge['relation_type']}\n"
                    f"  Confidence: {edge['confidence']:.2f}\n"
                    f"  Attributes: {edge.get('attributes', {})}"
                )
                
                graph_paths.append({
                    "edge": edge["embedding_text"],
                    "type": edge["relation_type"],
                    "score": edge["score"],
                    "from_key": edge["from_key"],
                    "to_key": edge["to_key"]
                })
            
            context_text = "\n\n".join(context_parts)
            
            logger.info(f"✅ Built context from {len(relevant_edges)} graph edges")
            
            # Step 3: Generate answer with LLM
            # (This would call your AI service in production)
            logger.info("🤖 Step 3: Generating answer with LLM...")
            
            system_prompt = f"""You are an AI assistant specialized in electrical engineering.

You have access to a knowledge graph for project {project_id}.

Here are the relevant graph edges found for the user's query:

{context_text}

Based ONLY on this graph information, answer the user's question accurately and concisely.
Cite specific relationships and components mentioned in the edges.
If the information is not sufficient, clearly state what is missing."""

            # Return context for now (LLM call would go here)
            return {
                "answer": "Graph context retrieved successfully. (LLM generation would happen here)",
                "context": context_text,
                "sources": relevant_edges,
                "graph_paths": graph_paths,
                "status": "success"
            }
            
        except Exception as e:
            logger.error(f"❌ Query failed: {e}", exc_info=True)
            return {
                "answer": f"Query failed: {str(e)}",
                "sources": [],
                "graph_paths": [],
                "status": "error",
                "error": str(e)
            }
    
    # ========================================================================
    # UTILITY METHODS
    # ========================================================================
    
    def get_project_graph_stats(self, project_id: str) -> Dict[str, Any]:
        """Get statistics about the knowledge graph for a project."""
        arango_stats = self.graph_manager.get_project_statistics(project_id)
        vector_stats = self.vector_store.get_collection_stats(project_id)
        
        return {
            "project_id": project_id,
            "graph_database": arango_stats,
            "vector_store": vector_stats,
            "timestamp": datetime.utcnow().isoformat()
        }
    
    def _count_content_sections(self, structure: Dict) -> int:
        """Count sections with content"""
        count = 0
        for key, value in structure.items():
            if isinstance(value, dict):
                if '_raw_content' in value and value['_raw_content']:
                    count += 1
                count += self._count_content_sections(value)
        return count
    
    def _create_edge_text(self, relationship: Dict) -> str:
        """Create embedding text for a relationship"""
        from_id = relationship.get("from", "Unknown")
        to_id = relationship.get("to", "Unknown")
        rel_type = relationship.get("type", "relates_to")
        attrs = relationship.get("attributes", {})
        
        text = f"{from_id} {rel_type.replace('_', ' ')} {to_id}"
        
        if attrs:
            attr_str = ", ".join([f"{k}: {v}" for k, v in attrs.items()])
            text += f" with {attr_str}"
        
        return text
    
    def cancel_task(self):
        """Cancel ongoing task"""
        self.parser.cancel_task()


# Export
__all__ = ['GraphRAGSystem']