"""
Base Document Flow
===================
Abstract base class for all CoCoIndex document processing flows.

Each document type (Specification, CableList, SLD, etc.) implements
this interface to provide type-specific entity extraction and graph storage.

Author: Simorgh Industrial Assistant
"""

import logging
from abc import ABC, abstractmethod
from typing import List, Dict, Any, Optional, Tuple
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)


@dataclass
class ExtractedEntity:
    """Represents an extracted entity from a document"""
    entity_type: str
    entity_id: str
    properties: Dict[str, Any] = field(default_factory=dict)
    source_text: str = ""
    confidence: str = "medium"  # high, medium, low


@dataclass
class ExtractedRelationship:
    """Represents an extracted relationship between entities"""
    from_entity_id: str
    to_entity_id: str
    relationship_type: str
    properties: Dict[str, Any] = field(default_factory=dict)


@dataclass
class ExtractionResult:
    """Result of document extraction process"""
    success: bool
    document_id: str
    document_type: str
    entities: List[ExtractedEntity] = field(default_factory=list)
    relationships: List[ExtractedRelationship] = field(default_factory=list)
    errors: List[str] = field(default_factory=list)
    metadata: Dict[str, Any] = field(default_factory=dict)


class BaseDocumentFlow(ABC):
    """
    Abstract base class for document processing flows.

    Subclasses implement type-specific extraction logic for
    different document types (Specification, CableList, SLD, etc.)
    """

    def __init__(
        self,
        cocoindex_adapter,
        llm_service=None,
        qdrant_service=None
    ):
        """
        Initialize flow with required services.

        Args:
            cocoindex_adapter: CoCoIndex Neo4j adapter
            llm_service: LLM service for extraction (optional)
            qdrant_service: Qdrant service for semantic search (optional)
        """
        self.adapter = cocoindex_adapter
        self.llm_service = llm_service
        self.qdrant_service = qdrant_service

    @property
    @abstractmethod
    def document_type(self) -> str:
        """Return the document type this flow handles (e.g., 'Specification')"""
        pass

    @property
    @abstractmethod
    def supported_file_patterns(self) -> List[str]:
        """Return list of filename patterns this flow can handle"""
        pass

    @abstractmethod
    def detect_document_type(
        self,
        content: str,
        filename: str,
        metadata: Dict[str, Any] = None
    ) -> Tuple[bool, float]:
        """
        Detect if this flow can handle the given document.

        Args:
            content: Document text content
            filename: Original filename
            metadata: Additional document metadata

        Returns:
            Tuple of (can_handle: bool, confidence: float 0-1)
        """
        pass

    @abstractmethod
    def extract_entities(
        self,
        project_number: str,
        document_id: str,
        content: str,
        filename: str,
        llm_mode: str = None
    ) -> ExtractionResult:
        """
        Extract entities from document content.

        Args:
            project_number: Project context
            document_id: Unique document identifier
            content: Document text content
            filename: Original filename
            llm_mode: LLM mode (online/offline)

        Returns:
            ExtractionResult with entities and relationships
        """
        pass

    @abstractmethod
    def build_relationships(
        self,
        entities: List[ExtractedEntity],
        content: str = None
    ) -> List[ExtractedRelationship]:
        """
        Build relationships between extracted entities.

        Args:
            entities: List of extracted entities
            content: Optional document content for context

        Returns:
            List of relationships
        """
        pass

    def process_document(
        self,
        project_number: str,
        document_id: str,
        content: str,
        filename: str,
        metadata: Dict[str, Any] = None,
        llm_mode: str = None
    ) -> Dict[str, Any]:
        """
        Complete document processing pipeline.

        Steps:
        1. Check if flow can handle document
        2. Extract entities
        3. Build relationships
        4. Store to graph

        Args:
            project_number: Project context
            document_id: Unique document identifier
            content: Document text content
            filename: Original filename
            metadata: Additional metadata
            llm_mode: LLM mode

        Returns:
            Processing result with statistics
        """
        logger.info(f"Processing document {document_id} with {self.document_type} flow")

        # Step 1: Verify this flow can handle the document
        can_handle, confidence = self.detect_document_type(content, filename, metadata)
        if not can_handle:
            logger.warning(f"Document {document_id} not suitable for {self.document_type} flow")
            return {
                "success": False,
                "document_id": document_id,
                "error": f"Document not suitable for {self.document_type} flow",
                "detection_confidence": confidence
            }

        # Step 2: Ensure project exists
        self.adapter.create_project(
            project_number=project_number,
            project_name=f"Project {project_number}"
        )

        # Step 3: Extract entities
        extraction_result = self.extract_entities(
            project_number=project_number,
            document_id=document_id,
            content=content,
            filename=filename,
            llm_mode=llm_mode
        )

        if not extraction_result.success:
            logger.error(f"Entity extraction failed: {extraction_result.errors}")
            return {
                "success": False,
                "document_id": document_id,
                "errors": extraction_result.errors
            }

        # Step 4: Build additional relationships
        additional_rels = self.build_relationships(
            extraction_result.entities,
            content
        )
        extraction_result.relationships.extend(additional_rels)

        # Step 5: Store to graph
        store_result = self.store_to_graph(
            project_number=project_number,
            document_id=document_id,
            extraction_result=extraction_result,
            metadata=metadata
        )

        logger.info(f"Document {document_id} processed: "
                   f"{len(extraction_result.entities)} entities, "
                   f"{len(extraction_result.relationships)} relationships")

        return {
            "success": True,
            "document_id": document_id,
            "document_type": self.document_type,
            "entities_extracted": len(extraction_result.entities),
            "relationships_extracted": len(extraction_result.relationships),
            "detection_confidence": confidence,
            "store_result": store_result
        }

    def store_to_graph(
        self,
        project_number: str,
        document_id: str,
        extraction_result: ExtractionResult,
        metadata: Dict[str, Any] = None
    ) -> Dict[str, Any]:
        """
        Store extracted entities and relationships to Neo4j.

        IMPORTANT: Links entities to the Document node (not just Project).
        The Document node uses 'id' as identifier, while other entities use 'entity_id'.

        Args:
            project_number: Project context
            document_id: Document identifier (matches Document.id)
            extraction_result: Extraction results
            metadata: Additional metadata

        Returns:
            Storage statistics
        """
        try:
            # Update existing Document node properties (don't create separate document entity)
            # Document nodes use 'id' not 'entity_id'
            doc_props = {
                "document_type": self.document_type,
                "entities_count": len(extraction_result.entities),
            }

            # Update Document node via direct query
            self._update_document_properties(
                project_number=project_number,
                document_id=document_id,
                properties=doc_props
            )

            # Create entities (except the SpecificationDocument which is the Document itself)
            entities_created = 0
            for entity in extraction_result.entities:
                # Skip creating separate document entity - we use the existing Document node
                if entity.entity_type.endswith("Document"):
                    continue

                props = {
                    **entity.properties,
                    "source_text": entity.source_text,
                    "confidence": entity.confidence
                }

                self.adapter.create_entity(
                    project_number=project_number,
                    entity_type=entity.entity_type,
                    entity_id=entity.entity_id,
                    properties=props
                )
                entities_created += 1

            # Create relationships with special handling for Document source
            relationships_created = 0
            for rel in extraction_result.relationships:
                # Handle relationships FROM Document node (uses 'id' not 'entity_id')
                if rel.from_entity_id == document_id:
                    success = self._create_document_relationship(
                        project_number=project_number,
                        document_id=document_id,
                        to_entity_id=rel.to_entity_id,
                        relationship_type=rel.relationship_type,
                        properties=rel.properties
                    )
                else:
                    # Normal entity-to-entity relationship
                    success = self.adapter.create_relationship(
                        project_number=project_number,
                        from_entity_id=rel.from_entity_id,
                        to_entity_id=rel.to_entity_id,
                        relationship_type=rel.relationship_type,
                        properties=rel.properties
                    )
                if success:
                    relationships_created += 1

            return {
                "success": True,
                "entities_created": entities_created,
                "relationships_created": relationships_created
            }

        except Exception as e:
            logger.error(f"Failed to store to graph: {e}")
            return {
                "success": False,
                "error": str(e)
            }

    def _update_document_properties(
        self,
        project_number: str,
        document_id: str,
        properties: Dict[str, Any]
    ) -> bool:
        """
        Update properties on existing Document node.

        Document nodes use 'id' as identifier (not 'entity_id').
        """
        try:
            with self.adapter.driver.session() as session:
                # Build SET clause for properties
                set_clauses = []
                params = {
                    "doc_id": document_id,
                    "project_number": project_number
                }

                for key, value in properties.items():
                    param_name = f"prop_{key}"
                    set_clauses.append(f"doc.{key} = ${param_name}")
                    params[param_name] = value

                set_clause = ", ".join(set_clauses) if set_clauses else "doc.updated_at = datetime()"

                query = f"""
                MATCH (doc:Document {{id: $doc_id, project_number: $project_number}})
                SET {set_clause}, doc.extraction_completed_at = datetime()
                RETURN doc.id as id
                """

                result = session.run(query, params)
                record = result.single()
                return record is not None

        except Exception as e:
            logger.error(f"Failed to update document properties: {e}")
            return False

    def _create_document_relationship(
        self,
        project_number: str,
        document_id: str,
        to_entity_id: str,
        relationship_type: str,
        properties: Dict[str, Any] = None
    ) -> bool:
        """
        Create relationship from Document node to another entity.

        Document nodes use 'id' as identifier, while other entities use 'entity_id'.
        This method handles the asymmetric matching.
        """
        try:
            safe_rel_type = relationship_type.replace(" ", "_").replace("-", "_").upper()

            with self.adapter.driver.session() as session:
                query = f"""
                MATCH (doc:Document {{id: $doc_id, project_number: $project_number}})
                MATCH (target {{entity_id: $to_id, project_number: $project_number}})
                MERGE (doc)-[r:{safe_rel_type}]->(target)
                SET r += $properties,
                    r.created_at = coalesce(r.created_at, datetime())
                RETURN r IS NOT NULL as created
                """

                result = session.run(query, {
                    "doc_id": document_id,
                    "project_number": project_number,
                    "to_id": to_entity_id,
                    "properties": properties or {}
                })
                record = result.single()
                success = record["created"] if record else False

                if success:
                    logger.debug(f"Created Document->{relationship_type}->{to_entity_id}")
                else:
                    logger.warning(f"Failed to create Document relationship: {document_id} -> {to_entity_id}")

                return success

        except Exception as e:
            logger.error(f"Failed to create document relationship: {e}")
            return False

    def get_extraction_prompt(
        self,
        category: str = None,
        fields: List[str] = None
    ) -> str:
        """
        Get LLM extraction prompt for this document type.

        Can be overridden by subclasses for type-specific prompts.

        Args:
            category: Optional category filter
            fields: Optional specific fields to extract

        Returns:
            LLM prompt string
        """
        return self._default_extraction_prompt()

    def _default_extraction_prompt(self) -> str:
        """Default extraction prompt template"""
        return f"""You are an expert document analyzer for {self.document_type} documents.

Extract all relevant entities and their properties from the provided document.

Return the results in JSON format:
{{
    "entities": [
        {{
            "entity_type": "...",
            "entity_id": "unique_id",
            "properties": {{}},
            "confidence": "high|medium|low"
        }}
    ],
    "relationships": [
        {{
            "from_entity": "entity_id",
            "to_entity": "entity_id",
            "type": "RELATIONSHIP_TYPE"
        }}
    ]
}}
"""


class DocumentFlowRegistry:
    """
    Registry for document processing flows.

    Manages all available flows and routes documents to appropriate handlers.
    """

    def __init__(self):
        self._flows: List[BaseDocumentFlow] = []

    def register_flow(self, flow: BaseDocumentFlow):
        """Register a document flow"""
        self._flows.append(flow)
        logger.info(f"Registered flow: {flow.document_type}")

    def get_flow_for_document(
        self,
        content: str,
        filename: str,
        metadata: Dict[str, Any] = None
    ) -> Optional[BaseDocumentFlow]:
        """
        Get the best matching flow for a document.

        Args:
            content: Document content
            filename: Filename
            metadata: Optional metadata

        Returns:
            Best matching flow or None
        """
        best_flow = None
        best_confidence = 0.0

        for flow in self._flows:
            can_handle, confidence = flow.detect_document_type(content, filename, metadata)
            if can_handle and confidence > best_confidence:
                best_flow = flow
                best_confidence = confidence

        if best_flow:
            logger.info(f"Selected flow: {best_flow.document_type} (confidence: {best_confidence:.2f})")

        return best_flow

    def get_all_flows(self) -> List[BaseDocumentFlow]:
        """Get all registered flows"""
        return self._flows.copy()

    def get_flow_by_type(self, document_type: str) -> Optional[BaseDocumentFlow]:
        """Get flow by document type"""
        for flow in self._flows:
            if flow.document_type.lower() == document_type.lower():
                return flow
        return None


# Global registry instance
_flow_registry: Optional[DocumentFlowRegistry] = None


def get_flow_registry() -> DocumentFlowRegistry:
    """Get or create flow registry singleton"""
    global _flow_registry

    if _flow_registry is None:
        _flow_registry = DocumentFlowRegistry()

    return _flow_registry
