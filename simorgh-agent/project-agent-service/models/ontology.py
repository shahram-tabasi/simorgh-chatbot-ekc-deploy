"""
Siemens LV/MV Electrical Ontology
==================================
Comprehensive dataclass models for industrial electrical systems based on Siemens standards.

Entity Categories:
1. Switchgear & Panels
2. Protection Devices
3. Power Distribution
4. Cables & Wiring
5. Transformers & Converters
6. Loads & Equipment
7. Measurement & Control

Author: Simorgh Industrial Assistant
"""

from dataclasses import dataclass, field
from typing import Optional, List, Dict, Any
from datetime import datetime
from enum import Enum


# =============================================================================
# ENUMS FOR STANDARDIZED VALUES
# =============================================================================

class VoltageLevel(str, Enum):
    """Standard voltage levels"""
    LV_230V = "230V"
    LV_400V = "400V"
    LV_690V = "690V"
    MV_3_3KV = "3.3kV"
    MV_6_6KV = "6.6kV"
    MV_11KV = "11kV"
    MV_20KV = "20kV"
    MV_33KV = "33kV"


class IPRating(str, Enum):
    """IP protection ratings"""
    IP20 = "IP20"
    IP21 = "IP21"
    IP30 = "IP30"
    IP31 = "IP31"
    IP40 = "IP40"
    IP54 = "IP54"
    IP55 = "IP55"
    IP65 = "IP65"
    IP66 = "IP66"


class PanelType(str, Enum):
    """Panel/Switchboard types"""
    MDB = "MDB"  # Main Distribution Board
    SMDB = "SMDB"  # Sub-Main Distribution Board
    DB = "DB"  # Distribution Board
    MCC = "MCC"  # Motor Control Center
    PCC = "PCC"  # Power Control Center
    PLC_PANEL = "PLC Panel"
    UPS_PANEL = "UPS Panel"
    CAPACITOR_BANK = "Capacitor Bank"


class LoadType(str, Enum):
    """Load equipment types"""
    MOTOR = "Motor"
    HEATER = "Heater"
    LIGHTING = "Lighting"
    HVAC = "HVAC"
    PUMP = "Pump"
    FAN = "Fan"
    COMPRESSOR = "Compressor"
    CONVEYOR = "Conveyor"
    TRANSFORMER = "Transformer"
    UPS = "UPS"
    BATTERY_CHARGER = "Battery Charger"


class CableType(str, Enum):
    """Cable types"""
    XLPE = "XLPE"
    PVC = "PVC"
    EPR = "EPR"
    FIRE_RESISTANT = "Fire Resistant"
    ARMOURED = "Armoured"
    FLEXIBLE = "Flexible"


class BreakerType(str, Enum):
    """Circuit breaker types"""
    MCB = "MCB"  # Miniature Circuit Breaker
    MCCB = "MCCB"  # Molded Case Circuit Breaker
    ACB = "ACB"  # Air Circuit Breaker
    VCB = "VCB"  # Vacuum Circuit Breaker
    OCB = "OCB"  # Oil Circuit Breaker
    SF6_CB = "SF6 CB"  # SF6 Circuit Breaker


# =============================================================================
# BASE ENTITY
# =============================================================================

@dataclass
class BaseEntity:
    """Base class for all electrical entities"""
    entity_id: str
    project_number: str
    entity_type: str
    description: Optional[str] = None
    location: Optional[str] = None
    manufacturer: Optional[str] = None
    model_number: Optional[str] = None
    serial_number: Optional[str] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for Neo4j"""
        return {
            k: v for k, v in self.__dict__.items()
            if v is not None and k != 'created_at' and k != 'updated_at'
        }


# =============================================================================
# SWITCHGEAR & PANELS
# =============================================================================

@dataclass
class SwitchgearSpec(BaseEntity):
    """Switchgear specifications"""
    panel_type: Optional[str] = None  # MDB, SMDB, MCC, etc.
    rated_voltage: Optional[str] = None  # e.g., "400V", "11kV"
    rated_current: Optional[float] = None  # Amperes
    rated_frequency: Optional[float] = 50.0  # Hz
    short_circuit_rating: Optional[float] = None  # kA
    ip_rating: Optional[str] = None  # IP54, IP55, etc.
    ambient_temperature_min: Optional[float] = None  # °C
    ambient_temperature_max: Optional[float] = None  # °C
    altitude: Optional[float] = None  # meters
    busbars_material: Optional[str] = None  # Copper, Aluminum
    busbars_configuration: Optional[str] = None  # Horizontal, Vertical
    form_of_separation: Optional[str] = None  # Form 1, 2, 3, 4
    color: Optional[str] = None  # RAL color code
    dimensions_height: Optional[float] = None  # mm
    dimensions_width: Optional[float] = None  # mm
    dimensions_depth: Optional[float] = None  # mm


@dataclass
class Panel(BaseEntity):
    """Distribution panel/switchboard instance"""
    panel_id: str = None
    panel_type: Optional[str] = None
    incoming_supply_voltage: Optional[str] = None
    incoming_supply_current: Optional[float] = None
    main_breaker_rating: Optional[float] = None
    total_load: Optional[float] = None  # kW
    total_connected_load: Optional[float] = None  # kW
    diversity_factor: Optional[float] = None
    power_factor: Optional[float] = None
    number_of_feeders: Optional[int] = None
    spare_ways: Optional[int] = None


@dataclass
class BusbarSpec(BaseEntity):
    """Busbar specifications"""
    material: Optional[str] = None  # Copper, Aluminum
    configuration: Optional[str] = None  # Horizontal, Vertical, L-shaped
    rated_current: Optional[float] = None  # Amperes
    short_time_current: Optional[float] = None  # kA
    peak_current: Optional[float] = None  # kA
    coating: Optional[str] = None  # Tin-plated, Silver-plated, Bare
    cross_section: Optional[float] = None  # mm²
    thickness: Optional[float] = None  # mm
    width: Optional[float] = None  # mm
    length: Optional[float] = None  # mm
    spacing: Optional[float] = None  # mm
    support_spacing: Optional[float] = None  # mm
    temperature_rise: Optional[float] = None  # °C


# =============================================================================
# PROTECTION DEVICES
# =============================================================================

@dataclass
class CircuitBreaker(BaseEntity):
    """Circuit breaker"""
    breaker_id: str = None
    breaker_type: Optional[str] = None  # MCB, MCCB, ACB, VCB
    rated_voltage: Optional[str] = None
    rated_current: Optional[float] = None  # Amperes
    breaking_capacity: Optional[float] = None  # kA
    poles: Optional[int] = None  # 1, 2, 3, 4
    tripping_curve: Optional[str] = None  # B, C, D, K, Z
    adjustable_thermal_setting: Optional[float] = None
    adjustable_magnetic_setting: Optional[float] = None
    earth_fault_protection: Optional[bool] = False
    auxiliary_contacts: Optional[int] = None
    shunt_trip: Optional[bool] = False
    under_voltage_release: Optional[bool] = False
    motor_protection: Optional[bool] = False


@dataclass
class Fuse(BaseEntity):
    """Fuse protection"""
    fuse_id: str = None
    fuse_type: Optional[str] = None  # HRC, NH, LV, MV
    rated_voltage: Optional[str] = None
    rated_current: Optional[float] = None
    breaking_capacity: Optional[float] = None  # kA
    fuse_size: Optional[str] = None  # 00, 0, 1, 2, 3, 4
    time_current_characteristic: Optional[str] = None  # gG, aM, gM


@dataclass
class ProtectionRelay(BaseEntity):
    """Protection relay"""
    relay_id: str = None
    relay_type: Optional[str] = None  # Overcurrent, Earth Fault, Differential, etc.
    protection_functions: List[str] = field(default_factory=list)  # 50, 51, 87, etc.
    pickup_current: Optional[float] = None
    time_delay: Optional[float] = None  # seconds
    current_transformer_ratio: Optional[str] = None  # e.g., "100/5"
    communication_protocol: Optional[str] = None  # Modbus, IEC 61850, etc.


# =============================================================================
# TRANSFORMERS
# =============================================================================

@dataclass
class Transformer(BaseEntity):
    """Power transformer"""
    transformer_id: str = None
    transformer_type: Optional[str] = None  # Distribution, Power, Isolation
    rated_power: Optional[float] = None  # kVA
    primary_voltage: Optional[str] = None  # e.g., "11kV"
    secondary_voltage: Optional[str] = None  # e.g., "400V"
    connection_type: Optional[str] = None  # Dyn11, Yy0, Dd0, etc.
    frequency: Optional[float] = 50.0  # Hz
    phases: Optional[int] = 3
    cooling_type: Optional[str] = None  # ONAN, ONAF, OFAF, etc.
    vector_group: Optional[str] = None  # Dyn11, etc.
    impedance_voltage: Optional[float] = None  # %
    no_load_losses: Optional[float] = None  # kW
    load_losses: Optional[float] = None  # kW
    temperature_rise: Optional[float] = None  # °C
    insulation_class: Optional[str] = None  # F, H, etc.
    tap_changer: Optional[bool] = False
    tap_range: Optional[str] = None  # e.g., "±5%"


# =============================================================================
# CABLES & WIRING
# =============================================================================

@dataclass
class Cable(BaseEntity):
    """Power cable"""
    cable_id: str = None
    cable_type: Optional[str] = None  # XLPE, PVC, EPR, etc.
    conductor_material: Optional[str] = None  # Copper, Aluminum
    number_of_cores: Optional[int] = None  # 1, 2, 3, 4, 5
    cross_section: Optional[float] = None  # mm²
    voltage_rating: Optional[str] = None  # e.g., "0.6/1kV"
    current_carrying_capacity: Optional[float] = None  # Amperes
    length: Optional[float] = None  # meters
    installation_method: Optional[str] = None  # Underground, Overhead, Cable Tray
    armoured: Optional[bool] = False
    fire_resistant: Optional[bool] = False
    screen_shield: Optional[bool] = False
    color_code: Optional[str] = None


@dataclass
class WireSpec(BaseEntity):
    """Wire specifications"""
    wire_size: Optional[str] = None  # AWG or mm²
    color: Optional[str] = None  # Red, Blue, Yellow, Green, Black, etc.
    insulation_type: Optional[str] = None  # PVC, XLPE, etc.
    insulation_voltage: Optional[str] = None
    temperature_rating: Optional[float] = None  # °C
    stranded: Optional[bool] = True
    number_of_strands: Optional[int] = None


@dataclass
class CableTray(BaseEntity):
    """Cable tray/conduit system"""
    tray_id: str = None
    tray_type: Optional[str] = None  # Ladder, Perforated, Solid Bottom
    material: Optional[str] = None  # Galvanized Steel, Stainless Steel, Aluminum
    width: Optional[float] = None  # mm
    height: Optional[float] = None  # mm
    length: Optional[float] = None  # mm
    load_capacity: Optional[float] = None  # kg/m
    fire_rating: Optional[str] = None


# =============================================================================
# LOADS & EQUIPMENT
# =============================================================================

@dataclass
class Load(BaseEntity):
    """Electrical load"""
    load_id: str = None
    load_type: Optional[str] = None  # Motor, Heater, Lighting, etc.
    rated_power: Optional[float] = None  # kW
    rated_voltage: Optional[str] = None
    rated_current: Optional[float] = None  # Amperes
    power_factor: Optional[float] = None
    efficiency: Optional[float] = None  # %
    duty_cycle: Optional[str] = None  # Continuous, Intermittent
    starting_current: Optional[float] = None  # Amperes (for motors)
    operating_hours: Optional[float] = None  # hours/day


@dataclass
class Motor(BaseEntity):
    """Electric motor"""
    motor_id: str = None
    motor_type: Optional[str] = None  # Induction, Synchronous, DC, etc.
    rated_power: Optional[float] = None  # kW
    rated_voltage: Optional[str] = None
    rated_current: Optional[float] = None  # Amperes
    rated_speed: Optional[float] = None  # RPM
    frequency: Optional[float] = 50.0  # Hz
    power_factor: Optional[float] = None
    efficiency: Optional[float] = None  # %
    starting_method: Optional[str] = None  # DOL, Star-Delta, VFD, Soft Starter
    enclosure_type: Optional[str] = None  # TEFC, TENV, ODP
    insulation_class: Optional[str] = None  # F, H
    service_factor: Optional[float] = None
    locked_rotor_current: Optional[float] = None  # Amperes


# =============================================================================
# MEASUREMENT & CONTROL
# =============================================================================

@dataclass
class MeteringDevice(BaseEntity):
    """Energy meter or measurement device"""
    meter_id: str = None
    meter_type: Optional[str] = None  # Energy, Power, Current, Voltage
    measurement_type: Optional[str] = None  # Active, Reactive, Apparent
    accuracy_class: Optional[float] = None  # 0.5, 1.0, etc.
    rated_voltage: Optional[str] = None
    rated_current: Optional[float] = None
    ct_ratio: Optional[str] = None  # e.g., "100/5"
    vt_ratio: Optional[str] = None  # e.g., "11000/110"
    communication_protocol: Optional[str] = None  # Modbus, IEC 61850, etc.
    display_type: Optional[str] = None  # LCD, LED, Digital


@dataclass
class CurrentTransformer(BaseEntity):
    """Current transformer (CT)"""
    ct_id: str = None
    rated_primary_current: Optional[float] = None  # Amperes
    rated_secondary_current: Optional[float] = 5.0  # Amperes (typically 5A or 1A)
    ct_ratio: Optional[str] = None  # e.g., "100/5"
    accuracy_class: Optional[str] = None  # 0.5, 1.0, 3.0, 5P10, etc.
    burden: Optional[float] = None  # VA
    insulation_voltage: Optional[str] = None


@dataclass
class VoltageTransformer(BaseEntity):
    """Voltage transformer (VT/PT)"""
    vt_id: str = None
    rated_primary_voltage: Optional[str] = None
    rated_secondary_voltage: Optional[str] = "110V"  # Typically 110V
    vt_ratio: Optional[str] = None  # e.g., "11000/110"
    accuracy_class: Optional[str] = None
    burden: Optional[float] = None  # VA
    insulation_class: Optional[str] = None


@dataclass
class ControlUnit(BaseEntity):
    """PLC, SCADA, or control system"""
    control_id: str = None
    control_type: Optional[str] = None  # PLC, RTU, SCADA, HMI
    cpu_model: Optional[str] = None
    io_modules: Optional[int] = None
    communication_ports: List[str] = field(default_factory=list)
    programming_language: Optional[str] = None  # Ladder, ST, FBD, etc.
    memory_capacity: Optional[str] = None
    operating_system: Optional[str] = None


# =============================================================================
# EARTHING & SAFETY
# =============================================================================

@dataclass
class EarthingSystem(BaseEntity):
    """Grounding/earthing system"""
    earthing_id: str = None
    earthing_type: Optional[str] = None  # TN-S, TN-C, TN-C-S, TT, IT
    earth_electrode_type: Optional[str] = None  # Rod, Plate, Grid
    earth_resistance: Optional[float] = None  # Ohms
    conductor_size: Optional[float] = None  # mm²
    conductor_material: Optional[str] = None  # Copper, Aluminum
    number_of_electrodes: Optional[int] = None
    electrode_depth: Optional[float] = None  # meters


# =============================================================================
# CIRCUITS
# =============================================================================

@dataclass
class Circuit(BaseEntity):
    """Electrical circuit"""
    circuit_id: str = None
    circuit_number: Optional[str] = None
    circuit_description: Optional[str] = None
    source_panel: Optional[str] = None
    destination_panel: Optional[str] = None
    rated_current: Optional[float] = None  # Amperes
    cable_size: Optional[float] = None  # mm²
    cable_length: Optional[float] = None  # meters
    voltage_drop: Optional[float] = None  # %
    protection_device: Optional[str] = None
    protection_rating: Optional[float] = None


# =============================================================================
# DOCUMENTS & STANDARDS
# =============================================================================

@dataclass
class Document(BaseEntity):
    """Technical document"""
    document_id: str = None
    document_type: Optional[str] = None  # Specification, Datasheet, Drawing, Manual
    title: Optional[str] = None
    document_number: Optional[str] = None
    revision: Optional[str] = None
    issue_date: Optional[str] = None
    file_path: Optional[str] = None
    page_count: Optional[int] = None


@dataclass
class Standard(BaseEntity):
    """Technical standard or regulation"""
    standard_id: str = None
    standard_number: Optional[str] = None  # IEC 61439, IEEE C37, etc.
    title: Optional[str] = None
    issuing_organization: Optional[str] = None  # IEC, IEEE, BS, DIN, etc.
    version: Optional[str] = None
    year: Optional[int] = None


# =============================================================================
# RELATIONSHIPS
# =============================================================================

class RelationshipType(str, Enum):
    """Standard relationship types in the graph"""
    # Power flow
    SUPPLIES = "SUPPLIES"
    FEEDS = "FEEDS"
    POWERS = "POWERS"

    # Protection
    PROTECTS = "PROTECTS"
    PROTECTED_BY = "PROTECTED_BY"

    # Physical containment
    CONTAINS = "CONTAINS"
    MOUNTED_IN = "MOUNTED_IN"
    INSTALLED_IN = "INSTALLED_IN"

    # Connectivity
    CONNECTS_TO = "CONNECTS_TO"
    CONNECTED_BY = "CONNECTED_BY"

    # Control
    CONTROLS = "CONTROLS"
    MONITORED_BY = "MONITORED_BY"

    # Measurement
    MEASURES = "MEASURES"
    MEASURED_BY = "MEASURED_BY"

    # Documentation
    SPECIFIED_IN = "SPECIFIED_IN"
    DOCUMENTED_BY = "DOCUMENTED_BY"

    # Project
    BELONGS_TO_PROJECT = "BELONGS_TO_PROJECT"


@dataclass
class Relationship:
    """Graph relationship"""
    from_entity_id: str
    to_entity_id: str
    relationship_type: str  # Use RelationshipType enum
    properties: Dict[str, Any] = field(default_factory=dict)


# =============================================================================
# PROJECT
# =============================================================================

@dataclass
class Project:
    """Root project node"""
    project_number: str
    project_name: str
    client: Optional[str] = None
    contract_number: Optional[str] = None
    contract_date: Optional[str] = None
    description: Optional[str] = None
    location: Optional[str] = None
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    status: Optional[str] = "Active"
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary"""
        return {k: v for k, v in self.__dict__.items() if v is not None}


# =============================================================================
# ENTITY REGISTRY
# =============================================================================

ENTITY_TYPES = {
    # Switchgear
    "SwitchgearSpec": SwitchgearSpec,
    "Panel": Panel,
    "BusbarSpec": BusbarSpec,

    # Protection
    "CircuitBreaker": CircuitBreaker,
    "Fuse": Fuse,
    "ProtectionRelay": ProtectionRelay,

    # Transformers
    "Transformer": Transformer,

    # Cables
    "Cable": Cable,
    "WireSpec": WireSpec,
    "CableTray": CableTray,

    # Loads
    "Load": Load,
    "Motor": Motor,

    # Measurement
    "MeteringDevice": MeteringDevice,
    "CurrentTransformer": CurrentTransformer,
    "VoltageTransformer": VoltageTransformer,
    "ControlUnit": ControlUnit,

    # Earthing
    "EarthingSystem": EarthingSystem,

    # Circuits
    "Circuit": Circuit,

    # Documents
    "Document": Document,
    "Standard": Standard,

    # Project
    "Project": Project
}


def get_entity_class(entity_type: str):
    """Get entity dataclass by type name"""
    return ENTITY_TYPES.get(entity_type)
