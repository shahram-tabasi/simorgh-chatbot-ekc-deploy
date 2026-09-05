"""
Graph RAG Service
==================
Neo4j-based Knowledge Graph RAG for project chat sessions.
Handles entity extraction, graph traversal, and context retrieval.

Author: Simorgh Industrial Assistant
"""

import os
import logging
import re
from typing import List, Dict, Any, Optional, Tuple
from neo4j import Driver
import openai

logger = logging.getLogger(__name__)


class GraphRAG:
    """
    Knowledge Graph RAG using Neo4j for project chats
    """

    def __init__(
        self,
        driver: Driver,
        openai_api_key: str = None
    ):
        """
        Initialize Graph RAG

        Args:
            driver: Neo4j driver instance
            openai_api_key: OpenAI API key for entity extraction
        """
        self.driver = driver
        self.openai_api_key = openai_api_key or os.getenv("OPENAI_API_KEY")
        openai.api_key = self.openai_api_key

        logger.info("✅ GraphRAG initialized")

    async def extract_entities(self, query: str, project_context: str = "") -> Dict[str, Any]:
        """
        Extract electrical engineering entities from user query using LLM

        Args:
            query: User's question
            project_context: Optional project context (name, client, etc.)

        Returns:
            Dict with extracted entities and intent
        """
        try:
            prompt = f"""Extract electrical engineering entities and intent from this question.

Project Context: {project_context}

Question: {query}

Extract:
1. Document types mentioned (e.g., "cable list", "SLD", "specification")
2. Equipment types (e.g., "panel", "transformer", "breaker", "motor")
3. Electrical properties (e.g., "400V", "630A", "50Hz", "LV", "MV")
4. Drawing types (e.g., "single line", "wiring diagram", "outline")
5. Project identifiers (OE numbers, revision codes)
6. Intent: What is the user trying to do? (find, analyze, compare, list, calculate, etc.)

Return JSON format:
{{
    "document_types": [...],
    "equipment": [...],
    "electrical_properties": {{
        "voltages": [...],
        "currents": [...],
        "frequencies": [...],
        "voltage_level": "LV" or "MV" or null
    }},
    "drawing_types": [...],
    "identifiers": [...],
    "intent": "...",
    "complexity": "simple" or "moderate" or "complex"
}}"""

            response = openai.ChatCompletion.create(
                model="gpt-4o-mini",
                messages=[
                    {"role": "system", "content": "You are an electrical engineering entity extraction assistant. Return only valid JSON."},
                    {"role": "user", "content": prompt}
                ],
                temperature=0.1,
                max_tokens=500
            )

            import json
            entities = json.loads(response.choices[0].message.content)

            logger.info(f"🔍 Extracted entities: {entities.get('intent', 'unknown')} ({entities.get('complexity', 'unknown')})")
            return entities

        except Exception as e:
            logger.error(f"❌ Entity extraction failed: {e}")
            # Fallback to simple keyword extraction
            return self._simple_entity_extraction(query)

    def _simple_entity_extraction(self, query: str) -> Dict[str, Any]:
        """Fallback keyword-based entity extraction"""
        query_lower = query.lower()

        # Detect voltage levels
        voltage_level = None
        if re.search(r'\b(lv|low.?voltage|400v|230v)\b', query_lower):
            voltage_level = "LV"
        elif re.search(r'\b(mv|medium.?voltage|11kv|33kv|20kv)\b', query_lower):
            voltage_level = "MV"

        # Detect document types
        doc_types = []
        doc_patterns = {
            'cable list': r'cable.*list',
            'datasheet': r'data.*sheet',
            'specification': r'spec(ification)?',
            'single line': r'(sld|single.*line)',
            'wiring': r'wiring'
        }
        for doc_type, pattern in doc_patterns.items():
            if re.search(pattern, query_lower):
                doc_types.append(doc_type)

        # Detect intent
        intent = "find"
        if re.search(r'\b(list|show|display|get)\b', query_lower):
            intent = "list"
        elif re.search(r'\b(compar|differ)\b', query_lower):
            intent = "compare"
        elif re.search(r'\b(calculat|comput)\b', query_lower):
            intent = "calculate"
        elif re.search(r'\b(analyz|check|verif)\b', query_lower):
            intent = "analyze"

        return {
            "document_types": doc_types,
            "equipment": [],
            "electrical_properties": {
                "voltages": [],
                "currents": [],
                "frequencies": [],
                "voltage_level": voltage_level
            },
            "drawing_types": [],
            "identifiers": [],
            "intent": intent,
            "complexity": "simple"
        }

    def build_graph_query(
        self,
        project_oenum: str,
        entities: Dict[str, Any],
        max_hops: int = 2
    ) -> str:
        """
        Build Cypher query based on extracted entities

        Args:
            project_oenum: Project OENUM
            entities: Extracted entities from query
            max_hops: Maximum graph traversal hops (1-3)

        Returns:
            Cypher query string
        """
        complexity = entities.get('complexity', 'simple')

        # Adjust hops based on complexity
        if complexity == 'simple':
            hops = min(max_hops, 1)
        elif complexity == 'moderate':
            hops = min(max_hops, 2)
        else:
            hops = max_hops

        # Base query - start from project
        query_parts = [
            f"MATCH (p:Project {{project_number: '{project_oenum}'}})"
        ]

        # Filter conditions
        filters = []

        # Add document type filters
        doc_types = entities.get('document_types', [])
        if doc_types:
            # Normalize document type names
            normalized_types = [self._normalize_doc_type(dt) for dt in doc_types]
            type_filter = " OR ".join([f"type.name =~ '(?i){dt}'" for dt in normalized_types])
            filters.append(f"({type_filter})")

        # Add voltage level filter
        voltage_level = entities.get('electrical_properties', {}).get('voltage_level')
        if voltage_level:
            filters.append(f"cat.name = '{voltage_level}'")

        # Build traversal pattern based on hops
        if hops == 1:
            # Direct children only
            traversal = """
            OPTIONAL MATCH (p)-[:HAS_CATEGORY]->(cat:Category)
            OPTIONAL MATCH (cat)-[:HAS_SUBCATEGORY|HAS_TYPE]->(type)
            OPTIONAL MATCH (type)-[:HAS_DOCUMENT|HAS_DRAWING]->(item)
            """
        elif hops == 2:
            # Include document/drawing relationships
            traversal = """
            OPTIONAL MATCH (p)-[:HAS_CATEGORY]->(cat:Category)
            OPTIONAL MATCH (cat)-[:HAS_SUBCATEGORY*0..1]->(subcat)
            OPTIONAL MATCH (subcat)-[:HAS_TYPE]->(type)
            OPTIONAL MATCH (type)-[:HAS_DOCUMENT|HAS_DRAWING]->(item)
            OPTIONAL MATCH (item)-[:CONTAINS_ENTITY]->(entity)
            """
        else:  # hops == 3
            # Include entity relationships
            traversal = """
            OPTIONAL MATCH (p)-[:HAS_CATEGORY]->(cat:Category)
            OPTIONAL MATCH (cat)-[:HAS_SUBCATEGORY*0..2]->(subcat)
            OPTIONAL MATCH (subcat)-[:HAS_TYPE]->(type)
            OPTIONAL MATCH (type)-[:HAS_DOCUMENT|HAS_DRAWING]->(item)
            OPTIONAL MATCH (item)-[:CONTAINS_ENTITY]->(entity)
            OPTIONAL MATCH (entity)-[rel:RELATES_TO|CONNECTED_TO|PART_OF]->(related)
            """

        query_parts.append(traversal)

        # Add WHERE clause if filters exist
        if filters:
            query_parts.append(f"WHERE {' AND '.join(filters)}")

        # Return relevant nodes and relationships
        query_parts.append("""
        RETURN
            p.project_number as project_number,
            p.project_name as project_name,
            collect(DISTINCT cat.name) as categories,
            collect(DISTINCT type.name) as types,
            collect(DISTINCT {
                id: item.id,
                name: item.name,
                type: labels(item)[0],
                properties: properties(item)
            }) as items,
            collect(DISTINCT {
                name: entity.name,
                type: labels(entity)[0],
                properties: properties(entity)
            }) as entities
        LIMIT 100
        """)

        query = "\n".join(query_parts)
        logger.info(f"🔧 Generated Cypher query with {hops} hops")
        return query

    def _normalize_doc_type(self, doc_type: str) -> str:
        """Normalize document type names for matching"""
        doc_type_map = {
            'cable list': 'CableList',
            'data sheet': 'DataSheet',
            'datasheet': 'DataSheet',
            'spec': 'Spec',
            'specification': 'Spec',
            'single line': 'SingleLine',
            'sld': 'SingleLine',
            'wiring': 'Wiring',
            'outline': 'Outline',
            'calculation': 'Calculation',
            'mto': 'Mto'
        }
        return doc_type_map.get(doc_type.lower(), doc_type)

    async def retrieve_subgraph(
        self,
        project_oenum: str,
        query: str,
        project_context: str = "",
        max_hops: int = 2
    ) -> Dict[str, Any]:
        """
        Retrieve relevant subgraph based on user query

        Args:
            project_oenum: Project OENUM
            query: User's question
            project_context: Optional project metadata
            max_hops: Maximum traversal depth

        Returns:
            Dict with subgraph data and metadata
        """
        try:
            # Extract entities from query
            entities = await self.extract_entities(query, project_context)

            # Build Cypher query
            cypher_query = self.build_graph_query(project_oenum, entities, max_hops)

            # Execute query
            with self.driver.session() as session:
                result = session.run(cypher_query)
                record = result.single()

                if not record:
                    logger.warning(f"⚠️ No subgraph found for project {project_oenum}")
                    return {
                        "success": False,
                        "message": "No relevant graph data found",
                        "entities": entities
                    }

                # Format subgraph
                subgraph = {
                    "project": {
                        "oenum": record["project_number"],
                        "name": record["project_name"]
                    },
                    "categories": record["categories"],
                    "types": record["types"],
                    "items": [item for item in record["items"] if item['id'] is not None],
                    "entities": [ent for ent in record["entities"] if ent['name'] is not None],
                    "extracted_entities": entities,
                    "hops": max_hops
                }

                logger.info(f"✅ Retrieved subgraph: {len(subgraph['items'])} items, {len(subgraph['entities'])} entities")
                return {
                    "success": True,
                    "subgraph": subgraph
                }

        except Exception as e:
            logger.error(f"❌ Subgraph retrieval failed: {e}")
            return {
                "success": False,
                "error": str(e)
            }

    def format_context_for_llm(self, subgraph: Dict[str, Any]) -> str:
        """
        Format subgraph data as context for LLM

        Args:
            subgraph: Subgraph data from retrieve_subgraph

        Returns:
            Formatted context string
        """
        if not subgraph:
            return ""

        context_parts = []

        # Project info
        project = subgraph.get('project', {})
        context_parts.append(f"# Project: {project.get('name')} ({project.get('oenum')})")
        context_parts.append("")

        # Categories and types
        categories = subgraph.get('categories', [])
        types = subgraph.get('types', [])
        if categories:
            context_parts.append(f"## Available Categories: {', '.join(categories)}")
        if types:
            context_parts.append(f"## Available Document/Drawing Types: {', '.join(types)}")
        context_parts.append("")

        # Items (documents/drawings)
        items = subgraph.get('items', [])
        if items:
            context_parts.append(f"## Documents and Drawings ({len(items)} items):")
            for item in items[:20]:  # Limit to prevent context overflow
                item_type = item.get('type', 'Unknown')
                item_name = item.get('name', 'Unnamed')
                props = item.get('properties', {})

                context_parts.append(f"- **{item_name}** ({item_type})")

                # Add relevant properties
                if 'filename' in props:
                    context_parts.append(f"  - File: {props['filename']}")
                if 'revision' in props:
                    context_parts.append(f"  - Revision: {props['revision']}")
                if 'description' in props:
                    context_parts.append(f"  - Description: {props['description']}")

            if len(items) > 20:
                context_parts.append(f"  ... and {len(items) - 20} more items")
            context_parts.append("")

        # Entities (equipment, etc.)
        entities = subgraph.get('entities', [])
        if entities:
            context_parts.append(f"## Extracted Entities ({len(entities)}):")
            for entity in entities[:10]:
                ent_name = entity.get('name', 'Unknown')
                ent_type = entity.get('type', 'Entity')
                props = entity.get('properties', {})

                context_parts.append(f"- **{ent_name}** ({ent_type})")

                if 'voltage' in props:
                    context_parts.append(f"  - Voltage: {props['voltage']}")
                if 'current' in props:
                    context_parts.append(f"  - Current: {props['current']}")

            if len(entities) > 10:
                context_parts.append(f"  ... and {len(entities) - 10} more entities")
            context_parts.append("")

        return "\n".join(context_parts)

    async def query(
        self,
        project_oenum: str,
        user_query: str,
        project_context: str = "",
        max_hops: int = 2,
        use_llm_formatting: bool = True
    ) -> Dict[str, Any]:
        """
        Complete Graph RAG query flow

        Args:
            project_oenum: Project OENUM
            user_query: User's question
            project_context: Optional project metadata
            max_hops: Maximum graph traversal depth
            use_llm_formatting: Whether to format context for LLM

        Returns:
            Dict with:
                - success: bool
                - context: formatted context string (if use_llm_formatting=True)
                - subgraph: raw subgraph data
                - entities: extracted entities
        """
        # Retrieve subgraph
        result = await self.retrieve_subgraph(
            project_oenum,
            user_query,
            project_context,
            max_hops
        )

        if not result.get('success'):
            return result

        subgraph = result['subgraph']

        # Format context if requested
        context = ""
        if use_llm_formatting:
            context = self.format_context_for_llm(subgraph)

        return {
            "success": True,
            "context": context,
            "subgraph": subgraph,
            "entities": subgraph.get('extracted_entities', {}),
            "stats": {
                "items_found": len(subgraph.get('items', [])),
                "entities_found": len(subgraph.get('entities', [])),
                "categories": len(subgraph.get('categories', [])),
                "hops": max_hops
            }
        }

    async def hybrid_search(
        self,
        project_oenum: str,
        user_query: str,
        vector_results: List[Dict[str, Any]] = None,
        project_context: str = "",
        max_hops: int = 2
    ) -> Dict[str, Any]:
        """
        Hybrid search combining graph traversal + vector search results

        Args:
            project_oenum: Project OENUM
            user_query: User's question
            vector_results: Optional vector search results from Qdrant
            project_context: Optional project metadata
            max_hops: Maximum graph traversal depth

        Returns:
            Combined context from graph and vector search
        """
        # Get graph context
        graph_result = await self.query(
            project_oenum,
            user_query,
            project_context,
            max_hops,
            use_llm_formatting=True
        )

        if not graph_result.get('success'):
            return graph_result

        context_parts = [graph_result['context']]

        # Add vector search results if provided
        if vector_results:
            context_parts.append("\n## Relevant Document Sections:")
            for idx, result in enumerate(vector_results[:5], 1):
                context_parts.append(f"\n### Section {idx} (Score: {result.get('score', 0):.2f})")
                context_parts.append(f"**File**: {result.get('filename', 'Unknown')}")
                if result.get('header'):
                    context_parts.append(f"**Section**: {result['header']}")
                context_parts.append(f"\n{result.get('text', '')}\n")

        combined_context = "\n".join(context_parts)

        return {
            "success": True,
            "context": combined_context,
            "graph_subgraph": graph_result['subgraph'],
            "vector_chunks": vector_results or [],
            "stats": {
                **graph_result['stats'],
                "vector_chunks": len(vector_results) if vector_results else 0
            }
        }
