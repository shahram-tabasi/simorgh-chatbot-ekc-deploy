"""
Section Summarizer Service
===========================
Uses LLM to analyze document sections and generate comprehensive summaries
that capture all subjects and topics for semantic search.

Author: Simorgh Industrial Assistant
"""

import logging
from typing import List, Dict, Any, Optional
from dataclasses import dataclass

logger = logging.getLogger(__name__)


@dataclass
class SectionSummary:
    """Represents a summarized section"""
    section_id: str
    section_title: str
    heading_level: int
    parent_section_id: Optional[str]
    full_content: str
    summary: str
    subjects: List[str]
    key_topics: List[str]
    char_count: int
    metadata: Dict[str, Any]


class SectionSummarizer:
    """
    Service for generating LLM-based summaries of document sections
    """

    def __init__(self, llm_service):
        """
        Initialize section summarizer

        Args:
            llm_service: LLMService instance for automatic online/offline handling
        """
        self.llm_service = llm_service

    def summarize_section(
        self,
        section_content: str,
        section_title: str,
        heading_level: int,
        context_hint: str = "",
        llm_mode: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Generate comprehensive summary for a section

        Args:
            section_content: Full section text content
            section_title: Section heading/title
            heading_level: Level of heading (1-6)
            context_hint: Optional context about document type
            llm_mode: Optional LLM mode (online/offline), auto-detected if None

        Returns:
            Dictionary with summary, subjects, and key topics
        """
        try:
            # Construct prompt for LLM analysis
            system_prompt = """You are an expert technical document analyzer specializing in electrical engineering and industrial systems.

Your task is to analyze a document section and provide:
1. A comprehensive summary that captures ALL subjects and topics discussed
2. A list of specific subjects/topics covered
3. Key technical topics and concepts

Focus on:
- Technical specifications and requirements
- Equipment and system information
- Standards and compliance references
- Design parameters and constraints
- Any numerical values or measurements

Be thorough - the summary will be used for semantic search, so it must capture all content."""

            user_prompt = f"""Analyze this document section:

**Section Title:** {section_title}
**Heading Level:** {heading_level}
{f"**Document Context:** {context_hint}" if context_hint else ""}

**Section Content:**
{section_content}

---

Please provide your analysis in this exact JSON format:
{{
    "summary": "A comprehensive 2-4 sentence summary capturing ALL subjects and topics in this section",
    "subjects": ["subject1", "subject2", "subject3", ...],
    "key_topics": ["topic1", "topic2", "topic3", ...]
}}

Make sure the summary is comprehensive and captures all important information for semantic search."""

            # Generate analysis using LLMService (auto-handles online/offline)
            result = self.llm_service.generate(
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt}
                ],
                mode=llm_mode,
                temperature=0.3,  # Lower temperature for consistent analysis
                use_cache=True
            )

            response_text = result["response"]

            # Parse JSON response
            import json
            import re

            # Extract JSON from response (handle markdown code blocks)
            json_match = re.search(r'```(?:json)?\s*(\{.*?\})\s*```', response_text, re.DOTALL)
            if json_match:
                json_str = json_match.group(1)
            else:
                # Try to find JSON object directly
                json_match = re.search(r'\{.*\}', response_text, re.DOTALL)
                if json_match:
                    json_str = json_match.group(0)
                else:
                    raise ValueError("No JSON found in LLM response")

            analysis = json.loads(json_str)

            logger.info(f"✅ Section analyzed: '{section_title}' - {len(analysis.get('subjects', []))} subjects found")

            return {
                "success": True,
                "summary": analysis.get("summary", ""),
                "subjects": analysis.get("subjects", []),
                "key_topics": analysis.get("key_topics", []),
                "llm_mode": result.get("mode"),
                "tokens": result.get("tokens", {})
            }

        except Exception as e:
            logger.error(f"❌ Failed to summarize section '{section_title}': {e}")

            # Fallback: Create basic summary from first sentences
            sentences = section_content.split('.')[:3]
            fallback_summary = '.'.join(sentences) + '.' if sentences else section_content[:300]

            return {
                "success": False,
                "summary": fallback_summary,
                "subjects": [section_title],
                "key_topics": [],
                "error": str(e),
                "fallback": True
            }

    def summarize_sections_batch(
        self,
        sections: List[Dict[str, Any]],
        context_hint: str = "",
        llm_mode: Optional[str] = None,
        max_concurrent: int = 3
    ) -> List[SectionSummary]:
        """
        Summarize multiple sections in batch

        Args:
            sections: List of section dictionaries with keys:
                - section_id: Unique section identifier
                - heading: Section title
                - heading_level: Level of heading
                - content: Full section content
                - parent_section_id: Optional parent section ID
                - metadata: Optional additional metadata
            context_hint: Optional context about document type
            llm_mode: Optional LLM mode
            max_concurrent: Maximum concurrent LLM calls (not implemented yet, sequential for now)

        Returns:
            List of SectionSummary objects
        """
        logger.info(f"📚 Summarizing {len(sections)} sections...")

        summaries = []

        for idx, section in enumerate(sections, 1):
            section_id = section.get("section_id")
            heading = section.get("heading", "Untitled Section")
            heading_level = section.get("heading_level", 0)
            content = section.get("content", "")
            parent_section_id = section.get("parent_section_id")
            metadata = section.get("metadata", {})

            if not content.strip():
                logger.warning(f"⚠️ Section '{heading}' is empty, skipping")
                continue

            logger.info(f"📄 [{idx}/{len(sections)}] Analyzing section: '{heading}'")

            # Generate summary
            summary_result = self.summarize_section(
                section_content=content,
                section_title=heading,
                heading_level=heading_level,
                context_hint=context_hint,
                llm_mode=llm_mode
            )

            # Create SectionSummary object
            section_summary = SectionSummary(
                section_id=section_id,
                section_title=heading,
                heading_level=heading_level,
                parent_section_id=parent_section_id,
                full_content=content,
                summary=summary_result.get("summary", ""),
                subjects=summary_result.get("subjects", []),
                key_topics=summary_result.get("key_topics", []),
                char_count=len(content),
                metadata={
                    **metadata,
                    "summarization_success": summary_result.get("success", False),
                    "llm_mode": summary_result.get("llm_mode"),
                    "tokens": summary_result.get("tokens", {}),
                    "is_fallback": summary_result.get("fallback", False)
                }
            )

            summaries.append(section_summary)

        logger.info(f"✅ Summarization complete: {len(summaries)}/{len(sections)} sections processed")

        return summaries

    def get_summary_statistics(self, summaries: List[SectionSummary]) -> Dict[str, Any]:
        """
        Get statistics about summaries

        Args:
            summaries: List of SectionSummary objects

        Returns:
            Statistics dictionary
        """
        if not summaries:
            return {
                "total_sections": 0,
                "total_subjects": 0,
                "total_topics": 0,
                "avg_subjects_per_section": 0,
                "avg_summary_length": 0
            }

        total_subjects = sum(len(s.subjects) for s in summaries)
        total_topics = sum(len(s.key_topics) for s in summaries)
        total_summary_chars = sum(len(s.summary) for s in summaries)

        return {
            "total_sections": len(summaries),
            "total_subjects": total_subjects,
            "total_topics": total_topics,
            "avg_subjects_per_section": total_subjects / len(summaries),
            "avg_topics_per_section": total_topics / len(summaries),
            "avg_summary_length": total_summary_chars / len(summaries),
            "successful_summarizations": sum(
                1 for s in summaries
                if s.metadata.get("summarization_success", False)
            ),
            "fallback_summaries": sum(
                1 for s in summaries
                if s.metadata.get("is_fallback", False)
            )
        }
