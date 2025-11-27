"""
Graph Entity & Relationship Extractor
Uses LLM to extract structured entities and relationships from PDF sections
"""

import json
import re
import logging
from typing import Dict, List, Optional, Tuple, Any
import requests

from electrical_ontology import (
    EntityType,
    RelationType,
    VoltageClass,
    ENTITY_ATTRIBUTES,
    ValidationRule,
    create_edge_embedding_text
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class GraphExtractor:
    """
    Extracts entities and relationships from text using LLM.
    
    This is the "intelligence" that builds your knowledge graph.
    """
    
    def __init__(self, ai_url: str, thinking_level: str = "medium"):
        self.ai_url = ai_url
        self.thinking_level = thinking_level
    
    def extract_from_section(self, 
                            section_title: str,
                            section_content: str,
                            project_id: str,
                            document_hash: str) -> Dict[str, Any]:
        """
        Extract entities and relationships from a document section.
        
        Returns:
            {
                "entities": [
                    {
                        "id": "CB_001",
                        "type": "CircuitBreaker",
                        "name": "Main Incomer CB",
                        "attributes": {...},
                        "confidence": 0.95
                    },
                    ...
                ],
                "relationships": [
                    {
                        "from": "CB_001",
                        "to": "TR_001",
                        "type": "feeds",
                        "attributes": {...},
                        "confidence": 0.90
                    },
                    ...
                ]
            }
        """
        logger.info(f"🔍 Extracting graph from: {section_title}")
        
        system_prompt = self._create_system_prompt()
        user_prompt = self._create_user_prompt(section_title, section_content)
        
        try:
            response = requests.post(
                self.ai_url,
                json={
                    "system_prompt": system_prompt,
                    "user_prompt": user_prompt,
                    "thinking_level": self.thinking_level,
                    "max_tokens": 3000,
                    "stream": False
                },
                timeout=120
            )
            
            response.raise_for_status()
            ai_output = response.json().get('output', '')
            
            # Parse LLM output
            extracted_data = self._parse_llm_output(ai_output)
            
            # Validate and enrich
            extracted_data = self._validate_and_enrich(extracted_data, project_id, document_hash)
            
            logger.info(f"✅ Extracted {len(extracted_data['entities'])} entities, "
                       f"{len(extracted_data['relationships'])} relationships")
            
            return extracted_data
            
        except Exception as e:
            logger.error(f"❌ Graph extraction failed: {e}")
            return {"entities": [], "relationships": [], "error": str(e)}
    
    def _create_system_prompt(self) -> str:
        """Create system prompt for LLM"""
        
        entity_types_str = ", ".join([et.value for et in EntityType])
        relation_types_str = ", ".join([rt.value for rt in RelationType])
        
        return f"""You are an AI specialized in extracting structured knowledge graphs from electrical engineering specifications.

Your task: Extract ENTITIES and RELATIONSHIPS from the provided text.

═══════════════════════════════════════════════════════════════════
ENTITY TYPES (identify these):
═══════════════════════════════════════════════════════════════════
{entity_types_str}

═══════════════════════════════════════════════════════════════════
RELATIONSHIP TYPES (identify these):
═══════════════════════════════════════════════════════════════════
{relation_types_str}

═══════════════════════════════════════════════════════════════════
OUTPUT FORMAT - MUST BE VALID JSON:
═══════════════════════════════════════════════════════════════════

{{
  "entities": [
    {{
      "id": "UNIQUE_ID",
      "type": "EntityType",
      "name": "Human-readable name",
      "attributes": {{
        "rated_voltage_kv": 33,
        "rated_current_a": 1250,
        ...
      }},
      "confidence": 0.95
    }}
  ],
  "relationships": [
    {{
      "from": "ENTITY_ID_1",
      "to": "ENTITY_ID_2",
      "type": "relationship_type",
      "attributes": {{
        "via": "intermediate_component",
        "description": "630A feeder connection"
      }},
      "confidence": 0.90
    }}
  ]
}}

═══════════════════════════════════════════════════════════════════
EXTRACTION RULES:
═══════════════════════════════════════════════════════════════════

1. **ENTITY IDs**: 
   - Use format: TYPE_NUMBER (e.g., CB_001, TR_001, CABLE_001)
   - If document provides ID/tag (e.g., "CB-1A"), use that
   - Be consistent across the document

2. **ENTITY NAMES**: 
   - Descriptive: "Main Incomer Circuit Breaker"
   - Include location if mentioned: "Panel A Main CB"
   - Include rating if key: "1250A Circuit Breaker"

3. **ATTRIBUTES**:
   - Extract ALL technical specifications
   - Include units in key names: "rated_voltage_kv", "rated_current_a"
   - Use standard units: kV, A, kA, mm², Hz, kVA
   - For ranges: {{"min": 20, "max": 55, "unit": "°C"}}

4. **RELATIONSHIPS**:
   - Identify physical connections: connects_to, feeds
   - Identify protection: protects, protected_by
   - Identify hierarchy: part_of, contains
   - Include "via" in attributes if connection goes through another component

5. **CONFIDENCE SCORES**:
   - 0.95+: Explicitly stated ("CB-001 feeds TR-001")
   - 0.80-0.94: Clearly implied from context
   - 0.60-0.79: Inferred from technical logic
   - <0.60: Uncertain, mark but flag

6. **VOLTAGE CLASS**:
   - LV: < 1kV
   - MV: 1kV - 36kV
   - HV: > 36kV

7. **HANDLE AMBIGUITY**:
   - If unclear, include but lower confidence
   - Add "inferred": true in attributes
   - Include reasoning in "note" field

═══════════════════════════════════════════════════════════════════
EXAMPLES:
═══════════════════════════════════════════════════════════════════

Input: "The 630A circuit breaker CB-1A connects to the 1000kVA transformer TR-1 
via 3x240mm² XLPE cable CABLE-1. The CB protects against overload with a 
definite-time relay."

Output:
{{
  "entities": [
    {{
      "id": "CB_1A",
      "type": "CircuitBreaker",
      "name": "Main Circuit Breaker CB-1A",
      "attributes": {{
        "rated_current_a": 630,
        "protection_type": "definite-time relay"
      }},
      "confidence": 0.98
    }},
    {{
      "id": "TR_1",
      "type": "Transformer",
      "name": "1000kVA Transformer TR-1",
      "attributes": {{
        "capacity_kva": 1000
      }},
      "confidence": 0.98
    }},
    {{
      "id": "CABLE_1",
      "type": "Cable",
      "name": "Power Cable CABLE-1",
      "attributes": {{
        "size_mm2": 240,
        "number_of_cores": 3,
        "insulation_type": "XLPE"
      }},
      "confidence": 0.95
    }}
  ],
  "relationships": [
    {{
      "from": "CB_1A",
      "to": "TR_1",
      "type": "feeds",
      "attributes": {{
        "via": "CABLE_1",
        "description": "630A power feed"
      }},
      "confidence": 0.95
    }},
    {{
      "from": "CB_1A",
      "to": "CABLE_1",
      "type": "connects_to",
      "attributes": {{}},
      "confidence": 0.98
    }},
    {{
      "from": "CABLE_1",
      "to": "TR_1",
      "type": "connects_to",
      "attributes": {{}},
      "confidence": 0.98
    }},
    {{
      "from": "CB_1A",
      "to": "TR_1",
      "type": "protects",
      "attributes": {{
        "protection_type": "overload"
      }},
      "confidence": 0.90
    }}
  ]
}}

═══════════════════════════════════════════════════════════════════
CRITICAL REMINDERS:
═══════════════════════════════════════════════════════════════════

- Extract EVERY component mentioned
- Identify ALL connections and relationships
- Be exhaustive with technical specifications
- Output ONLY valid JSON, no additional text
- Include confidence scores for everything

Now extract from the following section:
"""
    
    def _create_user_prompt(self, title: str, content: str) -> str:
        """Create user prompt"""
        return f"""Section Title: {title}

Section Content:
{content}

Extract all entities and relationships as structured JSON."""
    
    def _parse_llm_output(self, output: str) -> Dict[str, Any]:
        """Parse LLM JSON output"""
        try:
            # Clean output
            json_str = re.sub(r'^```json\s*', '', output)
            json_str = re.sub(r'\s*```$', '', json_str)
            
            # Find JSON object
            json_match = re.search(r'\{.*\}', json_str, re.DOTALL)
            if json_match:
                json_str = json_match.group()
            
            data = json.loads(json_str)
            
            # Ensure required keys
            if "entities" not in data:
                data["entities"] = []
            if "relationships" not in data:
                data["relationships"] = []
            
            return data
            
        except Exception as e:
            logger.error(f"Failed to parse LLM output: {e}")
            return {"entities": [], "relationships": [], "parse_error": str(e)}
    
    def _validate_and_enrich(self, 
                            data: Dict[str, Any],
                            project_id: str,
                            document_hash: str) -> Dict[str, Any]:
        """
        Validate extracted data and enrich with metadata.
        """
        # Enrich entities
        enriched_entities = []
        entity_map = {}  # For relationship validation
        
        for entity in data.get("entities", []):
            # Normalize entity type
            entity_type = self._normalize_entity_type(entity.get("type", ""))
            
            if not entity_type:
                logger.warning(f"⚠️ Unknown entity type: {entity.get('type')}")
                continue
            
            # Add metadata
            entity["type"] = entity_type.value
            entity["voltage_class"] = self._infer_voltage_class(entity.get("attributes", {}))
            entity["project_id"] = project_id
            entity["document_hash"] = document_hash
            
            # Validate attributes against schema
            if entity_type in ENTITY_ATTRIBUTES:
                entity["attributes"] = self._validate_attributes(
                    entity.get("attributes", {}),
                    ENTITY_ATTRIBUTES[entity_type]
                )
            
            enriched_entities.append(entity)
            entity_map[entity["id"]] = entity
        
        # Validate relationships
        enriched_relationships = []
        
        for rel in data.get("relationships", []):
            # Check entities exist
            if rel["from"] not in entity_map or rel["to"] not in entity_map:
                logger.warning(f"⚠️ Relationship references unknown entity: {rel['from']} → {rel['to']}")
                continue
            
            # Normalize relationship type
            rel_type = self._normalize_relation_type(rel.get("type", ""))
            
            if not rel_type:
                logger.warning(f"⚠️ Unknown relationship type: {rel.get('type')}")
                continue
            
            rel["type"] = rel_type.value
            rel["project_id"] = project_id
            rel["document_hash"] = document_hash
            
            # Validate compatibility
            entity1 = entity_map[rel["from"]]
            entity2 = entity_map[rel["to"]]
            
            if not ValidationRule.validate_voltage_compatibility(
                entity1.get("attributes", {}),
                entity2.get("attributes", {}),
                rel_type
            ):
                logger.warning(f"⚠️ Voltage incompatibility: {rel['from']} → {rel['to']}")
                rel["validation_warning"] = "voltage_incompatible"
            
            enriched_relationships.append(rel)
        
        return {
            "entities": enriched_entities,
            "relationships": enriched_relationships
        }
    
    def _normalize_entity_type(self, type_str: str) -> Optional[EntityType]:
        """Normalize entity type string to EntityType enum"""
        type_str = type_str.strip().replace(" ", "").replace("-", "").replace("_", "").lower()
        
        for et in EntityType:
            if et.value.replace("_", "").lower() == type_str:
                return et
        
        return None
    
    def _normalize_relation_type(self, type_str: str) -> Optional[RelationType]:
        """Normalize relationship type string"""
        type_str = type_str.strip().replace(" ", "_").replace("-", "_").lower()
        
        for rt in RelationType:
            if rt.value == type_str:
                return rt
        
        return None
    
    def _infer_voltage_class(self, attributes: Dict) -> Optional[str]:
        """Infer voltage class from attributes"""
        voltage_keys = ["rated_voltage_kv", "voltage_rating_kv", "voltage_kv", "primary_voltage_kv"]
        
        for key in voltage_keys:
            if key in attributes:
                voltage = attributes[key]
                if voltage < 1:
                    return VoltageClass.LV.value
                elif voltage <= 36:
                    return VoltageClass.MV.value
                else:
                    return VoltageClass.HV.value
        
        return None
    
    def _validate_attributes(self, attributes: Dict, schema_class: type) -> Dict:
        """Validate attributes against schema"""
        # Basic validation - can be expanded
        return attributes


# Export
__all__ = ['GraphExtractor']