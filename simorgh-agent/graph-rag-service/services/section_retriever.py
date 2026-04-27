"""
Section Retriever Service
==========================
Orchestrates the enhanced document processing pipeline:
1. Extract hierarchical sections from documents
2. Generate LLM summaries for each section
3. Store in Qdrant (summaries for search, full content for retrieval)
4. Retrieve full sections based on summary matches

Author: Simorgh Industrial Assistant
"""

import logging
from typing import List, Dict, Any, Optional

from services.document_chunker import DocumentChunker
from services.section_summarizer import SectionSummarizer
from services.qdrant_service import QdrantService

logger = logging.getLogger(__name__)


class SectionRetriever:
    """
    Service for enhanced document processing and retrieval
    """

    def __init__(
        self,
        llm_service,
        qdrant_service: Optional[QdrantService] = None
    ):
        """
        Initialize section retriever

        Args:
            llm_service: LLMService instance for summarization
            qdrant_service: Optional QdrantService instance (created if None)
        """
        self.llm_service = llm_service
        self.qdrant_service = qdrant_service
        self.chunker = DocumentChunker()
        self.summarizer = SectionSummarizer(llm_service)

    def process_and_store_document(
        self,
        markdown_content: str,
        project_number: str,
        document_id: str,
        filename: str,
        document_type_hint: str = "",
        llm_mode: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Complete pipeline: Extract sections → Summarize → Store in Qdrant

        Args:
            markdown_content: Document content in markdown
            project_number: Project OE number
            document_id: Unique document identifier
            filename: Original filename
            document_type_hint: Optional hint about document type (for better summarization)
            llm_mode: Optional LLM mode (online/offline)

        Returns:
            Result dictionary with statistics
        """
        try:
            logger.info(f"🚀 Starting enhanced document processing: {filename}")

            # STEP 1: Extract hierarchical sections
            logger.info(f"📄 [1/3] Extracting hierarchical sections...")
            sections = self.chunker.extract_hierarchical_sections(
                markdown_content=markdown_content,
                document_id=document_id,
                filename=filename
            )

            if not sections:
                logger.warning(f"⚠️ No sections found in document {filename}")
                return {
                    "success": False,
                    "error": "No sections extracted from document"
                }

            section_stats = self.chunker.get_section_hierarchy_statistics(sections)
            logger.info(f"📊 Section extraction stats: {section_stats}")

            # Convert to dict format for summarizer
            sections_dict = self.chunker.sections_to_dict_format(sections)

            # STEP 2: Generate LLM summaries for all sections
            logger.info(f"🤖 [2/3] Generating LLM summaries for {len(sections)} sections...")
            section_summaries = self.summarizer.summarize_sections_batch(
                sections=sections_dict,
                context_hint=document_type_hint or f"Document: {filename}",
                llm_mode=llm_mode
            )

            if not section_summaries:
                logger.warning(f"⚠️ No summaries generated for {filename}")
                return {
                    "success": False,
                    "error": "Failed to generate summaries"
                }

            summary_stats = self.summarizer.get_summary_statistics(section_summaries)
            logger.info(f"📊 Summary stats: {summary_stats}")

            # STEP 3: Store in Qdrant (dual storage: summaries + full sections)
            logger.info(f"💾 [3/3] Storing {len(section_summaries)} section summaries in Qdrant...")

            # Convert SectionSummary objects to dict format for Qdrant
            section_data = []
            for summary_obj in section_summaries:
                section_data.append({
                    "section_id": summary_obj.section_id,
                    "section_title": summary_obj.section_title,
                    "heading_level": summary_obj.heading_level,
                    "parent_section_id": summary_obj.parent_section_id,
                    "summary": summary_obj.summary,
                    "full_content": summary_obj.full_content,
                    "subjects": summary_obj.subjects,
                    "key_topics": summary_obj.key_topics,
                    "metadata": summary_obj.metadata
                })

            # Store in Qdrant
            # Note: For project documents, we use a placeholder user_id since projects are user-agnostic
            storage_success = self.qdrant_service.add_section_summaries(
                user_id="system",  # System-level storage for project documents
                document_id=document_id,
                section_summaries=section_data,
                project_oenum=project_number  # Project OE number for session isolation
            )

            if not storage_success:
                logger.error(f"❌ Failed to store summaries in Qdrant")
                return {
                    "success": False,
                    "error": "Failed to store summaries in Qdrant"
                }

            logger.info(f"✅ Document processing complete: {filename}")

            return {
                "success": True,
                "document_id": document_id,
                "filename": filename,
                "sections_extracted": len(sections),
                "summaries_generated": len(section_summaries),
                "section_stats": section_stats,
                "summary_stats": summary_stats
            }

        except Exception as e:
            logger.error(f"❌ Enhanced document processing failed: {e}", exc_info=True)
            return {
                "success": False,
                "error": str(e)
            }

    def retrieve_relevant_sections(
        self,
        project_number: str,
        query: str,
        limit: int = 5,
        document_id: Optional[str] = None,
        score_threshold: float = 0.3
    ) -> Dict[str, Any]:
        """
        Retrieve relevant sections for a query

        Semantic search on summaries → Returns full section content

        Args:
            project_number: Project OE number
            query: User query
            limit: Maximum number of sections to retrieve
            document_id: Optional filter by specific document
            score_threshold: Minimum relevance score

        Returns:
            Dictionary with retrieved sections and metadata
        """
        try:
            logger.info(f"🔍 Searching for relevant sections: '{query[:50]}...'")

            # Search section summaries (returns full content)
            results = self.qdrant_service.search_section_summaries(
                user_id="system",  # System-level for project documents
                query=query,
                limit=limit,
                document_id=document_id,
                score_threshold=score_threshold,
                project_oenum=project_number  # Project OE number for session isolation
            )

            logger.info(f"✅ Retrieved {len(results)} relevant sections")

            return {
                "success": True,
                "sections": results,
                "count": len(results)
            }

        except Exception as e:
            logger.error(f"❌ Section retrieval failed: {e}")
            return {
                "success": False,
                "error": str(e),
                "sections": []
            }

    def format_sections_for_context(
        self,
        sections: List[Dict[str, Any]],
        max_sections: Optional[int] = None,
        include_subjects: bool = True
    ) -> str:
        """
        Format retrieved sections as context for LLM

        Args:
            sections: List of retrieved section dictionaries
            max_sections: Optional limit on number of sections to include
            include_subjects: Whether to include detected subjects

        Returns:
            Formatted context string
        """
        if not sections:
            return ""

        # Limit sections if specified
        if max_sections:
            sections = sections[:max_sections]

        context_parts = [
            f"## 📄 Relevant Document Sections ({len(sections)} sections found)\n"
        ]

        for idx, section in enumerate(sections, 1):
            section_title = section.get("section_title", "Untitled")
            full_content = section.get("full_content", "")
            score = section.get("score", 0.0)
            subjects = section.get("subjects", [])
            key_topics = section.get("key_topics", [])

            context_parts.append(f"\n### Section {idx}: {section_title}")
            context_parts.append(f"**Relevance Score:** {score:.2%}")

            if include_subjects and subjects:
                context_parts.append(f"**Subjects:** {', '.join(subjects)}")

            if include_subjects and key_topics:
                context_parts.append(f"**Key Topics:** {', '.join(key_topics)}")

            context_parts.append(f"\n**Content:**\n{full_content}\n")
            context_parts.append("---")

        return "\n".join(context_parts)

    def get_processing_statistics(
        self,
        project_number: str
    ) -> Dict[str, Any]:
        """
        Get statistics about processed documents for a project

        Args:
            project_number: Project OE number

        Returns:
            Statistics dictionary
        """
        try:
            stats = self.qdrant_service.get_collection_stats(project_number=project_number)
            return {
                "success": True,
                "stats": stats
            }
        except Exception as e:
            logger.error(f"❌ Failed to get statistics: {e}")
            return {
                "success": False,
                "error": str(e)
            }
