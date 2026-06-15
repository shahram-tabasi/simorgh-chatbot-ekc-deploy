"""
Qdrant Vector Database Service
================================
Manages document chunk storage and semantic search using Qdrant.
Each project has isolated vector space for document chunks.
Also manages user conversation memory for long-term context.

Author: Simorgh Industrial Assistant
"""

import os
import json
import logging
import urllib.request
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

# ---------------------------------------------------------------------------
# Unified document collection — MUST match project-agent-service's
# qdrant_service constants exactly. Uploads are written by project-agent
# into ONE collection partitioned by the tenant_id payload field; this
# service only READS that collection (the search_project_documents /
# retrieve_chunks MCP tools), so it must target the same collection name,
# the same tenant key scheme, AND the same embedding model/dimension.
#
# Embedding parity is critical: project-agent embeds via embeddings-service
# (768-dim). This service historically fell back to SentenceTransformer
# MiniLM (384-dim) because main.py passes llm_service=None — which made
# every project-document search a dimension mismatch that returned nothing.
# _embed_query below pins query embeddings to embeddings-service so stored
# and query vectors are produced by the same model.
# ---------------------------------------------------------------------------
DOCS_COLLECTION = os.getenv("QDRANT_DOCS_COLLECTION", "project_documents")
TENANT_FIELD = "tenant_id"
EMBEDDINGS_URL = os.getenv("EMBEDDINGS_URL", "http://embeddings-service:8031")


def _tenant_of(session_id: Optional[str], project_oenum: Optional[str]) -> str:
    if project_oenum:
        return f"project:{str(project_oenum).strip().lower()}"
    if session_id:
        return f"session:{str(session_id).strip().lower()}"
    raise ValueError(
        "Either session_id or project_oenum must be provided for tenant isolation"
    )


def _embed_query(text: str, timeout: int = 30) -> List[float]:
    """Embed via the shared embeddings-service so query vectors match the
    vectors project-agent stored. Contract: POST /embeddings {"text": ...}
    → {"embedding": [...]}."""
    req = urllib.request.Request(
        f"{EMBEDDINGS_URL}/embeddings",
        data=json.dumps({"text": text}).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r).get("embedding", [])


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

                # Prepare payload with session context. Phase 0 schema:
                # `filename` and `heading_path` are first-class fields so
                # list_documents/get_document_text/_scroll_tenant don't
                # have to dig through metadata or rely on the old
                # "section_title = filename" hack (which made it
                # impossible to also store the real heading).
                #
                # Backwards-compat: old chunks have filename=None and
                # section_title=<filename>; readers fall back to
                # section_title when filename is absent.
                meta = chunk.get("metadata") or {}
                filename_field = (
                    chunk.get("filename")
                    or meta.get("filename")
                    or ""
                )
                heading_path = (
                    chunk.get("heading_path")
                    or meta.get("heading_path")
                    or ""
                )
                payload = {
                    "document_id": document_id,
                    "user_id": user_id,
                    "text": text,
                    "filename": filename_field,
                    "section_title": chunk.get("section_title", ""),
                    "heading_path": heading_path,
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
        # Unified collection + tenant filter (must match project-agent's
        # write path). Embed the query via embeddings-service for parity
        # with the stored vectors.
        collection_name = DOCS_COLLECTION
        tenant_id = _tenant_of(session_id, project_oenum)

        try:
            # Generate query embedding via the shared service (768-dim).
            query_embedding = _embed_query(query)

            must = [
                FieldCondition(key=TENANT_FIELD, match=MatchValue(value=tenant_id))
            ]
            if document_id:
                must.append(
                    FieldCondition(key="document_id", match=MatchValue(value=document_id))
                )
            search_filter = Filter(must=must)

            # If the unified collection doesn't exist yet, don't error.
            try:
                exists = any(
                    c.name == collection_name
                    for c in self.client.get_collections().collections
                )
            except Exception:
                exists = True
            if not exists:
                logger.info("docs collection %s absent — no results", collection_name)
                return []

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

    def _scroll_tenant(self, tenant_id: str, document_id: Optional[str] = None,
                       filename: Optional[str] = None):
        """Scroll ALL points for a tenant (optionally one document, by id or
        by filename) from the unified collection. Payload-only; no vectors.
        Returns [] if the collection doesn't exist yet."""
        try:
            exists = any(
                c.name == DOCS_COLLECTION
                for c in self.client.get_collections().collections
            )
        except Exception:
            exists = True
        if not exists:
            return []
        must = [FieldCondition(key=TENANT_FIELD, match=MatchValue(value=tenant_id))]
        if document_id:
            must.append(
                FieldCondition(key="document_id", match=MatchValue(value=document_id))
            )
        should = None
        if filename:
            # Phase 0: new chunks carry `filename` as a first-class field.
            # Old chunks (pre-Phase 0) store filename in `section_title`
            # because of the original "section_title = filename" hack —
            # match either with a should-clause so both schemas resolve.
            should = [
                FieldCondition(key="filename", match=MatchValue(value=filename)),
                FieldCondition(key="section_title", match=MatchValue(value=filename)),
            ]
        flt = Filter(must=must, should=should) if should else Filter(must=must)
        out, offset = [], None
        while True:
            points, offset = self.client.scroll(
                collection_name=DOCS_COLLECTION,
                scroll_filter=flt,
                limit=256,
                with_payload=True,
                with_vectors=False,
                offset=offset,
            )
            out.extend(points)
            if offset is None:
                break
        return out

    def list_documents(
        self,
        user_id: str,
        session_id: Optional[str] = None,
        project_oenum: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """List the distinct documents indexed for a tenant: one row per
        document_id with its filename and chunk count. Lets the agent see
        WHAT files exist before searching/reading them."""
        tenant_id = _tenant_of(session_id, project_oenum)
        try:
            points = self._scroll_tenant(tenant_id)
        except Exception as e:
            logger.error(f"❌ list_documents failed: {e}")
            return []
        docs: Dict[str, Dict[str, Any]] = {}
        for p in points:
            pl = p.payload or {}
            did = pl.get("document_id") or ""
            if not did:
                continue
            # Filename resolution order (Phase 0): top-level `filename`
            # (new chunks) → metadata.filename → section_title (legacy
            # chunks where filename was stuffed into section_title).
            d = docs.setdefault(did, {
                "document_id": did,
                "filename": pl.get("filename")
                            or (pl.get("metadata") or {}).get("filename")
                            or pl.get("section_title") or "",
                "chunk_count": 0,
            })
            d["chunk_count"] += 1
        return list(docs.values())

    def get_document_text(
        self,
        document_id: Optional[str] = None,
        user_id: str = "system",
        session_id: Optional[str] = None,
        project_oenum: Optional[str] = None,
        filename: Optional[str] = None,
        max_chars: int = 20000,
    ) -> Dict[str, Any]:
        """Reconstruct a single document's full text by concatenating its
        chunks in chunk_index order (capped at max_chars). Resolve by
        document_id OR filename — prefer filename, which the planner knows
        at plan time (the runtime document_id UUID is only known AFTER
        list_project_documents runs, and the executor can't pass values
        between steps)."""
        tenant_id = _tenant_of(session_id, project_oenum)
        try:
            points = self._scroll_tenant(
                tenant_id, document_id=document_id, filename=filename
            )
            # Fuzzy fallback: exact filename match found nothing. The LLM
            # often slightly garbles the (Persian/Arabic) filename — extra
            # "ال" article, a stray space, different normalization. Pick the
            # tenant's document whose filename is CLOSEST (difflib ratio),
            # so a near-miss still resolves instead of returning empty.
            if not points and filename:
                import difflib
                want = filename.strip().lower()
                all_pts = self._scroll_tenant(tenant_id)
                names = {}
                for p in all_pts:
                    pl = p.payload or {}
                    # Phase 0: prefer the first-class filename field; fall
                    # back to legacy hiding spots for old chunks.
                    nm = str(pl.get("filename")
                             or (pl.get("metadata") or {}).get("filename")
                             or pl.get("section_title") or "")
                    if nm:
                        names.setdefault(nm, []).append(p)
                best, best_score = None, 0.0
                for nm in names:
                    score = difflib.SequenceMatcher(None, want, nm.lower()).ratio()
                    # token overlap helps for "الموجودی انبار" vs "موجودی انبار"
                    if want in nm.lower() or nm.lower() in want:
                        score = max(score, 0.9)
                    if score > best_score:
                        best, best_score = nm, score
                if best and best_score >= 0.6:
                    points = names[best]
        except Exception as e:
            logger.error(f"❌ get_document_text failed: {e}")
            # content_kind="error" — distinct from "stub" so the caller can
            # choose to retry vs treat as no-content.
            return {"document_id": document_id, "filename": filename or "",
                    "text": "", "content": "", "content_kind": "error",
                    "chunk_count": 0, "error": str(e)[:200]}
        # Sort by chunk_index when present (legacy chunk schema), else by
        # (heading_level, section_id) which mirrors document order for the
        # section-summary schema (Phase 0 upload path stores those).
        chunks = sorted(
            (p.payload or {} for p in points),
            key=lambda pl: (
                pl.get("chunk_index") if "chunk_index" in pl else 10**9,
                pl.get("heading_level", 0),
                str(pl.get("section_id") or ""),
            ),
        )
        out_name = filename or ""
        parts: List[str] = []
        for pl in chunks:
            # Phase 0: try the new first-class `filename` field before
            # falling back to old hiding spots.
            out_name = (out_name
                        or pl.get("filename")
                        or (pl.get("metadata") or {}).get("filename")
                        or pl.get("section_title") or "")
            # Section-summary points carry the real prose in `full_content`;
            # legacy chunk points carry it in `text`. Prefer whichever has
            # actual content. `summary` is the LLM-generated abstract —
            # useful, but full_content is authoritative for grounding.
            body = (
                pl.get("full_content")
                or pl.get("text")
                or pl.get("summary")
                or ""
            )
            if body:
                # Prepend the section heading so the model can cite it.
                hdr = pl.get("section_title") or ""
                parts.append((f"## {hdr}\n{body}" if hdr else body))
        text = "\n\n".join(parts)[:max_chars]

        # Content-kind contract (Commit A of the grounding pipeline):
        #   "indexed" → real document text reassembled from chunks
        #   "stub"    → catalogued (filename known) but no extracted content
        #               in Qdrant; common when a PDF was registered but not
        #               text-indexed at upload time. Callers MUST treat
        #               "stub" as no-content for grounding purposes and
        #               fall back to a fresh extraction path (gitlab-mcp
        #               via doc-processor, etc.).
        #   "error"  → exception path above.
        # The "text" key is retained for backwards-compat; "content" is
        # the canonical field going forward.
        has_chunks = len(chunks) > 0
        has_text = bool(text.strip())
        if has_text and has_chunks:
            kind = "indexed"
        else:
            kind = "stub"

        return {
            "document_id": document_id or "",
            "filename": out_name,
            "text": text,            # back-compat alias
            "content": text,         # canonical
            "content_kind": kind,
            "chunk_count": len(chunks),
        }

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
        project_oenum: Optional[str] = None,
        filename: Optional[str] = None,
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
            # Phase 1.3: precompute heading_path breadcrumbs by walking
            # parent_section_id chains. Indexed once here so search-side
            # retrieval doesn't need to do graph walks.
            by_id = {
                s.get("section_id"): s for s in section_summaries
                if s.get("section_id")
            }

            def _breadcrumb(s: Dict[str, Any]) -> str:
                titles: List[str] = []
                cur = s
                seen = set()
                for _ in range(16):  # safety cap on chain depth
                    sid = cur.get("section_id")
                    if not sid or sid in seen:
                        break
                    seen.add(sid)
                    t = (cur.get("section_title") or "").strip()
                    if t:
                        titles.append(t)
                    pid = cur.get("parent_section_id")
                    if not pid:
                        break
                    parent = by_id.get(pid)
                    if not parent:
                        break
                    cur = parent
                return "/" + "/".join(reversed(titles)) if titles else ""

            points = []

            for section_data in section_summaries:
                # Inject the computed heading_path back into the section
                # dict so the payload-build below picks it up via the
                # heading_path fallback we added in Phase 0.
                if not section_data.get("heading_path"):
                    section_data["heading_path"] = _breadcrumb(section_data)
                section_id = section_data.get("section_id")
                summary = section_data.get("summary", "")
                full_content = section_data.get("full_content", "")

                if not summary or not full_content:
                    logger.warning(f"⚠️ Empty summary or content for section {section_id}, skipping")
                    continue

                # Generate embedding from SUMMARY (not full content)
                # This allows semantic search on high-level topics
                embedding = self.generate_embedding(summary)

                # Phase 0: filename + heading_path as first-class fields.
                # filename comes from the caller (was completely missing
                # before, leaving list_documents blind to summary-shaped
                # uploads); heading_path falls back to section_title when
                # the chunker hasn't computed it yet — Phase 1 will fill
                # the full breadcrumb (e.g. "/2 Scope/2.1.3 CTs").
                _meta = section_data.get("metadata") or {}
                _fn = (
                    filename
                    or section_data.get("filename")
                    or _meta.get("filename")
                    or ""
                )
                _heading_path = (
                    section_data.get("heading_path")
                    or _meta.get("heading_path")
                    or section_data.get("section_title", "")
                )
                # Prepare payload with both summary and full content
                payload = {
                    "document_id": document_id,
                    "user_id": user_id,
                    "filename": _fn,
                    "section_id": section_id,
                    "section_title": section_data.get("section_title", ""),
                    "heading_level": section_data.get("heading_level", 0),
                    "heading_path": _heading_path,
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

    def search_relevant_sections(
        self,
        query: str,
        project_oenum: Optional[str] = None,
        session_id: Optional[str] = None,
        top_k: int = 5,
        score_threshold: float = 0.25,
    ) -> List[Dict[str, Any]]:
        """Phase 1 (small-to-big): tenant-scoped section search over the
        unified `project_documents` collection.

        Why this exists alongside `search_section_summaries`:
        the older helper uses `_get_collection_name`, which targets a
        per-session collection — but `add_section_summaries` writes to
        the UNIFIED `project_documents` collection with a `tenant_id`
        payload filter. So the older helper searches an empty namespace
        and silently returns []. This helper queries the right place.

        Returns one hit per matching section with:
          score, filename, section_title, heading_level, heading_path,
          full_content, summary, parent_section_id, document_id.

        Ordering is by descending similarity; the caller is expected to
        re-order with the lost-in-the-middle sandwich pattern before
        injecting into the prompt.
        """
        if not query or not query.strip():
            return []
        try:
            tenant_id = _tenant_of(session_id, project_oenum)
            qvec = self.generate_embedding(query)
            must = [
                FieldCondition(key=TENANT_FIELD,
                               match=MatchValue(value=tenant_id)),
                FieldCondition(key="storage_type",
                               match=MatchValue(value="section_summary")),
            ]
            results = self.client.search(
                collection_name=DOCS_COLLECTION,
                query_vector=qvec,
                limit=top_k,
                query_filter=Filter(must=must),
                score_threshold=score_threshold,
            )
            out: List[Dict[str, Any]] = []
            for r in results:
                pl = r.payload or {}
                out.append({
                    "score": float(r.score) if r.score is not None else 0.0,
                    "filename": (pl.get("filename")
                                 or (pl.get("metadata") or {}).get("filename")
                                 or ""),
                    "section_id": pl.get("section_id", ""),
                    "section_title": pl.get("section_title", ""),
                    "heading_level": pl.get("heading_level", 0),
                    "heading_path": pl.get("heading_path", ""),
                    "parent_section_id": pl.get("parent_section_id", ""),
                    "full_content": pl.get("full_content") or pl.get("text", ""),
                    "summary": pl.get("summary", ""),
                    "document_id": pl.get("document_id", ""),
                })
            logger.info(
                "search_relevant_sections: query_len=%d tenant=%s hits=%d",
                len(query), tenant_id, len(out))
            return out
        except Exception as e:
            logger.error(f"❌ search_relevant_sections failed: {e}")
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
