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
        embedding_model: str = "sentence-transformers/all-MiniLM-L6-v2",
        llm_service=None,
        embedding_dim: Optional[int] = None
    ):
        """
        Initialize Qdrant service

        Args:
            qdrant_url: Qdrant server URL (default: localhost:6333)
            qdrant_api_key: Optional API key for Qdrant Cloud
            embedding_model: Sentence transformer model for embeddings (fallback if no llm_service)
            llm_service: Optional LLMService instance for LLM-based embeddings
            embedding_dim: Optional explicit embedding dimension (auto-detected if not provided)
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

        # Initialize embedding generation
        self.llm_service = llm_service
        self.embedding_model = None
        self.embedding_model_name = None

        if self.llm_service:
            # Use LLM-based embeddings (better for domain-specific content)
            logger.info(f"🔄 Using LLM-based embeddings for superior semantic understanding")

            # Get embedding dimension
            if embedding_dim:
                self.embedding_dim = embedding_dim
                logger.info(f"✅ LLM embeddings configured (dimension: {self.embedding_dim})")
            else:
                # Auto-detect dimension by generating a test embedding
                logger.info(f"🔄 Auto-detecting embedding dimension...")
                test_embedding = self.llm_service.generate_embedding("test")
                self.embedding_dim = len(test_embedding)
                logger.info(f"✅ LLM embeddings configured (auto-detected dimension: {self.embedding_dim})")
        else:
            # Fallback to SentenceTransformer (legacy mode)
            self.embedding_model_name = embedding_model
            logger.info(f"🔄 Loading SentenceTransformer model: {embedding_model}")

            # Try loading from local cache first (offline mode), then fallback to download
            try:
                logger.info(f"🔄 Attempting to load model from local cache...")
                self.embedding_model = SentenceTransformer(embedding_model, local_files_only=True)
                logger.info(f"✅ Loaded model from local cache")
            except Exception as cache_error:
                logger.warning(f"⚠️ Model not in local cache, downloading from HuggingFace: {cache_error}")
                try:
                    self.embedding_model = SentenceTransformer(embedding_model, local_files_only=False)
                    logger.info(f"✅ Model downloaded from HuggingFace")
                except Exception as download_error:
                    logger.error(f"❌ Failed to download model: {download_error}")
                    raise

            self.embedding_dim = self.embedding_model.get_sentence_embedding_dimension()
            logger.info(f"✅ Embedding model loaded (dimension: {self.embedding_dim})")

    def _get_collection_name(
        self,
        user_id: str,
        session_id: Optional[str] = None,
        project_oenum: Optional[str] = None
    ) -> str:
        """
        Get session-specific collection name (ensures strict isolation)

        Collection naming strategy:
        - General chat: user_{user_id}_session_{session_id}
        - Project chat: user_{user_id}_project_{project_oenum}

        Args:
            user_id: User identifier
            session_id: Optional session ID for general chats
            project_oenum: Optional project OE number for project chats

        Returns:
            Session-specific collection name

        Raises:
            ValueError: If neither session_id nor project_oenum provided
        """
        # Sanitize user_id
        user_id_clean = user_id.replace("-", "_").replace(" ", "_").replace(".", "_").lower()

        if project_oenum:
            # Project chat: user_{user_id}_project_{project_oenum}
            project_clean = project_oenum.replace("-", "_").replace(" ", "_").lower()
            return f"user_{user_id_clean}_project_{project_clean}"
        elif session_id:
            # General chat: user_{user_id}_session_{session_id}
            session_clean = session_id.replace("-", "_").replace(" ", "_").lower()
            return f"user_{user_id_clean}_session_{session_clean}"
        else:
            raise ValueError("Either session_id or project_oenum must be provided for collection isolation")

    def _get_user_memory_collection_name(self, user_id: str) -> str:
        """
        DEPRECATED: Use _get_collection_name with session_id instead
        Get collection name for user's conversation memory

        Args:
            user_id: User identifier

        Returns:
            Collection name for the user's memory
        """
        # Sanitize user ID for collection name
        sanitized = user_id.replace("-", "_").replace(" ", "_").replace(".", "_").lower()
        return f"user_memory_{sanitized}"

    def ensure_collection_exists(
        self,
        user_id: str,
        session_id: Optional[str] = None,
        project_oenum: Optional[str] = None
    ) -> bool:
        """
        Ensure session-specific collection exists, create if not

        Args:
            user_id: User identifier
            session_id: Optional session ID for general chats
            project_oenum: Optional project OE number for project chats

        Returns:
            True if collection exists or was created
        """
        collection_name = self._get_collection_name(user_id, session_id, project_oenum)

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

        Uses LLM-based embeddings if llm_service is configured,
        otherwise falls back to SentenceTransformer.

        Args:
            text: Input text

        Returns:
            Embedding vector
        """
        try:
            if self.llm_service:
                # Use LLM-based embeddings for better domain-specific understanding
                embedding = self.llm_service.generate_embedding(text)
                return embedding
            else:
                # Fallback to SentenceTransformer (legacy mode)
                embedding = self.embedding_model.encode(text, convert_to_numpy=True)
                return embedding.tolist()
        except Exception as e:
            logger.error(f"❌ Failed to generate embedding: {e}")
            raise

    def add_document_chunks(
        self,
        user_id: str,
        document_id: str,
        chunks: List[Dict[str, Any]],
        session_id: Optional[str] = None,
        project_oenum: Optional[str] = None
    ) -> bool:
        """
        Add document chunks to session-specific Qdrant collection

        Args:
            user_id: User identifier
            document_id: Document unique identifier
            chunks: List of chunk dictionaries with keys:
                - text: Chunk text content
                - section_title: Section/heading title
                - chunk_index: Chunk position in document
                - metadata: Optional additional metadata
            session_id: Optional session ID for general chats
            project_oenum: Optional project OE number for project chats

        Returns:
            True if successful
        """
        collection_name = self._get_collection_name(user_id, session_id, project_oenum)

        # Ensure collection exists
        if not self.ensure_collection_exists(user_id, session_id, project_oenum):
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

                # Prepare payload with session context
                payload = {
                    "document_id": document_id,
                    "user_id": user_id,
                    "text": text,
                    "section_title": chunk.get("section_title", ""),
                    "chunk_index": chunk.get("chunk_index", 0),
                }

                # Add session context
                if project_oenum:
                    payload["project_oenum"] = project_oenum
                if session_id:
                    payload["session_id"] = session_id

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
        user_id: str,
        query: str,
        limit: int = 5,
        document_id: Optional[str] = None,
        score_threshold: float = 0.5,
        session_id: Optional[str] = None,
        project_oenum: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """
        Perform semantic search in session-specific collection

        Args:
            user_id: User identifier
            query: Search query text
            limit: Maximum number of results
            document_id: Optional filter by specific document
            score_threshold: Minimum similarity score (0.0 to 1.0)
            session_id: Optional session ID for general chats
            project_oenum: Optional project OE number for project chats

        Returns:
            List of search results with chunks and scores
        """
        collection_name = self._get_collection_name(user_id, session_id, project_oenum)

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
        document_id: str,
        user_id: str = "system"
    ) -> List[Dict[str, Any]]:
        """
        Get all chunks for a specific document

        Args:
            project_number: Project OE number
            document_id: Document unique identifier
            user_id: User ID (default: "system" for project-level documents)

        Returns:
            List of all chunks for the document
        """
        try:
            # Get the collection name for this project
            collection_name = self._get_collection_name(
                user_id=user_id,
                project_oenum=project_number
            )

            # Check if collection exists first
            collections = self.client.get_collections().collections
            exists = any(c.name == collection_name for c in collections)

            if not exists:
                logger.info(f"ℹ️ Collection {collection_name} does not exist")
                return []

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
        document_id: str,
        user_id: str = "system"
    ) -> bool:
        """
        Delete all chunks/sections for a specific document

        This method removes all vector data associated with a single document
        from the project's Qdrant collection. Used when re-uploading or
        deleting individual documents.

        Args:
            project_number: Project OE number
            document_id: Document unique identifier
            user_id: User ID (default: "system" for project-level documents)

        Returns:
            True if successful
        """
        try:
            # Get the collection name for this project
            collection_name = self._get_collection_name(
                user_id=user_id,
                project_oenum=project_number
            )

            # Check if collection exists first
            collections = self.client.get_collections().collections
            exists = any(c.name == collection_name for c in collections)

            if not exists:
                logger.info(f"ℹ️ Collection {collection_name} does not exist, nothing to delete")
                return True

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

            logger.info(f"🗑️ Deleted all chunks for document {document_id} in {collection_name}")
            return True

        except Exception as e:
            logger.error(f"❌ Failed to delete document chunks: {e}")
            return False

    def delete_project_collection(
        self,
        project_number: str,
        user_id: str = "system"
    ) -> bool:
        """
        Delete entire collection for a project

        Args:
            project_number: Project OE number
            user_id: User ID (default: "system" for project-level documents)

        Returns:
            True if successful
        """
        try:
            # Get the collection name for this project
            collection_name = self._get_collection_name(
                user_id=user_id,
                project_oenum=project_number
            )

            # Check if collection exists first
            collections = self.client.get_collections().collections
            exists = any(c.name == collection_name for c in collections)

            if not exists:
                logger.info(f"ℹ️ Collection {collection_name} does not exist, nothing to delete")
                return True

            self.client.delete_collection(collection_name=collection_name)
            logger.info(f"🗑️ Deleted collection: {collection_name}")
            return True

        except Exception as e:
            logger.error(f"❌ Failed to delete collection: {e}")
            return False

    def delete_all_project_collections(self, project_number: str) -> Dict[str, Any]:
        """
        Delete ALL collections associated with a project (from all users)

        This method finds and deletes all Qdrant collections that contain
        the project number, ensuring complete cleanup on project deletion.

        Args:
            project_number: Project OE number

        Returns:
            Dictionary with deletion results
        """
        try:
            # Sanitize project number for pattern matching
            project_clean = project_number.replace("-", "_").replace(" ", "_").lower()
            project_pattern = f"_project_{project_clean}"

            # Get all collections
            collections = self.client.get_collections().collections
            deleted_collections = []
            failed_collections = []

            for collection in collections:
                # Check if collection belongs to this project
                if project_pattern in collection.name:
                    try:
                        self.client.delete_collection(collection_name=collection.name)
                        deleted_collections.append(collection.name)
                        logger.info(f"🗑️ Deleted project collection: {collection.name}")
                    except Exception as e:
                        failed_collections.append({
                            "name": collection.name,
                            "error": str(e)
                        })
                        logger.error(f"❌ Failed to delete collection {collection.name}: {e}")

            result = {
                "success": len(failed_collections) == 0,
                "deleted_count": len(deleted_collections),
                "deleted_collections": deleted_collections,
                "failed_collections": failed_collections
            }

            if deleted_collections:
                logger.info(f"✅ Deleted {len(deleted_collections)} collections for project {project_number}")
            else:
                logger.info(f"ℹ️ No collections found for project {project_number}")

            return result

        except Exception as e:
            logger.error(f"❌ Failed to delete project collections: {e}")
            return {
                "success": False,
                "error": str(e),
                "deleted_count": 0,
                "deleted_collections": [],
                "failed_collections": []
            }

    def get_collection_stats(
        self,
        project_number: Optional[str] = None,
        user_id: str = "system",
        session_id: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Get statistics for a collection (project or session)

        Flexible method that can get stats for:
        - Project collections: provide project_number
        - Session collections: provide session_id

        Args:
            project_number: Project OE number (for project collections)
            user_id: User ID (default: "system" for project-level documents)
            session_id: Session ID (for session collections)

        Returns:
            Dictionary with collection statistics
        """
        try:
            # Determine collection name based on parameters
            if project_number:
                collection_name = self._get_collection_name(
                    user_id=user_id,
                    project_oenum=project_number
                )
            elif session_id:
                collection_name = self._get_collection_name(
                    user_id=user_id,
                    session_id=session_id
                )
            else:
                return {
                    "error": "Must provide either project_number or session_id",
                    "exists": False
                }

            # Check if collection exists first
            collections = self.client.get_collections().collections
            exists = any(c.name == collection_name for c in collections)

            if not exists:
                return {
                    "collection_name": collection_name,
                    "exists": False,
                    "vectors_count": 0,
                    "points_count": 0
                }

            info = self.client.get_collection(collection_name=collection_name)

            return {
                "collection_name": collection_name,
                "exists": True,
                "vectors_count": info.vectors_count,
                "points_count": info.points_count,
                "status": str(info.status),
                "optimizer_status": str(info.optimizer_status)
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
            # Generate embedding from BOTH user question and assistant answer
            # This allows finding conversations based on what the user asked OR what was discussed
            combined_text = f"User: {user_message}\nAssistant: {assistant_response}"

            # Generate embedding from combined text for better semantic matching
            embedding = self.generate_embedding(combined_text)

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
        project_filter: Optional[str] = None,
        chat_id: Optional[str] = None,
        fallback_to_recent: bool = True,
        fallback_limit: int = 10
    ) -> List[Dict[str, Any]]:
        """
        Retrieve semantically similar past conversations for a user
        If no semantic matches found and fallback_to_recent=True, return most recent conversations

        Args:
            user_id: User identifier
            current_query: Current user query
            limit: Maximum number of similar conversations to retrieve
            score_threshold: Minimum similarity score (0.0 to 1.0)
            project_filter: Optional filter by project number
            chat_id: Optional filter by chat ID (for session isolation)
            fallback_to_recent: If True and no semantic matches, return recent conversations
            fallback_limit: Number of recent conversations to return as fallback

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

            # Prepare filter for project and chat isolation
            search_filter = None
            filter_conditions = []

            if project_filter:
                filter_conditions.append(
                    FieldCondition(
                        key="project_number",
                        match=MatchValue(value=project_filter)
                    )
                )

            if chat_id:
                filter_conditions.append(
                    FieldCondition(
                        key="chat_id",
                        match=MatchValue(value=chat_id)
                    )
                )

            if filter_conditions:
                search_filter = Filter(must=filter_conditions)

            # Perform semantic search with score threshold
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

            # If no semantic matches found and fallback is enabled, get recent conversations
            if len(formatted_results) == 0 and fallback_to_recent:
                logger.info(f"💡 No semantic matches found, falling back to {fallback_limit} most recent conversations")

                # Search without score threshold to get recent conversations
                recent_results = self.client.search(
                    collection_name=collection_name,
                    query_vector=query_embedding,
                    limit=fallback_limit,
                    query_filter=search_filter,
                    score_threshold=None  # No threshold for fallback
                )

                # Sort by timestamp (most recent first)
                recent_results_sorted = sorted(
                    recent_results,
                    key=lambda x: x.payload.get("timestamp", ""),
                    reverse=True
                )

                # Format fallback results
                for result in recent_results_sorted:
                    formatted_results.append({
                        "conversation_id": result.id,
                        "score": result.score,
                        "user_message": result.payload.get("user_message", ""),
                        "assistant_response": result.payload.get("assistant_response", ""),
                        "chat_id": result.payload.get("chat_id", ""),
                        "project_number": result.payload.get("project_number", ""),
                        "timestamp": result.payload.get("timestamp", ""),
                        "metadata": result.payload.get("metadata", {}),
                        "is_fallback": True  # Mark as fallback result
                    })

                logger.info(f"📚 Returned {len(formatted_results)} recent conversations as fallback")
            else:
                logger.info(f"🔍 Found {len(formatted_results)} semantically similar past conversations for user {user_id}")

            return formatted_results

        except Exception as e:
            logger.error(f"❌ Failed to retrieve similar conversations: {e}")
            return []

    def delete_session_collection(
        self,
        user_id: str,
        session_id: Optional[str] = None,
        project_oenum: Optional[str] = None
    ) -> bool:
        """
        Delete session-specific collection (complete data removal)

        Args:
            user_id: User identifier
            session_id: Optional session ID for general chats
            project_oenum: Optional project OE number for project chats

        Returns:
            True if successful
        """
        try:
            collection_name = self._get_collection_name(user_id, session_id, project_oenum)

            # Check if collection exists first
            collections = self.client.get_collections().collections
            exists = any(c.name == collection_name for c in collections)

            if not exists:
                logger.info(f"ℹ️ Collection {collection_name} does not exist, nothing to delete")
                return True

            self.client.delete_collection(collection_name=collection_name)
            logger.info(f"🗑️ Deleted session collection: {collection_name}")
            return True

        except Exception as e:
            logger.error(f"❌ Failed to delete session collection: {e}")
            return False

    def delete_user_memory(self, user_id: str) -> bool:
        """
        DEPRECATED: Use delete_session_collection instead
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

    # =========================================================================
    # ENHANCED DUAL STORAGE: Summaries (for search) + Full Sections (for retrieval)
    # =========================================================================

    def add_section_summaries(
        self,
        user_id: str,
        document_id: str,
        section_summaries: List[Dict[str, Any]],
        session_id: Optional[str] = None,
        project_oenum: Optional[str] = None
    ) -> bool:
        """
        Add section summaries with dual storage model to session-specific collection

        Stores:
        1. Summary vectors (for semantic search)
        2. Full section content (linked via section_id for retrieval)

        Args:
            user_id: User identifier
            document_id: Document unique identifier
            section_summaries: List of section summary dictionaries with keys:
                - section_id: Unique section identifier
                - section_title: Section heading
                - heading_level: Heading level (0-6)
                - parent_section_id: Optional parent section ID
                - summary: LLM-generated summary (vectorized for search)
                - full_content: Complete section text (stored for retrieval)
                - subjects: List of detected subjects
                - key_topics: List of key topics
                - metadata: Additional metadata

            session_id: Optional session ID for general chats
            project_oenum: Optional project OE number for project chats

        Returns:
            True if successful
        """
        collection_name = self._get_collection_name(user_id, session_id, project_oenum)

        # Ensure collection exists
        if not self.ensure_collection_exists(user_id, session_id, project_oenum):
            return False

        try:
            points = []

            for section_data in section_summaries:
                section_id = section_data.get("section_id")
                summary = section_data.get("summary", "")
                full_content = section_data.get("full_content", "")

                if not summary or not full_content:
                    logger.warning(f"⚠️ Empty summary or content for section {section_id}, skipping")
                    continue

                # Generate embedding from SUMMARY (not full content)
                # This allows semantic search on high-level topics
                embedding = self.generate_embedding(summary)

                # Prepare payload with both summary and full content
                payload = {
                    "document_id": document_id,
                    "user_id": user_id,
                    "section_id": section_id,
                    "section_title": section_data.get("section_title", ""),
                    "heading_level": section_data.get("heading_level", 0),
                    "parent_section_id": section_data.get("parent_section_id", ""),

                    # Summary (used for vector search)
                    "summary": summary,

                    # Full content (retrieved when summary matches)
                    "full_content": full_content,

                    # Subjects and topics
                    "subjects": section_data.get("subjects", []),
                    "key_topics": section_data.get("key_topics", []),

                    # Storage type marker
                    "storage_type": "section_summary",  # Distinguish from old chunks

                    # Char counts
                    "summary_char_count": len(summary),
                    "content_char_count": len(full_content),
                }

                # Add session context
                if project_oenum:
                    payload["project_oenum"] = project_oenum
                if session_id:
                    payload["session_id"] = session_id

                # Add optional metadata
                if "metadata" in section_data:
                    payload["metadata"] = section_data["metadata"]

                # Create point with section_id as the point ID
                point = PointStruct(
                    id=section_id,  # Use section_id directly for easy retrieval
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
                logger.info(f"✅ Added {len(points)} section summaries to {collection_name}")
                return True
            else:
                logger.warning(f"⚠️ No valid section summaries to add")
                return False

        except Exception as e:
            logger.error(f"❌ Failed to add section summaries: {e}")
            return False

    def search_section_summaries(
        self,
        user_id: str,
        query: str,
        limit: int = 5,
        document_id: Optional[str] = None,
        score_threshold: float = 0.5,
        session_id: Optional[str] = None,
        project_oenum: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """
        Search section summaries and retrieve full section content from session-specific collection

        This method:
        1. Performs semantic search on summaries
        2. Returns full section content for matched sections

        Args:
            user_id: User identifier
            query: Search query text
            limit: Maximum number of results
            document_id: Optional filter by specific document
            score_threshold: Minimum similarity score (0.0 to 1.0)
            session_id: Optional session ID for general chats
            project_oenum: Optional project OE number for project chats

        Returns:
            List of results with full section content
        """
        collection_name = self._get_collection_name(user_id, session_id, project_oenum)

        try:
            # Generate query embedding
            query_embedding = self.generate_embedding(query)

            # Prepare filter for section summaries
            filter_conditions = [
                FieldCondition(
                    key="storage_type",
                    match=MatchValue(value="section_summary")
                )
            ]

            if document_id:
                filter_conditions.append(
                    FieldCondition(
                        key="document_id",
                        match=MatchValue(value=document_id)
                    )
                )

            search_filter = Filter(must=filter_conditions)

            # Perform search
            results = self.client.search(
                collection_name=collection_name,
                query_vector=query_embedding,
                limit=limit,
                query_filter=search_filter,
                score_threshold=score_threshold
            )

            # Format results with FULL CONTENT (not summary)
            formatted_results = []
            for result in results:
                formatted_results.append({
                    "section_id": result.payload.get("section_id", ""),
                    "score": result.score,

                    # Return FULL content for context
                    "text": result.payload.get("full_content", ""),
                    "full_content": result.payload.get("full_content", ""),

                    # Also include summary for reference
                    "summary": result.payload.get("summary", ""),

                    # Section metadata
                    "section_title": result.payload.get("section_title", ""),
                    "heading_level": result.payload.get("heading_level", 0),
                    "parent_section_id": result.payload.get("parent_section_id", ""),

                    # Topics
                    "subjects": result.payload.get("subjects", []),
                    "key_topics": result.payload.get("key_topics", []),

                    # Document reference
                    "document_id": result.payload.get("document_id", ""),

                    # Metadata
                    "metadata": result.payload.get("metadata", {})
                })

            logger.info(f"🔍 Found {len(formatted_results)} section matches for query")
            return formatted_results

        except Exception as e:
            logger.error(f"❌ Section summary search failed: {e}")
            return []

    def get_section_by_id(
        self,
        project_number: str,
        section_id: str
    ) -> Optional[Dict[str, Any]]:
        """
        Retrieve a specific section by its ID

        Args:
            project_number: Project OE number
            section_id: Section unique identifier

        Returns:
            Section data with full content, or None if not found
        """
        collection_name = self._get_collection_name(project_number)

        try:
            # Retrieve point by ID
            points = self.client.retrieve(
                collection_name=collection_name,
                ids=[section_id]
            )

            if not points:
                logger.warning(f"⚠️ Section {section_id} not found")
                return None

            point = points[0]

            return {
                "section_id": point.payload.get("section_id", ""),
                "section_title": point.payload.get("section_title", ""),
                "heading_level": point.payload.get("heading_level", 0),
                "parent_section_id": point.payload.get("parent_section_id", ""),
                "full_content": point.payload.get("full_content", ""),
                "summary": point.payload.get("summary", ""),
                "subjects": point.payload.get("subjects", []),
                "key_topics": point.payload.get("key_topics", []),
                "document_id": point.payload.get("document_id", ""),
                "metadata": point.payload.get("metadata", {})
            }

        except Exception as e:
            logger.error(f"❌ Failed to retrieve section {section_id}: {e}")
            return None
