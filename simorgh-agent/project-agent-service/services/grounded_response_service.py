"""
Grounded Response Service
==========================
Ensures LLM responses are strictly grounded in uploaded documents.
Implements NotebookLM-style source attribution and citation.

Features:
1. Source-only responses (no hallucination)
2. Inline citations [1], [2], etc.
3. Claim verification against sources
4. Confidence scoring
5. "I don't know" when info not in sources

Author: Simorgh Industrial Assistant
"""

import re
import logging
import json
from typing import Dict, Any, List, Optional, Tuple
from dataclasses import dataclass, field
from datetime import datetime

logger = logging.getLogger(__name__)


@dataclass
class Citation:
    """A single citation reference"""
    id: int
    section_id: str
    section_title: str
    quoted_text: str
    document_name: str = ""
    page_number: Optional[int] = None
    relevance_score: float = 0.0


@dataclass
class GroundedResponse:
    """Response with grounding information"""
    response_text: str
    citations: List[Citation] = field(default_factory=list)
    is_grounded: bool = True
    confidence_score: float = 0.0
    sources_used: int = 0
    has_ungrounded_claims: bool = False
    ungrounded_claims: List[str] = field(default_factory=list)
    processing_time_ms: float = 0.0


class GroundedResponseService:
    """
    Service for generating responses grounded strictly in document sources.

    Usage:
        service = GroundedResponseService(llm_service, qdrant_service)

        result = await service.generate_grounded_response(
            query="What is the voltage rating?",
            project_number="04A12065",
            user_id="user123"
        )

        print(result.response_text)  # "The voltage rating is 400V [1]..."
        print(result.citations)      # [Citation(id=1, section_title="Specs", ...)]
    """

    # System prompt for grounded responses
    GROUNDED_SYSTEM_PROMPT = """You are a document analysis assistant. You MUST follow these rules strictly:

## CRITICAL RULES - NEVER BREAK THESE:

1. **ONLY use information from the provided SOURCES below**
   - If the answer is not in the sources, say "This information is not available in the uploaded documents."
   - NEVER use your general knowledge or make assumptions
   - NEVER invent or guess information

2. **ALWAYS cite your sources using [1], [2], etc.**
   - Every fact must have a citation
   - Use the citation number matching the source
   - Example: "The rated voltage is 400V [1] and the IP rating is IP65 [2]."

3. **Quote relevant text when helpful**
   - Use quotes for specific values or definitions
   - Example: According to the specifications, "the maximum operating temperature is 45°C" [1].

4. **Be precise and factual**
   - Only state what the documents explicitly say
   - Don't extrapolate or interpret beyond what's written
   - If something is unclear, say so

5. **Format for clarity**
   - Use bullet points for lists
   - Use tables for comparisons
   - Be concise but complete

## RESPONSE FORMAT:

Your response should:
- Answer the question using ONLY the sources
- Include inline citations [1], [2], etc.
- End with a brief note if important info might be missing

If no relevant information exists in sources:
"I cannot find information about [topic] in the uploaded documents. The available documents cover: [list what they do cover]."
"""

    def __init__(
        self,
        llm_service=None,
        qdrant_service=None,
        section_retriever=None
    ):
        """
        Initialize with required services.

        Args:
            llm_service: LLM service for generation
            qdrant_service: Qdrant for vector search
            section_retriever: Section retriever for document access
        """
        self.llm = llm_service
        self.qdrant = qdrant_service
        self.section_retriever = section_retriever

        logger.info("GroundedResponseService initialized")

    async def generate_grounded_response(
        self,
        query: str,
        project_number: Optional[str] = None,
        chat_id: Optional[str] = None,
        user_id: str = "system",
        max_sources: int = 5,
        score_threshold: float = 0.3,
        llm_mode: Optional[str] = None
    ) -> GroundedResponse:
        """
        Generate a response grounded strictly in document sources.

        Args:
            query: User's question
            project_number: Project OENUM (for project chats)
            chat_id: Chat ID (for general chats)
            user_id: User ID
            max_sources: Maximum sources to retrieve
            score_threshold: Minimum relevance score
            llm_mode: LLM mode (online/offline)

        Returns:
            GroundedResponse with citations
        """
        import time
        start_time = time.time()

        try:
            # Step 1: Retrieve relevant sources
            sources = await self._retrieve_sources(
                query=query,
                project_number=project_number,
                chat_id=chat_id,
                user_id=user_id,
                limit=max_sources,
                score_threshold=score_threshold
            )

            if not sources:
                return GroundedResponse(
                    response_text="I cannot answer this question because no relevant information was found in the uploaded documents. Please upload documents related to your question, or rephrase your query.",
                    is_grounded=True,
                    confidence_score=1.0,
                    sources_used=0,
                    processing_time_ms=(time.time() - start_time) * 1000
                )

            # Step 2: Build context with numbered sources
            sources_context = self._build_sources_context(sources)

            # Step 3: Generate grounded response
            response_text = await self._generate_with_sources(
                query=query,
                sources_context=sources_context,
                llm_mode=llm_mode
            )

            # Step 4: Parse citations from response
            citations, cited_ids = self._parse_citations(response_text, sources)

            # Step 5: Verify grounding
            is_grounded, ungrounded_claims = self._verify_grounding(
                response_text, sources, cited_ids
            )

            # Step 6: Calculate confidence
            confidence = self._calculate_confidence(
                sources=sources,
                citations=citations,
                is_grounded=is_grounded
            )

            return GroundedResponse(
                response_text=response_text,
                citations=citations,
                is_grounded=is_grounded,
                confidence_score=confidence,
                sources_used=len(sources),
                has_ungrounded_claims=len(ungrounded_claims) > 0,
                ungrounded_claims=ungrounded_claims,
                processing_time_ms=(time.time() - start_time) * 1000
            )

        except Exception as e:
            logger.error(f"Grounded response generation failed: {e}", exc_info=True)
            return GroundedResponse(
                response_text=f"I encountered an error while searching the documents. Please try again.",
                is_grounded=False,
                confidence_score=0.0,
                processing_time_ms=(time.time() - start_time) * 1000
            )

    async def _retrieve_sources(
        self,
        query: str,
        project_number: Optional[str],
        chat_id: Optional[str],
        user_id: str,
        limit: int,
        score_threshold: float
    ) -> List[Dict[str, Any]]:
        """Retrieve relevant document sections"""
        sources = []

        try:
            if self.qdrant:
                # Search for relevant sections
                results = self.qdrant.search_section_summaries(
                    user_id="system",  # Documents stored with system user
                    query=query,
                    limit=limit,
                    project_oenum=project_number,
                    score_threshold=score_threshold
                )

                if results:
                    for idx, result in enumerate(results):
                        sources.append({
                            "id": idx + 1,
                            "section_id": result.get("section_id", ""),
                            "section_title": result.get("section_title", f"Section {idx + 1}"),
                            "content": result.get("full_content", result.get("text", "")),
                            "summary": result.get("summary", ""),
                            "document_name": result.get("document_name", result.get("filename", "Document")),
                            "page_number": result.get("page_number"),
                            "score": result.get("score", 0.0),
                            "subjects": result.get("subjects", [])
                        })

                    logger.info(f"Retrieved {len(sources)} sources for grounded response")

            # Also try section retriever if available
            if self.section_retriever and project_number and not sources:
                try:
                    sections_result = self.section_retriever.retrieve_relevant_sections(
                        project_number=project_number,
                        query=query,
                        limit=limit,
                        score_threshold=score_threshold
                    )

                    if sections_result.get("success") and sections_result.get("sections"):
                        for idx, section in enumerate(sections_result["sections"]):
                            sources.append({
                                "id": idx + 1,
                                "section_id": section.get("section_id", ""),
                                "section_title": section.get("title", f"Section {idx + 1}"),
                                "content": section.get("full_content", section.get("content", "")),
                                "summary": section.get("summary", ""),
                                "document_name": section.get("document_name", "Document"),
                                "page_number": section.get("page_number"),
                                "score": section.get("score", 0.0),
                                "subjects": section.get("subjects", [])
                            })
                except Exception as e:
                    logger.warning(f"Section retriever failed: {e}")

        except Exception as e:
            logger.error(f"Source retrieval failed: {e}")

        return sources

    def _build_sources_context(self, sources: List[Dict[str, Any]]) -> str:
        """Build formatted context from sources with citation numbers"""
        context_parts = ["# SOURCES (Use these to answer the question)\n"]

        for source in sources:
            source_id = source["id"]
            title = source.get("section_title", f"Section {source_id}")
            content = source.get("content", "")
            doc_name = source.get("document_name", "")
            page = source.get("page_number")

            context_parts.append(f"\n## [{source_id}] {title}")
            if doc_name:
                context_parts.append(f"**Document:** {doc_name}")
            if page:
                context_parts.append(f"**Page:** {page}")
            context_parts.append(f"\n{content}\n")
            context_parts.append("---")

        return "\n".join(context_parts)

    async def _generate_with_sources(
        self,
        query: str,
        sources_context: str,
        llm_mode: Optional[str]
    ) -> str:
        """Generate response using LLM with sources context"""
        if not self.llm:
            return "LLM service not available."

        messages = [
            {"role": "system", "content": self.GROUNDED_SYSTEM_PROMPT},
            {"role": "user", "content": f"{sources_context}\n\n---\n\n# QUESTION\n{query}"}
        ]

        try:
            # Try async first
            if hasattr(self.llm, 'async_generate'):
                result = await self.llm.async_generate(
                    messages=messages,
                    mode=llm_mode,
                    temperature=0.3  # Lower temperature for factual responses
                )
            else:
                # Fallback to sync
                result = self.llm.generate(
                    messages=messages,
                    mode=llm_mode,
                    temperature=0.3
                )

            return result.get("response", "")

        except Exception as e:
            logger.error(f"LLM generation failed: {e}")
            return "I encountered an error generating a response."

    def _parse_citations(
        self,
        response_text: str,
        sources: List[Dict[str, Any]]
    ) -> Tuple[List[Citation], set]:
        """Parse citation references [1], [2], etc. from response"""
        citations = []
        cited_ids = set()

        # Find all citation patterns like [1], [2], [1,2], [1-3]
        citation_pattern = r'\[(\d+(?:[-,]\d+)*)\]'
        matches = re.findall(citation_pattern, response_text)

        for match in matches:
            # Handle ranges like "1-3" and lists like "1,2"
            if '-' in match:
                start, end = map(int, match.split('-'))
                ids = list(range(start, end + 1))
            elif ',' in match:
                ids = [int(x.strip()) for x in match.split(',')]
            else:
                ids = [int(match)]

            for cite_id in ids:
                if cite_id not in cited_ids:
                    cited_ids.add(cite_id)

                    # Find matching source
                    source = next((s for s in sources if s["id"] == cite_id), None)
                    if source:
                        citations.append(Citation(
                            id=cite_id,
                            section_id=source.get("section_id", ""),
                            section_title=source.get("section_title", ""),
                            quoted_text=source.get("content", "")[:200] + "...",
                            document_name=source.get("document_name", ""),
                            page_number=source.get("page_number"),
                            relevance_score=source.get("score", 0.0)
                        ))

        return citations, cited_ids

    def _verify_grounding(
        self,
        response_text: str,
        sources: List[Dict[str, Any]],
        cited_ids: set
    ) -> Tuple[bool, List[str]]:
        """
        Verify that response claims are grounded in sources.
        Returns (is_grounded, list of ungrounded claims)
        """
        ungrounded_claims = []

        # Check if response acknowledges lack of information
        no_info_phrases = [
            "not available in",
            "cannot find",
            "no information",
            "not mentioned",
            "documents don't contain",
            "not in the sources"
        ]

        is_acknowledgment = any(phrase in response_text.lower() for phrase in no_info_phrases)

        if is_acknowledgment:
            return True, []

        # Check if citations are present
        if not cited_ids and len(response_text) > 100:
            # Long response without citations is suspicious
            ungrounded_claims.append("Response contains claims without citations")
            return False, ungrounded_claims

        # Check that cited sources exist
        source_ids = {s["id"] for s in sources}
        invalid_citations = cited_ids - source_ids

        if invalid_citations:
            ungrounded_claims.append(f"Invalid citation references: {invalid_citations}")
            return False, ungrounded_claims

        return True, []

    def _calculate_confidence(
        self,
        sources: List[Dict[str, Any]],
        citations: List[Citation],
        is_grounded: bool
    ) -> float:
        """Calculate confidence score for the response"""
        if not is_grounded:
            return 0.3

        if not sources:
            return 0.5  # Acknowledged no sources

        # Base confidence from source relevance scores
        avg_relevance = sum(s.get("score", 0.5) for s in sources) / len(sources)

        # Boost for having citations
        citation_boost = min(len(citations) * 0.1, 0.3)

        # Calculate final confidence
        confidence = min(avg_relevance + citation_boost, 1.0)

        return round(confidence, 2)

    def format_response_with_citations(
        self,
        grounded_response: GroundedResponse,
        include_sources_panel: bool = True
    ) -> Dict[str, Any]:
        """
        Format response for API/frontend consumption.

        Returns:
            {
                "response": "The voltage is 400V [1]...",
                "citations": [...],
                "sources_panel": "## Sources\n1. Section Title...",
                "metadata": {...}
            }
        """
        result = {
            "response": grounded_response.response_text,
            "citations": [
                {
                    "id": c.id,
                    "section_title": c.section_title,
                    "document_name": c.document_name,
                    "page_number": c.page_number,
                    "quoted_text": c.quoted_text,
                    "relevance_score": c.relevance_score
                }
                for c in grounded_response.citations
            ],
            "metadata": {
                "is_grounded": grounded_response.is_grounded,
                "confidence_score": grounded_response.confidence_score,
                "sources_used": grounded_response.sources_used,
                "has_ungrounded_claims": grounded_response.has_ungrounded_claims,
                "processing_time_ms": grounded_response.processing_time_ms
            }
        }

        if include_sources_panel and grounded_response.citations:
            sources_panel = "\n\n---\n## 📚 Sources\n"
            for citation in grounded_response.citations:
                sources_panel += f"\n**[{citation.id}]** {citation.section_title}"
                if citation.document_name:
                    sources_panel += f" — _{citation.document_name}_"
                if citation.page_number:
                    sources_panel += f" (p. {citation.page_number})"
                sources_panel += "\n"

            result["sources_panel"] = sources_panel

        return result


# =============================================================================
# SINGLETON
# =============================================================================

_grounded_service_instance: Optional[GroundedResponseService] = None


def get_grounded_response_service(
    llm_service=None,
    qdrant_service=None,
    section_retriever=None
) -> GroundedResponseService:
    """Get or create grounded response service singleton"""
    global _grounded_service_instance

    if _grounded_service_instance is None:
        _grounded_service_instance = GroundedResponseService(
            llm_service=llm_service,
            qdrant_service=qdrant_service,
            section_retriever=section_retriever
        )

    return _grounded_service_instance
