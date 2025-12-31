# CocoIndex Flows - Electrical Entity Extraction

## Overview

CocoIndex pipeline for extracting electrical engineering entities from project documents and populating the Neo4j knowledge graph.

## Pipeline Architecture

```
Markdown Documents
    ↓
[Load & Chunk]
    ↓
[LLM Entity Extraction]
    ↓
[Neo4j Storage]
    ↓
Knowledge Graph
```

## Extracted Entities

### 1. Equipment
- **Types**: Panel, Transformer, Breaker, Motor, Cable, Switch, etc.
- **Properties**:
  - Voltage (e.g., "400V", "11kV")
  - Current (e.g., "630A")
  - Power (e.g., "250kW")
  - Frequency (e.g., "50Hz")
  - Voltage level (LV/MV/HV)
  - Location

### 2. Connections
- **Types**: POWERS, CONNECTS_TO, SUPPLIES, FEEDS
- **Properties**: from equipment, to equipment, via (cable/connection)

### 3. Locations
- **Types**: Building, Room, Area, Site
- **Contains**: List of equipment IDs

## Usage

### From Backend Service

```python
from cocoindex_flows.electrical_entity_extraction import create_electrical_pipeline

# Create pipeline
pipeline = create_electrical_pipeline(
    project_oenum="OE12345",
    markdown_files=[
        "/app/uploads/docs/project/OE12345/spec.md",
        "/app/uploads/docs/project/OE12345/cable_list.md"
    ],
    neo4j_uri="bolt://neo4j:7687",
    neo4j_username="neo4j",
    neo4j_password="password",
    openai_api_key="sk-..."
)

# Run extraction
result = pipeline.run()
print(f"Extracted entities: {result}")
```

### From Command Line

```bash
cd /app
python electrical_entity_extraction.py OE12345 \
    /app/uploads/docs/project/OE12345/spec.md \
    /app/uploads/docs/project/OE12345/cable_list.md
```

## Graph Schema

### Nodes

```cypher
(:Project {project_number, project_name})
(:Document {id, filename, doc_type})
(:Equipment {id, name, type, voltage, current, power, frequency, voltage_level, location})
(:Location {name, type})
```

### Relationships

```cypher
(Document)-[:MENTIONS_EQUIPMENT]->(Equipment)
(Equipment)-[:BELONGS_TO_PROJECT]->(Project)
(Equipment)-[:CONNECTS_TO|POWERS|SUPPLIES|FEEDS]->(Equipment)
(Equipment)-[:LOCATED_IN]->(Location)
(Location)-[:PART_OF_PROJECT]->(Project)
```

## Configuration

Environment variables:
- `NEO4J_URI`: Neo4j connection URI (default: `bolt://neo4j:7687`)
- `NEO4J_USERNAME`: Neo4j username (default: `neo4j`)
- `NEO4J_PASSWORD`: Neo4j password
- `OPENAI_API_KEY`: OpenAI API key for entity extraction

## Integration with Backend

The backend service can trigger entity extraction after document upload:

```python
from services.doc_processor_client import DocProcessorClient
from services.document_classifier import DocumentClassifier
from cocoindex_flows.electrical_entity_extraction import create_electrical_pipeline

# 1. Process document to markdown
doc_processor = DocProcessorClient()
result = await doc_processor.process_document(file_path, user_id)

# 2. Classify document
classifier = DocumentClassifier()
category, doc_type, confidence = classifier.classify(filename, result['content'])

# 3. Add to project graph structure
# ... (using project_graph_init.py)

# 4. Run entity extraction
pipeline = create_electrical_pipeline(
    project_oenum=project_oenum,
    markdown_files=[result['output_path']],
    # ... credentials
)
pipeline.run()
```

## Performance

- Chunk size: 2000 characters
- Chunk overlap: 200 characters
- LLM model: gpt-4o-mini (cost-effective, fast)
- Average processing time: ~2-5 seconds per chunk
- Batch processing supported for multiple documents

## Future Enhancements

1. **Caching**: Cache extracted entities to avoid re-processing
2. **Incremental Updates**: Only process new/changed documents
3. **Confidence Scoring**: Add confidence scores to extracted entities
4. **Relationship Inference**: Use graph algorithms to infer implicit relationships
5. **Entity Deduplication**: Merge duplicate equipment entities
6. **Vector Embeddings**: Generate embeddings for hybrid search
