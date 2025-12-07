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
