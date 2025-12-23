"""
Graph Builder Service
=====================
Automatically extracts entities from spec documents and builds
knowledge graph structure with relationships.

Author: Simorgh Industrial Assistant
"""

import logging
from typing import List, Dict, Any, Optional
import json
import re

logger = logging.getLogger(__name__)


class GraphBuilder:
    """
    Service for building knowledge graph from documents
    """

    def __init__(self, llm_service, neo4j_driver):
        """
        Initialize graph builder

        Args:
            llm_service: LLMService for entity extraction
            neo4j_driver: Neo4j driver for graph operations
        """
        self.llm_service = llm_service
        self.neo4j_driver = neo4j_driver

    def extract_entities_from_spec(
        self,
        document_content: str,
        document_id: str,
        filename: str,
        llm_mode: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Extract structured entities from spec document using LLM

        Args:
            document_content: Full document content
            document_id: Unique document identifier
            filename: Original filename
            llm_mode: Optional LLM mode

        Returns:
            Dictionary with extracted entities and relationships
        """
        try:
            logger.info(f"🔍 Extracting entities from spec: {filename}")

            system_prompt = """You are an expert electrical engineering document analyzer.

Your task is to extract structured entities and their relationships from a technical specification document.

Extract the following types of entities:
1. **Equipment**: Switchgear, transformers, circuit breakers, protection devices, etc.
2. **Systems**: Power distribution systems, protection systems, control systems, etc.
3. **Specifications**: Technical requirements, ratings, standards, parameters
4. **Relationships**: How entities are connected or related

Provide output in this JSON format:
{
    "equipment": [
        {
            "name": "Equipment name",
            "type": "Type of equipment",
            "specifications": ["spec1", "spec2"],
            "related_systems": ["system1"]
        }
    ],
    "systems": [
        {
            "name": "System name",
            "type": "System type",
            "description": "Brief description",
            "components": ["component1", "component2"]
        }
    ],
    "specifications": [
        {
            "category": "Category name (e.g., Power Distribution, Protection)",
            "fields": [
                {
                    "name": "Field name",
                    "value": "Extracted value",
                    "unit": "Unit if applicable",
                    "description": "What this specifies"
                }
            ]
        }
    ],
    "relationships": [
        {
            "from": "Entity 1",
            "to": "Entity 2",
            "type": "Relationship type (CONNECTED_TO, PROTECTS, SUPPLIES, etc.)"
        }
    ]
}"""

            user_prompt = f"""Extract structured entities from this specification document:

**Document:** {filename}

**Content:**
{document_content[:8000]}

Analyze the document and extract all equipment, systems, specifications, and their relationships."""

            # Generate analysis using LLM
            result = self.llm_service.generate(
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt}
                ],
                mode=llm_mode,
                temperature=0.2,  # Low temperature for consistent extraction
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

            entities = json.loads(json_str)

            logger.info(f"✅ Extracted {len(entities.get('equipment', []))} equipment, "
                       f"{len(entities.get('systems', []))} systems, "
                       f"{len(entities.get('specifications', []))} spec categories")

            return {
                "success": True,
                "entities": entities,
                "document_id": document_id,
                "filename": filename
            }

        except Exception as e:
            logger.error(f"❌ Entity extraction failed: {e}")
            return {
                "success": False,
                "error": str(e),
                "entities": {}
            }

    def build_graph_from_entities(
        self,
        project_number: str,
        document_id: str,
        entities: Dict[str, Any]
    ) -> bool:
        """
        Build Neo4j graph structure from extracted entities

        Args:
            project_number: Project OE number
            document_id: Document unique identifier
            entities: Extracted entities dictionary

        Returns:
            True if successful
        """
        try:
            logger.info(f"🏗️ Building graph structure for document {document_id}")

            with self.neo4j_driver.session() as session:
                # Create equipment nodes
                equipment_list = entities.get("equipment", [])
                for equip in equipment_list:
                    session.run("""
                        MATCH (doc:Document {id: $doc_id, project_number: $project_number})
                        MERGE (eq:Equipment {name: $name, project_number: $project_number})
                        SET eq.type = $type,
                            eq.specifications = $specs
                        MERGE (doc)-[:HAS_EQUIPMENT]->(eq)
                    """, {
                        "doc_id": document_id,
                        "project_number": project_number,
                        "name": equip.get("name", ""),
                        "type": equip.get("type", ""),
                        "specs": equip.get("specifications", [])
                    })

                # Create system nodes
                systems_list = entities.get("systems", [])
                for system in systems_list:
                    session.run("""
                        MATCH (doc:Document {id: $doc_id, project_number: $project_number})
                        MERGE (sys:System {name: $name, project_number: $project_number})
                        SET sys.type = $type,
                            sys.description = $description,
                            sys.components = $components
                        MERGE (doc)-[:HAS_SYSTEM]->(sys)
                    """, {
                        "doc_id": document_id,
                        "project_number": project_number,
                        "name": system.get("name", ""),
                        "type": system.get("type", ""),
                        "description": system.get("description", ""),
                        "components": system.get("components", [])
                    })

                # Create specification categories and fields
                spec_categories = entities.get("specifications", [])
                for spec_cat in spec_categories:
                    category_name = spec_cat.get("category", "")

                    # Create category node
                    session.run("""
                        MATCH (doc:Document {id: $doc_id, project_number: $project_number})
                        MERGE (cat:SpecCategory {name: $category, project_number: $project_number})
                        MERGE (doc)-[:HAS_SPEC_CATEGORY]->(cat)
                    """, {
                        "doc_id": document_id,
                        "project_number": project_number,
                        "category": category_name
                    })

                    # Create field nodes
                    for field in spec_cat.get("fields", []):
                        field_name = field.get("name", "")
                        value = field.get("value", "")
                        unit = field.get("unit", "")
                        description = field.get("description", "")

                        session.run("""
                            MATCH (doc:Document {id: $doc_id, project_number: $project_number})
                            MATCH (cat:SpecCategory {name: $category, project_number: $project_number})

                            // Create field with document_id for uniqueness
                            MERGE (field:SpecField {
                                name: $field_name,
                                category_name: $category,
                                document_id: $doc_id,
                                project_number: $project_number
                            })
                            SET field.description = $description,
                                field.updated_at = datetime()
                            MERGE (cat)-[:HAS_FIELD]->(field)

                            // Try to link to project-level ExtractionGuide if exists
                            OPTIONAL MATCH (guide:ExtractionGuide {
                                field_name: $field_name,
                                category_name: $category,
                                project_number: $project_number
                            })
                            WHERE guide.document_id IS NULL
                            FOREACH (_ IN CASE WHEN guide IS NOT NULL THEN [1] ELSE [] END |
                                MERGE (field)-[:REFERENCES_GUIDE]->(guide)
                                MERGE (doc)-[:USES_GUIDE]->(guide)
                                MERGE (guide)-[:USED_IN_DOCUMENT]->(doc)
                            )

                            // Create value node if value exists (with document_id in unique key)
                            FOREACH (v IN CASE WHEN $value <> '' THEN [1] ELSE [] END |
                                MERGE (value:ActualValue {
                                    field_name: $field_name,
                                    category_name: $category,
                                    document_id: $doc_id,
                                    project_number: $project_number
                                })
                                SET value.extracted_value = $value,
                                    value.unit = $unit,
                                    value.extraction_method = 'llm_entity_extraction',
                                    value.updated_at = datetime()
                                MERGE (field)-[:HAS_VALUE]->(value)
                            )

                            // Link value to guide if both exist
                            WITH field, guide, $value as val
                            WHERE guide IS NOT NULL AND val <> ''
                            MATCH (field)-[:HAS_VALUE]->(value:ActualValue {
                                field_name: $field_name,
                                category_name: $category,
                                document_id: $doc_id,
                                project_number: $project_number
                            })
                            MERGE (value)-[:EXTRACTED_BY_GUIDE]->(guide)
                        """, {
                            "category": category_name,
                            "field_name": field_name,
                            "value": value,
                            "unit": unit,
                            "description": description,
                            "doc_id": document_id,
                            "project_number": project_number
                        })

                # Create relationships
                relationships = entities.get("relationships", [])
                for rel in relationships:
                    from_entity = rel.get("from", "")
                    to_entity = rel.get("to", "")
                    rel_type = rel.get("type", "RELATED_TO")

                    # Create relationship (flexible - works for any node types)
                    session.run(f"""
                        MATCH (from {{name: $from_name, project_number: $project_number}})
                        MATCH (to {{name: $to_name, project_number: $project_number}})
                        MERGE (from)-[:{rel_type}]->(to)
                    """, {
                        "from_name": from_entity,
                        "to_name": to_entity,
                        "project_number": project_number
                    })

            logger.info(f"✅ Graph structure built successfully for document {document_id}")
            return True

        except Exception as e:
            logger.error(f"❌ Failed to build graph structure: {e}", exc_info=True)
            return False

    def build_graph_for_document(
        self,
        project_number: str,
        document_id: str,
        document_content: str,
        filename: str,
        llm_mode: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Complete pipeline: Extract entities → Build graph

        Args:
            project_number: Project OE number
            document_id: Document unique identifier
            document_content: Full document content
            filename: Original filename
            llm_mode: Optional LLM mode

        Returns:
            Result dictionary
        """
        # Step 1: Extract entities
        extraction_result = self.extract_entities_from_spec(
            document_content=document_content,
            document_id=document_id,
            filename=filename,
            llm_mode=llm_mode
        )

        if not extraction_result.get("success"):
            return extraction_result

        # Step 2: Build graph
        entities = extraction_result["entities"]
        graph_success = self.build_graph_from_entities(
            project_number=project_number,
            document_id=document_id,
            entities=entities
        )

        return {
            "success": graph_success,
            "entities_extracted": {
                "equipment_count": len(entities.get("equipment", [])),
                "systems_count": len(entities.get("systems", [])),
                "spec_categories_count": len(entities.get("specifications", [])),
                "relationships_count": len(entities.get("relationships", []))
            }
        }
