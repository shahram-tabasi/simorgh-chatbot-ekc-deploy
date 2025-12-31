"""
CoCoIndex Flows Package
========================
Document processing flows for extracting entities and building knowledge graphs.

Available Flows:
- SpecificationFlow: Processes Siemens LV/MV specification documents
- IndustrialElectricalFlow: General electrical document processing

Usage:
    from cocoindex_flows import (
        get_cocoindex_adapter,
        create_specification_flow,
        get_flow_registry
    )

    # Get adapter
    adapter = get_cocoindex_adapter()

    # Create flow
    spec_flow = create_specification_flow(adapter, llm_service)

    # Process document
    result = spec_flow.process_document(
        project_number="OE12345",
        document_id="doc_001",
        content=document_content,
        filename="spec.pdf"
    )

Author: Simorgh Industrial Assistant
"""

from .cocoindex_adapter import (
    CoCoIndexAdapter,
    get_cocoindex_adapter,
    close_cocoindex_adapter
)

from .base_flow import (
    BaseDocumentFlow,
    ExtractedEntity,
    ExtractedRelationship,
    ExtractionResult,
    DocumentFlowRegistry,
    get_flow_registry
)

from .spec_flow import (
    SpecificationFlow,
    create_specification_flow,
    get_spec_extraction_schema,
    SPEC_EXTRACTION_SCHEMA
)

__all__ = [
    # Adapter
    "CoCoIndexAdapter",
    "get_cocoindex_adapter",
    "close_cocoindex_adapter",

    # Base Flow
    "BaseDocumentFlow",
    "ExtractedEntity",
    "ExtractedRelationship",
    "ExtractionResult",
    "DocumentFlowRegistry",
    "get_flow_registry",

    # Specification Flow
    "SpecificationFlow",
    "create_specification_flow",
    "get_spec_extraction_schema",
    "SPEC_EXTRACTION_SCHEMA"
]
