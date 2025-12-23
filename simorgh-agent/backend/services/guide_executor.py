"""
Guide Executor Service
=======================
Executes extraction guides during graph construction to extract
specific parameters from documents using semantic search + LLM extraction.

Each guide node acts like a "mini query":
1. Use guide instruction to semantic search for relevant section
2. Retrieve full section content
3. Use LLM to extract specific parameter
4. Store extracted value in entity node

Author: Simorgh Industrial Assistant
"""

import logging
from typing import List, Dict, Any, Optional
import json
import re

logger = logging.getLogger(__name__)


class GuideExecutor:
    """
    Service for executing extraction guides during graph construction
    """

    def __init__(
        self,
        llm_service,
        qdrant_service,
        neo4j_driver
    ):
        """
        Initialize guide executor

        Args:
            llm_service: LLMService for extraction
            qdrant_service: QdrantService for semantic search
            neo4j_driver: Neo4j driver for graph operations
        """
        self.llm_service = llm_service
        self.qdrant_service = qdrant_service
        self.neo4j_driver = neo4j_driver

    def get_extraction_guides(
        self,
        project_number: str,
        category: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """
        Retrieve project-level extraction guides from Neo4j graph

        NEW BEHAVIOR:
        - Queries project-level ExtractionGuide nodes (no document_id)
        - Uses REFERENCES_GUIDE relationship for field linkage

        Args:
            project_number: Project OE number
            category: Optional filter by category

        Returns:
            List of extraction guides with field information
        """
        try:
            with self.neo4j_driver.session() as session:
                if category:
                    query = """
                    MATCH (guide:ExtractionGuide {
                        project_number: $project_number,
                        category_name: $category
                    })
                    WHERE guide.document_id IS NULL  // Ensure project-level
                    RETURN guide.category_name as category,
                           guide.field_name as field_name,
                           guide.definition as definition,
                           guide.extraction_instructions as instruction,
                           guide.common_values as common_values,
                           guide.examples as examples,
                           guide.notes as notes
                    """
                    params = {"category": category, "project_number": project_number}
                else:
                    query = """
                    MATCH (guide:ExtractionGuide {project_number: $project_number})
                    WHERE guide.document_id IS NULL  // Ensure project-level
                    RETURN guide.category_name as category,
                           guide.field_name as field_name,
                           guide.definition as definition,
                           guide.extraction_instructions as instruction,
                           guide.common_values as common_values,
                           guide.examples as examples,
                           guide.notes as notes
                    """
                    params = {"project_number": project_number}

                result = session.run(query, params)

                guides = []
                for record in result:
                    guides.append({
                        "category": record["category"],
                        "field_name": record["field_name"],
                        "definition": record["definition"] or "",
                        "instruction": record["instruction"] or "",
                        "common_values": record["common_values"] or "",
                        "examples": record["examples"] or "",
                        "notes": record["notes"] or ""
                    })

                logger.info(f"📚 Retrieved {len(guides)} project-level extraction guides")
                return guides

        except Exception as e:
            logger.error(f"❌ Failed to retrieve extraction guides: {e}")
            return []

    def execute_guide(
        self,
        guide: Dict[str, Any],
        project_number: str,
        document_id: str,
        llm_mode: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Execute a single extraction guide

        Process:
        1. Use guide instruction for semantic search
        2. Retrieve relevant section
        3. Use LLM to extract specific parameter
        4. Return extracted value

        Args:
            guide: Guide dictionary with instruction and metadata
            project_number: Project OE number
            document_id: Document unique identifier
            llm_mode: Optional LLM mode

        Returns:
            Extraction result dictionary
        """
        try:
            field_name = guide.get("field_name", "")
            instruction = guide.get("instruction", "")
            definition = guide.get("definition", "")
            common_values = guide.get("common_values", "")

            logger.info(f"🔍 Executing guide for field: {field_name}")

            # STEP 1: Semantic search using guide instruction
            search_results = self.qdrant_service.search_section_summaries(
                project_number=project_number,
                query=instruction,
                limit=3,
                document_id=document_id,
                score_threshold=0.3
            )

            if not search_results:
                logger.warning(f"⚠️ No relevant sections found for guide: {field_name}")
                return {
                    "success": False,
                    "field_name": field_name,
                    "extracted_value": None,
                    "error": "No relevant sections found"
                }

            # STEP 2: Get full content of top-matching section
            top_section = search_results[0]
            section_content = top_section.get("full_content", "")
            section_title = top_section.get("section_title", "")
            relevance_score = top_section.get("score", 0.0)

            logger.info(f"📄 Found relevant section: '{section_title}' (score: {relevance_score:.2f})")

            # STEP 3: Use LLM to extract parameter from section
            extraction_result = self._extract_parameter_with_llm(
                field_name=field_name,
                definition=definition,
                instruction=instruction,
                common_values=common_values,
                section_content=section_content,
                section_title=section_title,
                llm_mode=llm_mode
            )

            return {
                "success": True,
                "field_name": field_name,
                "extracted_value": extraction_result.get("value"),
                "confidence": extraction_result.get("confidence", "medium"),
                "source_section": section_title,
                "relevance_score": relevance_score
            }

        except Exception as e:
            logger.error(f"❌ Guide execution failed for {field_name}: {e}")
            return {
                "success": False,
                "field_name": field_name,
                "extracted_value": None,
                "error": str(e)
            }

    def _extract_parameter_with_llm(
        self,
        field_name: str,
        definition: str,
        instruction: str,
        common_values: str,
        section_content: str,
        section_title: str,
        llm_mode: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Use LLM to extract specific parameter from section content

        Args:
            field_name: Name of field to extract
            definition: Definition of the field
            instruction: Extraction instruction
            common_values: Common expected values
            section_content: Full section text
            section_title: Section title
            llm_mode: Optional LLM mode

        Returns:
            Extraction result with value and confidence
        """
        try:
            system_prompt = f"""You are an expert electrical specification extractor.

Your task is to extract a specific parameter from a document section.

**Field to Extract:** {field_name}
**Definition:** {definition}
**Common Values:** {common_values}

Extract the exact value for this field from the provided section.
If the value is not explicitly stated, respond with "NOT_FOUND".

Provide your response in this JSON format:
{{
    "value": "extracted value here or NOT_FOUND",
    "confidence": "high|medium|low",
    "explanation": "brief explanation of where/how you found it"
}}"""

            user_prompt = f"""**Section:** {section_title}

**Content:**
{section_content}

---

Extract the value for: **{field_name}**

{instruction}"""

            # Generate extraction using LLM
            result = self.llm_service.generate(
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt}
                ],
                mode=llm_mode,
                temperature=0.1,  # Very low temperature for precise extraction
                use_cache=True
            )

            response_text = result["response"]

            # Parse JSON response
            json_match = re.search(r'```(?:json)?\s*(\{.*?\})\s*```', response_text, re.DOTALL)
            if json_match:
                json_str = json_match.group(1)
            else:
                json_match = re.search(r'\{.*\}', response_text, re.DOTALL)
                if json_match:
                    json_str = json_match.group(0)
                else:
                    raise ValueError("No JSON found in LLM response")

            extraction = json.loads(json_str)

            value = extraction.get("value", "NOT_FOUND")
            if value == "NOT_FOUND":
                value = None

            logger.info(f"✅ Extracted '{field_name}': {value}")

            return {
                "value": value,
                "confidence": extraction.get("confidence", "medium"),
                "explanation": extraction.get("explanation", "")
            }

        except Exception as e:
            logger.error(f"❌ LLM extraction failed: {e}")
            return {
                "value": None,
                "confidence": "low",
                "explanation": f"Extraction failed: {str(e)}"
            }

    def execute_all_guides(
        self,
        project_number: str,
        document_id: str,
        category: Optional[str] = None,
        llm_mode: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Execute all extraction guides for a document

        Args:
            project_number: Project OE number
            document_id: Document unique identifier
            category: Optional filter by category
            llm_mode: Optional LLM mode

        Returns:
            Execution results with extracted values
        """
        logger.info(f"🚀 Executing all extraction guides for document {document_id}")

        # Get all guides
        guides = self.get_extraction_guides(
            project_number=project_number,
            category=category
        )

        if not guides:
            logger.warning(f"⚠️ No extraction guides found")
            return {
                "success": False,
                "error": "No extraction guides available"
            }

        # Execute each guide
        results = []
        for guide in guides:
            result = self.execute_guide(
                guide=guide,
                project_number=project_number,
                document_id=document_id,
                llm_mode=llm_mode
            )
            results.append(result)

        # Count successes
        successful_extractions = sum(1 for r in results if r.get("success") and r.get("extracted_value"))

        logger.info(f"✅ Guide execution complete: {successful_extractions}/{len(results)} values extracted")

        return {
            "success": True,
            "total_guides": len(guides),
            "successful_extractions": successful_extractions,
            "results": results
        }

    def store_extracted_values(
        self,
        project_number: str,
        document_id: str,
        extraction_results: List[Dict[str, Any]]
    ) -> bool:
        """
        Store extracted values in Neo4j graph with new structure

        NEW BEHAVIOR:
        - ActualValues include document_id and category_name in unique key
        - Links ActualValue to ExtractionGuide (EXTRACTED_BY_GUIDE)
        - Creates Document ↔ ExtractionGuide many-to-many relationships

        Args:
            project_number: Project OE number
            document_id: Document unique identifier
            extraction_results: List of extraction result dictionaries

        Returns:
            True if successful
        """
        try:
            logger.info(f"💾 Storing {len(extraction_results)} extracted values to graph")

            with self.neo4j_driver.session() as session:
                for result in extraction_results:
                    if not result.get("success") or not result.get("extracted_value"):
                        continue

                    field_name = result.get("field_name")
                    category_name = result.get("category", "")
                    value = result.get("extracted_value")
                    confidence = result.get("confidence", "medium")
                    source_section = result.get("source_section", "")

                    # Store value in graph with new relationships
                    session.run("""
                        MATCH (doc:Document {id: $doc_id, project_number: $project_number})
                        MATCH (field:SpecField {
                            name: $field_name,
                            category_name: $category_name,
                            document_id: $doc_id,
                            project_number: $project_number
                        })

                        // Match project-level guide
                        MATCH (guide:ExtractionGuide {
                            field_name: $field_name,
                            category_name: $category_name,
                            project_number: $project_number
                        })
                        WHERE guide.document_id IS NULL

                        // Create ActualValue with proper unique key (includes document_id)
                        MERGE (value:ActualValue {
                            field_name: $field_name,
                            category_name: $category_name,
                            document_id: $doc_id,
                            project_number: $project_number
                        })
                        SET value.extracted_value = $extracted_value,
                            value.confidence = $confidence,
                            value.source_section = $source_section,
                            value.extraction_method = 'guide_executor',
                            value.updated_at = datetime()

                        // Link value to field
                        MERGE (field)-[:HAS_VALUE]->(value)

                        // Link value to guide (for traceability)
                        MERGE (value)-[:EXTRACTED_BY_GUIDE]->(guide)

                        // Create many-to-many Document ↔ Guide relationships
                        MERGE (doc)-[:USES_GUIDE]->(guide)
                        MERGE (guide)-[:USED_IN_DOCUMENT]->(doc)
                    """, {
                        "field_name": field_name,
                        "category_name": category_name,
                        "extracted_value": value,
                        "confidence": confidence,
                        "doc_id": document_id,
                        "source_section": source_section,
                        "project_number": project_number
                    })

            logger.info(f"✅ Stored extracted values in graph with guide linkage")
            return True

        except Exception as e:
            logger.error(f"❌ Failed to store extracted values: {e}", exc_info=True)
            return False
