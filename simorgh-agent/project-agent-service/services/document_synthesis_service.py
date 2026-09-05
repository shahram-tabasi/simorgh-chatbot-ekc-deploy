"""
Document Synthesis Service
===========================
Generates document summaries, cross-document analysis, and study materials.

Features:
1. Full document summaries
2. Multi-document synthesis
3. Key insights extraction
4. FAQ generation
5. Study guide creation
6. Suggested questions

Author: Simorgh Industrial Assistant
"""

import logging
import json
from typing import Dict, Any, List, Optional
from dataclasses import dataclass, field
from datetime import datetime

logger = logging.getLogger(__name__)


@dataclass
class DocumentSummary:
    """Summary of a single document"""
    document_id: str
    document_name: str
    summary: str
    key_topics: List[str] = field(default_factory=list)
    key_entities: List[str] = field(default_factory=list)
    section_count: int = 0
    word_count: int = 0
    suggested_questions: List[str] = field(default_factory=list)


@dataclass
class MultiDocSynthesis:
    """Synthesis across multiple documents"""
    overview: str
    documents: List[DocumentSummary] = field(default_factory=list)
    common_themes: List[str] = field(default_factory=list)
    connections: List[Dict[str, Any]] = field(default_factory=list)
    contradictions: List[str] = field(default_factory=list)
    knowledge_gaps: List[str] = field(default_factory=list)
    suggested_questions: List[str] = field(default_factory=list)
    faq: List[Dict[str, str]] = field(default_factory=list)


@dataclass
class StudyGuide:
    """Study guide generated from documents"""
    title: str
    overview: str
    key_concepts: List[Dict[str, str]] = field(default_factory=list)
    important_facts: List[str] = field(default_factory=list)
    review_questions: List[Dict[str, str]] = field(default_factory=list)
    summary_notes: str = ""


class DocumentSynthesisService:
    """
    Service for generating document summaries and multi-document analysis.

    Usage:
        service = DocumentSynthesisService(llm_service, qdrant_service)

        # Single document summary
        summary = await service.generate_document_summary(
            document_id="doc123",
            project_number="04A12065"
        )

        # Multi-document synthesis
        synthesis = await service.generate_multi_doc_synthesis(
            project_number="04A12065"
        )

        # Study guide
        guide = await service.generate_study_guide(
            project_number="04A12065",
            focus_topics=["protection", "voltage"]
        )
    """

    SUMMARY_PROMPT = """Analyze this document and provide a comprehensive summary.

## Document Sections:
{sections}

## Instructions:
1. Write a clear, concise summary (2-3 paragraphs)
2. Identify 5-10 key topics covered
3. List important entities (equipment, standards, values)
4. Generate 5 questions a reader might ask about this document

## Output Format (JSON):
{{
    "summary": "Clear summary of the document...",
    "key_topics": ["topic1", "topic2", ...],
    "key_entities": ["entity1", "entity2", ...],
    "suggested_questions": ["question1?", "question2?", ...]
}}
"""

    SYNTHESIS_PROMPT = """Analyze these documents together and synthesize the information.

## Documents:
{documents}

## Instructions:
1. Write an overview that ties all documents together (2-3 paragraphs)
2. Identify common themes across documents
3. Find connections between documents (e.g., one references another's specs)
4. Note any contradictions or inconsistencies
5. Identify knowledge gaps (what's not covered)
6. Generate an FAQ (5-10 questions with answers from the documents)
7. Suggest follow-up questions for deeper understanding

## Output Format (JSON):
{{
    "overview": "Overview connecting all documents...",
    "common_themes": ["theme1", "theme2", ...],
    "connections": [
        {{"from": "doc1", "to": "doc2", "relationship": "references specs from"}}
    ],
    "contradictions": ["contradiction1", ...],
    "knowledge_gaps": ["gap1", ...],
    "faq": [
        {{"question": "Q1?", "answer": "A1..."}},
        ...
    ],
    "suggested_questions": ["question1?", ...]
}}
"""

    STUDY_GUIDE_PROMPT = """Create a comprehensive study guide from these documents.

## Documents:
{documents}

## Focus Topics (if specified):
{focus_topics}

## Instructions:
Create a study guide with:
1. Title and overview
2. Key concepts with definitions
3. Important facts to remember
4. Review questions with answers
5. Summary notes for quick review

## Output Format (JSON):
{{
    "title": "Study Guide: [Topic]",
    "overview": "This guide covers...",
    "key_concepts": [
        {{"term": "concept1", "definition": "definition..."}},
        ...
    ],
    "important_facts": ["fact1", "fact2", ...],
    "review_questions": [
        {{"question": "Q1?", "answer": "A1..."}},
        ...
    ],
    "summary_notes": "Quick review notes..."
}}
"""

    def __init__(
        self,
        llm_service=None,
        qdrant_service=None,
        redis_service=None,
        neo4j_driver=None
    ):
        """Initialize with required services"""
        self.llm = llm_service
        self.qdrant = qdrant_service
        self.redis = redis_service
        self.neo4j_driver = neo4j_driver

        logger.info("DocumentSynthesisService initialized")

    async def generate_document_summary(
        self,
        document_id: str = None,
        document_name: str = None,
        project_number: str = None,
        chat_id: str = None,
        force_regenerate: bool = False
    ) -> Optional[DocumentSummary]:
        """
        Generate a comprehensive summary for a single document.

        Args:
            document_id: Document ID to summarize
            document_name: Document filename (alternative to ID)
            project_number: Project OENUM
            chat_id: Chat ID (for general chats)
            force_regenerate: Bypass cache

        Returns:
            DocumentSummary object
        """
        try:
            # Check cache first
            cache_key = f"doc_summary:{document_id or document_name}:{project_number or chat_id}"
            if not force_regenerate and self.redis:
                cached = self.redis.get(cache_key, db="cache")
                if cached:
                    logger.info(f"Returning cached document summary")
                    return DocumentSummary(**cached)

            # Get document sections
            sections = await self._get_document_sections(
                document_id=document_id,
                document_name=document_name,
                project_number=project_number
            )

            if not sections:
                logger.warning(f"No sections found for document")
                return None

            # Build sections text
            sections_text = self._format_sections_for_prompt(sections)

            # Generate summary using LLM
            prompt = self.SUMMARY_PROMPT.format(sections=sections_text)

            result = await self._call_llm(prompt)

            if not result:
                return None

            # Parse response
            parsed = self._parse_json_response(result)

            if not parsed:
                # Fallback: use result as summary
                parsed = {
                    "summary": result[:1000],
                    "key_topics": [],
                    "key_entities": [],
                    "suggested_questions": []
                }

            summary = DocumentSummary(
                document_id=document_id or "",
                document_name=document_name or sections[0].get("document_name", "Document"),
                summary=parsed.get("summary", ""),
                key_topics=parsed.get("key_topics", []),
                key_entities=parsed.get("key_entities", []),
                section_count=len(sections),
                word_count=sum(len(s.get("content", "").split()) for s in sections),
                suggested_questions=parsed.get("suggested_questions", [])
            )

            # Cache result
            if self.redis:
                self.redis.set(cache_key, summary.__dict__, db="cache", ttl=3600)

            logger.info(f"Generated summary for document: {summary.document_name}")
            return summary

        except Exception as e:
            logger.error(f"Document summary generation failed: {e}", exc_info=True)
            return None

    async def generate_multi_doc_synthesis(
        self,
        project_number: str = None,
        chat_id: str = None,
        document_ids: List[str] = None,
        force_regenerate: bool = False
    ) -> Optional[MultiDocSynthesis]:
        """
        Generate synthesis across multiple documents.

        Args:
            project_number: Project OENUM
            chat_id: Chat ID (for general chats)
            document_ids: Specific documents to synthesize (optional)
            force_regenerate: Bypass cache

        Returns:
            MultiDocSynthesis object
        """
        try:
            # Check cache
            cache_key = f"multi_synthesis:{project_number or chat_id}"
            if not force_regenerate and self.redis:
                cached = self.redis.get(cache_key, db="cache")
                if cached:
                    logger.info("Returning cached multi-doc synthesis")
                    return self._dict_to_synthesis(cached)

            # Get all documents
            documents = await self._get_all_documents(
                project_number=project_number,
                chat_id=chat_id,
                document_ids=document_ids
            )

            if not documents:
                logger.warning("No documents found for synthesis")
                return None

            # Generate individual summaries first
            doc_summaries = []
            for doc in documents:
                summary = await self.generate_document_summary(
                    document_id=doc.get("id"),
                    document_name=doc.get("name"),
                    project_number=project_number,
                    chat_id=chat_id
                )
                if summary:
                    doc_summaries.append(summary)

            if not doc_summaries:
                return None

            # Build documents text for synthesis
            docs_text = self._format_summaries_for_synthesis(doc_summaries)

            # Generate synthesis
            prompt = self.SYNTHESIS_PROMPT.format(documents=docs_text)
            result = await self._call_llm(prompt)

            if not result:
                return None

            parsed = self._parse_json_response(result)

            if not parsed:
                parsed = {
                    "overview": result[:1500],
                    "common_themes": [],
                    "connections": [],
                    "contradictions": [],
                    "knowledge_gaps": [],
                    "faq": [],
                    "suggested_questions": []
                }

            synthesis = MultiDocSynthesis(
                overview=parsed.get("overview", ""),
                documents=doc_summaries,
                common_themes=parsed.get("common_themes", []),
                connections=parsed.get("connections", []),
                contradictions=parsed.get("contradictions", []),
                knowledge_gaps=parsed.get("knowledge_gaps", []),
                suggested_questions=parsed.get("suggested_questions", []),
                faq=parsed.get("faq", [])
            )

            # Cache result
            if self.redis:
                self.redis.set(cache_key, self._synthesis_to_dict(synthesis), db="cache", ttl=3600)

            logger.info(f"Generated multi-doc synthesis for {len(doc_summaries)} documents")
            return synthesis

        except Exception as e:
            logger.error(f"Multi-doc synthesis failed: {e}", exc_info=True)
            return None

    async def generate_study_guide(
        self,
        project_number: str = None,
        chat_id: str = None,
        focus_topics: List[str] = None,
        force_regenerate: bool = False
    ) -> Optional[StudyGuide]:
        """
        Generate a study guide from documents.

        Args:
            project_number: Project OENUM
            chat_id: Chat ID
            focus_topics: Topics to focus on (optional)
            force_regenerate: Bypass cache

        Returns:
            StudyGuide object
        """
        try:
            cache_key = f"study_guide:{project_number or chat_id}:{'-'.join(focus_topics or [])}"
            if not force_regenerate and self.redis:
                cached = self.redis.get(cache_key, db="cache")
                if cached:
                    return StudyGuide(**cached)

            # Get document sections
            sections = await self._get_all_sections(
                project_number=project_number,
                chat_id=chat_id
            )

            if not sections:
                return None

            docs_text = self._format_sections_for_prompt(sections[:50])  # Limit sections
            focus_text = ", ".join(focus_topics) if focus_topics else "All topics"

            prompt = self.STUDY_GUIDE_PROMPT.format(
                documents=docs_text,
                focus_topics=focus_text
            )

            result = await self._call_llm(prompt)

            if not result:
                return None

            parsed = self._parse_json_response(result)

            if not parsed:
                return None

            guide = StudyGuide(
                title=parsed.get("title", "Study Guide"),
                overview=parsed.get("overview", ""),
                key_concepts=parsed.get("key_concepts", []),
                important_facts=parsed.get("important_facts", []),
                review_questions=parsed.get("review_questions", []),
                summary_notes=parsed.get("summary_notes", "")
            )

            if self.redis:
                self.redis.set(cache_key, guide.__dict__, db="cache", ttl=3600)

            return guide

        except Exception as e:
            logger.error(f"Study guide generation failed: {e}", exc_info=True)
            return None

    async def generate_suggested_questions(
        self,
        project_number: str = None,
        chat_id: str = None,
        count: int = 10
    ) -> List[str]:
        """
        Generate suggested questions based on document content.

        Returns list of questions users might want to ask.
        """
        try:
            # Try to get from synthesis
            synthesis = await self.generate_multi_doc_synthesis(
                project_number=project_number,
                chat_id=chat_id
            )

            if synthesis and synthesis.suggested_questions:
                return synthesis.suggested_questions[:count]

            # Fallback: get from individual summaries
            documents = await self._get_all_documents(
                project_number=project_number,
                chat_id=chat_id
            )

            questions = []
            for doc in documents[:5]:  # Limit to 5 docs
                summary = await self.generate_document_summary(
                    document_id=doc.get("id"),
                    document_name=doc.get("name"),
                    project_number=project_number
                )
                if summary and summary.suggested_questions:
                    questions.extend(summary.suggested_questions)

            # Deduplicate and limit
            seen = set()
            unique = []
            for q in questions:
                if q.lower() not in seen:
                    seen.add(q.lower())
                    unique.append(q)

            return unique[:count]

        except Exception as e:
            logger.error(f"Suggested questions generation failed: {e}")
            return []

    async def get_document_connections(
        self,
        project_number: str
    ) -> List[Dict[str, Any]]:
        """
        Find connections between documents using Neo4j.

        Returns list of document relationships.
        """
        if not self.neo4j_driver:
            return []

        try:
            with self.neo4j_driver.session() as session:
                result = session.run("""
                    MATCH (d1:Document {project_number: $project_number})
                    MATCH (d2:Document {project_number: $project_number})
                    WHERE d1 <> d2
                    OPTIONAL MATCH (d1)-[:HAS_SPEC_CATEGORY]->(c1:SpecCategory)
                    OPTIONAL MATCH (d2)-[:HAS_SPEC_CATEGORY]->(c2:SpecCategory)
                    WHERE c1.name = c2.name
                    WITH d1, d2, collect(DISTINCT c1.name) as shared_categories
                    WHERE size(shared_categories) > 0
                    RETURN d1.filename as doc1, d2.filename as doc2,
                           shared_categories, size(shared_categories) as strength
                    ORDER BY strength DESC
                    LIMIT 20
                """, {"project_number": project_number})

                connections = []
                for record in result:
                    connections.append({
                        "from": record["doc1"],
                        "to": record["doc2"],
                        "shared_topics": record["shared_categories"],
                        "strength": record["strength"]
                    })

                return connections

        except Exception as e:
            logger.error(f"Document connections query failed: {e}")
            return []

    # =========================================================================
    # HELPER METHODS
    # =========================================================================

    async def _get_document_sections(
        self,
        document_id: str = None,
        document_name: str = None,
        project_number: str = None
    ) -> List[Dict[str, Any]]:
        """Get sections for a specific document"""
        if not self.qdrant:
            return []

        try:
            # Search for sections from this document
            filter_conditions = {}
            if document_id:
                filter_conditions["document_id"] = document_id
            if document_name:
                filter_conditions["document_name"] = document_name

            results = self.qdrant.search_section_summaries(
                user_id="system",
                query="",  # Empty query to get all
                limit=50,
                project_oenum=project_number,
                score_threshold=0.0
            )

            # Filter by document
            if document_name and results:
                results = [r for r in results if document_name.lower() in r.get("document_name", "").lower()]

            return results or []

        except Exception as e:
            logger.error(f"Get document sections failed: {e}")
            return []

    async def _get_all_documents(
        self,
        project_number: str = None,
        chat_id: str = None,
        document_ids: List[str] = None
    ) -> List[Dict[str, Any]]:
        """Get all documents for a project/chat"""
        documents = []

        try:
            if self.redis:
                # Get from document tracking
                key = f"project:{project_number}:documents" if project_number else f"chat:{chat_id}:documents"
                doc_list = self.redis.get(key, db="cache")
                if doc_list:
                    documents = doc_list if isinstance(doc_list, list) else []

            # Also try Qdrant
            if not documents and self.qdrant:
                results = self.qdrant.search_section_summaries(
                    user_id="system",
                    query="",
                    limit=100,
                    project_oenum=project_number,
                    score_threshold=0.0
                )

                # Group by document
                doc_names = set()
                for r in results or []:
                    doc_name = r.get("document_name", r.get("filename"))
                    if doc_name and doc_name not in doc_names:
                        doc_names.add(doc_name)
                        documents.append({
                            "id": r.get("document_id"),
                            "name": doc_name
                        })

        except Exception as e:
            logger.error(f"Get all documents failed: {e}")

        return documents

    async def _get_all_sections(
        self,
        project_number: str = None,
        chat_id: str = None
    ) -> List[Dict[str, Any]]:
        """Get all sections for a project/chat"""
        if not self.qdrant:
            return []

        try:
            results = self.qdrant.search_section_summaries(
                user_id="system",
                query="",
                limit=100,
                project_oenum=project_number,
                score_threshold=0.0
            )
            return results or []
        except Exception as e:
            logger.error(f"Get all sections failed: {e}")
            return []

    def _format_sections_for_prompt(self, sections: List[Dict[str, Any]]) -> str:
        """Format sections for LLM prompt"""
        parts = []
        for i, section in enumerate(sections[:30], 1):  # Limit sections
            title = section.get("section_title", f"Section {i}")
            content = section.get("full_content", section.get("content", ""))[:1000]
            parts.append(f"### {title}\n{content}\n")
        return "\n".join(parts)

    def _format_summaries_for_synthesis(self, summaries: List[DocumentSummary]) -> str:
        """Format document summaries for synthesis prompt"""
        parts = []
        for summary in summaries:
            parts.append(f"## {summary.document_name}")
            parts.append(f"**Summary:** {summary.summary}")
            parts.append(f"**Topics:** {', '.join(summary.key_topics)}")
            parts.append(f"**Entities:** {', '.join(summary.key_entities)}")
            parts.append("")
        return "\n".join(parts)

    async def _call_llm(self, prompt: str) -> Optional[str]:
        """Call LLM with prompt"""
        if not self.llm:
            return None

        try:
            messages = [
                {"role": "system", "content": "You are a document analysis expert. Always respond in valid JSON format."},
                {"role": "user", "content": prompt}
            ]

            if hasattr(self.llm, 'async_generate'):
                result = await self.llm.async_generate(messages=messages, temperature=0.3)
            else:
                result = self.llm.generate(messages=messages, temperature=0.3)

            return result.get("response", "")
        except Exception as e:
            logger.error(f"LLM call failed: {e}")
            return None

    def _parse_json_response(self, response: str) -> Optional[Dict]:
        """Parse JSON from LLM response"""
        try:
            # Try direct parse
            return json.loads(response)
        except:
            pass

        try:
            # Try to extract JSON from markdown code block
            import re
            match = re.search(r'```(?:json)?\s*([\s\S]*?)\s*```', response)
            if match:
                return json.loads(match.group(1))
        except:
            pass

        try:
            # Try to find JSON object
            import re
            match = re.search(r'\{[\s\S]*\}', response)
            if match:
                return json.loads(match.group(0))
        except:
            pass

        return None

    def _synthesis_to_dict(self, synthesis: MultiDocSynthesis) -> Dict:
        """Convert synthesis to dict for caching"""
        return {
            "overview": synthesis.overview,
            "documents": [s.__dict__ for s in synthesis.documents],
            "common_themes": synthesis.common_themes,
            "connections": synthesis.connections,
            "contradictions": synthesis.contradictions,
            "knowledge_gaps": synthesis.knowledge_gaps,
            "suggested_questions": synthesis.suggested_questions,
            "faq": synthesis.faq
        }

    def _dict_to_synthesis(self, data: Dict) -> MultiDocSynthesis:
        """Convert dict to synthesis object"""
        return MultiDocSynthesis(
            overview=data.get("overview", ""),
            documents=[DocumentSummary(**d) for d in data.get("documents", [])],
            common_themes=data.get("common_themes", []),
            connections=data.get("connections", []),
            contradictions=data.get("contradictions", []),
            knowledge_gaps=data.get("knowledge_gaps", []),
            suggested_questions=data.get("suggested_questions", []),
            faq=data.get("faq", [])
        )


# =============================================================================
# SINGLETON
# =============================================================================

_synthesis_service_instance: Optional[DocumentSynthesisService] = None


def get_document_synthesis_service(
    llm_service=None,
    qdrant_service=None,
    redis_service=None,
    neo4j_driver=None
) -> DocumentSynthesisService:
    """Get or create document synthesis service singleton"""
    global _synthesis_service_instance

    if _synthesis_service_instance is None:
        _synthesis_service_instance = DocumentSynthesisService(
            llm_service=llm_service,
            qdrant_service=qdrant_service,
            redis_service=redis_service,
            neo4j_driver=neo4j_driver
        )

    return _synthesis_service_instance
