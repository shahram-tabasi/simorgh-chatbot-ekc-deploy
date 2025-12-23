"""
Document Overview Service
==========================
Tracks all uploaded documents per project/chat and generates
brief overviews to be included in LLM context.

Author: Simorgh Industrial Assistant
"""

import logging
from typing import List, Dict, Any, Optional
from datetime import datetime
import json

logger = logging.getLogger(__name__)


class DocumentOverviewService:
    """
    Service for tracking and generating document overviews
    """

    def __init__(self, redis_service):
        """
        Initialize document overview service

        Args:
            redis_service: RedisService instance for storing document metadata
        """
        self.redis = redis_service

    def _get_project_docs_key(self, project_number: str) -> str:
        """Get Redis key for project documents"""
        return f"project:{project_number}:documents"

    def _get_chat_docs_key(self, chat_id: str) -> str:
        """Get Redis key for chat documents (general chat)"""
        return f"chat:{chat_id}:documents"

    def add_document(
        self,
        document_id: str,
        filename: str,
        document_type: str,
        category: str,
        key_topics: List[str],
        sections_count: int,
        total_chars: int,
        project_number: Optional[str] = None,
        chat_id: Optional[str] = None,
        user_id: Optional[str] = None,
        additional_metadata: Optional[Dict[str, Any]] = None
    ) -> bool:
        """
        Add document to tracking system

        Args:
            document_id: Unique document identifier
            filename: Original filename
            document_type: Type of document (Spec, Drawing, Report, etc.)
            category: Category (Client, Internal, etc.)
            key_topics: List of detected topics/subjects
            sections_count: Number of sections in document
            total_chars: Total character count
            project_number: Project OE number (for project chat)
            chat_id: Chat ID (for general chat or project chat)
            user_id: User who uploaded
            additional_metadata: Optional additional metadata

        Returns:
            True if successful
        """
        try:
            document_metadata = {
                "document_id": document_id,
                "filename": filename,
                "document_type": document_type,
                "category": category,
                "key_topics": key_topics,
                "sections_count": sections_count,
                "total_chars": total_chars,
                "uploaded_at": datetime.utcnow().isoformat(),
                "uploaded_by": user_id or "unknown",
                "project_number": project_number or "",
                "chat_id": chat_id or ""
            }

            # Add additional metadata if provided
            if additional_metadata:
                document_metadata.update(additional_metadata)

            # Store in appropriate location
            if project_number:
                key = self._get_project_docs_key(project_number)
            elif chat_id:
                key = self._get_chat_docs_key(chat_id)
            else:
                logger.error("❌ Must provide either project_number or chat_id")
                return False

            # Get existing documents list
            existing_docs = self.redis.get(key, db="chat") or []

            # Add new document
            existing_docs.append(document_metadata)

            # Store back
            self.redis.set(
                key,
                existing_docs,
                ttl=None,  # No expiration
                db="chat"
            )

            logger.info(f"✅ Tracked document: {filename} ({document_type}/{category})")
            return True

        except Exception as e:
            logger.error(f"❌ Failed to add document to tracking: {e}")
            return False

    def get_documents(
        self,
        project_number: Optional[str] = None,
        chat_id: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """
        Get all documents for a project or chat

        Args:
            project_number: Project OE number
            chat_id: Chat ID

        Returns:
            List of document metadata dictionaries
        """
        try:
            if project_number:
                key = self._get_project_docs_key(project_number)
            elif chat_id:
                key = self._get_chat_docs_key(chat_id)
            else:
                logger.error("❌ Must provide either project_number or chat_id")
                return []

            documents = self.redis.get(key, db="chat") or []
            return documents

        except Exception as e:
            logger.error(f"❌ Failed to get documents: {e}")
            return []

    def generate_overview(
        self,
        project_number: Optional[str] = None,
        chat_id: Optional[str] = None,
        max_documents: Optional[int] = None
    ) -> str:
        """
        Generate a brief overview of all documents

        Args:
            project_number: Project OE number
            chat_id: Chat ID
            max_documents: Optional limit on number of documents to include

        Returns:
            Formatted overview string for LLM context
        """
        try:
            documents = self.get_documents(
                project_number=project_number,
                chat_id=chat_id
            )

            if not documents:
                return ""

            # Sort by upload date (most recent first)
            documents.sort(
                key=lambda d: d.get("uploaded_at", ""),
                reverse=True
            )

            # Limit if specified
            if max_documents:
                documents = documents[:max_documents]

            # Build overview
            overview_parts = [
                f"## 📚 Uploaded Documents Overview ({len(documents)} document{'s' if len(documents) != 1 else ''})\n",
                "The following documents have been uploaded to this project/chat:\n"
            ]

            for idx, doc in enumerate(documents, 1):
                filename = doc.get("filename", "Unknown")
                doc_type = doc.get("document_type", "Unknown")
                category = doc.get("category", "Unknown")
                key_topics = doc.get("key_topics", [])
                sections_count = doc.get("sections_count", 0)
                uploaded_at = doc.get("uploaded_at", "")

                # Format upload time
                try:
                    upload_dt = datetime.fromisoformat(uploaded_at.replace('Z', '+00:00'))
                    time_str = upload_dt.strftime("%Y-%m-%d %H:%M UTC")
                except:
                    time_str = "Unknown time"

                overview_parts.append(f"\n**{idx}. {filename}**")
                overview_parts.append(f"   - Type: {doc_type} | Category: {category}")
                overview_parts.append(f"   - Sections: {sections_count}")

                # Safely handle key_topics (could be list, int, or other type)
                if key_topics:
                    if isinstance(key_topics, list):
                        topics_str = ", ".join(str(t) for t in key_topics[:5])  # Limit to 5 topics
                        if len(key_topics) > 5:
                            topics_str += f" (+{len(key_topics) - 5} more)"
                        overview_parts.append(f"   - Key Topics: {topics_str}")
                    elif isinstance(key_topics, (str, int)):
                        overview_parts.append(f"   - Key Topics: {key_topics}")

                overview_parts.append(f"   - Uploaded: {time_str}")

            overview_parts.append("\n**Note:** These documents have been processed and are available for semantic search.")

            return "\n".join(overview_parts)

        except Exception as e:
            logger.error(f"❌ Failed to generate overview: {e}")
            return ""

    def get_document_count(
        self,
        project_number: Optional[str] = None,
        chat_id: Optional[str] = None
    ) -> int:
        """
        Get count of documents

        Args:
            project_number: Project OE number
            chat_id: Chat ID

        Returns:
            Number of documents
        """
        documents = self.get_documents(
            project_number=project_number,
            chat_id=chat_id
        )
        return len(documents)

    def get_document_by_id(
        self,
        document_id: str,
        project_number: Optional[str] = None,
        chat_id: Optional[str] = None
    ) -> Optional[Dict[str, Any]]:
        """
        Get specific document metadata by ID

        Args:
            document_id: Document unique identifier
            project_number: Project OE number
            chat_id: Chat ID

        Returns:
            Document metadata or None if not found
        """
        documents = self.get_documents(
            project_number=project_number,
            chat_id=chat_id
        )

        for doc in documents:
            if doc.get("document_id") == document_id:
                return doc

        return None

    def delete_document(
        self,
        document_id: str,
        project_number: Optional[str] = None,
        chat_id: Optional[str] = None
    ) -> bool:
        """
        Remove document from tracking

        Args:
            document_id: Document unique identifier
            project_number: Project OE number
            chat_id: Chat ID

        Returns:
            True if successful
        """
        try:
            if project_number:
                key = self._get_project_docs_key(project_number)
            elif chat_id:
                key = self._get_chat_docs_key(chat_id)
            else:
                logger.error("❌ Must provide either project_number or chat_id")
                return False

            documents = self.redis.get(key, db="chat") or []

            # Filter out the document
            updated_docs = [
                doc for doc in documents
                if doc.get("document_id") != document_id
            ]

            if len(updated_docs) == len(documents):
                logger.warning(f"⚠️ Document {document_id} not found in tracking")
                return False

            # Store updated list
            self.redis.set(
                key,
                updated_docs,
                ttl=None,
                db="chat"
            )

            logger.info(f"✅ Removed document {document_id} from tracking")
            return True

        except Exception as e:
            logger.error(f"❌ Failed to delete document from tracking: {e}")
            return False

    def get_statistics(
        self,
        project_number: Optional[str] = None,
        chat_id: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Get statistics about documents

        Args:
            project_number: Project OE number
            chat_id: Chat ID

        Returns:
            Statistics dictionary
        """
        documents = self.get_documents(
            project_number=project_number,
            chat_id=chat_id
        )

        if not documents:
            return {
                "total_documents": 0,
                "by_type": {},
                "by_category": {},
                "total_sections": 0,
                "total_chars": 0
            }

        # Calculate statistics
        by_type = {}
        by_category = {}
        total_sections = 0
        total_chars = 0

        for doc in documents:
            doc_type = doc.get("document_type", "Unknown")
            category = doc.get("category", "Unknown")

            by_type[doc_type] = by_type.get(doc_type, 0) + 1
            by_category[category] = by_category.get(category, 0) + 1

            total_sections += doc.get("sections_count", 0)
            total_chars += doc.get("total_chars", 0)

        return {
            "total_documents": len(documents),
            "by_type": by_type,
            "by_category": by_category,
            "total_sections": total_sections,
            "total_chars": total_chars,
            "avg_sections_per_doc": total_sections / len(documents) if documents else 0
        }
