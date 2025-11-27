from dotenv import load_dotenv
import dataclasses
from typing import Optional, List
import cocoindex

# Load environment variables
load_dotenv(override=True)

# ============================================================================
# COMPLETE DATA MODELS FOR INDUSTRIAL ELECTRICAL DOMAIN
# ============================================================================

@dataclasses.dataclass
class DocumentMetadata:
    """Complete document metadata"""
    title: str
    summary: str
    document_type: str  # "Specification", "Datasheet", "IO List", "Load List", "Site Layout", "SLD"
    project: Optional[str] = None
    document_number: Optional[str] = None
    revision: Optional[str] = None
    date: Optional[str] = None

@dataclasses.dataclass
class Project:
    """Project information"""
    name: str
    project_id: Optional[str] = None
    location: Optional[str] = None
    client: Optional[str] = None

@dataclasses.dataclass
class Site:
    """Site or facility"""
    name: str
    site_id: Optional[str] = None
    location: Optional[str] = None

@dataclasses.dataclass
class Building:
    """Building within a site"""
    name: str
    building_id: Optional[str] = None
    area: Optional[str] = None

@dataclasses.dataclass
class Room:
    """Room or zone within building"""
    name: str
    room_id: Optional[str] = None
    function: Optional[str] = None

@dataclasses.dataclass
class Panel:
    """Electrical panel/distribution board"""
    panel_id: str
    panel_type: str  # "MDB", "SDB", "Control Panel", "MCC"
    voltage_rating: Optional[str] = None
    current_rating: Optional[str] = None
    ip_rating: Optional[str] = None
    location: Optional[str] = None
    manufacturer: Optional[str] = None
    model: Optional[str] = None

@dataclasses.dataclass
class Transformer:
    """Power transformer"""
    transformer_id: str
    primary_voltage: Optional[str] = None
    secondary_voltage: Optional[str] = None
    capacity_kva: Optional[str] = None
    vector_group: Optional[str] = None
    cooling_type: Optional[str] = None

@dataclasses.dataclass
class Switchgear:
    """Switchgear equipment"""
    switchgear_id: str
    voltage_class: str
    switchgear_type: Optional[str] = None
    rated_current: Optional[str] = None
    breaking_capacity: Optional[str] = None

@dataclasses.dataclass
class Motor:
    """Electric motor"""
    motor_id: str
    power_rating: str
    voltage: Optional[str] = None
    rpm: Optional[str] = None
    efficiency: Optional[str] = None
    duty_cycle: Optional[str] = None

@dataclasses.dataclass
class CircuitBreaker:
    """Circuit breaker"""
    breaker_id: str
    breaker_type: str
    rated_current: str
    breaking_capacity: Optional[str] = None
    poles: Optional[str] = None

@dataclasses.dataclass
class Cable:
    """Electrical cable"""
    cable_id: str
    cable_type: str
    size: str
    length: Optional[str] = None
    insulation: Optional[str] = None
    cores: Optional[str] = None

@dataclasses.dataclass
class Circuit:
    """Electrical circuit"""
    circuit_id: str
    circuit_number: str
    description: str
    voltage: Optional[str] = None
    amperage: Optional[str] = None
    cable_size: Optional[str] = None
    protection_device: Optional[str] = None
    source_panel: Optional[str] = None

@dataclasses.dataclass
class Load:
    """Electrical load"""
    load_id: str
    load_name: str
    load_type: str  # "Motor", "Lighting", "Socket", "HVAC", "Control"
    power_kw: str
    voltage: Optional[str] = None
    phases: Optional[str] = None
    duty_cycle: Optional[str] = None
    location: Optional[str] = None
    fed_from_panel: Optional[str] = None
    circuit_number: Optional[str] = None

@dataclasses.dataclass
class IOPoint:
    """Input/Output control point"""
    io_id: str
    tag_number: str
    io_type: str  # "DI", "DO", "AI", "AO"
    description: str                    # ✅ Move here (non-default first)
    signal_type: Optional[str] = None   # ✅ Now all defaults are after non-defaults
    panel_location: Optional[str] = None
    equipment_monitored: Optional[str] = None

@dataclasses.dataclass
class Parameter:
    """Technical parameter with value and unit"""
    name: str
    value: str
    unit: Optional[str] = None
    tolerance: Optional[str] = None
    condition: Optional[str] = None
    parameter_type: str = "Specification"
    min_value: Optional[str] = None
    max_value: Optional[str] = None

@dataclasses.dataclass
class Standard:
    """Industry standard"""
    name: str
    standard_id: str
    applies_to: str
    section: Optional[str] = None
    version: Optional[str] = None

@dataclasses.dataclass
class Component:
    """Component or subassembly"""
    name: str
    component_type: str
    function: str
    manufacturer: Optional[str] = None
    part_number: Optional[str] = None

@dataclasses.dataclass
class Requirement:
    """Technical requirement"""
    description: str
    requirement_type: str
    applies_to: str
    value: Optional[str] = None
    priority: Optional[str] = None

@dataclasses.dataclass
class Manufacturer:
    """Equipment manufacturer"""
    name: str
    country: Optional[str] = None
    contact: Optional[str] = None

@dataclasses.dataclass
class TypedRelationship:
    """Semantic relationship between entities"""
    subject: str
    subject_type: str
    predicate: str  # SUPPLIES, FEEDS, PROTECTS, MONITORS, CONTROLS, etc.
    object: str
    object_type: str
    context: Optional[str] = None

# ============================================================================
# MAIN FLOW DEFINITION FOR RAG SYSTEM
# ============================================================================

@cocoindex.flow_def(name="IndustrialElectricalRAG")
def industrial_electrical_rag_flow(flow_builder, data_scope):
    
    # Source: Load all document types
    data_scope["documents"] = flow_builder.add_source(
        cocoindex.sources.LocalFile(
            path="/docs",
            included_patterns=["*.md", "*.mdx", "*.pdf", "*.txt"]
        )
    )

    # Collectors for all entity types
    document_node = data_scope.add_collector()
    project_node = data_scope.add_collector()
    site_node = data_scope.add_collector()
    building_node = data_scope.add_collector()
    room_node = data_scope.add_collector()
    panel_node = data_scope.add_collector()
    transformer_node = data_scope.add_collector()
    switchgear_node = data_scope.add_collector()
    motor_node = data_scope.add_collector()
    breaker_node = data_scope.add_collector()
    cable_node = data_scope.add_collector()
    circuit_node = data_scope.add_collector()
    load_node = data_scope.add_collector()
    io_point_node = data_scope.add_collector()
    parameter_node = data_scope.add_collector()
    standard_node = data_scope.add_collector()
    component_node = data_scope.add_collector()
    requirement_node = data_scope.add_collector()
    manufacturer_node = data_scope.add_collector()
    
    # Relationship collectors
    typed_relationships = data_scope.add_collector()
    document_references = data_scope.add_collector()
    
    with data_scope["documents"].row() as doc:
        
        # ====================================================================
        # PASS 1: Document Metadata & Context
        # ====================================================================
        doc["metadata"] = doc["content"].transform(
            cocoindex.functions.ExtractByLlm(
                llm_spec=cocoindex.llm.LlmSpec(
                    api_type=cocoindex.LlmApiType.OPENAI, 
                    model="gpt-4o-mini"  # Cheaper for metadata
                ),
                output_type=DocumentMetadata,
                instruction="""
                Extract comprehensive document metadata.
                
                Document types to identify:
                - "Specification" - Technical specs, design criteria
                - "Datasheet" - Equipment datasheets, catalog info
                - "IO List" - Input/output point lists, control points
                - "Load List" - Electrical load schedules
                - "Site Layout" - Physical layouts, locations
                - "Single Line Diagram (SLD)" - Power distribution diagrams
                - "Schematic" - Detailed electrical drawings
                - "Test Report" - Commissioning, test results
                - "Manual" - Operation and maintenance manuals
                
                Extract:
                - Document title
                - Comprehensive summary (3-5 sentences)
                - Document type from list above
                - Project name if mentioned
                - Document number/reference
                - Revision number
                - Date
                """
            )
        )
        
        document_node.collect(
            filename=doc["filename"],
            title=doc["metadata"]["title"],
            summary=doc["metadata"]["summary"],
            document_type=doc["metadata"]["document_type"],
            project=doc["metadata"]["project"],
            document_number=doc["metadata"]["document_number"],
            revision=doc["metadata"]["revision"],
            date=doc["metadata"]["date"]
        )
        
        # ====================================================================
        # PASS 2: Project Hierarchy (Project, Site, Building, Room)
        # ====================================================================
        # Store as a different field type or skip the hierarchy for now
        doc["hierarchy_text"] = doc["content"].transform(
            cocoindex.functions.ExtractByLlm(
                llm_spec=cocoindex.llm.LlmSpec(
                    api_type=cocoindex.LlmApiType.OPENAI,
                    model="gpt-4o-mini"
                ),
                output_type=dict,
                instruction="""
                Extract project hierarchy information.
                
                Return a dictionary with these keys (set to None if not found):
                {
                    "project": {"name": str, "project_id": str, "location": str, "client": str},
                    "sites": [{"name": str, "site_id": str, "location": str}],
                    "buildings": [{"name": str, "building_id": str, "area": str}],
                    "rooms": [{"name": str, "room_id": str, "function": str}]
                }
                
                Examples:
                - "Sarmad Iron & Steel Co. - Steel Making Plant" → project name
                - "Building A", "MV Room" → building, room
                - "Site: Industrial Zone, Tehran" → site location
                """
            )
        )
        
        # Store project info (similar for site, building, room)
        # ... (implementation continues with storing hierarchy)
        
        # ====================================================================
        # PASS 3: Electrical Equipment (Comprehensive)
        # ====================================================================
        doc["equipment"] = doc["content"].transform(
            cocoindex.functions.ExtractByLlm(
                llm_spec=cocoindex.llm.LlmSpec(
                    api_type=cocoindex.LlmApiType.OPENAI,
                    model="gpt-4o"  # Use full model for complex extraction
                ),
                output_type=dict,
                instruction="""
                Extract ALL electrical equipment mentioned in this document.
                
                Return a dictionary with these lists:
                {
                    "panels": [Panel objects],
                    "transformers": [Transformer objects],
                    "switchgear": [Switchgear objects],
                    "motors": [Motor objects],
                    "breakers": [CircuitBreaker objects],
                    "cables": [Cable objects]
                }
                
                For each equipment type, extract:
                
                PANELS (MDB, SDB, Control Panels, MCC):
                - panel_id (e.g., "MDB-01", "MCC-02")
                - panel_type
                - voltage_rating, current_rating, ip_rating
                - location, manufacturer, model
                
                TRANSFORMERS:
                - transformer_id (e.g., "TR-01")
                - primary_voltage, secondary_voltage
                - capacity_kva, vector_group, cooling_type
                
                SWITCHGEAR:
                - switchgear_id
                - voltage_class (e.g., "33kV")
                - type, rated_current, breaking_capacity
                
                MOTORS:
                - motor_id
                - power_rating, voltage, rpm
                - efficiency, duty_cycle
                
                CIRCUIT BREAKERS:
                - breaker_id
                - type, rated_current, breaking_capacity, poles
                
                CABLES:
                - cable_id
                - cable_type, size, length, insulation, cores
                
                Be thorough - extract from tables, text, and specifications.
                """
            )
        )
        
        # Store panels
        if "panels" in doc["equipment"] and doc["equipment"]["panels"]:
            with doc["equipment"]["panels"].row() as panel:
                panel_node.collect(
                    id=cocoindex.GeneratedField.UUID,
                    panel_id=panel["panel_id"],
                    panel_type=panel["panel_type"],
                    voltage_rating=panel["voltage_rating"],
                    current_rating=panel["current_rating"],
                    ip_rating=panel["ip_rating"],
                    location=panel["location"],
                    manufacturer=panel["manufacturer"],
                    model=panel["model"]
                )
                
                document_references.collect(
                    id=cocoindex.GeneratedField.UUID,
                    source_filename=doc["filename"],
                    target_entity=panel["panel_id"],
                    target_type="Panel",
                    relationship_type="DESCRIBES"
                )
        
        # Similar for other equipment types...
        
        # ====================================================================
        # PASS 4: Circuits & Loads (Critical for RAG)
        # ====================================================================
        doc["circuits_loads"] = doc["content"].transform(
            cocoindex.functions.ExtractByLlm(
                llm_spec=cocoindex.llm.LlmSpec(
                    api_type=cocoindex.LlmApiType.OPENAI,
                    model="gpt-4o"
                ),
                output_type=dict,
                instruction="""
                Extract circuits and loads. This is CRITICAL for power tracing queries.
                
                Return:
                {
                    "circuits": [Circuit objects],
                    "loads": [Load objects]
                }
                
                CIRCUITS:
                - circuit_id (unique identifier)
                - circuit_number (e.g., "C-01", "Circuit 1")
                - description
                - voltage, amperage, cable_size
                - protection_device (breaker type/size)
                - source_panel (which panel it originates from)
                
                LOADS:
                - load_id (unique identifier)
                - load_name
                - load_type: "Motor", "Lighting", "Socket", "HVAC", "Control", "Instrument"
                - power_kw (power rating in kW)
                - voltage, phases
                - duty_cycle
                - location
                - fed_from_panel (which panel supplies this load)
                - circuit_number (which circuit feeds this load)
                
                Extract from:
                - Load schedules/lists
                - Circuit tables
                - Single line diagrams
                - Panel schedules
                
                Link circuits to their source panels and loads!
                """
            )
        )
        
        # Store circuits
        if "circuits" in doc["circuits_loads"] and doc["circuits_loads"]["circuits"]:
            with doc["circuits_loads"]["circuits"].row() as circuit:
                circuit_node.collect(
                    id=cocoindex.GeneratedField.UUID,
                    circuit_id=circuit["circuit_id"],
                    circuit_number=circuit["circuit_number"],
                    description=circuit["description"],
                    voltage=circuit["voltage"],
                    amperage=circuit["amperage"],
                    cable_size=circuit["cable_size"],
                    protection_device=circuit["protection_device"],
                    source_panel=circuit["source_panel"]
                )
                
                # Create relationship: Panel → Circuit
                if circuit["source_panel"]:
                    typed_relationships.collect(
                        id=cocoindex.GeneratedField.UUID,
                        subject=circuit["source_panel"],
                        subject_type="Panel",
                        predicate="ORIGINATES_CIRCUIT",
                        object=circuit["circuit_id"],
                        object_type="Circuit",
                        context=f"Circuit {circuit['circuit_number']}"
                    )
        
        # Store loads
        if "loads" in doc["circuits_loads"] and doc["circuits_loads"]["loads"]:
            with doc["circuits_loads"]["loads"].row() as load:
                load_node.collect(
                    id=cocoindex.GeneratedField.UUID,
                    load_id=load["load_id"],
                    load_name=load["load_name"],
                    load_type=load["load_type"],
                    power_kw=load["power_kw"],
                    voltage=load["voltage"],
                    phases=load["phases"],
                    duty_cycle=load["duty_cycle"],
                    location=load["location"],
                    fed_from_panel=load["fed_from_panel"],
                    circuit_number=load["circuit_number"]
                )
                
                # Create relationships: Circuit → Load, Panel → Load
                if load["circuit_number"]:
                    typed_relationships.collect(
                        id=cocoindex.GeneratedField.UUID,
                        subject=load["circuit_number"],
                        subject_type="Circuit",
                        predicate="SUPPLIES",
                        object=load["load_id"],
                        object_type="Load",
                        context=f"Supplies power to {load['load_name']}"
                    )
                
                if load["fed_from_panel"]:
                    typed_relationships.collect(
                        id=cocoindex.GeneratedField.UUID,
                        subject=load["fed_from_panel"],
                        subject_type="Panel",
                        predicate="FEEDS",
                        object=load["load_id"],
                        object_type="Load",
                        context=f"Panel feeds load"
                    )
        
        # ====================================================================
        # PASS 5: IO Points (for control system documents)
        # ====================================================================
        doc["io_points"] = doc["content"].transform(
            cocoindex.functions.ExtractByLlm(
                llm_spec=cocoindex.llm.LlmSpec(
                    api_type=cocoindex.LlmApiType.OPENAI,
                    model="gpt-4o"
                ),
                output_type=list[IOPoint],
                instruction="""
                Extract IO (Input/Output) points from control system documents.
                
                Look for:
                - Tag numbers (e.g., "DI-101", "AO-205")
                - IO types: "DI" (Digital Input), "DO" (Digital Output),
                            "AI" (Analog Input), "AO" (Analog Output)
                - Signal types: "24VDC", "4-20mA", "0-10V", etc.
                - Descriptions: What the point monitors or controls
                - Panel location: Which control panel houses this IO
                - Equipment monitored: What equipment this IO is connected to
                
                Example:
                - Tag: "DI-101", Type: "DI", Signal: "24VDC", Description: "Motor Running Status",
                  Panel: "PLC-01", Equipment: "Motor-M01"
                """
            )
        )
        
        # ====================================================================
        # PASS 6: Parameters (as before)
        # ====================================================================
        doc["parameters"] = doc["content"].transform(
            cocoindex.functions.ExtractByLlm(
                llm_spec=cocoindex.llm.LlmSpec(
                    api_type=cocoindex.LlmApiType.OPENAI,
                    model="gpt-4o-mini"
                ),
                output_type=list[Parameter],
                instruction="""
                Extract ALL technical parameters from tables and text.
                Include: value, unit, tolerance, min/max ranges, conditions.
                """
            )
        )
        
        # ====================================================================
        # PASS 7: Standards, Components, Requirements (as before)
        # ====================================================================
        # ... (same as enhanced_pipeline.py)
        
        # ====================================================================
        # PASS 8: Comprehensive Relationships (CRITICAL FOR RAG)
        # ====================================================================
        doc["relationships"] = doc["content"].transform(
            cocoindex.functions.ExtractByLlm(
                llm_spec=cocoindex.llm.LlmSpec(
                    api_type=cocoindex.LlmApiType.OPENAI,
                    model="gpt-4o"  # Use best model for relationships
                ),
                output_type=list[TypedRelationship],
                instruction="""
                Extract ALL relationships between entities. This is CRITICAL for graph traversal in RAG.
                
                Key relationship types to identify:
                
                POWER FLOW:
                - SUPPLIES: Transformer SUPPLIES Panel, Panel SUPPLIES Load
                - FEEDS: Panel FEEDS Circuit, Circuit FEEDS Load
                - FED_FROM: Panel FED_FROM Transformer
                - BACKUP_FOR: Generator BACKUP_FOR Transformer
                
                CONTROL:
                - MONITORS: IO_Point MONITORS Motor
                - CONTROLS: IO_Point CONTROLS Valve
                - PROTECTS: Circuit_Breaker PROTECTS Circuit
                - INTERRUPTS: Breaker INTERRUPTS Fault_Current
                
                CONTAINMENT:
                - CONTAINS: Panel CONTAINS Circuit_Breaker
                - PART_OF: Component PART_OF Equipment
                - INSTALLED_IN: Equipment INSTALLED_IN Room
                
                LOCATION:
                - LOCATED_IN: Equipment LOCATED_IN Room
                - HOUSED_IN: Panel HOUSED_IN Building
                - INSTALLED_AT: Equipment INSTALLED_AT Site
                
                SPECIFICATION:
                - HAS_PARAMETER: Equipment HAS_PARAMETER Parameter
                - COMPLIES_WITH: Equipment COMPLIES_WITH Standard
                - REQUIRES: Equipment REQUIRES Requirement
                - MANUFACTURED_BY: Product MANUFACTURED_BY Manufacturer
                
                CONNECTION:
                - CONNECTS: Cable CONNECTS Panel_to_Panel
                - RUNS_FROM: Cable RUNS_FROM Panel_A
                - RUNS_TO: Cable RUNS_TO Panel_B
                - ORIGINATES_FROM: Circuit ORIGINATES_FROM Panel
                - TERMINATES_AT: Circuit TERMINATES_AT Load
                
                Extract context that explains WHY this relationship exists.
                Be thorough - these relationships enable graph traversal for RAG queries!
                """
            )
        )
        
        with doc["relationships"].row() as rel:
            typed_relationships.collect(
                id=cocoindex.GeneratedField.UUID,
                subject=rel["subject"],
                subject_type=rel["subject_type"],
                predicate=rel["predicate"],
                object=rel["object"],
                object_type=rel["object_type"],
                context=rel["context"]
            )
    
    # ========================================================================
    # NEO4J EXPORTS
    # ========================================================================
    
    conn_spec = cocoindex.add_auth_entry(
        "Neo4jConnection",
        cocoindex.storages.Neo4jConnection(
            uri="bolt://neo4j:7687",
            user="neo4j",
            password="cocoindex"
        )
    )
    
    # Export all node types
    document_node.export("document_node",
        cocoindex.storages.Neo4j(connection=conn_spec,
            mapping=cocoindex.storages.Nodes(label="Document")),
        primary_key_fields=["filename"])
    
    panel_node.export("panel_node",
        cocoindex.storages.Neo4j(connection=conn_spec,
            mapping=cocoindex.storages.Nodes(label="Panel")),
        primary_key_fields=["id"])
    
    circuit_node.export("circuit_node",
        cocoindex.storages.Neo4j(connection=conn_spec,
            mapping=cocoindex.storages.Nodes(label="Circuit")),
        primary_key_fields=["id"])
    
    load_node.export("load_node",
        cocoindex.storages.Neo4j(connection=conn_spec,
            mapping=cocoindex.storages.Nodes(label="Load")),
        primary_key_fields=["id"])
    
    # ... (export all other node types)
    
    # Export relationships
    typed_relationships.export("typed_relationships",
        cocoindex.storages.Neo4j(connection=conn_spec,
            mapping=cocoindex.storages.Relationships(
                rel_type="RELATED_TO",
                source=cocoindex.storages.NodeFromFields(label="Entity",
                    fields=[cocoindex.storages.TargetFieldMapping(
                        source="subject", target="value")]),
                target=cocoindex.storages.NodeFromFields(label="Entity",
                    fields=[cocoindex.storages.TargetFieldMapping(
                        source="object", target="value")]))),
        primary_key_fields=["id"])