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
