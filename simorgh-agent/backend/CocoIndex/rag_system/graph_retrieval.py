"""
Graph Retrieval Engine for Industrial Electrical RAG System

This module provides intelligent graph traversal for retrieving relevant context
based on user queries. It uses intent classification and entity recognition to
determine which graph patterns to execute.
"""

from neo4j import GraphDatabase
from typing import List, Dict, Any, Optional
import openai
import os
import json

class GraphRetrieval:
    """
    Intelligent graph retrieval using Neo4j for RAG system.
    Supports multiple query patterns for different question types.
    """
    
    def __init__(self, neo4j_uri: str = "bolt://localhost:7687",
                 neo4j_user: str = "neo4j",
                 neo4j_password: str = "cocoindex"):
        """Initialize Neo4j connection"""
        self.driver = GraphDatabase.driver(neo4j_uri, auth=(neo4j_user, neo4j_password))
        self.openai_client = openai.OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
    
    def close(self):
        """Close Neo4j connection"""
        self.driver.close()
    
    # ========================================================================
    # INTENT CLASSIFICATION & ENTITY RECOGNITION
    # ========================================================================
    
    def classify_intent(self, question: str) -> Dict[str, Any]:
        """
        Classify user question intent and extract entities.
        
        Returns:
        {
            "intent": str,  # "equipment_spec", "load_tracing", "circuit_topology", etc.
            "entities": list,  # Extracted entity mentions
            "confidence": float
        }
        """
        
        response = self.openai_client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{
                "role": "system",
                "content": """You are an expert at analyzing questions about industrial electrical systems.
                
                Classify questions into these intent categories:
                
                1. "equipment_spec" - Questions about equipment specifications, ratings, properties
                   Examples: "What's the voltage of Panel MDB-01?", "Show specs for Transformer TR-01"
                
                2. "load_tracing" - Questions about which panel/circuit feeds a load
                   Examples: "Which panel feeds Load ABC-123?", "What supplies power to Motor M-01?"
                
                3. "circuit_topology" - Questions about circuits from a panel, circuit details
                   Examples: "Show all circuits from Panel MCC-02", "List circuits in Building A"
                
                4. "equipment_location" - Questions about where equipment is located
                   Examples: "Where is Transformer TR-01?", "What equipment is in Room 101?"
                
                5. "compliance_check" - Questions about standards compliance, requirements
                   Examples: "Does the switchgear comply with IEC 62271?", "What standards apply?"
                
                6. "power_flow" - Questions about power distribution path
                   Examples: "Trace power from transformer to load", "Show power flow for Building A"
                
                7. "io_mapping" - Questions about control points, IO lists
                   Examples: "What does IO point DI-101 monitor?", "Show all IO for Panel PLC-01"
                
                8. "cross_reference" - Questions needing info from multiple documents
                   Examples: "Find all information about Transformer TR-01", "Aggregate specs for all motors"
                
                9. "proximity_search" - Questions about equipment in a location
                   Examples: "What's in Building A?", "List all panels in Room MV-101"
                
                10. "comparison" - Compare equipment or specifications
                    Examples: "Compare voltage ratings of all transformers", "Which panel has highest rating?"
                
                Also extract:
                - All entity mentions (equipment IDs, panel numbers, locations, etc.)
                - Entity types (Panel, Load, Transformer, Circuit, etc.)
                
                Respond with ONLY valid JSON:
                {
                    "intent": "intent_category",
                    "entities": [
                        {"text": "MDB-01", "type": "Panel"},
                        {"text": "Building A", "type": "Building"}
                    ],
                    "confidence": 0.95
                }
                """
            }, {
                "role": "user",
                "content": f"Classify this question: {question}"
            }],
            temperature=0.0
        )
        
        result = json.loads(response.choices[0].message.content)
        return result
    
    # ========================================================================
    # QUERY PATTERN EXECUTORS
    # ========================================================================
    
    def get_equipment_spec(self, equipment_id: str, equipment_type: str = None) -> Dict[str, Any]:
        """
        Pattern 1: Get complete specifications for equipment.
        
        Returns all parameters, location, standards, and source documents.
        """
        
        with self.driver.session() as session:
            query = """
            // Find equipment (flexible matching)
            MATCH (e)
            WHERE toLower(e.panel_id) CONTAINS toLower($id)
               OR toLower(e.transformer_id) CONTAINS toLower($id)
               OR toLower(e.switchgear_id) CONTAINS toLower($id)
               OR toLower(e.motor_id) CONTAINS toLower($id)
               OR toLower(e.name) CONTAINS toLower($id)
            
            // Get parameters
            OPTIONAL MATCH (e)-[:HAS_PARAMETER]->(p:Parameter)
            
            // Get location
            OPTIONAL MATCH (e)-[:LOCATED_IN]->(room:Room)-[:PART_OF]->(building:Building)
            
            // Get standards
            OPTIONAL MATCH (e)-[:COMPLIES_WITH]->(std:Standard)
            
            // Get source documents
            OPTIONAL MATCH (doc:Document)-[:DESCRIBES]->(e)
            
            RETURN 
                e AS equipment,
                labels(e)[0] AS equipment_type,
                COLLECT(DISTINCT {name: p.name, value: p.value, unit: p.unit, tolerance: p.tolerance}) AS parameters,
                COLLECT(DISTINCT {room: room.name, building: building.name}) AS location,
                COLLECT(DISTINCT std.standard_id) AS standards,
                COLLECT(DISTINCT {filename: doc.filename, title: doc.title}) AS source_documents
            LIMIT 1
            """
            
            result = session.run(query, id=equipment_id)
            record = result.single()
            
            if not record:
                return {"error": f"Equipment '{equipment_id}' not found"}
            
            return {
                "equipment": dict(record["equipment"]),
                "equipment_type": record["equipment_type"],
                "parameters": [p for p in record["parameters"] if p['name']],
                "location": record["location"][0] if record["location"] else None,
                "standards": record["standards"],
                "source_documents": record["source_documents"]
            }
    
    def trace_load_power(self, load_id: str) -> Dict[str, Any]:
        """
        Pattern 2: Trace which panel/circuit feeds a load.
        
        Returns complete power path from source to load.
        """
        
        with self.driver.session() as session:
            query = """
            // Find load
            MATCH (load:Load)
            WHERE toLower(load.load_id) CONTAINS toLower($load_id)
               OR toLower(load.load_name) CONTAINS toLower($load_id)
            
            // Trace to feeding circuit
            OPTIONAL MATCH (circuit:Circuit)-[:SUPPLIES]->(load)
            
            // Trace to source panel
            OPTIONAL MATCH (panel:Panel)-[:ORIGINATES_CIRCUIT]->(circuit)
            
            // Trace upstream power source
            OPTIONAL MATCH (upstream)<-[:FED_FROM|SUPPLIED_BY*1..3]-(panel)
            
            // Get protection device
            OPTIONAL MATCH (circuit)-[:PROTECTED_BY]->(breaker:CircuitBreaker)
            
            RETURN 
                load,
                circuit,
                panel,
                COLLECT(DISTINCT upstream) AS power_source,
                breaker,
                [(load)<-[r:SUPPLIES|FEEDS|FED_FROM|SUPPLIED_BY*1..5]-(source) | 
                 {node: source, relationship: type(r)}] AS power_path
            LIMIT 1
            """
            
            result = session.run(query, load_id=load_id)
            record = result.single()
            
            if not record:
                return {"error": f"Load '{load_id}' not found"}
            
            return {
                "load": dict(record["load"]),
                "circuit": dict(record["circuit"]) if record["circuit"] else None,
                "panel": dict(record["panel"]) if record["panel"] else None,
                "power_source": [dict(ps) for ps in record["power_source"]],
                "breaker": dict(record["breaker"]) if record["breaker"] else None,
                "power_path": record["power_path"]
            }
    
    def get_panel_circuits(self, panel_id: str) -> Dict[str, Any]:
        """
        Pattern 3: Get all circuits from a panel.
        
        Returns all circuits, their loads, and protection devices.
        """
        
        with self.driver.session() as session:
            query = """
            // Find panel
            MATCH (panel:Panel)
            WHERE toLower(panel.panel_id) CONTAINS toLower($panel_id)
            
            // Get all circuits
            MATCH (panel)-[:ORIGINATES_CIRCUIT]->(circuit:Circuit)
            
            // Get loads fed by each circuit
            OPTIONAL MATCH (circuit)-[:SUPPLIES]->(load:Load)
            
            // Get protection device
            OPTIONAL MATCH (circuit)-[:PROTECTED_BY]->(breaker:CircuitBreaker)
            
            // Get cable
            OPTIONAL MATCH (circuit)-[:USES_CABLE]->(cable:Cable)
            
            RETURN 
                panel,
                COLLECT(DISTINCT {
                    circuit: circuit,
                    loads: COLLECT(DISTINCT load),
                    breaker: breaker,
                    cable: cable
                }) AS circuits
            LIMIT 1
            """
            
            result = session.run(query, panel_id=panel_id)
            record = result.single()
            
            if not record:
                return {"error": f"Panel '{panel_id}' not found"}
            
            return {
                "panel": dict(record["panel"]),
                "circuits": [{
                    "circuit": dict(c["circuit"]),
                    "loads": [dict(l) for l in c["loads"] if l],
                    "breaker": dict(c["breaker"]) if c["breaker"] else None,
                    "cable": dict(c["cable"]) if c["cable"] else None
                } for c in record["circuits"]]
            }
    
    def get_equipment_by_location(self, location: str) -> Dict[str, Any]:
        """
        Pattern 4: Find all equipment in a location (building/room).
        
        Returns all equipment in the specified location.
        """
        
        with self.driver.session() as session:
            query = """
            // Find location (room or building)
            MATCH (loc)
            WHERE (loc:Room OR loc:Building OR loc:Site)
              AND (toLower(loc.name) CONTAINS toLower($location)
                OR toLower(loc.room_id) CONTAINS toLower($location)
                OR toLower(loc.building_id) CONTAINS toLower($location))
            
            // Get all equipment in this location
            MATCH (equipment)-[:LOCATED_IN|INSTALLED_IN|HOUSED_IN]->(loc)
            
            // Get equipment parameters
            OPTIONAL MATCH (equipment)-[:HAS_PARAMETER]->(param:Parameter)
            
            RETURN 
                loc,
                labels(loc)[0] AS location_type,
                COLLECT(DISTINCT {
                    equipment: equipment,
                    type: labels(equipment)[0],
                    parameters: COLLECT(DISTINCT {name: param.name, value: param.value, unit: param.unit})
                }) AS equipment_list
            LIMIT 1
            """
            
            result = session.run(query, location=location)
            record = result.single()
            
            if not record:
                return {"error": f"Location '{location}' not found"}
            
            return {
                "location": dict(record["loc"]),
                "location_type": record["location_type"],
                "equipment": [{
                    "equipment": dict(e["equipment"]),
                    "type": e["type"],
                    "parameters": [p for p in e["parameters"] if p["name"]]
                } for e in record["equipment_list"]]
            }
    
    def check_compliance(self, equipment_id: str = None, standard_id: str = None) -> Dict[str, Any]:
        """
        Pattern 5: Check standards compliance.
        
        Can query by equipment or by standard.
        """
        
        with self.driver.session() as session:
            if equipment_id:
                query = """
                MATCH (equipment)
                WHERE toLower(equipment.panel_id) CONTAINS toLower($id)
                   OR toLower(equipment.name) CONTAINS toLower($id)
                
                MATCH (equipment)-[:COMPLIES_WITH]->(std:Standard)
                
                OPTIONAL MATCH (equipment)-[:HAS_PARAMETER]->(param:Parameter)
                WHERE param.parameter_type = 'Requirement'
                
                RETURN 
                    equipment,
                    labels(equipment)[0] AS equipment_type,
                    COLLECT(DISTINCT std) AS standards,
                    COLLECT(DISTINCT param) AS requirements
                """
                result = session.run(query, id=equipment_id)
            
            else:  # Query by standard
                query = """
                MATCH (std:Standard)
                WHERE toLower(std.standard_id) CONTAINS toLower($std_id)
                
                MATCH (equipment)-[:COMPLIES_WITH]->(std)
                
                RETURN 
                    std,
                    COLLECT(DISTINCT {
                        equipment: equipment,
                        type: labels(equipment)[0]
                    }) AS compliant_equipment
                """
                result = session.run(query, std_id=standard_id)
            
            record = result.single()
            
            if not record:
                return {"error": "No compliance information found"}
            
            if equipment_id:
                return {
                    "equipment": dict(record["equipment"]),
                    "equipment_type": record["equipment_type"],
                    "standards": [dict(s) for s in record["standards"]],
                    "requirements": [dict(r) for r in record["requirements"]]
                }
            else:
                return {
                    "standard": dict(record["std"]),
                    "compliant_equipment": [{
                        "equipment": dict(e["equipment"]),
                        "type": e["type"]
                    } for e in record["compliant_equipment"]]
                }
    
    def get_io_mapping(self, io_id: str = None, panel_id: str = None) -> Dict[str, Any]:
        """
        Pattern 6: Get IO point mappings.
        
        Can query by IO point or by panel.
        """
        
        with self.driver.session() as session:
            if io_id:
                query = """
                MATCH (io:IOPoint)
                WHERE toLower(io.io_id) CONTAINS toLower($id)
                   OR toLower(io.tag_number) CONTAINS toLower($id)
                
                OPTIONAL MATCH (io)-[:MONITORS|CONTROLS]->(equipment)
                
                OPTIONAL MATCH (io)-[:LOCATED_IN]->(panel:Panel)
                
                RETURN 
                    io,
                    equipment,
                    labels(equipment)[0] AS equipment_type,
                    panel
                """
                result = session.run(query, id=io_id)
            else:
                query = """
                MATCH (panel:Panel)
                WHERE toLower(panel.panel_id) CONTAINS toLower($panel_id)
                
                MATCH (io:IOPoint)-[:LOCATED_IN]->(panel)
                
                OPTIONAL MATCH (io)-[:MONITORS|CONTROLS]->(equipment)
                
                RETURN 
                    panel,
                    COLLECT(DISTINCT {
                        io: io,
                        equipment: equipment,
                        equipment_type: labels(equipment)[0]
                    }) AS io_points
                """
                result = session.run(query, panel_id=panel_id)
            
            record = result.single()
            
            if not record:
                return {"error": "IO point not found"}
            
            if io_id:
                return {
                    "io_point": dict(record["io"]),
                    "equipment": dict(record["equipment"]) if record["equipment"] else None,
                    "equipment_type": record["equipment_type"],
                    "panel": dict(record["panel"]) if record["panel"] else None
                }
            else:
                return {
                    "panel": dict(record["panel"]),
                    "io_points": [{
                        "io": dict(p["io"]),
                        "equipment": dict(p["equipment"]) if p["equipment"] else None,
                        "equipment_type": p["equipment_type"]
                    } for p in record["io_points"]]
                }
    
    def cross_reference_equipment(self, equipment_id: str) -> Dict[str, Any]:
        """
        Pattern 7: Find all information from multiple documents.
        
        Aggregates info from specs, datasheets, site layouts, etc.
        """
        
        with self.driver.session() as session:
            query = """
            // Find equipment
            MATCH (equipment)
            WHERE toLower(equipment.panel_id) CONTAINS toLower($id)
               OR toLower(equipment.transformer_id) CONTAINS toLower($id)
               OR toLower(equipment.name) CONTAINS toLower($id)
            
            // Get all related documents
            MATCH (doc:Document)-[r:DESCRIBES|REFERENCES|SPECIFIES]->(equipment)
            
            // Get all information
            OPTIONAL MATCH (equipment)-[:HAS_PARAMETER]->(param:Parameter)
            OPTIONAL MATCH (equipment)-[:LOCATED_IN]->(loc)
            OPTIONAL MATCH (equipment)-[:COMPLIES_WITH]->(std:Standard)
            OPTIONAL MATCH (equipment)-[:HAS_COMPONENT]->(comp:Component)
            OPTIONAL MATCH (equipment)-[:REQUIRES]->(req:Requirement)
            
            // Get power connections
            OPTIONAL MATCH (equipment)-[:SUPPLIES|FEEDS|FED_FROM]-(connected)
            
            RETURN 
                equipment,
                labels(equipment)[0] AS equipment_type,
                COLLECT(DISTINCT {
                    document: doc,
                    document_type: doc.document_type,
                    relationship: type(r)
                }) AS documents,
                COLLECT(DISTINCT param) AS parameters,
                COLLECT(DISTINCT loc) AS locations,
                COLLECT(DISTINCT std) AS standards,
                COLLECT(DISTINCT comp) AS components,
                COLLECT(DISTINCT req) AS requirements,
                COLLECT(DISTINCT {
                    node: connected,
                    type: labels(connected)[0]
                }) AS connections
            """
            
            result = session.run(query, id=equipment_id)
            record = result.single()
            
            if not record:
                return {"error": f"Equipment '{equipment_id}' not found"}
            
            return {
                "equipment": dict(record["equipment"]),
                "equipment_type": record["equipment_type"],
                "documents": [{
                    "document": dict(d["document"]),
                    "document_type": d["document_type"],
                    "relationship": d["relationship"]
                } for d in record["documents"]],
                "parameters": [dict(p) for p in record["parameters"] if p],
                "locations": [dict(l) for l in record["locations"] if l],
                "standards": [dict(s) for s in record["standards"]],
                "components": [dict(c) for c in record["components"]],
                "requirements": [dict(r) for r in record["requirements"]],
                "connections": record["connections"]
            }
    
    # ========================================================================
    # MAIN RETRIEVAL INTERFACE
    # ========================================================================
    
    def retrieve(self, question: str) -> Dict[str, Any]:
        """
        Main retrieval method. Automatically classifies intent and retrieves relevant context.
        
        Args:
            question: User's natural language question
            
        Returns:
            Dictionary containing:
            - intent: Classified intent
            - entities: Extracted entities
            - context: Retrieved graph context
            - citations: Source documents
        """
        
        # Step 1: Classify intent and extract entities
        classification = self.classify_intent(question)
        intent = classification["intent"]
        entities = classification["entities"]
        
        # Step 2: Execute appropriate query pattern
        context = {}
        
        if intent == "equipment_spec" and entities:
            # Get equipment specs
            equipment = entities[0]["text"]
            context = self.get_equipment_spec(equipment)
        
        elif intent == "load_tracing" and entities:
            # Trace load power
            load = entities[0]["text"]
            context = self.trace_load_power(load)
        
        elif intent == "circuit_topology" and entities:
            # Get panel circuits
            panel = entities[0]["text"]
            context = self.get_panel_circuits(panel)
        
        elif intent == "equipment_location" and entities:
            # Get equipment by location
            location = entities[0]["text"]
            context = self.get_equipment_by_location(location)
        
        elif intent == "compliance_check" and entities:
            # Check compliance
            entity = entities[0]["text"]
            entity_type = entities[0].get("type", "")
            
            if "Standard" in entity_type or "IEC" in entity or "IEEE" in entity:
                context = self.check_compliance(standard_id=entity)
            else:
                context = self.check_compliance(equipment_id=entity)
        
        elif intent == "io_mapping" and entities:
            # Get IO mapping
            entity = entities[0]["text"]
            if "Panel" in entities[0].get("type", ""):
                context = self.get_io_mapping(panel_id=entity)
            else:
                context = self.get_io_mapping(io_id=entity)
        
        elif intent == "cross_reference" and entities:
            # Cross-reference multiple documents
            equipment = entities[0]["text"]
            context = self.cross_reference_equipment(equipment)
        
        else:
            context = {"error": "Intent not recognized or no entities found"}
        
        # Step 3: Extract citations
        citations = []
        if "source_documents" in context:
            citations = context["source_documents"]
        elif "documents" in context:
            citations = [d["document"] for d in context["documents"]]
        
        return {
            "intent": intent,
            "entities": entities,
            "context": context,
            "citations": citations,
            "raw_question": question
        }


# ============================================================================
# EXAMPLE USAGE
# ============================================================================

if __name__ == "__main__":
    # Initialize retrieval engine
    retrieval = GraphRetrieval()
    
    # Example queries
    questions = [
        "What are the specs of Panel MDB-01?",
        "Which panel feeds Load ABC-123?",
        "Show all circuits from Panel MCC-02",
        "What equipment is in Building A Room 101?",
        "Does the switchgear comply with IEC 62271?"
    ]
    
    for question in questions:
        print(f"\n{'='*80}")
        print(f"Question: {question}")
        print(f"{'='*80}")
        
        result = retrieval.retrieve(question)
        
        print(f"\nIntent: {result['intent']}")
        print(f"Entities: {result['entities']}")
        print(f"\nContext retrieved:")
        print(json.dumps(result['context'], indent=2))
        print(f"\nCitations: {result['citations']}")
    
    retrieval.close()