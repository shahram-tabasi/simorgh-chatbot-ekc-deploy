"""
Vector RAG Service
==================
Qdrant-based Retrieval Augmented Generation for general chat sessions.
Handles document chunking, embedding, and semantic search.

Author: Simorgh Industrial Assistant
"""

import os
import logging
import hashlib
from typing import List, Dict, Any, Optional, Tuple
from pathlib import Path
import re

from qdrant_client import QdrantClient
from qdrant_client.models import (
    Distance, VectorParams, PointStruct,
    Filter, FieldCondition, MatchValue
)
import openai

logger = logging.getLogger(__name__)


class VectorRAG:
    """
    DEPRECATED: Use QdrantService with session-specific collections instead
    Vector RAG using Qdrant for general chat documents (kept for backward compatibility)

    NOTE: This class is being phased out in favor of using QdrantService directly
    with session-specific collection isolation.
    """

    def __init__(
        self,
        qdrant_url: str = None,
        openai_api_key: str = None,
        collection_name: str = None,
        llm_service=None,
        embedding_dim: Optional[int] = None,
        user_id: Optional[str] = None,
        session_id: Optional[str] = None
    ):
        """
        Initialize Vector RAG with session isolation support

        Args:
            qdrant_url: Qdrant service URL
            openai_api_key: OpenAI API key for embeddings (fallback if no llm_service)
            collection_name: DEPRECATED - use user_id + session_id instead
            llm_service: Optional LLMService instance for LLM-based embeddings
            embedding_dim: Optional explicit embedding dimension (auto-detected if not provided)
            user_id: User identifier (required for session isolation)
            session_id: Session ID (required for session isolation)
        """
        self.qdrant_url = qdrant_url or os.getenv("QDRANT_URL", "http://qdrant:6333")
        self.openai_api_key = openai_api_key or os.getenv("OPENAI_API_KEY")

        # Session isolation support
        self.user_id = user_id
        self.session_id = session_id

        # Generate session-specific collection name
        if user_id and session_id:
            user_id_clean = user_id.replace("-", "_").replace(" ", "_").replace(".", "_").lower()
            session_clean = session_id.replace("-", "_").replace(" ", "_").lower()
            self.collection_name = f"user_{user_id_clean}_session_{session_clean}"
            logger.info(f"✅ Session-isolated collection: {self.collection_name}")
        elif collection_name:
            self.collection_name = collection_name
            logger.warning(f"⚠️ Using legacy non-isolated collection: {collection_name}")
        else:
            # Fallback for backward compatibility
            self.collection_name = "general_docs"
            logger.warning(f"⚠️ No session isolation - using default collection: {self.collection_name}")

        # Initialize Qdrant client
        self.qdrant = QdrantClient(url=self.qdrant_url)

        # Initialize embedding generation
        self.llm_service = llm_service

        if self.llm_service:
            # Use LLM-based embeddings (better for domain-specific content)
            logger.info(f"🔄 Using LLM-based embeddings for VectorRAG")

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

            self.embedding_model = None  # Not using direct OpenAI API
        else:
            # Fallback to direct OpenAI embeddings (legacy mode)
            openai.api_key = self.openai_api_key
            self.embedding_model = "text-embedding-3-small"  # 1536 dimensions, fast
            self.embedding_dim = 1536
            logger.info(f"✅ Using OpenAI embeddings: {self.embedding_model}")

        # Chunking configuration
        self.chunk_size = 1000  # characters
        self.chunk_overlap = 200  # characters

        # Ensure collection exists
        self._ensure_collection()

        logger.info(f"✅ VectorRAG initialized: {self.qdrant_url}, collection={self.collection_name}")

    def _ensure_collection(self):
        """Create collection if it doesn't exist"""
        try:
            collections = self.qdrant.get_collections().collections
            exists = any(c.name == self.collection_name for c in collections)

            if not exists:
                self.qdrant.create_collection(
                    collection_name=self.collection_name,
                    vectors_config=VectorParams(
                        size=self.embedding_dim,
                        distance=Distance.COSINE
                    )
                )
                logger.info(f"✅ Created Qdrant collection: {self.collection_name}")
        except Exception as e:
            logger.error(f"❌ Failed to ensure collection: {e}")
            raise

    def chunk_markdown(self, markdown: str, metadata: Dict[str, Any] = None) -> List[Dict[str, Any]]:
        """
        Chunk markdown document semantically

        Strategy:
        1. Split by headers (##, ###) to preserve structure
        2. Further split large sections by paragraphs
        3. Maintain chunk_size with chunk_overlap

        Args:
            markdown: Markdown content
            metadata: Optional metadata to attach to chunks

        Returns:
            List of chunks with metadata
        """
        chunks = []
        metadata = metadata or {}

        # Split by headers (preserve hierarchy)
        sections = re.split(r'\n(#{1,3}\s+.+)', markdown)

        current_section = ""
        current_header = ""

        for i, part in enumerate(sections):
            # Check if this is a header
            if re.match(r'^#{1,3}\s+', part):
                # Process previous section if it exists
                if current_section:
                    chunks.extend(self._chunk_section(
                        current_section,
                        current_header,
                        metadata
                    ))

                # Start new section
                current_header = part.strip()
                current_section = ""
            else:
                current_section += part

        # Process final section
        if current_section:
            chunks.extend(self._chunk_section(
                current_section,
                current_header,
                metadata
            ))

        # Add position index
        for idx, chunk in enumerate(chunks):
            chunk['position'] = idx

        logger.info(f"Created {len(chunks)} chunks from document")
        return chunks

    def _chunk_section(
        self,
        text: str,
        header: str,
        metadata: Dict[str, Any]
    ) -> List[Dict[str, Any]]:
        """Chunk a single section"""
        chunks = []

        # Clean text
        text = text.strip()
        if not text:
            return chunks

        # If section is small enough, return as single chunk
        if len(text) <= self.chunk_size:
            chunks.append({
                'text': text,
                'header': header,
                **metadata
            })
            return chunks

        # Split by paragraphs first
        paragraphs = re.split(r'\n\n+', text)

        current_chunk = ""
        for para in paragraphs:
            # If adding this paragraph exceeds chunk_size, save current chunk
            if current_chunk and len(current_chunk) + len(para) > self.chunk_size:
                chunks.append({
                    'text': current_chunk.strip(),
                    'header': header,
                    **metadata
                })

                # Start new chunk with overlap
                overlap_text = current_chunk[-self.chunk_overlap:] if len(current_chunk) > self.chunk_overlap else current_chunk
                current_chunk = overlap_text + "\n\n" + para
            else:
                current_chunk += "\n\n" + para if current_chunk else para

        # Add final chunk
        if current_chunk.strip():
            chunks.append({
                'text': current_chunk.strip(),
                'header': header,
                **metadata
            })

        return chunks

    async def embed_text(self, text: str) -> List[float]:
        """
        Generate embedding for text

        Uses LLM-based embeddings if llm_service is configured,
        otherwise falls back to direct OpenAI API.

        Args:
            text: Text to embed

        Returns:
            Embedding vector
        """
        try:
            if self.llm_service:
                # Use LLM-based embeddings for better domain-specific understanding
                embedding = self.llm_service.generate_embedding(text)
                return embedding
            else:
                # Fallback to direct OpenAI API (legacy mode)
                response = openai.Embedding.create(
                    model=self.embedding_model,
                    input=text
                )
                return response['data'][0]['embedding']
        except Exception as e:
            logger.error(f"❌ Embedding failed: {e}")
            raise

    async def index_document(
        self,
        markdown_content: str,
        user_id: str,
        filename: str,
        doc_id: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Index a markdown document for a user

        Args:
            markdown_content: Markdown text
            user_id: User ID (for filtering)
            filename: Original filename
            doc_id: Optional document ID (auto-generated if not provided)

        Returns:
            Indexing result with statistics
        """
        # Generate doc_id if not provided
        if not doc_id:
            doc_id = hashlib.md5(f"{user_id}_{filename}".encode()).hexdigest()

        logger.info(f"📥 Indexing document: {filename} for user {user_id}")

        # Chunk document
        chunks = self.chunk_markdown(
            markdown_content,
            metadata={
                'user_id': user_id,
                'filename': filename,
                'doc_id': doc_id
            }
        )

        # Generate embeddings and create points
        points = []
        for chunk in chunks:
            try:
                embedding = await self.embed_text(chunk['text'])

                # Prepare payload with session context
                payload = {
                    'user_id': user_id,
                    'doc_id': doc_id,
                    'filename': filename,
                    'text': chunk['text'],
                    'header': chunk.get('header', ''),
                    'position': chunk['position']
                }

                # Add session context if available
                if self.session_id:
                    payload['session_id'] = self.session_id

                point = PointStruct(
                    id=hashlib.md5(
                        f"{doc_id}_{chunk['position']}".encode()
                    ).hexdigest(),
                    vector=embedding,
                    payload=payload
                )
                points.append(point)

            except Exception as e:
                logger.error(f"❌ Failed to embed chunk {chunk['position']}: {e}")
                continue

        # Upload to Qdrant
        try:
            self.qdrant.upsert(
                collection_name=self.collection_name,
                points=points
            )
            logger.info(f"✅ Indexed {len(points)} chunks for {filename}")

            return {
                "success": True,
                "doc_id": doc_id,
                "chunks_indexed": len(points),
                "filename": filename,
                "user_id": user_id
            }

        except Exception as e:
            logger.error(f"❌ Failed to upsert to Qdrant: {e}")
            return {
                "success": False,
                "error": str(e)
            }

    async def search(
        self,
        query: str,
        user_id: str,
        top_k: int = 5,
        score_threshold: float = 0.7
    ) -> List[Dict[str, Any]]:
        """
        Search for relevant chunks

        Args:
            query: Search query
            user_id: User ID (for filtering)
            top_k: Number of results to return
            score_threshold: Minimum similarity score

        Returns:
            List of relevant chunks with scores
        """
        try:
            # Generate query embedding
            query_embedding = await self.embed_text(query)

            # Search in Qdrant with user filter
            results = self.qdrant.search(
                collection_name=self.collection_name,
                query_vector=query_embedding,
                query_filter=Filter(
                    must=[
                        FieldCondition(
                            key="user_id",
                            match=MatchValue(value=user_id)
                        )
                    ]
                ),
                limit=top_k,
                score_threshold=score_threshold
            )

            # Format results
            chunks = []
            for result in results:
                chunks.append({
                    'text': result.payload['text'],
                    'filename': result.payload['filename'],
                    'header': result.payload.get('header', ''),
                    'score': result.score,
                    'position': result.payload.get('position', 0)
                })

            logger.info(f"🔍 Found {len(chunks)} relevant chunks for query: {query[:50]}...")
            return chunks

        except Exception as e:
            logger.error(f"❌ Search failed: {e}")
            return []

    async def delete_document(self, user_id: str, doc_id: str) -> bool:
        """Delete all chunks for a document"""
        try:
            self.qdrant.delete(
                collection_name=self.collection_name,
                points_selector=Filter(
                    must=[
                        FieldCondition(key="user_id", match=MatchValue(value=user_id)),
                        FieldCondition(key="doc_id", match=MatchValue(value=doc_id))
                    ]
                )
            )
            logger.info(f"🗑️ Deleted document chunks: {doc_id}")
            return True
        except Exception as e:
            logger.error(f"❌ Failed to delete document: {e}")
            return False

    async def get_user_stats(self, user_id: str) -> Dict[str, Any]:
        """Get indexing statistics for a user"""
        try:
            # Count points for user
            result = self.qdrant.scroll(
                collection_name=self.collection_name,
                scroll_filter=Filter(
                    must=[
                        FieldCondition(key="user_id", match=MatchValue(value=user_id))
                    ]
                ),
                limit=10000,  # Max to count
                with_payload=True,
                with_vectors=False
            )

            chunks = result[0]
            total_chunks = len(chunks)

            # Count unique documents
            doc_ids = set(chunk.payload['doc_id'] for chunk in chunks)

            return {
                "user_id": user_id,
                "total_documents": len(doc_ids),
                "total_chunks": total_chunks,
                "collection": self.collection_name
            }

        except Exception as e:
            logger.error(f"❌ Failed to get user stats: {e}")
            return {"error": str(e)}
