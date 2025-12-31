"""
Specification Document CoCoIndex Flow
======================================
Processes electrical specification documents and extracts structured data
based on ITEM 1-13 categories (Siemens LV/MV switchgear specifications).

This flow:
1. Detects specification documents
2. Extracts entities based on 13 category items
3. Creates graph structure with categories, fields, and values
4. Links to project-level extraction guides

Author: Simorgh Industrial Assistant
"""

import os
import re
import json
import logging
from typing import List, Dict, Any, Optional, Tuple
from dataclasses import dataclass

from .base_flow import (
    BaseDocumentFlow,
    ExtractedEntity,
    ExtractedRelationship,
    ExtractionResult,
    get_flow_registry
)

logger = logging.getLogger(__name__)


# =============================================================================
# SPECIFICATION EXTRACTION SCHEMA
# =============================================================================

SPEC_EXTRACTION_SCHEMA = {
    "ITEM_1": {
        "category_name": "Switchgear Specifications",
        "item_number": 1,
        "fields": [
            "Type of Switchgear",
            "Rated Voltage",
            "Rated Current",
            "Rated Frequency",
            "Short Circuit Current (1S)",
            "Short Circuit Current (3S)",
            "Peak Short Circuit Current",
            "Control Voltage",
            "Busbar System",
            "Protection Degree",
            "Installation Type",
            "Paint Color",
            "Type of Wiring",
            "AC Auxiliary Voltage",
            "DC Auxiliary Voltage",
            "Interruption",
            "Form of Separation",
            "Accessibility",
            "Service Continuity",
            "Type of Construction",
            "Type of Operating Mechanism"
        ]
    },
    "ITEM_2": {
        "category_name": "Busbar Specifications",
        "item_number": 2,
        "fields": [
            "Main Busbar Material",
            "Main Busbar Size",
            "Vertical Busbar Material",
            "Vertical Busbar Size",
            "Earth Busbar Material",
            "Earth Busbar Size",
            "Neutral Busbar Material",
            "Neutral Busbar Size",
            "Busbar Support Type",
            "Busbar Connection Type"
        ]
    },
    "ITEM_3": {
        "category_name": "Wire Size",
        "item_number": 3,
        "fields": [
            "Control Wire Size",
            "Power Wire Size",
            "CT Wire Size",
            "Earthing Wire Size"
        ]
    },
    "ITEM_4": {
        "category_name": "Wire Color",
        "item_number": 4,
        "fields": [
            "Phase L1 Color",
            "Phase L2 Color",
            "Phase L3 Color",
            "Neutral Color",
            "Earth Color",
            "Control Wire Color"
        ]
    },
    "ITEM_5": {
        "category_name": "Wire Specifications",
        "item_number": 5,
        "fields": [
            "Wire Type",
            "Wire Insulation",
            "Wire Rating",
            "Wire Standard"
        ]
    },
    "ITEM_6": {
        "category_name": "Label Color",
        "item_number": 6,
        "fields": [
            "Equipment Label Color",
            "Warning Label Color",
            "Identification Label Color"
        ]
    },
    "ITEM_7": {
        "category_name": "Auxiliary Voltage",
        "item_number": 7,
        "fields": [
            "AC Auxiliary Voltage",
            "DC Auxiliary Voltage",
            "Control Circuit Voltage",
            "Signaling Voltage"
        ]
    },
    "ITEM_8": {
        "category_name": "Accessories",
        "item_number": 8,
        "fields": [
            "Space Heater",
            "Thermostat",
            "Interior Light",
            "Door Switch",
            "Earthing Switch",
            "Surge Arrester",
            "Padlock Provision",
            "Mimic Diagram",
            "Lifting Eyes",
            "Base Frame",
            "Cable Gland Plate",
            "Terminal Blocks",
            "Auxiliary Contacts",
            "Spring Charging Motor",
            "Mechanical Interlock",
            "Key Interlock",
            "Position Indicator",
            "Trip Circuit Supervision",
            "Arc Flash Protection",
            "Temperature Monitoring",
            "Humidity Control",
            "Ventilation Fan",
            "Cable Entry"
        ]
    },
    "ITEM_9": {
        "category_name": "CT & PT",
        "item_number": 9,
        "fields": [
            "CT Specification",
            "PT Specification",
            "CT/PT Class"
        ]
    },
    "ITEM_10": {
        "category_name": "Measuring Instrument",
        "item_number": 10,
        "fields": [
            "Ammeter Type",
            "Voltmeter Type",
            "Power Meter Type",
            "Energy Meter Type",
            "Power Factor Meter",
            "Frequency Meter"
        ]
    },
    "ITEM_11": {
        "category_name": "Circuit Breaker",
        "item_number": 11,
        "fields": [
            "Circuit Breaker Type",
            "Breaking Capacity",
            "Operating Mechanism"
        ]
    },
    "ITEM_12": {
        "category_name": "Network",
        "item_number": 12,
        "fields": [
            "Communication Protocol",
            "Network Interface",
            "SCADA Integration",
            "Remote Monitoring",
            "Data Logger"
        ]
    },
    "ITEM_13": {
        "category_name": "Voltage Class",
        "item_number": 13,
        "fields": [
            "Voltage Class"
        ]
    }
}


# =============================================================================
# SPECIFICATION FLOW IMPLEMENTATION
# =============================================================================

class SpecificationFlow(BaseDocumentFlow):
    """
    CoCoIndex flow for processing Specification documents.

    Handles ITEM 1-13 extraction for Siemens LV/MV switchgear specifications.
    """

    @property
    def document_type(self) -> str:
        return "Specification"

    @property
    def supported_file_patterns(self) -> List[str]:
        return [
            "*spec*",
            "*specification*",
            "*technical*requirement*",
            "*data*sheet*",
            "*switchgear*spec*"
        ]

    def detect_document_type(
        self,
        content: str,
        filename: str,
        metadata: Dict[str, Any] = None
    ) -> Tuple[bool, float]:
        """
        Detect if document is a specification.

        Checks:
        1. Filename patterns
        2. Content keywords
        3. Structure patterns (ITEM references)
        """
        confidence = 0.0
        filename_lower = filename.lower()
        content_lower = content.lower()[:5000]  # Check first 5000 chars

        # Filename checks
        if "spec" in filename_lower:
            confidence += 0.3
        if "technical" in filename_lower and "requirement" in filename_lower:
            confidence += 0.2
        if "datasheet" in filename_lower or "data sheet" in filename_lower:
            confidence += 0.2

        # Content keyword checks
        spec_keywords = [
            "rated voltage",
            "rated current",
            "short circuit",
            "switchgear",
            "busbar",
            "circuit breaker",
            "protection degree",
            "ip rating",
            "auxiliary voltage"
        ]

        keyword_matches = sum(1 for kw in spec_keywords if kw in content_lower)
        confidence += min(keyword_matches * 0.1, 0.4)

        # ITEM pattern check
        item_pattern = r'\bitem\s*\d+\b'
        item_matches = len(re.findall(item_pattern, content_lower))
        if item_matches >= 3:
            confidence += 0.3
        elif item_matches >= 1:
            confidence += 0.15

        # Category name check
        for item_key, item_data in SPEC_EXTRACTION_SCHEMA.items():
            if item_data["category_name"].lower() in content_lower:
                confidence += 0.1
                break

        # Cap at 1.0
        confidence = min(confidence, 1.0)

        can_handle = confidence >= 0.3
        logger.debug(f"Specification detection: {filename} -> {can_handle} ({confidence:.2f})")

        return can_handle, confidence

    def extract_entities(
        self,
        project_number: str,
        document_id: str,
        content: str,
        filename: str,
        llm_mode: str = None
    ) -> ExtractionResult:
        """
        Extract specification entities from document.

        Creates:
        - SpecificationDocument node
        - SpecCategory nodes for each ITEM
        - SpecField nodes for each field
        - ActualValue nodes for extracted values
        """
        entities: List[ExtractedEntity] = []
        relationships: List[ExtractedRelationship] = []
        errors: List[str] = []

        try:
            # Create document entity
            doc_entity = ExtractedEntity(
                entity_type="SpecificationDocument",
                entity_id=document_id,
                properties={
                    "filename": filename,
                    "document_type": "Specification"
                },
                confidence="high"
            )
            entities.append(doc_entity)

            # Process each category
            for item_key, item_data in SPEC_EXTRACTION_SCHEMA.items():
                category_name = item_data["category_name"]
                item_number = item_data["item_number"]
                fields = item_data["fields"]

                # Extract values for this category
                category_result = self._extract_category(
                    content=content,
                    category_name=category_name,
                    item_number=item_number,
                    fields=fields,
                    llm_mode=llm_mode
                )

                if category_result.get("success"):
                    # Create category entity
                    category_id = f"{document_id}_ITEM_{item_number}"
                    category_entity = ExtractedEntity(
                        entity_type="SpecCategory",
                        entity_id=category_id,
                        properties={
                            "name": category_name,
                            "item_number": item_number,
                            "document_id": document_id
                        },
                        confidence="high"
                    )
                    entities.append(category_entity)

                    # Link category to document
                    relationships.append(ExtractedRelationship(
                        from_entity_id=document_id,
                        to_entity_id=category_id,
                        relationship_type="HAS_SPEC_CATEGORY"
                    ))

                    # Create field and value entities
                    for field_data in category_result.get("fields", []):
                        field_name = field_data.get("field_name", "")
                        value = field_data.get("value")
                        confidence = field_data.get("confidence", "medium")
                        source_text = field_data.get("source_text", "")

                        # Create field entity
                        field_id = f"{category_id}_{self._sanitize_id(field_name)}"
                        field_entity = ExtractedEntity(
                            entity_type="SpecField",
                            entity_id=field_id,
                            properties={
                                "name": field_name,
                                "category_name": category_name,
                                "document_id": document_id
                            },
                            confidence="high"
                        )
                        entities.append(field_entity)

                        # Link field to category
                        relationships.append(ExtractedRelationship(
                            from_entity_id=category_id,
                            to_entity_id=field_id,
                            relationship_type="HAS_FIELD"
                        ))

                        # Create value entity if value exists
                        if value:
                            value_id = f"{field_id}_value"
                            value_entity = ExtractedEntity(
                                entity_type="ActualValue",
                                entity_id=value_id,
                                properties={
                                    "value": value,
                                    "field_name": field_name,
                                    "category_name": category_name,
                                    "document_id": document_id,
                                    "extraction_method": "spec_flow"
                                },
                                source_text=source_text,
                                confidence=confidence
                            )
                            entities.append(value_entity)

                            # Link value to field
                            relationships.append(ExtractedRelationship(
                                from_entity_id=field_id,
                                to_entity_id=value_id,
                                relationship_type="HAS_VALUE"
                            ))

            return ExtractionResult(
                success=True,
                document_id=document_id,
                document_type=self.document_type,
                entities=entities,
                relationships=relationships,
                metadata={"categories_processed": len(SPEC_EXTRACTION_SCHEMA)}
            )

        except Exception as e:
            logger.error(f"Extraction failed: {e}")
            errors.append(str(e))
            return ExtractionResult(
                success=False,
                document_id=document_id,
                document_type=self.document_type,
                entities=entities,
                relationships=relationships,
                errors=errors
            )

    def _extract_category(
        self,
        content: str,
        category_name: str,
        item_number: int,
        fields: List[str],
        llm_mode: str = None
    ) -> Dict[str, Any]:
        """
        Extract values for a single category using LLM.

        Args:
            content: Document content
            category_name: Category name
            item_number: ITEM number
            fields: List of field names to extract
            llm_mode: LLM mode

        Returns:
            Extraction result with field values
        """
        if not self.llm_service:
            logger.warning("No LLM service available, using pattern matching")
            return self._pattern_extract_category(content, category_name, fields)

        try:
            # Build extraction prompt
            fields_list = "\n".join([f"- {field}" for field in fields])

            system_prompt = f"""You are an expert electrical specification extractor.

Extract values for the following specification category from the document.

**Category:** {category_name} (ITEM {item_number})
**Fields to Extract:**
{fields_list}

For each field, find the exact value specified in the document.
If a value is not found, return null.

Return JSON format:
{{
    "category": "{category_name}",
    "fields": [
        {{
            "field_name": "...",
            "value": "extracted value or null",
            "confidence": "high|medium|low",
            "source_text": "relevant excerpt from document"
        }}
    ]
}}"""

            user_prompt = f"""**Document Content (excerpt):**
{content[:6000]}

---

Extract all values for **{category_name}** (ITEM {item_number}).
"""

            # Call LLM
            result = self.llm_service.generate(
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt}
                ],
                mode=llm_mode,
                temperature=0.1,
                use_cache=True
            )

            response_text = result.get("response", "")

            # Parse JSON response
            json_match = re.search(r'```(?:json)?\s*(\{.*?\})\s*```', response_text, re.DOTALL)
            if json_match:
                json_str = json_match.group(1)
            else:
                json_match = re.search(r'\{.*\}', response_text, re.DOTALL)
                json_str = json_match.group(0) if json_match else "{}"

            extraction = json.loads(json_str)

            return {
                "success": True,
                "category": category_name,
                "fields": extraction.get("fields", [])
            }

        except Exception as e:
            logger.error(f"LLM extraction failed for {category_name}: {e}")
            return self._pattern_extract_category(content, category_name, fields)

    def _pattern_extract_category(
        self,
        content: str,
        category_name: str,
        fields: List[str]
    ) -> Dict[str, Any]:
        """
        Fallback pattern-based extraction when LLM unavailable.

        Uses regex patterns to find field values.
        """
        extracted_fields = []
        content_lower = content.lower()

        for field_name in fields:
            field_lower = field_name.lower()

            # Common patterns for field:value pairs
            patterns = [
                rf'{re.escape(field_lower)}\s*[:\-=]\s*([^\n]+)',
                rf'{re.escape(field_lower)}\s+(?:is|are|shall be)\s+([^\n]+)',
                rf'(?:^|\n)\s*{re.escape(field_lower)}\s*[:\-=]\s*([^\n]+)',
            ]

            value = None
            source_text = ""

            for pattern in patterns:
                match = re.search(pattern, content_lower, re.IGNORECASE)
                if match:
                    value = match.group(1).strip()[:200]  # Limit value length
                    # Get source context
                    start = max(0, match.start() - 50)
                    end = min(len(content), match.end() + 50)
                    source_text = content[start:end]
                    break

            extracted_fields.append({
                "field_name": field_name,
                "value": value,
                "confidence": "low" if value else None,
                "source_text": source_text
            })

        return {
            "success": True,
            "category": category_name,
            "fields": extracted_fields
        }

    def build_relationships(
        self,
        entities: List[ExtractedEntity],
        content: str = None
    ) -> List[ExtractedRelationship]:
        """
        Build additional relationships between specification entities.

        Links:
        - Related categories based on content references
        - Values to extraction guides (if available)
        """
        additional_relationships: List[ExtractedRelationship] = []

        # Find related categories based on content
        categories = [e for e in entities if e.entity_type == "SpecCategory"]

        for i, cat1 in enumerate(categories):
            for cat2 in categories[i+1:]:
                # Check if categories reference each other in their properties
                cat1_name = cat1.properties.get("name", "").lower()
                cat2_name = cat2.properties.get("name", "").lower()

                # Known related pairs
                related_pairs = [
                    ("switchgear", "circuit breaker"),
                    ("busbar", "wire"),
                    ("ct & pt", "measuring"),
                    ("accessories", "network")
                ]

                for pair in related_pairs:
                    if (pair[0] in cat1_name and pair[1] in cat2_name) or \
                       (pair[1] in cat1_name and pair[0] in cat2_name):
                        additional_relationships.append(ExtractedRelationship(
                            from_entity_id=cat1.entity_id,
                            to_entity_id=cat2.entity_id,
                            relationship_type="RELATED_TO"
                        ))
                        break

        return additional_relationships

    def _sanitize_id(self, text: str) -> str:
        """Sanitize text for use as entity ID"""
        # Replace special characters with underscores
        sanitized = re.sub(r'[^a-zA-Z0-9_]', '_', text)
        # Remove consecutive underscores
        sanitized = re.sub(r'_+', '_', sanitized)
        # Remove leading/trailing underscores
        return sanitized.strip('_')

    def get_extraction_prompt(
        self,
        category: str = None,
        fields: List[str] = None
    ) -> str:
        """Get extraction prompt for specification documents"""
        if category and fields:
            fields_list = "\n".join([f"- {f}" for f in fields])
            return f"""Extract values for {category}:

**Fields:**
{fields_list}

Return JSON with field names and extracted values."""

        # Full extraction prompt
        return """You are an expert electrical specification extractor.

Extract all specification values from this document.

Focus on these 13 categories:
1. Switchgear Specifications
2. Busbar Specifications
3. Wire Size
4. Wire Color
5. Wire Specifications
6. Label Color
7. Auxiliary Voltage
8. Accessories
9. CT & PT
10. Measuring Instrument
11. Circuit Breaker
12. Network
13. Voltage Class

For each category, extract all relevant fields and their values.

Return structured JSON with:
{
    "categories": [
        {
            "name": "Category Name",
            "item_number": 1,
            "fields": [
                {"field_name": "...", "value": "...", "confidence": "high|medium|low"}
            ]
        }
    ]
}
"""


# =============================================================================
# FLOW REGISTRATION
# =============================================================================

def create_specification_flow(
    cocoindex_adapter,
    llm_service=None,
    qdrant_service=None
) -> SpecificationFlow:
    """
    Create and optionally register a SpecificationFlow instance.

    Args:
        cocoindex_adapter: CoCoIndex adapter
        llm_service: Optional LLM service
        qdrant_service: Optional Qdrant service

    Returns:
        SpecificationFlow instance
    """
    flow = SpecificationFlow(
        cocoindex_adapter=cocoindex_adapter,
        llm_service=llm_service,
        qdrant_service=qdrant_service
    )

    # Register with flow registry
    registry = get_flow_registry()
    registry.register_flow(flow)

    return flow


def get_spec_extraction_schema() -> Dict[str, Any]:
    """Get the complete specification extraction schema"""
    return SPEC_EXTRACTION_SCHEMA.copy()
