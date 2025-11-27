"""
Industrial Electrical Ontology - Siemens LV/MV Panel Specifications
Based on: use_it_for_create_onthology.xlsx

This module defines all entity types, their attributes, and relationships
for the knowledge graph used in the Industrial Electrical Assistant.
"""

from dataclasses import dataclass, field
from typing import Optional, List, Dict, Any
from enum import Enum

# =============================================================================
# ENUMS - Standardized Values
# =============================================================================

class EntityType(str, Enum):
    """All node types in the knowledge graph"""
    # Core
    PROJECT = "Project"
    DOCUMENT = "Document"
    
    # Equipment
    SWITCHGEAR = "Switchgear"
    PANEL = "Panel"
    TRANSFORMER = "Transformer"
    CIRCUIT_BREAKER = "CircuitBreaker"
    MOTOR = "Motor"
    CONTACTOR = "Contactor"
    
    # Electrical Components
    BUSBAR = "Busbar"
    CABLE = "Cable"
    WIRE = "Wire"
    CIRCUIT = "Circuit"
    LOAD = "Load"
    
    # Instruments
    CT = "CurrentTransformer"
    PT = "PotentialTransformer"
    MEASURING_INSTRUMENT = "MeasuringInstrument"
    
    # Control
    IO_POINT = "IOPoint"
    PLC = "PLC"
    NETWORK = "Network"
    
    # Specifications
    SPEC_SWITCHGEAR = "SwitchgearSpec"
    SPEC_BUSBAR = "BusbarSpec"
    SPEC_WIRE = "WireSpec"
    SPEC_ACCESSORY = "AccessorySpec"


class RelationType(str, Enum):
    """All relationship types in the knowledge graph"""
    # Project Hierarchy
    BELONGS_TO_PROJECT = "BELONGS_TO_PROJECT"
    HAS_DOCUMENT = "HAS_DOCUMENT"
    HAS_ENTITY = "HAS_ENTITY"
    
    # Document Relations
    DESCRIBES = "DESCRIBES"
    REFERENCES = "REFERENCES"
    
    # Power Flow
    SUPPLIES = "SUPPLIES"
    FEEDS = "FEEDS"
    FED_FROM = "FED_FROM"
    CONNECTS_TO = "CONNECTS_TO"
    
    # Containment
    CONTAINS = "CONTAINS"
    PART_OF = "PART_OF"
    INSTALLED_IN = "INSTALLED_IN"
    
    # Protection & Control
    PROTECTS = "PROTECTS"
    MONITORS = "MONITORS"
    CONTROLS = "CONTROLS"
    
    # Specifications
    HAS_SPEC = "HAS_SPEC"
    HAS_PARAMETER = "HAS_PARAMETER"
    COMPLIES_WITH = "COMPLIES_WITH"
    
    # Manufacturing
    MANUFACTURED_BY = "MANUFACTURED_BY"
    MODEL_OF = "MODEL_OF"


class DocumentType(str, Enum):
    """Types of technical documents"""
    SPECIFICATION = "Specification"
    DATASHEET = "Datasheet"
    IO_LIST = "IO List"
    LOAD_LIST = "Load List"
    SITE_LAYOUT = "Site Layout"
    SLD = "Single Line Diagram"
    SCHEMATIC = "Schematic"
    TEST_REPORT = "Test Report"
    MANUAL = "Manual"


class LoadType(str, Enum):
    """Types of electrical loads"""
    MOTOR = "Motor"
    LIGHTING = "Lighting"
    SOCKET = "Socket"
    HVAC = "HVAC"
    CONTROL = "Control"
    INSTRUMENT = "Instrument"
    DRIVE = "Drive"


class IOType(str, Enum):
    """Types of IO points"""
    DI = "Digital Input"
    DO = "Digital Output"
    AI = "Analog Input"
    AO = "Analog Output"


# =============================================================================
# DATA CLASSES - Entity Definitions
# =============================================================================

@dataclass
class Project:
    """Root node for project isolation in Neo4j"""
    project_number: str  # e.g., "P-2024-001"
    project_name: str
    client: Optional[str] = None
    contract_number: Optional[str] = None
    contract_date: Optional[str] = None
    location: Optional[str] = None
    description: Optional[str] = None
    created_by: Optional[str] = None
    created_at: Optional[str] = None
    
    def to_neo4j_properties(self) -> Dict[str, Any]:
        return {k: v for k, v in self.__dict__.items() if v is not None}


@dataclass
class Document:
    """Document node"""
    filename: str
    title: str
    document_type: str
    summary: Optional[str] = None
    document_number: Optional[str] = None
    revision: Optional[str] = None
    date: Optional[str] = None
    hash: Optional[str] = None
    
    def to_neo4j_properties(self) -> Dict[str, Any]:
        return {k: v for k, v in self.__dict__.items() if v is not None}


@dataclass
class SwitchgearSpec:
    """
    Switchgear Specifications (Main Characteristic)
    Based on ontology item 1
    """
    # Electrical Ratings
    rated_short_time_withstand_current: Optional[str] = None  # kA
    main_busbar_rated_current: Optional[str] = None  # A
    frequency: Optional[str] = None  # Hz (50 or 60)
    service_voltage: Optional[str] = None  # V
    rated_insulation_voltage: Optional[str] = None  # V
    rated_impulse_withstand_voltage: Optional[str] = None  # kV
    rated_power_frequency_withstand_voltage: Optional[str] = None  # V
    
    # Physical
    switchboard_color: Optional[str] = None  # RAL code
    degree_of_protection: Optional[str] = None  # IP rating
    design_temperature_min: Optional[float] = None  # °C
    design_temperature_max: Optional[float] = None  # °C
    altitude_above_sea_level: Optional[int] = None  # meters
    thickness_of_painting: Optional[str] = None  # microns
    sheet_thickness: Optional[str] = None  # mm
    
    # Configuration
    switchgear_access: Optional[str] = None  # Front, Front/Rear
    type_of_entrance: Optional[str] = None  # Top, Bottom
    type_of_separation: Optional[str] = None  # Form 1, 2, 3, 4
    internal_arc_fault_duration: Optional[str] = None  # seconds
    rear_door_interlock: Optional[bool] = None
    chassis_height: Optional[str] = None  # 10 or 20 cm
    lifting_lugs: Optional[bool] = None
    ambient_humidity_level: Optional[float] = None  # %
    
    def to_neo4j_properties(self) -> Dict[str, Any]:
        return {k: v for k, v in self.__dict__.items() if v is not None}


@dataclass
class BusbarSpec:
    """
    Busbar Specifications
    Based on ontology item 2
    """
    main_busbar_configuration: Optional[str] = None  # Single, Double
    main_earth_bus_size: Optional[str] = None  # mm²
    coating: Optional[str] = None  # Silver, Tin, etc.
    thermofit_cover_color: Optional[str] = None  # Color or Black
    busbar_type: Optional[str] = None  # Copper, Aluminum
    color_coding: Optional[str] = None  # Phase colors
    neutral_busbar_ratio: Optional[float] = None  # % of phase
    earthing_busbar_ratio: Optional[float] = None  # % of phase
    minimum_earthing_busbar_size: Optional[str] = None  # mm²
    
    def to_neo4j_properties(self) -> Dict[str, Any]:
        return {k: v for k, v in self.__dict__.items() if v is not None}


@dataclass
class WireSpec:
    """
    Wire Specifications (Items 3, 4, 5)
    """
    # Wire Size (Item 3)
    control_circuit_size: Optional[str] = None  # mm²
    ct_secondary_size: Optional[str] = None  # mm²
    pt_secondary_size: Optional[str] = None  # mm²
    plc_power_supply_size: Optional[str] = None  # mm²
    
    # Wire Color (Item 4)
    ac_phase_color: Optional[str] = None
    ac_neutral_color: Optional[str] = None
    plc_input_color: Optional[str] = None
    plc_output_color: Optional[str] = None
    three_phase_colors: Optional[str] = None  # R,Y,B or L1,L2,L3
    dc_positive_color: Optional[str] = None
    dc_negative_color: Optional[str] = None
    
    # Wire Specifications (Item 5)
    voltage_rating: Optional[str] = None  # V
    insulation_type: Optional[str] = None  # PVC, HFLS
    fire_resistance: Optional[str] = None  # IEC rating
    conductor_type: Optional[str] = None  # Extra Flexible, CU5
    
    def to_neo4j_properties(self) -> Dict[str, Any]:
        return {k: v for k, v in self.__dict__.items() if v is not None}


@dataclass
class AuxiliaryVoltageSpec:
    """
    Auxiliary Voltage Specifications
    Based on ontology item 7
    """
    control_protection_voltage: Optional[str] = None  # V DC/AC
    closing_voltage: Optional[str] = None  # V DC/AC
    tripping_voltage: Optional[str] = None  # V DC/AC
    signalling_voltage: Optional[str] = None  # V DC/AC
    spring_charging_motor_voltage: Optional[str] = None  # V AC
    panel_lighting_voltage: Optional[str] = None  # V AC
    space_heater_voltage: Optional[str] = None  # V AC
    motor_space_heater_voltage: Optional[str] = None  # V AC
    
    def to_neo4j_properties(self) -> Dict[str, Any]:
        return {k: v for k, v in self.__dict__.items() if v is not None}


@dataclass
class AccessorySpec:
    """
    Accessories Specifications
    Based on ontology item 8
    """
    # Components
    mini_contactor_type: Optional[str] = None
    hygrostat_thermostat: Optional[str] = None
    earth_leakage_type: Optional[str] = None  # RCBO or RCCB
    mcb_fuse_type: Optional[str] = None
    socket_outlet_type: Optional[str] = None
    
    # Hardware
    bolt_washer_material: Optional[str] = None  # Stainless Steel
    busbar_joint_bolt_type: Optional[str] = None
    vibration_proof_lock_washer: Optional[bool] = None
    
    # Interlock & Safety
    key_interlock: Optional[str] = None
    mv_padlock: Optional[str] = None
    door_stopper: Optional[str] = None
    fail_safe_operation: Optional[str] = None  # Fail-Safe or Normal
    
    # Indication
    mimic_color: Optional[str] = None
    signal_lamp_type: Optional[str] = None
    semaphore: Optional[bool] = None
    discrepancy_switch: Optional[bool] = None
    push_button_with_signal: Optional[str] = None
    
    # Communication
    communication_protocol: Optional[str] = None  # Modbus, etc.
    outgoing_filter_type: Optional[str] = None  # For drives/harmonics
    
    # Space & Terminals
    feeder_space_percent: Optional[float] = None
    spare_terminals_percent: Optional[float] = None
    cable_duct_fill_ratio_percent: Optional[float] = None
    
    # ANSI Code
    ansi_code: Optional[str] = None
    
    def to_neo4j_properties(self) -> Dict[str, Any]:
        return {k: v for k, v in self.__dict__.items() if v is not None}


@dataclass
class CTSpec:
    """
    Current Transformer Specifications
    Based on ontology item 9
    """
    accuracy_class: Optional[str] = None  # 0.2, 0.5, 1.0
    ratio: Optional[str] = None  # e.g., "100/5"
    thermal_class: Optional[str] = None  # E, F, H
    burden: Optional[str] = None  # VA
    
    def to_neo4j_properties(self) -> Dict[str, Any]:
        return {k: v for k, v in self.__dict__.items() if v is not None}


@dataclass
class PTSpec:
    """
    Potential Transformer Specifications
    Based on ontology item 9
    """
    accuracy_class: Optional[str] = None
    ratio: Optional[str] = None  # e.g., "11000/110"
    thermal_class: Optional[str] = None
    burden: Optional[str] = None  # VA
    
    def to_neo4j_properties(self) -> Dict[str, Any]:
        return {k: v for k, v in self.__dict__.items() if v is not None}


@dataclass
class MeasuringInstrumentSpec:
    """
    Measuring Instrument Specifications
    Based on ontology item 10
    """
    accuracy_class: Optional[str] = None
    red_mark: Optional[str] = None  # Red Index, Red Line
    size: Optional[str] = None  # 2in, 6in
    scale: Optional[str] = None
    frame_size: Optional[str] = None
    selector_with_lock: Optional[bool] = None
    
    def to_neo4j_properties(self) -> Dict[str, Any]:
        return {k: v for k, v in self.__dict__.items() if v is not None}


@dataclass
class CircuitBreakerSpec:
    """
    Circuit Breaker Specifications
    Based on ontology item 11
    """
    rated_operating_sequence: Optional[str] = None  # O-t-CO-t'-CO
    ics: Optional[str] = None  # Service short-circuit breaking capacity
    icw: Optional[str] = None  # Short-time withstand current
    icu: Optional[str] = None  # Ultimate short-circuit breaking capacity
    coordination_type: Optional[str] = None  # Type 1, Type 2
    poles: Optional[int] = None  # 3P, 4P
    trip_unit: Optional[str] = None  # TMD, ETU
    
    def to_neo4j_properties(self) -> Dict[str, Any]:
        return {k: v for k, v in self.__dict__.items() if v is not None}


@dataclass
class NetworkSpec:
    """
    Network/Communication Specifications
    Based on ontology item 12
    """
    software_protocol: Optional[str] = None  # Modbus, Profibus, IEC 61850
    hardware_type: Optional[str] = None  # RJ45, Shielded Cable, Fiber
    converter_needed: Optional[str] = None
    switch_requirement: Optional[str] = None
    
    def to_neo4j_properties(self) -> Dict[str, Any]:
        return {k: v for k, v in self.__dict__.items() if v is not None}


@dataclass
class VacuumContactorSpec:
    """
    Vacuum Contactor Specifications
    Based on ontology item 13
    """
    latching_system: Optional[str] = None  # Mechanical Latch, Electrical Latch
    
    def to_neo4j_properties(self) -> Dict[str, Any]:
        return {k: v for k, v in self.__dict__.items() if v is not None}


@dataclass
class LabelSpec:
    """
    Label/Nameplate Specifications
    Based on ontology item 6
    """
    writing_color: Optional[str] = None
    background_color: Optional[str] = None
    nameplate_material: Optional[str] = None  # Steel, Plastic
    
    def to_neo4j_properties(self) -> Dict[str, Any]:
        return {k: v for k, v in self.__dict__.items() if v is not None}


# =============================================================================
# EQUIPMENT ENTITIES
# =============================================================================

@dataclass
class Panel:
    """Electrical Panel / Distribution Board"""
    panel_id: str
    panel_type: str  # MDB, SDB, MCC, Control Panel
    voltage_rating: Optional[str] = None
    current_rating: Optional[str] = None
    ip_rating: Optional[str] = None
    location: Optional[str] = None
    manufacturer: Optional[str] = None
    model: Optional[str] = None
    
    def to_neo4j_properties(self) -> Dict[str, Any]:
        return {k: v for k, v in self.__dict__.items() if v is not None}


@dataclass
class Transformer:
    """Power Transformer"""
    transformer_id: str
    primary_voltage: Optional[str] = None
    secondary_voltage: Optional[str] = None
    capacity_kva: Optional[float] = None
    vector_group: Optional[str] = None
    cooling_type: Optional[str] = None
    manufacturer: Optional[str] = None
    
    def to_neo4j_properties(self) -> Dict[str, Any]:
        return {k: v for k, v in self.__dict__.items() if v is not None}


@dataclass
class Motor:
    """Electric Motor"""
    motor_id: str
    power_rating: str  # kW
    voltage: Optional[str] = None
    rpm: Optional[int] = None
    efficiency: Optional[str] = None
    duty_cycle: Optional[str] = None
    frame_size: Optional[str] = None
    manufacturer: Optional[str] = None
    
    def to_neo4j_properties(self) -> Dict[str, Any]:
        return {k: v for k, v in self.__dict__.items() if v is not None}


@dataclass
class CircuitBreaker:
    """Circuit Breaker Equipment"""
    breaker_id: str
    breaker_type: str  # ACB, MCCB, MCB
    rated_current: str
    breaking_capacity: Optional[str] = None
    poles: Optional[int] = None
    manufacturer: Optional[str] = None
    model: Optional[str] = None
    
    def to_neo4j_properties(self) -> Dict[str, Any]:
        return {k: v for k, v in self.__dict__.items() if v is not None}


@dataclass
class Cable:
    """Electrical Cable"""
    cable_id: str
    cable_type: str
    size: str  # mm²
    length: Optional[float] = None  # meters
    insulation: Optional[str] = None
    cores: Optional[int] = None
    voltage_rating: Optional[str] = None
    
    def to_neo4j_properties(self) -> Dict[str, Any]:
        return {k: v for k, v in self.__dict__.items() if v is not None}


@dataclass
class Circuit:
    """Electrical Circuit"""
    circuit_id: str
    circuit_number: str
    description: str
    voltage: Optional[str] = None
    amperage: Optional[str] = None
    cable_size: Optional[str] = None
    protection_device: Optional[str] = None
    source_panel: Optional[str] = None
    
    def to_neo4j_properties(self) -> Dict[str, Any]:
        return {k: v for k, v in self.__dict__.items() if v is not None}


@dataclass
class Load:
    """Electrical Load"""
    load_id: str
    load_name: str
    load_type: str  # Motor, Lighting, etc.
    power_kw: float
    voltage: Optional[str] = None
    phases: Optional[int] = None
    duty_cycle: Optional[str] = None
    location: Optional[str] = None
    fed_from_panel: Optional[str] = None
    circuit_number: Optional[str] = None
    
    def to_neo4j_properties(self) -> Dict[str, Any]:
        return {k: v for k, v in self.__dict__.items() if v is not None}


@dataclass
class IOPoint:
    """Input/Output Control Point"""
    io_id: str
    tag_number: str
    io_type: str  # DI, DO, AI, AO
    description: str
    signal_type: Optional[str] = None  # 24VDC, 4-20mA
    panel_location: Optional[str] = None
    equipment_monitored: Optional[str] = None
    
    def to_neo4j_properties(self) -> Dict[str, Any]:
        return {k: v for k, v in self.__dict__.items() if v is not None}


# =============================================================================
# RELATIONSHIP DEFINITION
# =============================================================================

@dataclass
class Relationship:
    """Generic relationship between entities"""
    source_id: str
    source_type: str
    relation_type: str
    target_id: str
    target_type: str
    properties: Optional[Dict[str, Any]] = None
    context: Optional[str] = None
    
    def to_neo4j_params(self) -> Dict[str, Any]:
        params = {
            "source_id": self.source_id,
            "source_type": self.source_type,
            "relation_type": self.relation_type,
            "target_id": self.target_id,
            "target_type": self.target_type,
        }
        if self.properties:
            params["properties"] = self.properties
        if self.context:
            params["context"] = self.context
        return params


# =============================================================================
# LLM EXTRACTION PROMPTS
# =============================================================================

ENTITY_EXTRACTION_PROMPT = """
You are an Industrial Electrical Engineer specialized in Siemens LV/MV panel specifications.

Extract ALL entities and their specifications from the document.

Entity Types to Extract:
1. Switchgear Specifications (voltage, current, IP rating, etc.)
2. Busbar Specifications (configuration, coating, sizing)
3. Wire Specifications (size, color, insulation)
4. Auxiliary Voltage Specifications
5. Accessories (contactors, MCBs, interlocks)
6. CT/PT Specifications
7. Measuring Instruments
8. Circuit Breakers
9. Network/Communication Specifications
10. Panels, Transformers, Motors, Cables, Circuits, Loads

For each entity, extract all available attributes with their values and units.

Return as structured JSON following the ontology schema.
"""

RELATIONSHIP_EXTRACTION_PROMPT = """
Extract ALL relationships between entities in this document.

Key relationship types:
- SUPPLIES/FEEDS: Power flow (Transformer SUPPLIES Panel)
- PROTECTS: Protection devices (Breaker PROTECTS Circuit)
- CONTAINS: Containment (Panel CONTAINS Busbar)
- MONITORS/CONTROLS: IO points (IOPoint MONITORS Motor)
- HAS_SPEC: Specifications (Switchgear HAS_SPEC SwitchgearSpec)
- CONNECTS_TO: Physical connections (Cable CONNECTS Panel1 TO Panel2)

Include context explaining why the relationship exists.

Return as structured JSON with:
{
    "relationships": [
        {
            "source": "entity_id",
            "source_type": "EntityType",
            "predicate": "RELATIONSHIP_TYPE",
            "target": "entity_id",
            "target_type": "EntityType",
            "context": "explanation"
        }
    ]
}
"""