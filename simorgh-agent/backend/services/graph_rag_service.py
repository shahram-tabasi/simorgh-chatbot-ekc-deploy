"""
Graph RAG Service
=================
Provides graph traversal and knowledge retrieval from Neo4j
for answering user queries using structured specification data.

Author: Simorgh Industrial Assistant
"""

import logging
from typing import Dict, Any, List, Optional
from neo4j import Driver
import re

logger = logging.getLogger(__name__)


class GraphRAGService:
    """
    Service for retrieving knowledge from Neo4j graph structure
    """

    def __init__(self, driver: Driver):
        """
        Initialize with Neo4j driver

        Args:
            driver: Neo4j driver instance
        """
        self.driver = driver

    def query_specifications(
        self,
        project_number: str,
        query_keywords: List[str],
        limit: int = 10
    ) -> Dict[str, Any]:
        """
        Query specifications based on keywords

        Args:
            project_number: Project OE number
            query_keywords: List of keywords to search for
            limit: Maximum results

        Returns:
            Dictionary with retrieved specs and context
        """
        try:
            with self.driver.session() as session:
                # Build keyword pattern for case-insensitive search
                keyword_pattern = '|'.join([f'(?i){kw}' for kw in query_keywords])

                query = """
                MATCH (doc:Document {project_number: $project_number})
                    -[:HAS_SPEC_CATEGORY]->(cat:SpecCategory)
                    -[:HAS_FIELD]->(field:SpecField)
                OPTIONAL MATCH (field)-[:HAS_VALUE]->(value:ActualValue)
                OPTIONAL MATCH (field)-[:HAS_EXTRACTION_GUIDE]->(guide:ExtractionGuide)

                WHERE field.name =~ $keyword_pattern
                   OR cat.name =~ $keyword_pattern
                   OR value.extracted_value =~ $keyword_pattern

                RETURN doc.filename as document,
                       cat.name as category,
                       field.name as field_name,
                       value.extracted_value as field_value,
                       guide.definition as definition,
                       guide.common_values as common_values
                LIMIT $limit
                """

                result = session.run(
                    query,
                    project_number=project_number,
                    keyword_pattern=keyword_pattern,
                    limit=limit
                )

                specs = []
                for record in result:
                    specs.append({
                        "document": record["document"],
                        "category": record["category"],
                        "field": record["field_name"],
                        "value": record["field_value"] or "Not specified",
                        "definition": record["definition"] or "",
                        "common_values": record["common_values"] or ""
                    })

                return {
                    "success": True,
                    "specs": specs,
                    "count": len(specs)
                }

        except Exception as e:
            logger.error(f"❌ Failed to query specifications: {e}")
            return {
                "success": False,
                "specs": [],
                "count": 0,
                "error": str(e)
            }

    def get_document_specifications(
        self,
        project_number: str,
        document_id: Optional[str] = None,
        category_filter: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Get all specifications for a document or project

        Args:
            project_number: Project OE number
            document_id: Optional document ID filter
            category_filter: Optional category filter

        Returns:
            Complete specifications
        """
        try:
            with self.driver.session() as session:
                # Build query based on filters
                where_clauses = []
                params = {"project_number": project_number}

                if document_id:
                    where_clauses.append("doc.id = $doc_id")
                    params["doc_id"] = document_id

                if category_filter:
                    where_clauses.append("cat.name = $category")
                    params["category"] = category_filter

                where_clause = " AND " + " AND ".join(where_clauses) if where_clauses else ""

                query = f"""
                MATCH (doc:Document {{project_number: $project_number}})
                    -[:HAS_SPEC_CATEGORY]->(cat:SpecCategory)
                    -[:HAS_FIELD]->(field:SpecField)
                OPTIONAL MATCH (field)-[:HAS_VALUE]->(value:ActualValue)
                {where_clause}

                RETURN doc.filename as document,
                       doc.id as document_id,
                       cat.name as category,
                       field.name as field_name,
                       value.extracted_value as field_value
                ORDER BY doc.filename, cat.name, field.name
                """

                result = session.run(query, **params)

                # Group by document and category
                documents = {}
                for record in result:
                    doc_name = record["document"]
                    doc_id = record["document_id"]
                    category = record["category"]
                    field = record["field_name"]
                    value = record["field_value"] or ""

                    if doc_name not in documents:
                        documents[doc_name] = {
                            "document_id": doc_id,
                            "categories": {}
                        }

                    if category not in documents[doc_name]["categories"]:
                        documents[doc_name]["categories"][category] = {}

                    documents[doc_name]["categories"][category][field] = value

                return {
                    "success": True,
                    "documents": documents,
                    "document_count": len(documents)
                }

        except Exception as e:
            logger.error(f"❌ Failed to get document specifications: {e}")
            return {
                "success": False,
                "documents": {},
                "error": str(e)
            }

    def search_by_natural_query(
        self,
        project_number: str,
        query: str
    ) -> Dict[str, Any]:
        """
        Search specifications using natural language query

        Extracts keywords and searches across fields, values, and definitions

        Args:
            project_number: Project OE number
            query: Natural language query

        Returns:
            Relevant specifications
        """
        # Extract keywords from query
        keywords = self._extract_keywords(query)

        logger.info(f"🔍 Searching graph with keywords: {keywords}")

        # Query using keywords
        return self.query_specifications(
            project_number=project_number,
            query_keywords=keywords,
            limit=20
        )

    def get_protection_specifications(
        self,
        project_number: str
    ) -> Dict[str, Any]:
        """
        Get all protection-related specifications

        Args:
            project_number: Project OE number

        Returns:
            Protection specifications
        """
        try:
            with self.driver.session() as session:
                query = """
                MATCH (doc:Document {project_number: $project_number})
                    -[:HAS_SPEC_CATEGORY]->(cat:SpecCategory)
                    -[:HAS_FIELD]->(field:SpecField)
                OPTIONAL MATCH (field)-[:HAS_VALUE]->(value:ActualValue)

                WHERE field.name =~ '(?i).*(protection|trip|relay|rcd|spd|breaker|fault|earth).*'
                   OR cat.name =~ '(?i).*(protection|circuit.*breaker|network).*'

                RETURN doc.filename as document,
                       cat.name as category,
                       field.name as field_name,
                       value.extracted_value as field_value
                ORDER BY doc.filename, cat.name, field.name
                """

                result = session.run(query, project_number=project_number)

                protections = []
                for record in result:
                    protections.append({
                        "document": record["document"],
                        "category": record["category"],
                        "field": record["field_name"],
                        "value": record["field_value"] or "Not specified"
                    })

                return {
                    "success": True,
                    "protections": protections,
                    "count": len(protections)
                }

        except Exception as e:
            logger.error(f"❌ Failed to get protection specifications: {e}")
            return {
                "success": False,
                "protections": [],
                "error": str(e)
            }

    def build_context_from_specs(
        self,
        specs: List[Dict[str, Any]],
        query: str = ""
    ) -> str:
        """
        Build rich context text from specification results

        Args:
            specs: List of specification dictionaries
            query: Original user query

        Returns:
            Formatted context string
        """
        if not specs:
            return ""

        # Filter out specs with empty/null values
        specs_with_values = [
            spec for spec in specs
            if spec.get("value") and spec["value"].strip() and spec["value"] != "Not specified"
        ]

        if not specs_with_values:
            return ""

        context_parts = [
            f"## 📊 Project Specifications Found: {len(specs_with_values)} items\n",
            "**IMPORTANT: Use the following ACTUAL specifications from this project's documents.**\n"
        ]

        # Group by category
        by_category = {}
        for spec in specs_with_values:
            category = spec["category"]
            if category not in by_category:
                by_category[category] = []
            by_category[category].append(spec)

        # Format each category
        for category, items in by_category.items():
            category_readable = category.replace("_", " ")
            context_parts.append(f"\n### {category_readable} ({len(items)} specifications):")

            for item in items:
                field_readable = item["field"].replace("_", " ")
                value = item["value"]
                document = item.get("document", "")

                # Format with document reference
                spec_line = f"- **{field_readable}**: `{value}`"
                if document:
                    spec_line += f" _(from {document})_"

                context_parts.append(spec_line)

                # Add definition if available
                if item.get("definition") and len(item["definition"]) > 20:
                    context_parts.append(f"  > {item['definition'][:150]}...")

        return "\n".join(context_parts)

    def _extract_keywords(self, query: str) -> List[str]:
        """
        Extract meaningful keywords from natural language query

        Args:
            query: User query

        Returns:
            List of keywords
        """
        # Remove common words
        stop_words = {
            'the', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'of', 'is', 'are',
            'what', 'how', 'when', 'where', 'why', 'which', 'who', 'tell', 'me',
            'about', 'this', 'that', 'these', 'those', 'i', 'you', 'have', 'has',
            'do', 'does', 'can', 'will', 'would', 'should', 'could', 'and', 'or'
        }

        # Extract words
        words = re.findall(r'\b\w+\b', query.lower())

        # Filter meaningful keywords (length > 3, not stop words)
        keywords = [
            word for word in words
            if len(word) > 3 and word not in stop_words
        ]

        # Add common technical synonyms
        keyword_expansions = {
            'protection': ['protection', 'trip', 'relay', 'rcd', 'breaker'],
            'voltage': ['voltage', 'volt', 'rated.*voltage', 'service.*voltage'],
            'current': ['current', 'amp', 'rated.*current'],
            'breaker': ['breaker', 'circuit.*breaker', 'cb', 'acb', 'mccb'],
            'temperature': ['temperature', 'ambient', 'thermal'],
            'busbar': ['busbar', 'bus.*bar', 'main.*bus']
        }

        # Expand keywords
        expanded = set(keywords)
        for keyword in keywords:
            if keyword in keyword_expansions:
                expanded.update(keyword_expansions[keyword])

        return list(expanded)[:10]  # Limit to 10 keywords

    def get_project_summary(
        self,
        project_number: str
    ) -> Dict[str, Any]:
        """
        Get high-level project summary from graph

        Args:
            project_number: Project OE number

        Returns:
            Project summary
        """
        try:
            with self.driver.session() as session:
                query = """
                MATCH (p:Project {project_number: $project_number})
                OPTIONAL MATCH (p)-[:HAS_CATEGORY]->(doc_cat:Category {name: 'Document'})
                    -[:HAS_SUBCATEGORY*0..1]->(sub)
                    -[:HAS_TYPE]->(type)
                    -[:HAS_DOCUMENT]->(doc:Document)

                WITH p, count(DISTINCT doc) as total_docs

                OPTIONAL MATCH (spec_doc:Document {project_number: $project_number})
                    -[:HAS_SPEC_CATEGORY]->(cat:SpecCategory)
                    -[:HAS_FIELD]->(field:SpecField)

                RETURN p.project_name as name,
                       p.project_number as number,
                       total_docs,
                       count(DISTINCT spec_doc) as spec_docs,
                       count(DISTINCT cat) as spec_categories,
                       count(DISTINCT field) as spec_fields
                """

                result = session.run(query, project_number=project_number)
                record = result.single()

                if record:
                    return {
                        "success": True,
                        "project_name": record["name"],
                        "project_number": record["number"],
                        "total_documents": record["total_docs"],
                        "spec_documents": record["spec_docs"],
                        "spec_categories": record["spec_categories"],
                        "spec_fields": record["spec_fields"]
                    }
                else:
                    return {"success": False, "error": "Project not found"}

        except Exception as e:
            logger.error(f"❌ Failed to get project summary: {e}")
            return {"success": False, "error": str(e)}

    # =========================================================================
    # ENHANCED GRAPH TRAVERSAL (BFS) FOR KNOWLEDGE GRAPH RAG
    # =========================================================================

    def traverse_graph_bfs(
        self,
        project_number: str,
        start_nodes: List[str],
        max_depth: int = 3,
        relationship_types: Optional[List[str]] = None
    ) -> Dict[str, Any]:
        """
        Traverse graph using Breadth-First Search starting from given nodes

        Args:
            project_number: Project OE number
            start_nodes: List of starting node names
            max_depth: Maximum traversal depth
            relationship_types: Optional list of relationship types to follow

        Returns:
            Subgraph data with nodes and relationships
        """
        try:
            logger.info(f"🔍 BFS traversal from {len(start_nodes)} start nodes (max depth: {max_depth})")

            with self.driver.session() as session:
                # Build relationship pattern
                rel_pattern = ""
                if relationship_types:
                    rel_types = "|".join(f":{rt}" for rt in relationship_types)
                    rel_pattern = f"[{rel_types}*1..{max_depth}]"
                else:
                    rel_pattern = f"[*1..{max_depth}]"

                # Cypher query for BFS traversal
                query = f"""
                MATCH (start {{project_number: $project_number}})
                WHERE start.name IN $start_nodes

                MATCH path = (start)-{rel_pattern}-(connected)
                WHERE connected.project_number = $project_number

                WITH nodes(path) as path_nodes, relationships(path) as path_rels

                UNWIND path_nodes as node
                WITH DISTINCT node, path_rels

                OPTIONAL MATCH (node)-[r]-(related)
                WHERE related.project_number = $project_number

                RETURN
                    collect(DISTINCT {{
                        id: id(node),
                        labels: labels(node),
                        properties: properties(node)
                    }}) as nodes,
                    collect(DISTINCT {{
                        type: type(r),
                        start: id(startNode(r)),
                        end: id(endNode(r)),
                        properties: properties(r)
                    }}) as relationships
                """

                result = session.run(
                    query,
                    project_number=project_number,
                    start_nodes=start_nodes
                )

                record = result.single()

                if record:
                    nodes = record["nodes"]
                    relationships = record["relationships"]

                    logger.info(f"✅ BFS found {len(nodes)} nodes, {len(relationships)} relationships")

                    return {
                        "success": True,
                        "nodes": nodes,
                        "relationships": relationships,
                        "node_count": len(nodes),
                        "relationship_count": len(relationships)
                    }
                else:
                    return {
                        "success": False,
                        "nodes": [],
                        "relationships": [],
                        "error": "No paths found"
                    }

        except Exception as e:
            logger.error(f"❌ BFS traversal failed: {e}")
            return {
                "success": False,
                "nodes": [],
                "relationships": [],
                "error": str(e)
            }

    def find_related_subgraph(
        self,
        project_number: str,
        query: str,
        max_depth: int = 2
    ) -> Dict[str, Any]:
        """
        Find related subgraph based on natural language query

        Process:
        1. Extract keywords from query
        2. Find matching nodes in graph
        3. Perform BFS from matched nodes
        4. Return subgraph

        Args:
            project_number: Project OE number
            query: Natural language query
            max_depth: Maximum traversal depth

        Returns:
            Related subgraph data
        """
        try:
            logger.info(f"🔍 Finding related subgraph for: '{query[:50]}...'")

            # Extract keywords
            keywords = self._extract_keywords(query)
            logger.info(f"📝 Extracted keywords: {keywords}")

            # Find matching nodes
            with self.driver.session() as session:
                # Search for nodes matching keywords
                keyword_pattern = '|'.join([f'(?i){kw}' for kw in keywords])

                node_search_query = """
                MATCH (n {project_number: $project_number})
                WHERE n.name =~ $keyword_pattern
                   OR (n.type IS NOT NULL AND n.type =~ $keyword_pattern)
                   OR (n.description IS NOT NULL AND n.description =~ $keyword_pattern)
                RETURN DISTINCT n.name as name
                LIMIT 10
                """

                result = session.run(
                    node_search_query,
                    project_number=project_number,
                    keyword_pattern=keyword_pattern
                )

                start_nodes = [record["name"] for record in result if record["name"]]

            if not start_nodes:
                logger.warning(f"⚠️ No matching nodes found for keywords: {keywords}")
                return {
                    "success": False,
                    "error": "No matching nodes found",
                    "nodes": [],
                    "relationships": []
                }

            logger.info(f"📍 Found {len(start_nodes)} starting nodes for BFS")

            # Perform BFS traversal
            subgraph = self.traverse_graph_bfs(
                project_number=project_number,
                start_nodes=start_nodes,
                max_depth=max_depth
            )

            return subgraph

        except Exception as e:
            logger.error(f"❌ Subgraph search failed: {e}")
            return {
                "success": False,
                "error": str(e),
                "nodes": [],
                "relationships": []
            }

    def format_subgraph_for_context(
        self,
        subgraph: Dict[str, Any]
    ) -> str:
        """
        Format subgraph data as context for LLM

        Args:
            subgraph: Subgraph dictionary from traverse_graph_bfs or find_related_subgraph

        Returns:
            Formatted context string
        """
        if not subgraph.get("success") or not subgraph.get("nodes"):
            return ""

        nodes = subgraph["nodes"]
        relationships = subgraph["relationships"]

        context_parts = [
            f"## 🕸️ Knowledge Graph Context ({len(nodes)} entities, {len(relationships)} relationships)\n"
        ]

        # Group nodes by type
        nodes_by_type = {}
        for node in nodes:
            labels = node.get("labels", [])
            node_type = labels[0] if labels else "Unknown"

            if node_type not in nodes_by_type:
                nodes_by_type[node_type] = []

            nodes_by_type[node_type].append(node)

        # Format each type
        for node_type, type_nodes in nodes_by_type.items():
            if node_type in ["Project", "Category", "Unknown"]:
                continue  # Skip structural nodes

            context_parts.append(f"\n### {node_type} ({len(type_nodes)} items):")

            for node in type_nodes[:10]:  # Limit to 10 per type
                props = node.get("properties", {})
                name = props.get("name", "Unnamed")

                # Format based on node type
                if node_type == "Equipment":
                    equipment_type = props.get("type", "")
                    specs = props.get("specifications", [])
                    context_parts.append(f"- **{name}** ({equipment_type})")
                    if specs:
                        context_parts.append(f"  Specs: {', '.join(specs[:3])}")

                elif node_type == "System":
                    system_type = props.get("type", "")
                    description = props.get("description", "")
                    context_parts.append(f"- **{name}** ({system_type})")
                    if description:
                        context_parts.append(f"  {description[:100]}...")

                elif node_type == "ActualValue":
                    value = props.get("extracted_value", "")
                    field_name = props.get("field_name", "")
                    context_parts.append(f"- **{field_name}**: `{value}`")

                elif node_type == "SpecField":
                    description = props.get("description", "")
                    context_parts.append(f"- **{name}**")
                    if description:
                        context_parts.append(f"  {description[:80]}...")

                else:
                    context_parts.append(f"- **{name}**")

        # Add relationship summary
        if relationships:
            rel_types = {}
            for rel in relationships:
                rel_type = rel.get("type", "RELATED")
                rel_types[rel_type] = rel_types.get(rel_type, 0) + 1

            context_parts.append(f"\n### Relationships:")
            for rel_type, count in rel_types.items():
                context_parts.append(f"- {rel_type}: {count}")

        return "\n".join(context_parts)
