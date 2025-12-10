"""
Qdrant Vector Database Service
================================
Manages document chunk storage and semantic search using Qdrant.
Each project has isolated vector space for document chunks.
Also manages user conversation memory for long-term context.

Author: Simorgh Industrial Assistant
"""

import os
import logging
from typing import List, Dict, Optional, Any
from datetime import datetime
from qdrant_client import QdrantClient
from qdrant_client.models import (
    Distance, VectorParams, PointStruct,
    Filter, FieldCondition, MatchValue,
    SearchRequest, ScrollRequest
)
from sentence_transformers import SentenceTransformer
import hashlib
import uuid

logger = logging.getLogger(__name__)


class QdrantService:
    """
    Qdrant vector database service for document chunk management
    """

    def __init__(
        self,
        qdrant_url: str = None,
        qdrant_api_key: str = None,
        embedding_model: str = "sentence-transformers/all-MiniLM-L6-v2"
    ):
        """
        Initialize Qdrant service

        Args:
            qdrant_url: Qdrant server URL (default: localhost:6333)
            qdrant_api_key: Optional API key for Qdrant Cloud
            embedding_model: Sentence transformer model for embeddings
        """
        self.qdrant_url = qdrant_url or os.getenv("QDRANT_URL", "localhost")
        self.qdrant_port = int(os.getenv("QDRANT_PORT", "6333"))
        self.qdrant_api_key = qdrant_api_key or os.getenv("QDRANT_API_KEY")

        # Initialize Qdrant client
        if self.qdrant_api_key:
            # Cloud mode: use full URL with protocol
            self.client = QdrantClient(
                url=self.qdrant_url,
                api_key=self.qdrant_api_key
            )
            logger.info(f"✅ Connected to Qdrant Cloud: {self.qdrant_url}")
        else:
            # Local mode: check if URL has protocol
            if self.qdrant_url.startswith("http://") or self.qdrant_url.startswith("https://"):
                # Use url parameter for full URLs
                self.client = QdrantClient(url=self.qdrant_url)
                logger.info(f"✅ Connected to Qdrant: {self.qdrant_url}")
            else:
                # Use host/port for hostname only
                self.client = QdrantClient(
                    host=self.qdrant_url,
                    port=self.qdrant_port
                )
                logger.info(f"✅ Connected to Qdrant: {self.qdrant_url}:{self.qdrant_port}")

        # Initialize embedding model
        self.embedding_model_name = embedding_model
        logger.info(f"🔄 Loading embedding model: {embedding_model}")
        self.embedding_model = SentenceTransformer(embedding_model)
        self.embedding_dim = self.embedding_model.get_sentence_embedding_dimension()
        logger.info(f"✅ Embedding model loaded (dimension: {self.embedding_dim})")

    def _get_collection_name(self, project_number: str) -> str:
        """
        Get collection name for a project (ensures isolation)

        Args:
            project_number: Project OE number

        Returns:
            Collection name for the project
        """
        # Sanitize project number for collection name
        sanitized = project_number.replace("-", "_").replace(" ", "_").lower()
        return f"project_{sanitized}"

    def _get_user_memory_collection_name(self, user_id: str) -> str:
        """
        Get collection name for user's conversation memory

        Args:
            user_id: User identifier

        Returns:
            Collection name for the user's memory
        """
        # Sanitize user ID for collection name
        sanitized = user_id.replace("-", "_").replace(" ", "_").replace(".", "_").lower()
        return f"user_memory_{sanitized}"

    def ensure_collection_exists(self, project_number: str) -> bool:
        """
        Ensure collection exists for project, create if not

        Args:
            project_number: Project OE number

        Returns:
            True if collection exists or was created
        """
        collection_name = self._get_collection_name(project_number)

        try:
            # Check if collection exists
            collections = self.client.get_collections().collections
            exists = any(c.name == collection_name for c in collections)

            if not exists:
                # Create collection with vector configuration
                self.client.create_collection(
                    collection_name=collection_name,
                    vectors_config=VectorParams(
                        size=self.embedding_dim,
                        distance=Distance.COSINE
                    )
                )
                logger.info(f"✅ Created Qdrant collection: {collection_name}")
            else:
                logger.info(f"✓ Collection already exists: {collection_name}")

            return True

        except Exception as e:
            logger.error(f"❌ Failed to ensure collection exists: {e}")
            return False

    def generate_embedding(self, text: str) -> List[float]:
        """
        Generate embedding vector for text

        Args:
            text: Input text

        Returns:
            Embedding vector
        """
        try:
            embedding = self.embedding_model.encode(text, convert_to_numpy=True)
            return embedding.tolist()
        except Exception as e:
            logger.error(f"❌ Failed to generate embedding: {e}")
            raise

    def add_document_chunks(
        self,
        project_number: str,
        document_id: str,
        chunks: List[Dict[str, Any]]
    ) -> bool:
        """
        Add document chunks to Qdrant

        Args:
            project_number: Project OE number
            document_id: Document unique identifier
            chunks: List of chunk dictionaries with keys:
                - text: Chunk text content
                - section_title: Section/heading title
                - chunk_index: Chunk position in document
                - metadata: Optional additional metadata

        Returns:
            True if successful
        """
        collection_name = self._get_collection_name(project_number)

        # Ensure collection exists
        if not self.ensure_collection_exists(project_number):
            return False

        try:
            points = []

            for chunk in chunks:
                # Generate unique ID for chunk
                chunk_id = str(uuid.uuid4())

                # Generate embedding
                text = chunk.get("text", "")
                if not text:
                    logger.warning(f"⚠️ Empty chunk text, skipping")
                    continue

                embedding = self.generate_embedding(text)

                # Prepare payload
                payload = {
                    "document_id": document_id,
                    "project_number": project_number,
                    "text": text,
                    "section_title": chunk.get("section_title", ""),
                    "chunk_index": chunk.get("chunk_index", 0),
                }

                # Add optional metadata
                if "metadata" in chunk:
                    payload["metadata"] = chunk["metadata"]

                # Create point
                point = PointStruct(
                    id=chunk_id,
                    vector=embedding,
                    payload=payload
                )
                points.append(point)

            # Upload points in batch
            if points:
                self.client.upsert(
                    collection_name=collection_name,
                    points=points
                )
                logger.info(f"✅ Added {len(points)} chunks to {collection_name}")
                return True
            else:
                logger.warning(f"⚠️ No valid chunks to add")
                return False

        except Exception as e:
            logger.error(f"❌ Failed to add document chunks: {e}")
            return False

    def semantic_search(
        self,
        project_number: str,
        query: str,
        limit: int = 5,
        document_id: Optional[str] = None,
        score_threshold: float = 0.5
    ) -> List[Dict[str, Any]]:
        """
        Perform semantic search in project collection

        Args:
            project_number: Project OE number
            query: Search query text
            limit: Maximum number of results
            document_id: Optional filter by specific document
            score_threshold: Minimum similarity score (0.0 to 1.0)

        Returns:
            List of search results with chunks and scores
        """
        collection_name = self._get_collection_name(project_number)

        try:
            # Generate query embedding
            query_embedding = self.generate_embedding(query)

            # Prepare filter if document_id specified
            search_filter = None
            if document_id:
                search_filter = Filter(
                    must=[
                        FieldCondition(
                            key="document_id",
                            match=MatchValue(value=document_id)
                        )
                    ]
                )

            # Perform search
            results = self.client.search(
                collection_name=collection_name,
                query_vector=query_embedding,
                limit=limit,
                query_filter=search_filter,
                score_threshold=score_threshold
            )

            # Format results
            formatted_results = []
            for result in results:
                formatted_results.append({
                    "chunk_id": result.id,
                    "score": result.score,
                    "text": result.payload.get("text", ""),
                    "section_title": result.payload.get("section_title", ""),
                    "chunk_index": result.payload.get("chunk_index", 0),
                    "document_id": result.payload.get("document_id", ""),
                    "metadata": result.payload.get("metadata", {})
                })

            logger.info(f"🔍 Found {len(formatted_results)} results for query in {collection_name}")
            return formatted_results

        except Exception as e:
            logger.error(f"❌ Semantic search failed: {e}")
            return []

    def get_document_chunks(
        self,
        project_number: str,
        document_id: str
    ) -> List[Dict[str, Any]]:
        """
        Get all chunks for a specific document

        Args:
            project_number: Project OE number
            document_id: Document unique identifier

        Returns:
            List of all chunks for the document
        """
        collection_name = self._get_collection_name(project_number)

        try:
            # Scroll through all points with document_id filter
            results = self.client.scroll(
                collection_name=collection_name,
                scroll_filter=Filter(
                    must=[
                        FieldCondition(
                            key="document_id",
                            match=MatchValue(value=document_id)
                        )
                    ]
                ),
                limit=1000  # Adjust based on expected chunk count
            )

            chunks = []
            for point in results[0]:  # results is tuple (points, next_page_offset)
                chunks.append({
                    "chunk_id": point.id,
                    "text": point.payload.get("text", ""),
                    "section_title": point.payload.get("section_title", ""),
                    "chunk_index": point.payload.get("chunk_index", 0),
                    "metadata": point.payload.get("metadata", {})
                })

            # Sort by chunk_index
            chunks.sort(key=lambda x: x["chunk_index"])

            logger.info(f"📄 Retrieved {len(chunks)} chunks for document {document_id}")
            return chunks

        except Exception as e:
            logger.error(f"❌ Failed to get document chunks: {e}")
            return []

    def delete_document_chunks(
        self,
        project_number: str,
        document_id: str
    ) -> bool:
        """
        Delete all chunks for a document

        Args:
            project_number: Project OE number
            document_id: Document unique identifier

        Returns:
            True if successful
        """
        collection_name = self._get_collection_name(project_number)

        try:
            # Delete all points with matching document_id
            self.client.delete(
                collection_name=collection_name,
                points_selector=Filter(
                    must=[
                        FieldCondition(
                            key="document_id",
                            match=MatchValue(value=document_id)
                        )
                    ]
                )
            )

            logger.info(f"🗑️ Deleted all chunks for document {document_id}")
            return True

        except Exception as e:
            logger.error(f"❌ Failed to delete document chunks: {e}")
            return False

    def delete_project_collection(self, project_number: str) -> bool:
        """
        Delete entire collection for a project

        Args:
            project_number: Project OE number

        Returns:
            True if successful
        """
        collection_name = self._get_collection_name(project_number)

        try:
            self.client.delete_collection(collection_name=collection_name)
            logger.info(f"🗑️ Deleted collection: {collection_name}")
            return True

        except Exception as e:
            logger.error(f"❌ Failed to delete collection: {e}")
            return False

    def get_collection_stats(self, project_number: str) -> Dict[str, Any]:
        """
        Get statistics for project collection

        Args:
            project_number: Project OE number

        Returns:
            Dictionary with collection statistics
        """
        collection_name = self._get_collection_name(project_number)

        try:
            info = self.client.get_collection(collection_name=collection_name)

            return {
                "collection_name": collection_name,
                "vectors_count": info.vectors_count,
                "points_count": info.points_count,
                "status": info.status,
                "optimizer_status": info.optimizer_status
            }

        except Exception as e:
            logger.error(f"❌ Failed to get collection stats: {e}")
            return {}

    # =========================================================================
    # USER MEMORY METHODS (Long-term conversation context)
    # =========================================================================

    def ensure_user_memory_collection_exists(self, user_id: str) -> bool:
        """
        Ensure user memory collection exists, create if not

        Args:
            user_id: User identifier

        Returns:
            True if collection exists or was created
        """
        collection_name = self._get_user_memory_collection_name(user_id)

        try:
            # Check if collection exists
            collections = self.client.get_collections().collections
            exists = any(c.name == collection_name for c in collections)

            if not exists:
                # Create collection with vector configuration
                self.client.create_collection(
                    collection_name=collection_name,
                    vectors_config=VectorParams(
                        size=self.embedding_dim,
                        distance=Distance.COSINE
                    )
                )
                logger.info(f"✅ Created user memory collection: {collection_name}")
            else:
                logger.debug(f"✓ User memory collection exists: {collection_name}")

            return True

        except Exception as e:
            logger.error(f"❌ Failed to ensure user memory collection exists: {e}")
            return False

    def store_user_conversation(
        self,
        user_id: str,
        user_message: str,
        assistant_response: str,
        chat_id: Optional[str] = None,
        project_number: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None
    ) -> bool:
        """
        Store user conversation (both user message and assistant response) in Qdrant

        Args:
            user_id: User identifier
            user_message: User's message
            assistant_response: Assistant's response
            chat_id: Optional chat ID
            project_number: Optional project number
            metadata: Optional additional metadata

        Returns:
            True if successful
        """
        collection_name = self._get_user_memory_collection_name(user_id)

        # Ensure collection exists
        if not self.ensure_user_memory_collection_exists(user_id):
            return False

        try:
            # Generate unique ID for this conversation pair
            conversation_id = str(uuid.uuid4())
            timestamp = datetime.utcnow().isoformat()

            # Combine user message and assistant response for semantic search
            # We'll mainly search based on assistant responses but include context
            combined_text = f"User: {user_message}\nAssistant: {assistant_response}"

            # Generate embedding (primarily from assistant response for relevance)
            embedding = self.generate_embedding(assistant_response)

            # Prepare payload
            payload = {
                "user_id": user_id,
                "user_message": user_message,
                "assistant_response": assistant_response,
                "combined_text": combined_text,
                "chat_id": chat_id or "",
                "project_number": project_number or "",
                "timestamp": timestamp,
                "metadata": metadata or {}
            }

            # Create point
            point = PointStruct(
                id=conversation_id,
                vector=embedding,
                payload=payload
            )

            # Upload point
            self.client.upsert(
                collection_name=collection_name,
                points=[point]
            )

            logger.info(f"✅ Stored conversation in user memory for {user_id}")
            return True

        except Exception as e:
            logger.error(f"❌ Failed to store user conversation: {e}")
            return False

    def retrieve_similar_conversations(
        self,
        user_id: str,
        current_query: str,
        limit: int = 5,
        score_threshold: float = 0.6,
        project_filter: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """
        Retrieve semantically similar past conversations for a user

        Args:
            user_id: User identifier
            current_query: Current user query
            limit: Maximum number of similar conversations to retrieve
            score_threshold: Minimum similarity score (0.0 to 1.0)
            project_filter: Optional filter by project number

        Returns:
            List of similar past conversations with scores
        """
        collection_name = self._get_user_memory_collection_name(user_id)

        try:
            # Check if collection exists
            collections = self.client.get_collections().collections
            exists = any(c.name == collection_name for c in collections)

            if not exists:
                logger.info(f"ℹ️ No memory collection exists yet for user {user_id}")
                return []

            # Generate query embedding
            query_embedding = self.generate_embedding(current_query)

            # Prepare filter if project specified
            search_filter = None
            if project_filter:
                search_filter = Filter(
                    must=[
                        FieldCondition(
                            key="project_number",
                            match=MatchValue(value=project_filter)
                        )
                    ]
                )

            # Perform search
            results = self.client.search(
                collection_name=collection_name,
                query_vector=query_embedding,
                limit=limit,
                query_filter=search_filter,
                score_threshold=score_threshold
            )

            # Format results
            formatted_results = []
            for result in results:
                formatted_results.append({
                    "conversation_id": result.id,
                    "score": result.score,
                    "user_message": result.payload.get("user_message", ""),
                    "assistant_response": result.payload.get("assistant_response", ""),
                    "chat_id": result.payload.get("chat_id", ""),
                    "project_number": result.payload.get("project_number", ""),
                    "timestamp": result.payload.get("timestamp", ""),
                    "metadata": result.payload.get("metadata", {})
                })

            logger.info(f"🔍 Found {len(formatted_results)} similar past conversations for user {user_id}")
            return formatted_results

        except Exception as e:
            logger.error(f"❌ Failed to retrieve similar conversations: {e}")
            return []

    def delete_user_memory(self, user_id: str) -> bool:
        """
        Delete all conversation memory for a user

        Args:
            user_id: User identifier

        Returns:
            True if successful
        """
        collection_name = self._get_user_memory_collection_name(user_id)

        try:
            self.client.delete_collection(collection_name=collection_name)
            logger.info(f"🗑️ Deleted user memory collection: {collection_name}")
            return True

        except Exception as e:
            logger.error(f"❌ Failed to delete user memory: {e}")
            return False
