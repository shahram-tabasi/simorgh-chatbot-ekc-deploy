"""
CocoIndex Pipeline - Electrical Entity Extraction
==================================================
Extracts electrical engineering entities from markdown documents
and populates Neo4j knowledge graph.

Entities:
- Equipment (panels, transformers, breakers, motors, cables)
- Electrical properties (voltages, currents, frequencies, power)
- Connections and relationships
- Locations and layouts

Author: Simorgh Industrial Assistant
"""

from cocoindex import Pipeline, Step
from cocoindex.extractors import LLMExtractor
from cocoindex.loaders import MarkdownLoader
from cocoindex.storages import Neo4jStorage
from typing import Dict, Any, List
import os
import re


class ElectricalEntityExtractor(LLMExtractor):
    """
    Custom extractor for electrical engineering entities
    """

    def __init__(self, **kwargs):
        super().__init__(
            model="gpt-4o-mini",
            temperature=0.1,
            **kwargs
        )

    def get_extraction_prompt(self, text: str, metadata: Dict[str, Any]) -> str:
        """
        Generate prompt for electrical entity extraction
        """
        project_oenum = metadata.get('project_oenum', 'Unknown')
        doc_type = metadata.get('doc_type', 'Unknown')
        filename = metadata.get('filename', 'Unknown')

        prompt = f"""Extract electrical engineering entities from this document section.

Project: {project_oenum}
Document Type: {doc_type}
File: {filename}

Text:
{text}

Extract the following entities and relationships:

1. **Equipment Entities**:
   - Type: Panel, Transformer, Breaker, Motor, Cable, Switch, etc.
   - Name/ID
   - Electrical properties (voltage, current, power, frequency)
   - Physical properties (dimensions, weight if mentioned)

2. **Electrical Properties**:
   - Voltages (e.g., "400V", "11kV")
   - Currents (e.g., "630A", "50A")
   - Power (e.g., "250kW", "500kVA")
   - Frequency (e.g., "50Hz", "60Hz")
   - Voltage level classification (LV/MV)

3. **Connections/Relationships**:
   - Which equipment connects to which
   - Cable connections (from -> to)
   - Power flow direction

4. **Locations**:
   - Building/site references
   - Panel locations
   - Room/area names

Return JSON format:
{{
    "equipment": [
        {{
            "id": "unique_id",
            "name": "equipment_name",
            "type": "Panel|Transformer|Breaker|Motor|Cable|Other",
            "voltage": "value with unit",
            "current": "value with unit",
            "power": "value with unit",
            "frequency": "value with unit",
            "voltage_level": "LV|MV|HV",
            "properties": {{}},
            "location": "location if mentioned"
        }}
    ],
    "connections": [
        {{
            "from": "equipment_id_1",
            "to": "equipment_id_2",
            "via": "cable_id or connection_type",
            "type": "POWERS|CONNECTS_TO|SUPPLIES|FEEDS"
        }}
    ],
    "locations": [
        {{
            "name": "location_name",
            "type": "Building|Room|Area|Site",
            "contains": ["equipment_ids"]
        }}
    ]
}}

Important:
- Generate consistent IDs (use name + type if no explicit ID)
- Extract ALL numerical values with units
- Identify voltage level (LV: <1kV, MV: 1-36kV, HV: >36kV)
- Persian/Farsi text is acceptable
"""
        return prompt

    def parse_response(self, response: str) -> Dict[str, Any]:
        """Parse LLM response and return structured entities"""
        import json
        try:
            entities = json.loads(response)
            return entities
        except json.JSONDecodeError as e:
            # Try to extract JSON from markdown code blocks
            match = re.search(r'```(?:json)?\s*(\{.*?\})\s*```', response, re.DOTALL)
            if match:
                return json.loads(match.group(1))
            raise ValueError(f"Failed to parse LLM response: {e}")


class Neo4jElectricalStorage(Neo4jStorage):
    """
    Custom Neo4j storage for electrical entities
    """

    def __init__(self, uri: str, username: str, password: str):
        super().__init__(uri, username, password)

    def store_equipment(
        self,
        equipment: Dict[str, Any],
        project_oenum: str,
        document_id: str
    ):
        """Store equipment entity in Neo4j"""
        query = """
        MATCH (p:Project {project_number: $project_oenum})
        MATCH (doc:Document {id: $document_id})

        MERGE (eq:Equipment {id: $eq_id, project_number: $project_oenum})
        SET eq.name = $name,
            eq.type = $type,
            eq.voltage = $voltage,
            eq.current = $current,
            eq.power = $power,
            eq.frequency = $frequency,
            eq.voltage_level = $voltage_level,
            eq.location = $location,
            eq.properties = $properties,
            eq.updated_at = datetime()

        MERGE (doc)-[:MENTIONS_EQUIPMENT]->(eq)
        MERGE (eq)-[:BELONGS_TO_PROJECT]->(p)

        RETURN eq
        """

        with self.driver.session() as session:
            session.run(query, {
                'project_oenum': project_oenum,
                'document_id': document_id,
                'eq_id': equipment['id'],
                'name': equipment.get('name', ''),
                'type': equipment.get('type', 'Other'),
                'voltage': equipment.get('voltage', ''),
                'current': equipment.get('current', ''),
                'power': equipment.get('power', ''),
                'frequency': equipment.get('frequency', ''),
                'voltage_level': equipment.get('voltage_level', ''),
                'location': equipment.get('location', ''),
                'properties': str(equipment.get('properties', {}))
            })

    def store_connection(
        self,
        connection: Dict[str, Any],
        project_oenum: str
    ):
        """Store connection relationship between equipment"""
        rel_type = connection.get('type', 'CONNECTS_TO')

        query = f"""
        MATCH (from:Equipment {{id: $from_id, project_number: $project_oenum}})
        MATCH (to:Equipment {{id: $to_id, project_number: $project_oenum}})

        MERGE (from)-[r:{rel_type}]->(to)
        SET r.via = $via,
            r.updated_at = datetime()

        RETURN r
        """

        with self.driver.session() as session:
            session.run(query, {
                'project_oenum': project_oenum,
                'from_id': connection['from'],
                'to_id': connection['to'],
                'via': connection.get('via', '')
            })

    def store_location(
        self,
        location: Dict[str, Any],
        project_oenum: str
    ):
        """Store location entity"""
        query = """
        MATCH (p:Project {project_number: $project_oenum})

        MERGE (loc:Location {name: $name, project_number: $project_oenum})
        SET loc.type = $type,
            loc.updated_at = datetime()

        MERGE (loc)-[:PART_OF_PROJECT]->(p)

        WITH loc
        UNWIND $equipment_ids as eq_id
        MATCH (eq:Equipment {id: eq_id, project_number: $project_oenum})
        MERGE (eq)-[:LOCATED_IN]->(loc)

        RETURN loc
        """

        with self.driver.session() as session:
            session.run(query, {
                'project_oenum': project_oenum,
                'name': location['name'],
                'type': location.get('type', 'Area'),
                'equipment_ids': location.get('contains', [])
            })


def create_electrical_pipeline(
    project_oenum: str,
    markdown_files: List[str],
    neo4j_uri: str,
    neo4j_username: str,
    neo4j_password: str,
    openai_api_key: str
) -> Pipeline:
    """
    Create CocoIndex pipeline for electrical entity extraction

    Args:
        project_oenum: Project OENUM
        markdown_files: List of markdown file paths
        neo4j_uri: Neo4j connection URI
        neo4j_username: Neo4j username
        neo4j_password: Neo4j password
        openai_api_key: OpenAI API key

    Returns:
        Configured Pipeline instance
    """
    os.environ['OPENAI_API_KEY'] = openai_api_key

    # Initialize storage
    storage = Neo4jElectricalStorage(
        uri=neo4j_uri,
        username=neo4j_username,
        password=neo4j_password
    )

    # Create pipeline
    pipeline = Pipeline(name=f"electrical_extraction_{project_oenum}")

    # Step 1: Load markdown documents
    pipeline.add_step(
        Step(
            name="load_documents",
            processor=MarkdownLoader(
                files=markdown_files,
                chunk_size=2000,
                chunk_overlap=200
            )
        )
    )

    # Step 2: Extract entities
    pipeline.add_step(
        Step(
            name="extract_entities",
            processor=ElectricalEntityExtractor()
        )
    )

    # Step 3: Store in Neo4j
    @pipeline.step(name="store_to_neo4j")
    def store_entities(chunks: List[Dict[str, Any]]):
        """Store extracted entities to Neo4j"""
        for chunk in chunks:
            metadata = chunk.get('metadata', {})
            document_id = metadata.get('doc_id', '')
            entities = chunk.get('entities', {})

            # Store equipment
            for equipment in entities.get('equipment', []):
                storage.store_equipment(equipment, project_oenum, document_id)

            # Store connections
            for connection in entities.get('connections', []):
                storage.store_connection(connection, project_oenum)

            # Store locations
            for location in entities.get('locations', []):
                storage.store_location(location, project_oenum)

        return {"stored": len(chunks)}

    return pipeline


# Example usage
if __name__ == "__main__":
    import sys

    if len(sys.argv) < 2:
        print("Usage: python electrical_entity_extraction.py <project_oenum> <markdown_file1> [markdown_file2 ...]")
        sys.exit(1)

    project_oenum = sys.argv[1]
    markdown_files = sys.argv[2:]

    # Get credentials from environment
    neo4j_uri = os.getenv('NEO4J_URI', 'bolt://neo4j:7687')
    neo4j_username = os.getenv('NEO4J_USERNAME', 'neo4j')
    neo4j_password = os.getenv('NEO4J_PASSWORD', 'simorgh_secure_2024')
    openai_api_key = os.getenv('OPENAI_API_KEY')

    # Create and run pipeline
    pipeline = create_electrical_pipeline(
        project_oenum=project_oenum,
        markdown_files=markdown_files,
        neo4j_uri=neo4j_uri,
        neo4j_username=neo4j_username,
        neo4j_password=neo4j_password,
        openai_api_key=openai_api_key
    )

    print(f"🚀 Running entity extraction pipeline for project {project_oenum}")
    print(f"📄 Processing {len(markdown_files)} markdown files")

    result = pipeline.run()

    print(f"✅ Pipeline completed: {result}")
