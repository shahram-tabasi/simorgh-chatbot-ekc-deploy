# Critical Enhancement: Unified Neo4j Access via CoCoIndex

## Refactoring Plan Document

**Created:** December 2024
**Status:** In Progress
**Branch:** `claude/review-spec-agent-3kprS`

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Current Architecture Analysis](#2-current-architecture-analysis)
3. [Target Architecture](#3-target-architecture)
4. [Files Requiring Changes](#4-files-requiring-changes)
5. [Implementation Plan](#5-implementation-plan)
6. [Specification CoCoIndex Flow Design](#6-specification-cocoindex-flow-design)
7. [Testing Strategy](#7-testing-strategy)

---

## 1. Executive Summary

### Goal
Refactor all Neo4j access to go exclusively through CoCoIndex flows for project chats, while ensuring general chats remain completely isolated without Neo4j access.

### Key Principles
1. **General Chats:** Qdrant-only, isolated per chat, complete deletion on chat delete
2. **Project Chats:** CoCoIndex-powered Neo4j, project-scoped, shared context across project chats
3. **No Direct Cypher:** All Neo4j operations via CoCoIndex abstraction layer
4. **Parallel Processing:** Document processing runs Vector + Graph flows concurrently
5. **Extensibility:** Type-specific document flows (starting with Specification)

---

## 2. Current Architecture Analysis

### Files with Direct Neo4j/Cypher Usage

| File | Location | Direct Cypher Usage |
|------|----------|---------------------|
| `neo4j_service.py` | `backend/services/` | Core service - 50+ raw Cypher queries |
| `graph_rag.py` | `backend/services/` | `build_graph_query()` - dynamic Cypher generation |
| `graph_builder.py` | `backend/services/` | 4 major methods with inline Cypher |
| `project_graph_init.py` | `backend/services/` | 15+ methods with raw Cypher |
| `guide_executor.py` | `backend/services/` | 2 methods with Cypher queries |
| `session_manager.py` | `backend/services/` | `_delete_neo4j_project_data()` |
| `specification_agent.py` | `backend/services/` | Neo4j integration for spec extraction |

### Current Direct Cypher Patterns

```python
# Pattern 1: Inline Cypher in methods
session.run("""
    MATCH (p:Project {project_number: $project_number})
    OPTIONAL MATCH (p)<-[:BELONGS_TO_PROJECT]-(entity)
    RETURN ...
""", {"project_number": project_number})

# Pattern 2: Dynamic Cypher generation
query = f"MATCH (e:{entity_type} {{...}})"

# Pattern 3: Transaction functions with Cypher
def _create_project_structure(self, tx, project_oenum, project_name):
    tx.run("""MERGE (p:Project ...""")
```

---

## 3. Target Architecture

### 3.1 Chat System Separation

```
┌─────────────────────────────────────────────────────────────────┐
│                        CHAT SYSTEMS                              │
├─────────────────────────────────┬───────────────────────────────┤
│         GENERAL CHAT            │        PROJECT CHAT            │
├─────────────────────────────────┼───────────────────────────────┤
│ Storage: Qdrant only            │ Storage: Qdrant + Neo4j       │
│ Scope: Per-chat isolation       │ Scope: Per-project isolation  │
│ Context: Single chat            │ Context: Cross-chat in project│
│ Neo4j: NO ACCESS                │ Neo4j: Via CoCoIndex ONLY     │
│ Deletion: Full cascade          │ Deletion: Project-wide cascade│
└─────────────────────────────────┴───────────────────────────────┘
```

### 3.2 Document Processing Pipeline

```
Document Upload
       │
       ▼
┌──────────────────────┐
│  Document Classifier │
│  (Type Detection)    │
└──────┬───────────────┘
       │
       ├──────────────────────────────────────┐
       ▼                                      ▼
┌──────────────────────┐           ┌──────────────────────┐
│  FLOW 1: Vector      │           │  FLOW 2: CoCoIndex   │
│  (Existing Qdrant)   │           │  (NEW Knowledge Graph)│
├──────────────────────┤           ├──────────────────────┤
│ • Chunk document     │           │ • Type detection     │
│ • Generate embeddings│           │ • Type-specific flow │
│ • Store in Qdrant    │           │ • Entity extraction  │
│ • Store full content │           │ • Relationship build │
│   as payload         │           │ • Neo4j storage      │
└──────────────────────┘           └──────────────────────┘
       │                                      │
       └──────────────┬───────────────────────┘
                      ▼
              ┌───────────────┐
              │ Hybrid RAG    │
              │ Query Layer   │
              └───────────────┘
```

### 3.3 CoCoIndex Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     CoCoIndex Layer                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐ │
│  │ cocoindex_      │  │ cocoindex_      │  │ cocoindex_      │ │
│  │ spec_flow.py    │  │ cable_flow.py   │  │ sld_flow.py     │ │
│  │ (Priority 1)    │  │ (Future)        │  │ (Future)        │ │
│  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘ │
│           │                    │                    │           │
│           └────────────────────┼────────────────────┘           │
│                                ▼                                 │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │              CoCoIndex Neo4j Adapter                        ││
│  │  • Unified entity creation                                  ││
│  │  • Relationship management                                  ││
│  │  • Query abstraction                                        ││
│  │  • Project isolation enforcement                            ││
│  └─────────────────────────────────────────────────────────────┘│
│                                │                                 │
└────────────────────────────────┼─────────────────────────────────┘
                                 ▼
                          ┌─────────────┐
                          │   Neo4j     │
                          │  Database   │
                          └─────────────┘
```

---

## 4. Files Requiring Changes

### 4.1 New Files to Create

| File | Purpose |
|------|---------|
| `cocoindex_flows/cocoindex_adapter.py` | Unified Neo4j access layer |
| `cocoindex_flows/spec_flow.py` | Specification document flow |
| `cocoindex_flows/base_flow.py` | Base class for document flows |
| `backend/services/chat_context_service.py` | Separates general/project chat logic |

### 4.2 Files to Modify

| File | Changes |
|------|---------|
| `neo4j_service.py` | Deprecate direct methods, wrap with CoCoIndex adapter |
| `graph_rag.py` | Replace direct Cypher with CoCoIndex queries |
| `graph_builder.py` | Refactor to use CoCoIndex flows |
| `project_graph_init.py` | Move to CoCoIndex initialization flow |
| `guide_executor.py` | Use CoCoIndex for graph operations |
| `session_manager.py` | Separate deletion logic by chat type |
| `specification_agent.py` | Query graph via CoCoIndex, generate reports |
| `section_retriever.py` | Add parallel CoCoIndex processing |

### 4.3 Files to Delete (After Migration)

| File | Reason |
|------|--------|
| None (deprecate methods instead) | Maintain backward compatibility during transition |

---

## 5. Implementation Plan

### Phase 1: CoCoIndex Infrastructure (Current Focus)

#### Step 1.1: Create CoCoIndex Adapter
```python
# cocoindex_flows/cocoindex_adapter.py
class CoCoIndexAdapter:
    """Unified Neo4j access via CoCoIndex"""

    def create_project(self, project_number, metadata): ...
    def create_entity(self, project_number, entity_type, entity_id, properties): ...
    def create_relationship(self, project_number, from_id, to_id, rel_type, properties): ...
    def query_entities(self, project_number, entity_type, filters): ...
    def get_entity_neighborhood(self, project_number, entity_id, depth): ...
    def delete_project(self, project_number): ...
```

#### Step 1.2: Create Base Flow Class
```python
# cocoindex_flows/base_flow.py
class BaseDocumentFlow:
    """Base class for all document type flows"""

    @abstractmethod
    def detect_document_type(self, content, filename): ...

    @abstractmethod
    def extract_entities(self, content): ...

    @abstractmethod
    def build_relationships(self, entities): ...

    @abstractmethod
    def store_to_graph(self, project_number, entities, relationships): ...
```

### Phase 2: Specification Flow Implementation

#### Step 2.1: Specification CoCoIndex Flow
```python
# cocoindex_flows/spec_flow.py
class SpecificationFlow(BaseDocumentFlow):
    """
    Specification Document CoCoIndex Flow

    Extracts entities based on ITEM 1-13 categories:
    - ITEM 1: Switchgear Specifications (21 sub-items)
    - ITEM 2: Busbar Specifications (10 sub-items)
    - ITEM 3: Wire Size (4 sub-items)
    - ITEM 4: Wire Color (6 sub-items)
    - ITEM 5: Wire Specifications (4 sub-items)
    - ITEM 6: Label Color (3 sub-items)
    - ITEM 7: Auxiliary Voltage (4 sub-items)
    - ITEM 8: Accessories (23 sub-items)
    - ITEM 9: CT & PT (3 sub-items)
    - ITEM 10: Measuring Instrument (6 sub-items)
    - ITEM 11: C.B (3 sub-items)
    - ITEM 12: Network (5 sub-items)
    - ITEM 13: V.C (1 sub-item)
    """
```

#### Step 2.2: Graph Structure for Specifications
```
(:Project)
    ├── [:HAS_DOCUMENT] → (:SpecificationDocument)
    │       ├── [:HAS_SPEC_CATEGORY] → (:SpecCategory {name: "ITEM 1: Switchgear"})
    │       │       ├── [:HAS_FIELD] → (:SpecField {name: "Type of Switchgear"})
    │       │       │       └── [:HAS_VALUE] → (:ActualValue {value: "8PT40"})
    │       │       ├── [:HAS_FIELD] → (:SpecField {name: "Rated Voltage"})
    │       │       │       └── [:HAS_VALUE] → (:ActualValue {value: "400V"})
    │       │       └── ...
    │       ├── [:HAS_SPEC_CATEGORY] → (:SpecCategory {name: "ITEM 2: Busbar"})
    │       └── ...
    └── [:HAS_EXTRACTION_GUIDE] → (:ExtractionGuide) [Project-level templates]
```

### Phase 3: Chat System Separation

#### Step 3.1: General Chat Handler
```python
class GeneralChatHandler:
    """Handles general (non-project) chats - Qdrant only"""

    def __init__(self, qdrant_service, llm_service):
        self.qdrant = qdrant_service
        self.llm = llm_service
        # NO Neo4j access

    def process_query(self, chat_id, query): ...
    def delete_chat(self, chat_id): ...  # Full deletion
```

#### Step 3.2: Project Chat Handler
```python
class ProjectChatHandler:
    """Handles project chats - Qdrant + CoCoIndex"""

    def __init__(self, qdrant_service, cocoindex_adapter, llm_service):
        self.qdrant = qdrant_service
        self.cocoindex = cocoindex_adapter  # Only via CoCoIndex
        self.llm = llm_service

    def process_query(self, project_id, chat_id, query): ...
    def get_cross_chat_context(self, project_id): ...
```

### Phase 4: Specification Agent Refactoring

#### Step 4.1: Graph-Based Report Generation
```python
class SpecificationAgent:
    """Refactored to use graph data for reports"""

    def __init__(self, cocoindex_adapter, llm_service):
        self.cocoindex = cocoindex_adapter
        self.llm = llm_service

    def generate_report(self, project_id, document_id):
        """Generate spec report from graph data"""
        # 1. Query all spec categories from graph
        categories = self.cocoindex.get_spec_categories(project_id, document_id)

        # 2. For each category, get fields and values
        spec_data = {}
        for category in categories:
            fields = self.cocoindex.get_category_fields(project_id, document_id, category)
            spec_data[category] = fields

        # 3. Generate formatted report
        return self._format_report(spec_data)
```

---

## 6. Specification CoCoIndex Flow Design

### 6.1 Entity Extraction Mapping

Based on the specification table (ITEM 1-13):

```python
SPEC_EXTRACTION_SCHEMA = {
    "ITEM_1_SWITCHGEAR": {
        "category_name": "Switchgear Specifications",
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
    "ITEM_2_BUSBAR": {
        "category_name": "Busbar Specifications",
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
    # ... ITEM 3-13
}
```

### 6.2 LLM Extraction Prompt Template

```python
SPEC_EXTRACTION_PROMPT = """
You are an expert electrical specification extractor.

Extract values for the following specification category from the document.

**Category:** {category_name}
**Fields to Extract:**
{fields_list}

**Document Content:**
{document_content}

Return JSON format:
{
    "category": "{category_name}",
    "extracted_fields": [
        {
            "field_name": "...",
            "value": "extracted value or null",
            "confidence": "high|medium|low",
            "source_text": "relevant excerpt from document"
        }
    ]
}
"""
```

### 6.3 Graph Storage Operations

```python
def store_specification_to_graph(self, project_id, doc_id, extracted_data):
    """Store extracted specification data to Neo4j via CoCoIndex"""

    # 1. Create specification document node
    self.adapter.create_entity(
        project_number=project_id,
        entity_type="SpecificationDocument",
        entity_id=doc_id,
        properties={"filename": ..., "processed_at": ...}
    )

    # 2. For each category
    for category_data in extracted_data["categories"]:
        category_id = f"{doc_id}_{category_data['name']}"

        # Create category node
        self.adapter.create_entity(
            project_number=project_id,
            entity_type="SpecCategory",
            entity_id=category_id,
            properties={"name": category_data["name"]}
        )

        # Link to document
        self.adapter.create_relationship(
            project_number=project_id,
            from_id=doc_id,
            to_id=category_id,
            rel_type="HAS_SPEC_CATEGORY"
        )

        # 3. For each field
        for field in category_data["fields"]:
            field_id = f"{category_id}_{field['name']}"

            # Create field node
            self.adapter.create_entity(
                project_number=project_id,
                entity_type="SpecField",
                entity_id=field_id,
                properties={"name": field["name"]}
            )

            # Create value node if extracted
            if field["value"]:
                value_id = f"{field_id}_value"
                self.adapter.create_entity(
                    project_number=project_id,
                    entity_type="ActualValue",
                    entity_id=value_id,
                    properties={
                        "value": field["value"],
                        "confidence": field["confidence"],
                        "source_text": field.get("source_text", "")
                    }
                )

                self.adapter.create_relationship(
                    project_number=project_id,
                    from_id=field_id,
                    to_id=value_id,
                    rel_type="HAS_VALUE"
                )
```

---

## 7. Testing Strategy

### 7.1 Unit Tests

- CoCoIndex Adapter methods
- Specification Flow extraction accuracy
- Chat handler separation

### 7.2 Integration Tests

- End-to-end document upload → graph storage
- Cross-chat context retrieval
- Specification report generation

### 7.3 Regression Tests

- Existing Qdrant functionality unchanged
- General chat isolation maintained
- Project chat queries return correct data

---

## Implementation Checklist

- [ ] Create `cocoindex_flows/cocoindex_adapter.py`
- [ ] Create `cocoindex_flows/base_flow.py`
- [ ] Create `cocoindex_flows/spec_flow.py`
- [ ] Refactor `neo4j_service.py` to use adapter
- [ ] Update `graph_builder.py` to use CoCoIndex
- [ ] Update `project_graph_init.py` to use CoCoIndex
- [ ] Update `guide_executor.py` to use CoCoIndex
- [ ] Create `chat_context_service.py` for separation
- [ ] Refactor `specification_agent.py` for graph-based reports
- [ ] Update `session_manager.py` for proper deletion
- [ ] Add comprehensive tests
- [ ] Update documentation

---

## Notes

- Priority: Specification Flow is the first document type to implement
- Backward compatibility: Existing functionality must continue working during transition
- No data loss: All existing Qdrant data and operations remain unchanged
- Parallel processing: Document upload triggers both Vector and Graph flows concurrently
