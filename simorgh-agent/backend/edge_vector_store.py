"""
Edge Vector Store Manager
Stores edge embeddings in Qdrant for semantic search, with links back to ArangoDB graph
"""

import logging
from typing import Dict, List, Optional, Any
from datetime import datetime
from qdrant_client import QdrantClient
from qdrant_client.models import Distance, VectorParams, PointStruct, Filter, FieldCondition, MatchValue
from sentence_transformers import SentenceTransformer

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class EdgeVectorStore:
    """
    Manages vector embeddings of graph edges for semantic search.
    
    This enables: "Find all edges related to '630A circuit breaker protection'"
    Without this, you'd need exact AQL queries.
    """
    
    def __init__(self,
                 qdrant_url: str = "http://qdrant:6333",
                 embedding_model: str = "all-mpnet-base-v2",
                 collection_prefix: str = "edges"):
        """
        Initialize vector store for edges.
        
        Args:
            qdrant_url: Qdrant server URL
            embedding_model: SentenceTransformer model name
            collection_prefix: Prefix for Qdrant collections
        """
        try:
            self.client = QdrantClient(url=qdrant_url)
            logger.info(f"✅ Connected to Qdrant: {qdrant_url}")
            
            self.embedding_model = SentenceTransformer(embedding_model)
            self.embedding_dim = self.embedding_model.get_sentence_embedding_dimension()
            logger.info(f"✅ Loaded embedding model: {embedding_model} (dim={self.embedding_dim})")
            
            self.collection_prefix = collection_prefix
            
        except Exception as e:
            logger.error(f"❌ Failed to initialize vector store: {e}")
            raise
    
    def ensure_collection(self, project_id: str):
        """
        Ensure collection exists for project.
        
        Collection name: edges_{project_id}
        """
        collection_name = f"{self.collection_prefix}_{project_id}"
        
        try:
            self.client.get_collection(collection_name)
            logger.info(f"✓ Collection exists: {collection_name}")
        except:
            self.client.create_collection(
                collection_name=collection_name,
                vectors_config=VectorParams(
                    size=self.embedding_dim,
                    distance=Distance.COSINE
                )
            )
            logger.info(f"✅ Created collection: {collection_name}")
    
    def store_edge_embeddings(self,
                             project_id: str,
                             edges: List[Dict[str, Any]]) -> int:
        """
        Store embeddings for multiple edges.
        
        Args:
            project_id: Project identifier
            edges: List of edge documents with 'embedding_text' field
        
        Returns:
            Number of edges stored
        """
        if not edges:
            return 0
        
        collection_name = f"{self.collection_prefix}_{project_id}"
        self.ensure_collection(project_id)
        
        logger.info(f"📝 Storing {len(edges)} edge embeddings in {collection_name}")
        
        points = []
        
        for idx, edge in enumerate(edges):
            embedding_text = edge.get("embedding_text")
            
            if not embedding_text:
                logger.warning(f"⚠️ Edge {idx} has no embedding_text, skipping")
                continue
            
            # Generate embedding
            vector = self.embedding_model.encode(embedding_text).tolist()
            
            # Create point with metadata
            point = PointStruct(
                id=edge.get("_key", str(idx)),  # Use ArangoDB _key as ID
                vector=vector,
                payload={
                    "project_id": project_id,
                    "edge_key": edge.get("_key"),
                    "from_key": self._extract_key_from_id(edge.get("_from", "")),
                    "to_key": self._extract_key_from_id(edge.get("_to", "")),
                    "relation_type": edge.get("relation_type"),
                    "embedding_text": embedding_text,
                    "attributes": edge.get("attributes", {}),
                    "confidence": edge.get("confidence", 0.8),
                    "created_at": edge.get("created_at", datetime.utcnow().isoformat()),
                    "document_hash": edge.get("sources", [{}])[0].get("document_hash") if edge.get("sources") else None
                }
            )
            
            points.append(point)
        
        # Upload in batches
        batch_size = 100
        stored_count = 0
        
        for i in range(0, len(points), batch_size):
            batch = points[i:i + batch_size]
            
            try:
                self.client.upsert(
                    collection_name=collection_name,
                    points=batch
                )
                stored_count += len(batch)
                logger.info(f"   Uploaded batch {i//batch_size + 1}: {len(batch)} points")
            except Exception as e:
                logger.error(f"❌ Failed to upload batch: {e}")
        
        logger.info(f"✅ Stored {stored_count} edge embeddings")
        return stored_count
    
    def search_edges(self,
                    project_id: str,
                    query: str,
                    limit: int = 10,
                    relation_type: Optional[str] = None,
                    min_confidence: float = 0.0) -> List[Dict[str, Any]]:
        """
        Search for relevant edges using semantic search.
        
        Args:
            project_id: Project to search in
            query: Natural language query
            limit: Max results to return
            relation_type: Filter by specific relationship type (optional)
            min_confidence: Minimum confidence score (optional)
        
        Returns:
            List of matching edges with scores
        
        Example:
            search_edges(
                project_id="PROJ_001",
                query="circuit breaker protection transformer",
                limit=5,
                relation_type="protects"
            )
        """
        collection_name = f"{self.collection_prefix}_{project_id}"
        
        try:
            # Generate query embedding
            query_vector = self.embedding_model.encode(query).tolist()
            
            # Build filter
            query_filter = Filter(
                must=[
                    FieldCondition(
                        key="project_id",
                        match=MatchValue(value=project_id)
                    )
                ]
            )
            
            if relation_type:
                query_filter.must.append(
                    FieldCondition(
                        key="relation_type",
                        match=MatchValue(value=relation_type)
                    )
                )
            
            if min_confidence > 0:
                query_filter.must.append(
                    FieldCondition(
                        key="confidence",
                        range={"gte": min_confidence}
                    )
                )
            
            # Search
            results = self.client.search(
                collection_name=collection_name,
                query_vector=query_vector,
                query_filter=query_filter,
                limit=limit,
                with_payload=True
            )
            
            # Format results
            formatted_results = []
            
            for result in results:
                formatted_results.append({
                    "score": result.score,
                    "edge_key": result.payload.get("edge_key"),
                    "from_key": result.payload.get("from_key"),
                    "to_key": result.payload.get("to_key"),
                    "relation_type": result.payload.get("relation_type"),
                    "embedding_text": result.payload.get("embedding_text"),
                    "attributes": result.payload.get("attributes", {}),
                    "confidence": result.payload.get("confidence"),
                    "document_hash": result.payload.get("document_hash")
                })
            
            logger.info(f"🔍 Found {len(formatted_results)} relevant edges for query: '{query}'")
            return formatted_results
            
        except Exception as e:
            logger.error(f"❌ Edge search failed: {e}")
            return []
    
    def search_by_entity(self,
                        project_id: str,
                        entity_key: str,
                        query: Optional[str] = None,
                        limit: int = 10) -> List[Dict[str, Any]]:
        """
        Search edges connected to a specific entity.
        
        Args:
            project_id: Project ID
            entity_key: ArangoDB entity key
            query: Optional semantic query to filter results
            limit: Max results
        
        Example:
            # Find all edges related to CB_001 that mention "protection"
            search_by_entity(
                project_id="PROJ_001",
                entity_key="cb001_key",
                query="protection"
            )
        """
        collection_name = f"{self.collection_prefix}_{project_id}"
        
        try:
            # Build filter for edges connected to entity
            query_filter = Filter(
                must=[
                    FieldCondition(
                        key="project_id",
                        match=MatchValue(value=project_id)
                    )
                ],
                should=[
                    FieldCondition(
                        key="from_key",
                        match=MatchValue(value=entity_key)
                    ),
                    FieldCondition(
                        key="to_key",
                        match=MatchValue(value=entity_key)
                    )
                ]
            )
            
            if query:
                # Use semantic search
                query_vector = self.embedding_model.encode(query).tolist()
                
                results = self.client.search(
                    collection_name=collection_name,
                    query_vector=query_vector,
                    query_filter=query_filter,
                    limit=limit,
                    with_payload=True
                )
            else:
                # Just filter by entity, no semantic search
                results = self.client.scroll(
                    collection_name=collection_name,
                    scroll_filter=query_filter,
                    limit=limit,
                    with_payload=True
                )[0]  # scroll returns (points, next_offset)
            
            # Format results
            formatted_results = []
            
            for result in results:
                payload = result.payload if hasattr(result, 'payload') else result
                score = result.score if hasattr(result, 'score') else 1.0
                
                formatted_results.append({
                    "score": score,
                    "edge_key": payload.get("edge_key"),
                    "from_key": payload.get("from_key"),
                    "to_key": payload.get("to_key"),
                    "relation_type": payload.get("relation_type"),
                    "embedding_text": payload.get("embedding_text"),
                    "attributes": payload.get("attributes", {}),
                    "confidence": payload.get("confidence")
                })
            
            logger.info(f"🔍 Found {len(formatted_results)} edges for entity {entity_key}")
            return formatted_results
            
        except Exception as e:
            logger.error(f"❌ Entity edge search failed: {e}")
            return []
    
    def get_collection_stats(self, project_id: str) -> Dict[str, Any]:
        """
        Get statistics about the edge vector collection.
        """
        collection_name = f"{self.collection_prefix}_{project_id}"
        
        try:
            info = self.client.get_collection(collection_name)
            
            return {
                "collection_name": collection_name,
                "vectors_count": info.vectors_count,
                "indexed_vectors_count": info.indexed_vectors_count,
                "points_count": info.points_count,
                "status": info.status
            }
        except Exception as e:
            logger.error(f"Failed to get stats: {e}")
            return {
                "collection_name": collection_name,
                "error": str(e)
            }
    
    def delete_project_edges(self, project_id: str) -> bool:
        """
        Delete all edges for a project (useful for re-indexing).
        """
        collection_name = f"{self.collection_prefix}_{project_id}"
        
        try:
            self.client.delete_collection(collection_name)
            logger.info(f"✅ Deleted collection: {collection_name}")
            return True
        except Exception as e:
            logger.error(f"❌ Failed to delete collection: {e}")
            return False
    
    @staticmethod
    def _extract_key_from_id(arangodb_id: str) -> str:
        """
        Extract document key from ArangoDB ID.
        
        Example: "CircuitBreakers/abc123" → "abc123"
        """
        if "/" in arangodb_id:
            return arangodb_id.split("/")[1]
        return arangodb_id


# Export
__all__ = ['EdgeVectorStore']