"""
Enhanced Specification Extractor Service
==========================================
Uses two-stage RAG process to extract specification values:
1. Semantic search in Qdrant to find relevant document chunks
2. LLM extraction guided by detailed extraction guides from Neo4j

This provides more accurate extraction by combining vector search
with detailed domain knowledge.

Author: Simorgh Industrial Assistant
"""

import logging
import json
from typing import Dict, Any, Optional, List
from services.llm_service import LLMService
from services.qdrant_service import QdrantService
from services.project_graph_init import ProjectGraphInitializer
from services.extraction_guides_data import get_extraction_guide, get_all_extraction_guides

logger = logging.getLogger(__name__)


class EnhancedSpecExtractor:
    """
    Enhanced specification extractor using two-stage RAG process
    """

    def __init__(
        self,
        llm_service: LLMService,
        qdrant_service: QdrantService,
        graph_initializer: ProjectGraphInitializer
    ):
        """
        Initialize with required services

        Args:
            llm_service: LLM service for text generation
            qdrant_service: Qdrant vector database service
            graph_initializer: Neo4j graph initializer service
        """
        self.llm_service = llm_service
        self.qdrant_service = qdrant_service
        self.graph_initializer = graph_initializer

    def extract_specifications_enhanced(
        self,
        project_number: str,
        document_id: str,
        llm_mode: str = "online",
        search_limit: int = 5
    ) -> Dict[str, Dict[str, str]]:
        """
        Extract specifications using two-stage RAG process

        Stage 1: For each spec field, use extraction guide + semantic search
                 to find relevant document chunks
        Stage 2: Use LLM with guide instructions and relevant chunks to
                 extract the actual value

        Args:
            project_number: Project OE number
            document_id: Document identifier
            llm_mode: LLM mode ('online' or 'offline')
            search_limit: Number of chunks to retrieve per field

        Returns:
            Extracted specifications dictionary
        """
        logger.info(f"🔍 Starting enhanced spec extraction for {document_id}")

        # Get all extraction guides
        all_guides = get_all_extraction_guides()

        extracted_specs = {}

        # Process each category
        for category_name, fields_guides in all_guides.items():
            logger.info(f"📊 Processing category: {category_name}")

            category_values = {}

            # Extract each field in the category
            for field_name, guide_content in fields_guides.items():
                logger.info(f"  🔎 Extracting: {field_name}")

                try:
                    # Two-stage extraction
                    value = self._extract_field_value(
                        project_number=project_number,
                        document_id=document_id,
                        category_name=category_name,
                        field_name=field_name,
                        guide=guide_content,
                        llm_mode=llm_mode,
                        search_limit=search_limit
                    )

                    category_values[field_name] = value
                    logger.info(f"  ✓ Extracted: {field_name} = {value[:50] if value else 'N/A'}...")

                except Exception as e:
                    logger.error(f"  ❌ Failed to extract {field_name}: {e}")
                    category_values[field_name] = ""

            extracted_specs[category_name] = category_values

        logger.info(f"✅ Enhanced extraction completed: {len(extracted_specs)} categories")
        return extracted_specs

    def _extract_field_value(
        self,
        project_number: str,
        document_id: str,
        category_name: str,
        field_name: str,
        guide: Dict[str, str],
        llm_mode: str,
        search_limit: int
    ) -> str:
        """
        Extract single field value using two-stage RAG

        Args:
            project_number: Project number
            document_id: Document ID
            category_name: Category name
            field_name: Field name
            guide: Extraction guide content
            llm_mode: LLM mode
            search_limit: Number of chunks to search

        Returns:
            Extracted value string
        """
        # STAGE 1: Semantic search using extraction guide
        search_query = self._build_search_query(field_name, guide)

        # Search in Qdrant for relevant chunks
        relevant_chunks = self.qdrant_service.semantic_search(
            project_number=project_number,
            query=search_query,
            limit=search_limit,
            document_id=document_id,
            score_threshold=0.3  # Lower threshold to catch more possibilities
        )

        if not relevant_chunks:
            logger.warning(f"⚠️ No relevant chunks found for {field_name}")
            return ""

        # Combine chunk texts
        context_text = "\n\n".join([
            f"[Section: {chunk['section_title']}]\n{chunk['text']}"
            for chunk in relevant_chunks
        ])

        # STAGE 2: LLM extraction with guide and context
        extraction_prompt = self._build_extraction_prompt(
            field_name=field_name,
            guide=guide,
            context=context_text
        )

        # Generate extraction
        messages = [
            {
                "role": "system",
                "content": "You are an expert electrical engineer extracting information from technical specification documents. Be FLEXIBLE - extract ANY relevant information about the requested field, including product names, technical specifications, requirements, descriptions, or features. Accept multiple formats: exact values, ratings with units, requirement statements, or descriptive text. Combine related information concisely. Only respond 'Not specified' if truly no relevant information exists."
            },
            {
                "role": "user",
                "content": extraction_prompt
            }
        ]

        try:
            response = self.llm_service.generate(
                messages=messages,
                mode=llm_mode,
                temperature=0.1,  # Low temperature for factual extraction
                max_tokens=400  # Increased to allow flexible, descriptive extractions

                

            )

            extracted_value = response.strip()

            # Clean up common patterns - only filter explicit "not found" responses
            if extracted_value.lower() in ['not specified', 'not found', 'n/a', 'none', 'not mentioned']:
                return ""
            
            extracted_value = extracted_value.replace("Extracted Information:", "").strip()

            extracted_value = extracted_value.replace("**Extracted Information:**", "").strip()

            # Remove common LLM wrapper phrases
            extracted_value = extracted_value.replace("Extracted Information:", "").strip()
            extracted_value = extracted_value.replace("**Extracted Information:**", "").strip()

            return extracted_value

        except Exception as e:
            logger.error(f"❌ LLM extraction failed for {field_name}: {e}")
            return ""

    def _build_search_query(self, field_name: str, guide: Dict[str, str]) -> str:
        """
        Build semantic search query from field name and guide

        Args:
            field_name: Field name
            guide: Extraction guide

        Returns:
            Search query string
        """
        # Combine field definition with common values for better search
        field_readable = field_name.replace("_", " ")

        query_parts = [
            field_readable,
            guide.get("definition", "")[:200],  # First 200 chars of definition
        ]

        # Add keywords from extraction instructions
        instructions = guide.get("extraction_instructions", "")
        if instructions:
            # Extract key terms in quotes or common technical terms
            query_parts.append(instructions[:150])

        return " ".join(query_parts)

    def _build_extraction_prompt(
        self,
        field_name: str,
        guide: Dict[str, str],
        context: str
    ) -> str:
        """
        Build LLM prompt for extracting field value

        Args:
            field_name: Field name
            guide: Extraction guide
            context: Relevant document context

        Returns:
            Prompt string
        """
        field_readable = field_name.replace("_", " ")

        prompt = f"""
Extract information for: **{field_readable}**


**Definition:**

{guide.get('definition', 'N/A')}

**How to identify this information:**
{guide.get('extraction_instructions', 'N/A')}

**Examples of possible formats:**
{guide.get('examples', 'N/A')}

**Typical values (for reference):**
{guide.get('common_values', 'N/A')}

**Related information:**

{guide.get('relationships', 'N/A')}

 

**Important notes:**

{guide.get('notes', 'N/A')}

 

---

 

**Document Context (most relevant sections):**

 

{context}

 

---

 

**Task:**
Extract ANY relevant information about "{field_readable}" from the document context above.

**IMPORTANT - Be FLEXIBLE:**
✓ Accept product names, model numbers, or type descriptions
✓ Accept technical specifications (ratings, capacities, values with units)
✓ Accept requirements or mandatory conditions ("shall be provided...", "must have...")
✓ Accept descriptions of features or characteristics
✓ Accept presence/absence indicators ("included", "not required", "provided")
✓ Accept interlocking or operational requirements
✓ Combine multiple related pieces of information if found

**What to extract:**
- If you find a product name or type → extract it
- If you find technical specs or ratings → extract them
- If you find requirements or conditions → extract them
- If you find descriptions or features → extract them
- If you find multiple relevant pieces → combine them concisely

**Format:**
- Keep it concise but complete
- Include units when applicable (kA, kV, mm, etc.)
- Separate multiple items with semicolons if needed
- Example: "Provided at line side; 80 kA peak capacity; Interlocked with circuit breaker"

**If no relevant information is found:**
- Respond ONLY with: "Not specified"

**Extracted Information:**

"""

        return prompt.strip()

    def extract_with_fallback(
        self,
        project_number: str,
        document_id: str,
        markdown_content: str,
        filename: str,
        llm_mode: str = "online"
    ) -> Dict[str, Dict[str, str]]:
        """
        Extract specifications with fallback to simple extraction

        Tries enhanced RAG extraction first. If Qdrant chunks are not available,
        falls back to simple full-document LLM extraction.

        Args:
            project_number: Project OE number
            document_id: Document ID
            markdown_content: Full document markdown (for fallback)
            filename: Original filename
            llm_mode: LLM mode

        Returns:
            Extracted specifications
        """
        logger.info(f"🔄 Attempting enhanced extraction with RAG")

        try:
            # Try enhanced extraction
            specs = self.extract_specifications_enhanced(
                project_number=project_number,
                document_id=document_id,
                llm_mode=llm_mode
            )

            # Check if we got any meaningful results
            total_extracted = sum(
                1 for category in specs.values()
                for value in category.values()
                if value and value.strip()
            )

            if total_extracted > 5:  # If we got at least some values
                logger.info(f"✅ Enhanced extraction successful: {total_extracted} fields extracted")
                return specs
            else:
                logger.warning(f"⚠️ Enhanced extraction got few results ({total_extracted}), trying fallback")
                raise Exception("Insufficient results from enhanced extraction")

        except Exception as e:
            logger.warning(f"⚠️ Enhanced extraction failed: {e}. Falling back to simple extraction.")

            # Fallback to simple extraction using full document
            return self._simple_extraction_fallback(
                markdown_content=markdown_content,
                llm_mode=llm_mode
            )

    def _simple_extraction_fallback(
        self,
        markdown_content: str,
        llm_mode: str
    ) -> Dict[str, Dict[str, str]]:
        """
        Simple fallback extraction using full document

        Args:
            markdown_content: Full document content
            llm_mode: LLM mode

        Returns:
            Extracted specifications
        """
        logger.info(f"🔄 Using simple fallback extraction")

        all_guides = get_all_extraction_guides()
        extracted_specs = {}

        # Process in batches by category to avoid token limits
        for category_name, fields_guides in all_guides.items():
            logger.info(f"📊 Processing category (fallback): {category_name}")

            # Build prompt for entire category
            prompt = self._build_category_extraction_prompt(
                category_name=category_name,
                fields_guides=fields_guides,
                document_content=markdown_content[:15000]  # Limit document size
            )

            messages = [
                {
                    "role": "system",
                    "content": "You are an expert electrical engineer. Extract specification values from the document and return them as JSON."
                },
                {
                    "role": "user",
                    "content": prompt
                }
            ]

            try:
                response = self.llm_service.generate(
                    messages=messages,
                    mode=llm_mode,
                    temperature=0.1,
                    max_tokens=2000
                )

                # Try to parse JSON response
                try:
                    category_values = json.loads(response)
                except:
                    # If not valid JSON, create empty dict
                    logger.warning(f"⚠️ Could not parse LLM response as JSON for {category_name}")
                    category_values = {field: "" for field in fields_guides.keys()}

                extracted_specs[category_name] = category_values

            except Exception as e:
                logger.error(f"❌ Fallback extraction failed for {category_name}: {e}")
                extracted_specs[category_name] = {field: "" for field in fields_guides.keys()}

        return extracted_specs

    def _build_category_extraction_prompt(
        self,
        category_name: str,
        fields_guides: Dict[str, Dict[str, str]],
        document_content: str
    ) -> str:
        """
        Build prompt for extracting entire category

        Args:
            category_name: Category name
            fields_guides: Field guides for this category
            document_content: Document content

        Returns:
            Prompt string
        """
        fields_list = "\n".join([
            f"- {field.replace('_', ' ')}: {guide.get('definition', '')[:100]}..."
            for field, guide in fields_guides.items()
        ])

        prompt = f"""
Extract all values for category: **{category_name}**

**Fields to extract:**
{fields_list}

**Document content:**
{document_content}

**Instructions:**
- Extract values for all fields listed above
- Return as JSON object with field names as keys
- Use empty string "" for values not found
- Use exact field names as shown above (with underscores)

**Return JSON only, no other text:**
"""

        return prompt.strip()
