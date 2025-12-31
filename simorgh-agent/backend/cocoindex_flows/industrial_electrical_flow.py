"""
CocoIndex Industrial Electrical Flow
=====================================
Document processing flow for extracting Siemens LV/MV electrical entities from PDFs.

Flow Steps:
1. PDF text extraction
2. LLM-powered entity extraction (Siemens ontology)
3. Relationship inference
4. Neo4j export with project isolation

Author: Simorgh Industrial Assistant
"""

import os
import sys
import logging
from typing import List, Dict, Any, Optional
from pathlib import Path

# CocoIndex imports (adjust based on actual CocoIndex structure)
try:
    from cocoindex.core import Flow, Document, EntityExtractor, RelationshipExtractor
    from cocoindex.loaders import PDFLoader
    from cocoindex.exporters import Neo4jExporter
except ImportError:
    # Fallback for development without CocoIndex installed
    logging.warning("CocoIndex not installed - using mock classes")

    class Flow:
        def __init__(self, name: str):
            self.name = name

    class Document:
        pass

    class EntityExtractor:
        pass

    class RelationshipExtractor:
        pass

    class PDFLoader:
        pass

    class Neo4jExporter:
        pass


logger = logging.getLogger(__name__)


# =============================================================================
# ENTITY EXTRACTION PROMPTS
# =============================================================================

ENTITY_EXTRACTION_PROMPT = """
You are an expert in Siemens LV/MV electrical systems. Extract all electrical entities from the following text.

ENTITY TYPES TO EXTRACT:

1. **Switchgear & Panels**:
   - Panel (MDB, SMDB, DB, MCC, PCC)
   - Busbar specifications
   - Switchgear specifications

2. **Protection Devices**:
   - Circuit Breakers (MCB, MCCB, ACB, VCB)
   - Fuses (HRC, NH)
   - Protection Relays

3. **Transformers**:
   - Distribution transformers
   - Power transformers
   - Isolation transformers

4. **Cables & Wiring**:
   - Power cables (XLPE, PVC, EPR)
   - Cable trays
   - Wire specifications

5. **Loads**:
   - Motors (rated power, voltage, current)
   - Heaters
   - Lighting
   - HVAC equipment
   - Pumps, fans, compressors

6. **Measurement Devices**:
   - Energy meters
   - Current transformers (CTs)
   - Voltage transformers (VTs)
   - Control units (PLCs)

7. **Circuits**:
   - Circuit numbers
   - Feeders
   - Power distribution paths

For each entity, extract:
- Entity type
- Entity ID (panel number, motor tag, circuit number, etc.)
- Key specifications (voltage, current, power, ratings, etc.)
- Manufacturer and model (if mentioned)
- Location (if specified)

TEXT TO ANALYZE:
{text}

Return a JSON array of entities in this exact format:
[
  {{
    "entity_type": "Panel",
    "entity_id": "MDB-01",
    "properties": {{
      "panel_type": "MDB",
      "rated_voltage": "400V",
      "rated_current": 1600,
      "description": "Main Distribution Board",
      "location": "Electrical Room"
    }}
  }},
  {{
    "entity_type": "CircuitBreaker",
    "entity_id": "CB-MDB-01-INC",
    "properties": {{
      "breaker_type": "ACB",
      "rated_current": 1600,
      "breaking_capacity": 65,
      "manufacturer": "Siemens",
      "model_number": "3WL1"
    }}
  }},
  ...
]

IMPORTANT:
- Extract ALL entities, even if some information is incomplete
- Use standard entity IDs (e.g., MDB-01, TR-01, M-01)
- Include units (V, A, kW, kVA, etc.)
- Be precise with technical specifications
"""


RELATIONSHIP_EXTRACTION_PROMPT = """
You are an expert in electrical power systems. Given these entities and the source text,
identify relationships between them.

RELATIONSHIP TYPES:

1. **Power Flow**:
   - SUPPLIES: Source supplies destination (e.g., Transformer SUPPLIES Panel)
   - FEEDS: Panel feeds another panel or load
   - POWERS: Circuit powers a load

2. **Protection**:
   - PROTECTS: Circuit breaker protects circuit or equipment
   - PROTECTED_BY: Equipment is protected by a device

3. **Physical Containment**:
   - CONTAINS: Panel contains circuit breakers or feeders
   - MOUNTED_IN: Device is mounted in a panel

4. **Connectivity**:
   - CONNECTS_TO: Cable connects two devices
   - CONNECTED_BY: Devices are connected by a cable

5. **Measurement**:
   - MEASURES: Meter measures a circuit or equipment
   - MONITORED_BY: Equipment is monitored by a control system

ENTITIES:
{entities_json}

SOURCE TEXT:
{text}

Return a JSON array of relationships:
[
  {{
    "from_entity_id": "TR-01",
    "to_entity_id": "MDB-01",
    "relationship_type": "SUPPLIES",
    "properties": {{
      "voltage": "400V",
      "cable_id": "CB-TR-MDB"
    }}
  }},
  {{
    "from_entity_id": "MDB-01",
    "to_entity_id": "SMDB-01",
    "relationship_type": "FEEDS",
    "properties": {{
      "feeder_number": "F-01",
      "cable_size": "4x185mm2"
    }}
  }},
  ...
]

IMPORTANT:
- Only create relationships between entities that actually exist in the entity list
- Infer logical power flow relationships even if not explicitly stated
- Include relevant properties (voltage, cable IDs, feeder numbers, etc.)
"""


# =============================================================================
# INDUSTRIAL ELECTRICAL FLOW
# =============================================================================

class IndustrialElectricalFlow:
    """
    CocoIndex flow for processing industrial electrical documents

    Features:
    - PDF text extraction
    - Siemens ontology-based entity extraction
    - Relationship inference
    - Neo4j export with project isolation
    """

    def __init__(
        self,
        project_number: str,
        neo4j_uri: str = None,
        neo4j_user: str = None,
        neo4j_password: str = None,
        llm_mode: str = "online"
    ):
        """
        Initialize the flow

        Args:
            project_number: Project number for isolation
            neo4j_uri: Neo4j connection URI
            neo4j_user: Neo4j username
            neo4j_password: Neo4j password
            llm_mode: LLM mode (online/offline)
        """
        self.project_number = project_number
        self.llm_mode = llm_mode

        # Neo4j configuration
        self.neo4j_uri = neo4j_uri or os.getenv("NEO4J_URI", "bolt://neo4j:7687")
        self.neo4j_user = neo4j_user or os.getenv("NEO4J_USER", "neo4j")
        self.neo4j_password = neo4j_password or os.getenv("NEO4J_PASSWORD")

        logger.info(f"✅ Flow initialized for project: {project_number}")

    def process_document(
        self,
        document_path: str,
        document_metadata: Dict[str, Any] = None
    ) -> Dict[str, Any]:
        """
        Process a single document

        Args:
            document_path: Path to PDF file
            document_metadata: Optional metadata

        Returns:
            Processing results with entity/relationship counts
        """
        logger.info(f"Processing document: {document_path}")

        try:
            # Step 1: Load and extract text from PDF
            text = self._extract_text(document_path)

            if not text or len(text) < 100:
                logger.warning(f"Document has insufficient text: {document_path}")
                return {
                    "status": "skipped",
                    "reason": "insufficient_text"
                }

            # Step 2: Extract entities using LLM
            entities = self._extract_entities(text)
            logger.info(f"Extracted {len(entities)} entities")

            # Step 3: Extract relationships using LLM
            relationships = self._extract_relationships(entities, text)
            logger.info(f"Extracted {len(relationships)} relationships")

            # Step 4: Export to Neo4j with project isolation
            export_result = self._export_to_neo4j(entities, relationships)

            # Step 5: Create document node
            self._create_document_node(document_path, document_metadata, entities)

            return {
                "status": "success",
                "project_number": self.project_number,
                "document_path": document_path,
                "entities_extracted": len(entities),
                "relationships_extracted": len(relationships),
                "entities": entities,
                "relationships": relationships,
                "export_result": export_result
            }

        except Exception as e:
            logger.error(f"Error processing document: {e}")
            return {
                "status": "error",
                "error": str(e),
                "document_path": document_path
            }

    def _extract_text(self, document_path: str) -> str:
        """Extract text from PDF"""
        # Use pdfminer.six or PyPDF2 for text extraction
        try:
            from pdfminer.high_level import extract_text
            text = extract_text(document_path)
            return text
        except ImportError:
            # Fallback to PyPDF2
            try:
                import PyPDF2
                with open(document_path, 'rb') as file:
                    reader = PyPDF2.PdfReader(file)
                    text = ""
                    for page in reader.pages:
                        text += page.extract_text()
                    return text
            except Exception as e:
                logger.error(f"PDF extraction failed: {e}")
                return ""

    def _extract_entities(self, text: str) -> List[Dict[str, Any]]:
        """Extract entities using LLM"""
        # Import LLM service
        from backend.services.llm_service import get_llm_service

        llm_service = get_llm_service()

        # Split text into chunks if too long (max ~4000 tokens per chunk)
        chunks = self._chunk_text(text, max_length=8000)

        all_entities = []

        for i, chunk in enumerate(chunks):
            logger.info(f"Processing chunk {i + 1}/{len(chunks)}")

            prompt = ENTITY_EXTRACTION_PROMPT.format(text=chunk)

            messages = [
                {"role": "system", "content": "You are an expert entity extraction system for electrical engineering documents."},
                {"role": "user", "content": prompt}
            ]

            try:
                result = llm_service.generate(
                    messages=messages,
                    mode=self.llm_mode,
                    temperature=0.3,
                    max_tokens=4000
                )

                # Parse JSON response
                import json
                entities = json.loads(result["response"])

                # Add project_number to each entity
                for entity in entities:
                    entity["project_number"] = self.project_number

                all_entities.extend(entities)

            except Exception as e:
                logger.error(f"Entity extraction failed for chunk {i}: {e}")
                continue

        # Deduplicate entities by entity_id
        unique_entities = {}
        for entity in all_entities:
            entity_id = entity.get("entity_id")
            if entity_id and entity_id not in unique_entities:
                unique_entities[entity_id] = entity

        return list(unique_entities.values())

    def _extract_relationships(
        self,
        entities: List[Dict[str, Any]],
        text: str
    ) -> List[Dict[str, Any]]:
        """Extract relationships using LLM"""
        if not entities:
            return []

        from backend.services.llm_service import get_llm_service
        import json

        llm_service = get_llm_service()

        entities_json = json.dumps(entities, indent=2)

        # Chunk text if needed
        chunks = self._chunk_text(text, max_length=8000)

        all_relationships = []

        for i, chunk in enumerate(chunks):
            prompt = RELATIONSHIP_EXTRACTION_PROMPT.format(
                entities_json=entities_json,
                text=chunk
            )

            messages = [
                {"role": "system", "content": "You are an expert relationship extraction system for electrical power systems."},
                {"role": "user", "content": prompt}
            ]

            try:
                result = llm_service.generate(
                    messages=messages,
                    mode=self.llm_mode,
                    temperature=0.3,
                    max_tokens=3000
                )

                relationships = json.loads(result["response"])
                all_relationships.extend(relationships)

            except Exception as e:
                logger.error(f"Relationship extraction failed for chunk {i}: {e}")
                continue

        # Deduplicate relationships
        unique_rels = []
        seen = set()

        for rel in all_relationships:
            key = (rel["from_entity_id"], rel["to_entity_id"], rel["relationship_type"])
            if key not in seen:
                seen.add(key)
                unique_rels.append(rel)

        return unique_rels

    def _export_to_neo4j(
        self,
        entities: List[Dict[str, Any]],
        relationships: List[Dict[str, Any]]
    ) -> Dict[str, Any]:
        """Export entities and relationships to Neo4j"""
        from backend.services.neo4j_service import get_neo4j_service

        neo4j = get_neo4j_service()

        # Ensure project exists
        neo4j.create_project(
            project_number=self.project_number,
            project_name=f"Project {self.project_number}"
        )

        # Batch create entities
        entity_count = neo4j.batch_create_entities(
            project_number=self.project_number,
            entities=entities,
            batch_size=100
        )

        # Batch create relationships
        relationship_count = neo4j.batch_create_relationships(
            project_number=self.project_number,
            relationships=relationships,
            batch_size=100
        )

        logger.info(
            f"✅ Exported to Neo4j: {entity_count} entities, {relationship_count} relationships"
        )

        return {
            "entities_created": entity_count,
            "relationships_created": relationship_count
        }

    def _create_document_node(
        self,
        document_path: str,
        metadata: Dict[str, Any],
        entities: List[Dict[str, Any]]
    ):
        """Create a Document node in Neo4j"""
        from backend.services.neo4j_service import get_neo4j_service

        neo4j = get_neo4j_service()

        document_id = Path(document_path).stem

        doc_properties = {
            "file_path": document_path,
            "filename": Path(document_path).name,
            "entities_count": len(entities),
            **(metadata or {})
        }

        neo4j.create_entity(
            project_number=self.project_number,
            entity_type="Document",
            entity_id=document_id,
            properties=doc_properties
        )

        logger.info(f"✅ Document node created: {document_id}")

    def _chunk_text(self, text: str, max_length: int = 8000) -> List[str]:
        """Split text into chunks"""
        if len(text) <= max_length:
            return [text]

        chunks = []
        start = 0

        while start < len(text):
            end = start + max_length

            # Try to break at paragraph or sentence boundary
            if end < len(text):
                # Look for paragraph break
                break_pos = text.rfind('\n\n', start, end)
                if break_pos == -1:
                    # Look for sentence break
                    break_pos = text.rfind('. ', start, end)
                if break_pos == -1:
                    # Look for any space
                    break_pos = text.rfind(' ', start, end)
                if break_pos != -1:
                    end = break_pos + 1

            chunks.append(text[start:end])
            start = end

        return chunks


# =============================================================================
# FLOW ENTRY POINT
# =============================================================================

def create_flow(project_number: str, **kwargs):
    """
    Create and return the industrial electrical flow

    Args:
        project_number: Project number for isolation
        **kwargs: Additional flow configuration

    Returns:
        IndustrialElectricalFlow instance
    """
    return IndustrialElectricalFlow(project_number=project_number, **kwargs)


def process_document(
    project_number: str,
    document_path: str,
    document_metadata: Dict[str, Any] = None,
    llm_mode: str = "online"
) -> Dict[str, Any]:
    """
    Process a single document

    Args:
        project_number: Project number
        document_path: Path to PDF
        document_metadata: Optional metadata
        llm_mode: LLM mode (online/offline)

    Returns:
        Processing results
    """
    flow = create_flow(project_number, llm_mode=llm_mode)
    return flow.process_document(document_path, document_metadata)


# =============================================================================
# MAIN (for standalone testing)
# =============================================================================

if __name__ == "__main__":
    import sys

    if len(sys.argv) < 3:
        print("Usage: python industrial_electrical_flow.py <project_number> <pdf_path>")
        sys.exit(1)

    project_num = sys.argv[1]
    pdf_path = sys.argv[2]

    logging.basicConfig(level=logging.INFO)

    result = process_document(project_num, pdf_path)

    print("\n" + "=" * 80)
    print("PROCESSING RESULT")
    print("=" * 80)
    print(f"Status: {result['status']}")
    print(f"Entities: {result.get('entities_extracted', 0)}")
    print(f"Relationships: {result.get('relationships_extracted', 0)}")
    print("=" * 80)
