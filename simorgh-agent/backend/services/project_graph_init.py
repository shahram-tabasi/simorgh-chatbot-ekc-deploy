"""
Project Graph Initialization
==============================
Creates base hierarchical graph structure for electrical engineering projects in Neo4j.
Initializes document categories, drawing types, and project organization.

Author: Simorgh Industrial Assistant
"""

import logging
from typing import Dict, Any, List, Optional
from neo4j import Driver

logger = logging.getLogger(__name__)


class ProjectGraphInitializer:
    """
    Initializes base graph structure for projects in Neo4j
    """

    def __init__(self, driver: Driver):
        """
        Initialize with Neo4j driver

        Args:
            driver: Neo4j driver instance
        """
        self.driver = driver

    def initialize_project_structure(self, project_oenum: str, project_name: str) -> Dict[str, Any]:
        """
        Create complete base graph structure for a project

        Creates:
        - Project root node
        - Document → Client/EKC hierarchies
        - Drawing → LV/MV hierarchies
        - Identity → OE_Revision

        Args:
            project_oenum: Project OENUM (unique identifier)
            project_name: Human-readable project name

        Returns:
            Statistics about created nodes and relationships
        """
        logger.info(f"📊 Initializing graph structure for project: {project_oenum}")

        with self.driver.session() as session:
            # Create base project structure
            result = session.execute_write(
                self._create_project_structure,
                project_oenum,
                project_name
            )

            logger.info(f"✅ Graph structure initialized for {project_oenum}: {result}")
            return result

    def _create_project_structure(self, tx, project_oenum: str, project_name: str) -> Dict[str, Any]:
        """Transaction function to create entire project structure"""

        stats = {
            "nodes_created": 0,
            "relationships_created": 0,
            "categories": []
        }

        # 1. Create/merge project root
        query_project = """
        MERGE (p:Project {project_number: $oenum})
        ON CREATE SET p.project_name = $name, p.created_at = datetime()
        ON MATCH SET p.updated_at = datetime()
        RETURN p
        """
        result = tx.run(query_project, oenum=project_oenum, name=project_name)
        result.single()
        stats["nodes_created"] += 1

        # 2. Create Document hierarchy
        doc_stats = self._create_document_hierarchy(tx, project_oenum)
        stats["nodes_created"] += doc_stats["nodes"]
        stats["relationships_created"] += doc_stats["relationships"]
        stats["categories"].append("Document")

        # 3. Create Drawing hierarchy
        drawing_stats = self._create_drawing_hierarchy(tx, project_oenum)
        stats["nodes_created"] += drawing_stats["nodes"]
        stats["relationships_created"] += drawing_stats["relationships"]
        stats["categories"].append("Drawing")

        # 4. Create Identity hierarchy
        identity_stats = self._create_identity_hierarchy(tx, project_oenum)
        stats["nodes_created"] += identity_stats["nodes"]
        stats["relationships_created"] += identity_stats["relationships"]
        stats["categories"].append("Identity")

        return stats

    def _create_document_hierarchy(self, tx, project_oenum: str) -> Dict[str, int]:
        """Create Document → Client/EKC hierarchies"""

        query = """
        MATCH (p:Project {project_number: $oenum})

        // Main Document category
        MERGE (p)-[:HAS_CATEGORY]->(doc:Category {name: 'Document', project_number: $oenum})

        // Client branch
        MERGE (doc)-[:HAS_SUBCATEGORY]->(client:Category {name: 'Client', project_number: $oenum})
        MERGE (client)-[:HAS_TYPE]->(t1:DocumentType {name: 'CableList', project_number: $oenum})
        MERGE (client)-[:HAS_TYPE]->(t2:DocumentType {name: 'Comment', project_number: $oenum})
        MERGE (client)-[:HAS_TYPE]->(t3:DocumentType {name: 'Cover', project_number: $oenum})
        MERGE (client)-[:HAS_TYPE]->(t4:DocumentType {name: 'DataSheet', project_number: $oenum})
        MERGE (client)-[:HAS_TYPE]->(t5:DocumentType {name: 'IoList', project_number: $oenum})
        MERGE (client)-[:HAS_TYPE]->(t6:DocumentType {name: 'LoadList', project_number: $oenum})
        MERGE (client)-[:HAS_TYPE]->(t7:DocumentType {name: 'Logic', project_number: $oenum})
        MERGE (client)-[:HAS_TYPE]->(t8:DocumentType {name: 'Other', project_number: $oenum})
        MERGE (client)-[:HAS_TYPE]->(t9:DocumentType {name: 'SiteLayout', project_number: $oenum})
        MERGE (client)-[:HAS_TYPE]->(t10:DocumentType {name: 'SLD_OLD', project_number: $oenum})
        MERGE (client)-[:HAS_TYPE]->(t11:DocumentType {name: 'Spec', project_number: $oenum})
        MERGE (client)-[:HAS_TYPE]->(t12:DocumentType {name: 'StatusOfDocument', project_number: $oenum})

        // EKC branch
        MERGE (doc)-[:HAS_SUBCATEGORY]->(ekc:Category {name: 'Ekc', project_number: $oenum})

        // EKC → DocumentIndex
        MERGE (ekc)-[:HAS_SUBCATEGORY]->(docIndex:Category {name: 'DocumentIndex', project_number: $oenum})
        MERGE (docIndex)-[:HAS_TYPE]->(e1:DocumentType {name: 'ClaimList', project_number: $oenum})
        MERGE (docIndex)-[:HAS_TYPE]->(e2:DocumentType {name: 'Clarification', project_number: $oenum})
        MERGE (docIndex)-[:HAS_TYPE]->(e3:DocumentType {name: 'DataSheet', project_number: $oenum})
        MERGE (docIndex)-[:HAS_TYPE]->(e4:DocumentType {name: 'MinutesOfMeeting', project_number: $oenum})
        MERGE (docIndex)-[:HAS_TYPE]->(e5:DocumentType {name: 'NamePlate', project_number: $oenum})
        MERGE (docIndex)-[:HAS_TYPE]->(e6:DocumentType {name: 'Other', project_number: $oenum})
        MERGE (docIndex)-[:HAS_TYPE]->(e7:DocumentType {name: 'PartList', project_number: $oenum})
        MERGE (docIndex)-[:HAS_TYPE]->(e8:DocumentType {name: 'ReplySheet', project_number: $oenum})
        MERGE (docIndex)-[:HAS_TYPE]->(e9:DocumentType {name: 'SparePart', project_number: $oenum})
        MERGE (docIndex)-[:HAS_TYPE]->(e10:DocumentType {name: 'Transmittal', project_number: $oenum})
        MERGE (docIndex)-[:HAS_TYPE]->(e11:DocumentType {name: 'VendorList', project_number: $oenum})
        MERGE (docIndex)-[:HAS_TYPE]->(e12:DocumentType {name: 'VPIS', project_number: $oenum})

        // EKC → OrderList
        MERGE (ekc)-[:HAS_SUBCATEGORY]->(orderList:Category {name: 'OrderList', project_number: $oenum})
        MERGE (orderList)-[:HAS_TYPE]->(o1:DocumentType {name: 'Draft', project_number: $oenum})
        MERGE (orderList)-[:HAS_TYPE]->(o2:DocumentType {name: 'Mto', project_number: $oenum})
        MERGE (orderList)-[:HAS_TYPE]->(o3:DocumentType {name: 'OrderListProforma', project_number: $oenum})

        // EKC → TechnicalCalculation
        MERGE (ekc)-[:HAS_SUBCATEGORY]->(techCalc:Category {name: 'TechnicalCalculation', project_number: $oenum})
        MERGE (techCalc)-[:HAS_TYPE]->(tc1:DocumentType {name: 'Calculation', project_number: $oenum})
        MERGE (techCalc)-[:HAS_TYPE]->(tc2:DocumentType {name: 'DC_AC_Consumption', project_number: $oenum})
        MERGE (techCalc)-[:HAS_TYPE]->(tc3:DocumentType {name: 'HeatDissipation', project_number: $oenum})

        RETURN COUNT(*) as node_count
        """

        result = tx.run(query, oenum=project_oenum)
        result.single()

        # Approximate counts (2 categories + 3 subcategories + 39 types = 44 nodes, 43 relationships)
        return {"nodes": 44, "relationships": 43}

    def _create_drawing_hierarchy(self, tx, project_oenum: str) -> Dict[str, int]:
        """Create Drawing → LV/MV hierarchies"""

        query = """
        MATCH (p:Project {project_number: $oenum})

        // Main Drawing category
        MERGE (p)-[:HAS_CATEGORY]->(draw:Category {name: 'Drawing', project_number: $oenum})

        // LV branch
        MERGE (draw)-[:HAS_SUBCATEGORY]->(lv:Category {name: 'LV', project_number: $oenum})
        MERGE (lv)-[:HAS_TYPE]->(lv1:DrawingType {name: 'Outline', project_number: $oenum})
        MERGE (lv)-[:HAS_TYPE]->(lv2:DrawingType {name: 'Simaris', project_number: $oenum})
        MERGE (lv)-[:HAS_TYPE]->(lv3:DrawingType {name: 'SingleLine', project_number: $oenum})
        MERGE (lv)-[:HAS_TYPE]->(lv4:DrawingType {name: 'Wiring', project_number: $oenum})

        // MV branch
        MERGE (draw)-[:HAS_SUBCATEGORY]->(mv:Category {name: 'MV', project_number: $oenum})
        MERGE (mv)-[:HAS_TYPE]->(mv1:DrawingType {name: 'Outline', project_number: $oenum})
        MERGE (mv)-[:HAS_TYPE]->(mv2:DrawingType {name: 'SingleLine', project_number: $oenum})
        MERGE (mv)-[:HAS_TYPE]->(mv3:DrawingType {name: 'Wiring', project_number: $oenum})

        RETURN COUNT(*) as node_count
        """

        result = tx.run(query, oenum=project_oenum)
        result.single()

        # 1 category + 2 voltage types + 7 drawing types = 10 nodes, 9 relationships
        return {"nodes": 10, "relationships": 9}

    def _create_identity_hierarchy(self, tx, project_oenum: str) -> Dict[str, int]:
        """Create Identity → OE_Revision hierarchy"""

        query = """
        MATCH (p:Project {project_number: $oenum})

        // Identity category
        MERGE (p)-[:HAS_CATEGORY]->(identity:Category {name: 'Identity', project_number: $oenum})
        MERGE (identity)-[:HAS_TYPE]->(rev:IdentityType {name: 'OE_Revision', project_number: $oenum})

        RETURN COUNT(*) as node_count
        """

        result = tx.run(query, oenum=project_oenum)
        result.single()

        # 1 category + 1 type = 2 nodes, 2 relationships
        return {"nodes": 2, "relationships": 2}

    def check_project_initialized(self, project_oenum: str) -> bool:
        """
        Check if project structure has been initialized

        Args:
            project_oenum: Project OENUM

        Returns:
            True if structure exists, False otherwise
        """
        with self.driver.session() as session:
            query = """
            MATCH (p:Project {project_number: $oenum})-[:HAS_CATEGORY]->(cat:Category)
            RETURN count(cat) as category_count
            """
            result = session.run(query, oenum=project_oenum)
            record = result.single()

            # Should have at least 3 main categories (Document, Drawing, Identity)
            return record["category_count"] >= 3 if record else False

    def get_project_structure(self, project_oenum: str) -> Dict[str, Any]:
        """
        Get current project structure statistics

        Args:
            project_oenum: Project OENUM

        Returns:
            Structure statistics
        """
        with self.driver.session() as session:
            query = """
            MATCH (p:Project {project_number: $oenum})
            OPTIONAL MATCH (p)-[:HAS_CATEGORY]->(cat:Category)
            OPTIONAL MATCH (cat)-[:HAS_SUBCATEGORY|HAS_TYPE*1..2]->(node)
            RETURN
                p.project_number as oenum,
                p.project_name as name,
                count(DISTINCT cat) as categories,
                count(DISTINCT node) as total_types
            """
            result = session.run(query, oenum=project_oenum)
            record = result.single()

            if record:
                return {
                    "oenum": record["oenum"],
                    "name": record["name"],
                    "categories": record["categories"],
                    "total_types": record["total_types"],
                    "initialized": record["categories"] >= 3
                }
            else:
                return {
                    "oenum": project_oenum,
                    "initialized": False
                }

    def add_document_to_structure(
        self,
        project_oenum: str,
        category: str,  # 'Client' or 'Ekc'
        doc_type: str,  # e.g., 'Spec', 'DataSheet'
        document_id: str,
        document_metadata: Dict[str, Any]
    ) -> bool:
        """
        Add a document node to the project structure

        Args:
            project_oenum: Project OENUM
            category: Main category (Client/Ekc)
            doc_type: Document type
            document_id: Unique document identifier
            document_metadata: Additional document metadata

        Returns:
            Success boolean
        """
        with self.driver.session() as session:
            query = """
            MATCH (p:Project {project_number: $oenum})
            MATCH (p)-[:HAS_CATEGORY]->(:Category {name: 'Document'})-[:HAS_SUBCATEGORY*0..1]->(cat:Category)
            MATCH (cat)-[:HAS_TYPE]->(type:DocumentType {name: $doc_type})
            WHERE cat.name = $category OR cat.name = 'DocumentIndex' OR cat.name = 'OrderList' OR cat.name = 'TechnicalCalculation'

            MERGE (doc:Document {id: $doc_id, project_number: $oenum})
            SET doc += $metadata
            SET doc.indexed_at = datetime()

            MERGE (type)-[:HAS_DOCUMENT]->(doc)
            MERGE (doc)-[:BELONGS_TO_PROJECT]->(p)

            RETURN doc
            """

            try:
                result = session.run(query,
                    oenum=project_oenum,
                    category=category,
                    doc_type=doc_type,
                    doc_id=document_id,
                    metadata=document_metadata
                )
                record = result.single()
                return record is not None

            except Exception as e:
                logger.error(f"❌ Failed to add document: {e}")
                return False

    def add_spec_structure_to_document(
        self,
        project_oenum: str,
        document_id: str,
        specifications: Dict[str, Dict[str, str]]
    ) -> bool:
        """
        Add detailed specification structure to a Spec document

        Creates 13 category nodes linked to the document, each with their specific fields.

        Args:
            project_oenum: Project OENUM
            document_id: Document node ID
            specifications: Extracted specifications data

        Returns:
            Success boolean
        """
        logger.info(f"📊 Adding spec structure to document {document_id}")

        with self.driver.session() as session:
            try:
                # Create spec structure for each category
                for category_name, fields in specifications.items():
                    self._create_spec_category(
                        session,
                        project_oenum,
                        document_id,
                        category_name,
                        fields
                    )

                logger.info(f"✅ Spec structure added: {len(specifications)} categories")
                return True

            except Exception as e:
                logger.error(f"❌ Failed to add spec structure: {e}")
                return False

    def _create_spec_category(
        self,
        session,
        project_oenum: str,
        document_id: str,
        category_name: str,
        fields: Dict[str, str]
    ):
        """Create a specification category with its fields, extraction guides, and values"""

        # Import extraction guides
        from services.extraction_guides_data import get_extraction_guide

        # First create the category node
        query_category = """
        MATCH (doc:Document {id: $doc_id, project_number: $oenum})

        MERGE (cat:SpecCategory {
            name: $category_name,
            document_id: $doc_id,
            project_number: $oenum
        })

        MERGE (doc)-[:HAS_SPEC_CATEGORY]->(cat)

        RETURN cat
        """

        session.run(
            query_category,
            doc_id=document_id,
            oenum=project_oenum,
            category_name=category_name
        )

        # Then create field nodes with extraction guides and actual values
        for field_name, field_value in fields.items():
            # Get extraction guide for this field
            guide_data = get_extraction_guide(category_name, field_name)

            query_field = """
            MATCH (cat:SpecCategory {
                name: $category_name,
                document_id: $doc_id,
                project_number: $oenum
            })

            // Create SpecField node
            MERGE (field:SpecField {
                name: $field_name,
                category_name: $category_name,
                document_id: $doc_id,
                project_number: $oenum
            })
            SET field.updated_at = datetime()

            MERGE (cat)-[:HAS_FIELD]->(field)

            // Create ExtractionGuide node for this field
            MERGE (field)-[:HAS_EXTRACTION_GUIDE]->(guide:ExtractionGuide {
                field_name: $field_name,
                category_name: $category_name,
                document_id: $doc_id,
                project_number: $oenum
            })
            SET guide.definition = $definition,
                guide.extraction_instructions = $instructions,
                guide.examples = $examples,
                guide.common_values = $common_values,
                guide.relationships = $relationships,
                guide.notes = $notes,
                guide.updated_at = datetime()

            // Create ActualValue node for extracted value
            MERGE (field)-[:HAS_VALUE]->(value:ActualValue {
                field_name: $field_name,
                category_name: $category_name,
                document_id: $doc_id,
                project_number: $oenum
            })
            SET value.extracted_value = $field_value,
                value.extraction_method = 'enhanced_rag',
                value.updated_at = datetime()

            RETURN field
            """

            session.run(
                query_field,
                doc_id=document_id,
                oenum=project_oenum,
                category_name=category_name,
                field_name=field_name,
                field_value=field_value,
                definition=guide_data.get("definition", "") if guide_data else "",
                instructions=guide_data.get("extraction_instructions", "") if guide_data else "",
                examples=guide_data.get("examples", "") if guide_data else "",
                common_values=guide_data.get("common_values", "") if guide_data else "",
                relationships=guide_data.get("relationships", "") if guide_data else "",
                notes=guide_data.get("notes", "") if guide_data else ""
            )

    def get_spec_structure(
        self,
        project_oenum: str,
        document_id: str
    ) -> Optional[Dict[str, Dict[str, str]]]:
        """
        Retrieve specification structure for a document

        Args:
            project_oenum: Project OENUM
            document_id: Document ID

        Returns:
            Specification data or None if not found
        """
        with self.driver.session() as session:
            query = """
            MATCH (doc:Document {id: $doc_id, project_number: $oenum})
                -[:HAS_SPEC_CATEGORY]->(cat:SpecCategory)
                -[:HAS_FIELD]->(field:SpecField)
            OPTIONAL MATCH (field)-[:HAS_VALUE]->(value:ActualValue)

            RETURN cat.name as category,
                   field.name as field_name,
                   value.extracted_value as field_value
            ORDER BY cat.name, field.name
            """

            try:
                result = session.run(query, doc_id=document_id, oenum=project_oenum)

                # Build nested structure
                specs = {}
                for record in result:
                    category = record["category"]
                    field_name = record["field_name"]
                    field_value = record["field_value"] or ""

                    if category not in specs:
                        specs[category] = {}

                    specs[category][field_name] = field_value

                return specs if specs else None

            except Exception as e:
                logger.error(f"❌ Failed to retrieve spec structure: {e}")
                return None

    def update_spec_field(
        self,
        project_oenum: str,
        document_id: str,
        category_name: str,
        field_name: str,
        new_value: str
    ) -> bool:
        """
        Update a single specification field value

        Args:
            project_oenum: Project OENUM
            document_id: Document ID
            category_name: Category name
            field_name: Field name
            new_value: New field value

        Returns:
            Success boolean
        """
        with self.driver.session() as session:
            query = """
            MATCH (field:SpecField {
                name: $field_name,
                category_name: $category_name,
                document_id: $doc_id,
                project_number: $oenum
            })-[:HAS_VALUE]->(value:ActualValue)

            SET value.extracted_value = $new_value,
                value.updated_at = datetime(),
                value.manually_edited = true,
                value.extraction_method = 'manual_review'

            RETURN value
            """

            try:
                result = session.run(
                    query,
                    doc_id=document_id,
                    oenum=project_oenum,
                    category_name=category_name,
                    field_name=field_name,
                    new_value=new_value
                )
                return result.single() is not None

            except Exception as e:
                logger.error(f"❌ Failed to update spec field: {e}")
                return False

    def update_spec_structure(
        self,
        project_oenum: str,
        document_id: str,
        specifications: Dict[str, Dict[str, str]]
    ) -> bool:
        """
        Bulk update specification structure

        Args:
            project_oenum: Project OENUM
            document_id: Document ID
            specifications: Complete specification data

        Returns:
            Success boolean
        """
        logger.info(f"📝 Updating spec structure for document {document_id}")

        with self.driver.session() as session:
            try:
                for category_name, fields in specifications.items():
                    for field_name, field_value in fields.items():
                        query = """
                        MATCH (field:SpecField {
                            name: $field_name,
                            category_name: $category_name,
                            document_id: $doc_id,
                            project_number: $oenum
                        })-[:HAS_VALUE]->(value:ActualValue)

                        SET value.extracted_value = $new_value,
                            value.updated_at = datetime(),
                            value.reviewed = true,
                            value.extraction_method = 'manual_review'

                        RETURN value
                        """

                        session.run(
                            query,
                            doc_id=document_id,
                            oenum=project_oenum,
                            category_name=category_name,
                            field_name=field_name,
                            new_value=field_value
                        )

                logger.info(f"✅ Spec structure updated successfully")
                return True

            except Exception as e:
                logger.error(f"❌ Failed to update spec structure: {e}")
                return False

    def add_extraction_guide_to_field(
        self,
        project_oenum: str,
        document_id: str,
        category_name: str,
        field_name: str,
        guide_content: Dict[str, str]
    ) -> bool:
        """
        Add an extraction guide node to a specification field

        Args:
            project_oenum: Project OENUM
            document_id: Document ID
            category_name: Spec category name
            field_name: Spec field name
            guide_content: Guide content with keys:
                - definition: Field definition and purpose
                - extraction_instructions: How to extract this value
                - examples: Example values
                - common_values: Common/standard values
                - relationships: Related fields
                - notes: Additional notes

        Returns:
            Success boolean
        """
        with self.driver.session() as session:
            query = """
            MATCH (field:SpecField {
                name: $field_name,
                category_name: $category_name,
                document_id: $doc_id,
                project_number: $oenum
            })

            MERGE (guide:ExtractionGuide {
                field_name: $field_name,
                category_name: $category_name,
                project_number: $oenum
            })
            SET guide.definition = $definition,
                guide.extraction_instructions = $instructions,
                guide.examples = $examples,
                guide.common_values = $common_values,
                guide.relationships = $relationships,
                guide.notes = $notes,
                guide.updated_at = datetime()

            MERGE (field)-[:HAS_EXTRACTION_GUIDE]->(guide)

            RETURN guide
            """

            try:
                result = session.run(
                    query,
                    doc_id=document_id,
                    oenum=project_oenum,
                    category_name=category_name,
                    field_name=field_name,
                    definition=guide_content.get("definition", ""),
                    instructions=guide_content.get("extraction_instructions", ""),
                    examples=guide_content.get("examples", ""),
                    common_values=guide_content.get("common_values", ""),
                    relationships=guide_content.get("relationships", ""),
                    notes=guide_content.get("notes", "")
                )

                logger.info(f"✅ Added extraction guide for {category_name}.{field_name}")
                return result.single() is not None

            except Exception as e:
                logger.error(f"❌ Failed to add extraction guide: {e}")
                return False

    def get_extraction_guide(
        self,
        project_oenum: str,
        category_name: str,
        field_name: str
    ) -> Optional[Dict[str, str]]:
        """
        Get extraction guide for a specific field

        Args:
            project_oenum: Project OENUM
            category_name: Spec category name
            field_name: Spec field name

        Returns:
            Extraction guide content or None
        """
        with self.driver.session() as session:
            query = """
            MATCH (guide:ExtractionGuide {
                field_name: $field_name,
                category_name: $category_name,
                project_number: $oenum
            })

            RETURN guide.definition as definition,
                   guide.extraction_instructions as instructions,
                   guide.examples as examples,
                   guide.common_values as common_values,
                   guide.relationships as relationships,
                   guide.notes as notes
            """

            try:
                result = session.run(
                    query,
                    oenum=project_oenum,
                    category_name=category_name,
                    field_name=field_name
                )

                record = result.single()
                if record:
                    return {
                        "definition": record["definition"] or "",
                        "extraction_instructions": record["instructions"] or "",
                        "examples": record["examples"] or "",
                        "common_values": record["common_values"] or "",
                        "relationships": record["relationships"] or "",
                        "notes": record["notes"] or ""
                    }
                return None

            except Exception as e:
                logger.error(f"❌ Failed to get extraction guide: {e}")
                return None

    def initialize_all_extraction_guides(
        self,
        project_oenum: str,
        guides_data: Dict[str, Dict[str, Dict[str, str]]]
    ) -> Dict[str, int]:
        """
        Initialize all extraction guides for a project

        Args:
            project_oenum: Project OENUM
            guides_data: Nested dictionary structure:
                {
                    "category_name": {
                        "field_name": {
                            "definition": "...",
                            "extraction_instructions": "...",
                            "examples": "...",
                            "common_values": "...",
                            "relationships": "...",
                            "notes": "..."
                        }
                    }
                }

        Returns:
            Statistics about created guides
        """
        logger.info(f"📚 Initializing extraction guides for project {project_oenum}")

        stats = {
            "guides_created": 0,
            "guides_failed": 0,
            "categories_processed": 0
        }

        for category_name, fields in guides_data.items():
            for field_name, guide_content in fields.items():
                # Create guide node (not linked to specific document yet)
                success = self._create_standalone_extraction_guide(
                    project_oenum,
                    category_name,
                    field_name,
                    guide_content
                )

                if success:
                    stats["guides_created"] += 1
                else:
                    stats["guides_failed"] += 1

            stats["categories_processed"] += 1

        logger.info(f"✅ Extraction guides initialized: {stats}")
        return stats

    def _create_standalone_extraction_guide(
        self,
        project_oenum: str,
        category_name: str,
        field_name: str,
        guide_content: Dict[str, str]
    ) -> bool:
        """
        Create standalone extraction guide (not linked to specific document)

        These guides are project-level resources that can be linked to any
        spec document field of the same type.
        """
        with self.driver.session() as session:
            query = """
            MATCH (p:Project {project_number: $oenum})

            MERGE (guide:ExtractionGuide {
                field_name: $field_name,
                category_name: $category_name,
                project_number: $oenum
            })
            SET guide.definition = $definition,
                guide.extraction_instructions = $instructions,
                guide.examples = $examples,
                guide.common_values = $common_values,
                guide.relationships = $relationships,
                guide.notes = $notes,
                guide.created_at = datetime(),
                guide.is_template = true

            MERGE (p)-[:HAS_EXTRACTION_GUIDE]->(guide)

            RETURN guide
            """

            try:
                result = session.run(
                    query,
                    oenum=project_oenum,
                    category_name=category_name,
                    field_name=field_name,
                    definition=guide_content.get("definition", ""),
                    instructions=guide_content.get("extraction_instructions", ""),
                    examples=guide_content.get("examples", ""),
                    common_values=guide_content.get("common_values", ""),
                    relationships=guide_content.get("relationships", ""),
                    notes=guide_content.get("notes", "")
                )

                return result.single() is not None

            except Exception as e:
                logger.error(f"❌ Failed to create extraction guide: {e}")
                return False

    def link_extraction_guides_to_document(
        self,
        project_oenum: str,
        document_id: str
    ) -> int:
        """
        Link all project-level extraction guides to a spec document's fields

        This creates relationships between the document's SpecField nodes
        and the corresponding ExtractionGuide template nodes.

        Args:
            project_oenum: Project OENUM
            document_id: Document ID

        Returns:
            Number of links created
        """
        with self.driver.session() as session:
            query = """
            MATCH (doc:Document {id: $doc_id, project_number: $oenum})
                -[:HAS_SPEC_CATEGORY]->(cat:SpecCategory)
                -[:HAS_FIELD]->(field:SpecField)

            MATCH (guide:ExtractionGuide {
                field_name: field.name,
                category_name: cat.name,
                project_number: $oenum,
                is_template: true
            })

            MERGE (field)-[:HAS_EXTRACTION_GUIDE]->(guide)

            RETURN count(field) as links_created
            """

            try:
                result = session.run(query, doc_id=document_id, oenum=project_oenum)
                record = result.single()
                links_count = record["links_created"] if record else 0

                logger.info(f"✅ Linked {links_count} extraction guides to document {document_id}")
                return links_count

            except Exception as e:
                logger.error(f"❌ Failed to link extraction guides: {e}")
                return 0
