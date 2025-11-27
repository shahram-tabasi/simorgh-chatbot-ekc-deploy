"""
Electrical Engineering Knowledge Graph Ontology
Defines entity types, relationship types, and attributes for MV/LV electrical panels

This ontology represents the "Smart Memory" schema for your knowledge graph.
"""

from typing import Dict, List, Set, Optional
from enum import Enum
from dataclasses import dataclass, field

# ============================================================================
# ENTITY TYPE DEFINITIONS
# ============================================================================

class EntityType(str, Enum):
    """Core entity types in electrical systems"""
    
    # Equipment
    CIRCUIT_BREAKER = "CircuitBreaker"
    TRANSFORMER = "Transformer"
    CABLE = "Cable"
    BUSBAR = "Busbar"
    PANEL = "Panel"
    SWITCHGEAR = "Switchgear"
    CONTACTOR = "Contactor"
    RELAY = "Relay"
    FUSE = "Fuse"
    ISOLATOR = "Isolator"
    
    # Protection & Control
    PROTECTION_RELAY = "ProtectionRelay"
    CURRENT_TRANSFORMER = "CurrentTransformer"
    VOLTAGE_TRANSFORMER = "VoltageTransformer"
    METERING_DEVICE = "MeteringDevice"
    CONTROL_UNIT = "ControlUnit"
    
    # Infrastructure
    FEEDER = "Feeder"
    BUS_SECTION = "BusSection"
    EARTHING_SYSTEM = "EarthingSystem"
    CABLE_TRAY = "CableTray"
    ENCLOSURE = "Enclosure"
    
    # Standards & Specifications
    STANDARD = "Standard"
    SPECIFICATION = "Specification"
    TEST_REPORT = "TestReport"
    
    # Project Context
    PROJECT = "Project"
    LOCATION = "Location"
    MANUFACTURER = "Manufacturer"
    

class VoltageClass(str, Enum):
    """Voltage classification"""
    LV = "LV"  # Low Voltage (< 1kV)
    MV = "MV"  # Medium Voltage (1kV - 36kV)
    HV = "HV"  # High Voltage (> 36kV)


# ============================================================================
# RELATIONSHIP TYPE DEFINITIONS
# ============================================================================

class RelationType(str, Enum):
    """Relationship types between entities"""
    
    # Physical Connections
    CONNECTS_TO = "connects_to"
    FEEDS = "feeds"
    SUPPLIES_POWER_TO = "supplies_power_to"
    CONNECTED_VIA = "connected_via"
    
    # Protection & Control
    PROTECTS = "protects"
    PROTECTED_BY = "protected_by"
    CONTROLS = "controls"
    CONTROLLED_BY = "controlled_by"
    MONITORS = "monitors"
    TRIPS_ON = "trips_on"
    
    # Hierarchical
    PART_OF = "part_of"
    CONTAINS = "contains"
    LOCATED_IN = "located_in"
    INSTALLED_IN = "installed_in"
    
    # Sequential/Logical
    UPSTREAM_OF = "upstream_of"
    DOWNSTREAM_OF = "downstream_of"
    IN_SERIES_WITH = "in_series_with"
    IN_PARALLEL_WITH = "in_parallel_with"
    
    # Compliance & Standards
    COMPLIES_WITH = "complies_with"
    TESTED_BY = "tested_by"
    SPECIFIED_BY = "specified_by"
    MANUFACTURED_BY = "manufactured_by"
    
    # Attributes (as edges for vector embedding)
    HAS_VOLTAGE_RATING = "has_voltage_rating"
    HAS_CURRENT_RATING = "has_current_rating"
    HAS_BREAKING_CAPACITY = "has_breaking_capacity"
    HAS_IP_RATING = "has_ip_rating"
    HAS_MATERIAL = "has_material"
    HAS_SIZE = "has_size"
    HAS_LENGTH = "has_length"
    HAS_CONFIGURATION = "has_configuration"


# ============================================================================
# ATTRIBUTE SCHEMAS FOR EACH ENTITY TYPE
# ============================================================================

@dataclass
class CircuitBreakerAttributes:
    """Attributes for Circuit Breaker entities"""
    
    # Required
    rated_voltage_kv: Optional[float] = None
    rated_current_a: Optional[float] = None
    
    # Optional
    breaking_capacity_ka: Optional[float] = None
    breaking_capacity_duration_s: Optional[float] = None
    number_of_poles: Optional[int] = None
    operating_mechanism: Optional[str] = None  # "spring", "motor", "manual"
    type: Optional[str] = None  # "ACB", "VCB", "SF6", "OCB"
    make: Optional[str] = None
    model: Optional[str] = None
    auxiliary_contacts: Optional[int] = None
    control_voltage_v: Optional[float] = None
    trip_coil_voltage_v: Optional[float] = None
    close_coil_voltage_v: Optional[float] = None
    

@dataclass
class TransformerAttributes:
    """Attributes for Transformer entities"""
    
    # Required
    capacity_kva: Optional[float] = None
    primary_voltage_kv: Optional[float] = None
    secondary_voltage_kv: Optional[float] = None
    
    # Optional
    cooling_type: Optional[str] = None  # "ONAN", "ONAF", "OFAF"
    vector_group: Optional[str] = None  # "Dyn11", "Yyn0"
    impedance_percent: Optional[float] = None
    frequency_hz: Optional[float] = None
    number_of_phases: Optional[int] = None
    tap_changer_type: Optional[str] = None  # "OLTC", "off-load"
    tap_range: Optional[str] = None
    insulation_class: Optional[str] = None


@dataclass
class CableAttributes:
    """Attributes for Cable entities"""
    
    # Required
    size_mm2: Optional[float] = None
    number_of_cores: Optional[int] = None
    
    # Optional
    length_m: Optional[float] = None
    voltage_rating_kv: Optional[float] = None
    conductor_material: Optional[str] = None  # "Cu", "Al"
    insulation_type: Optional[str] = None  # "XLPE", "PVC", "EPR"
    armour_type: Optional[str] = None  # "SWA", "AWA", "unarmoured"
    current_carrying_capacity_a: Optional[float] = None
    installation_method: Optional[str] = None
    cable_type: Optional[str] = None  # "power", "control", "instrumentation"


@dataclass
class BusbarAttributes:
    """Attributes for Busbar entities"""
    
    # Required
    rated_current_a: Optional[float] = None
    
    # Optional
    material: Optional[str] = None  # "Cu", "Al"
    size_mm: Optional[str] = None  # "100x10"
    configuration: Optional[str] = None  # "single", "double", "triple"
    number_of_bars_per_phase: Optional[int] = None
    coating: Optional[str] = None  # "tin-plated", "silver-plated", "bare"
    short_time_current_ka: Optional[float] = None
    ip_rating: Optional[str] = None


@dataclass
class PanelAttributes:
    """Attributes for Panel entities"""
    
    # Required
    voltage_class: Optional[VoltageClass] = None
    
    # Optional
    number_of_feeders: Optional[int] = None
    ip_rating: Optional[str] = None  # "IP54", "IP65"
    dimensions_mm: Optional[str] = None  # "WxHxD"
    sheet_thickness_mm: Optional[float] = None
    material: Optional[str] = None  # "galvanized steel", "stainless steel"
    color: Optional[str] = None
    busbar_arrangement: Optional[str] = None
    fault_level_ka: Optional[float] = None
    panel_type: Optional[str] = None  # "incoming", "outgoing", "distribution"


# ============================================================================
# ATTRIBUTE MAPPING (for all entity types)
# ============================================================================

ENTITY_ATTRIBUTES: Dict[EntityType, type] = {
    EntityType.CIRCUIT_BREAKER: CircuitBreakerAttributes,
    EntityType.TRANSFORMER: TransformerAttributes,
    EntityType.CABLE: CableAttributes,
    EntityType.BUSBAR: BusbarAttributes,
    EntityType.PANEL: PanelAttributes,
}


# ============================================================================
# VALIDATION RULES
# ============================================================================

class ValidationRule:
    """Validation rules for graph consistency"""
    
    @staticmethod
    def validate_voltage_compatibility(entity1: Dict, entity2: Dict, relation: RelationType) -> bool:
        """Check if voltage ratings are compatible between connected entities"""
        if relation in [RelationType.CONNECTS_TO, RelationType.FEEDS]:
            v1 = entity1.get('rated_voltage_kv') or entity1.get('voltage_rating_kv')
            v2 = entity2.get('rated_voltage_kv') or entity2.get('voltage_rating_kv')
            
            if v1 and v2:
                # Allow 10% tolerance
                return abs(v1 - v2) / max(v1, v2) < 0.10
        
        return True
    
    @staticmethod
    def validate_current_rating(entity1: Dict, entity2: Dict, relation: RelationType) -> bool:
        """Check if current ratings are logical"""
        if relation == RelationType.FEEDS:
            # Upstream should have >= current rating than downstream
            i1 = entity1.get('rated_current_a')
            i2 = entity2.get('rated_current_a')
            
            if i1 and i2:
                return i1 >= i2 * 0.8  # Allow some margin
        
        return True
    
    @staticmethod
    def validate_voltage_class(entity1: Dict, entity2: Dict) -> bool:
        """Check voltage class compatibility"""
        vc1 = entity1.get('voltage_class')
        vc2 = entity2.get('voltage_class')
        
        if vc1 and vc2:
            # Transformer can connect different voltage classes
            if entity1.get('type') == EntityType.TRANSFORMER or entity2.get('type') == EntityType.TRANSFORMER:
                return True
            
            # Otherwise, should be same voltage class
            return vc1 == vc2
        
        return True


# ============================================================================
# EDGE EMBEDDING TEMPLATES
# ============================================================================

def create_edge_embedding_text(
    entity1_type: EntityType,
    entity1_name: str,
    relation: RelationType,
    entity2_type: EntityType,
    entity2_name: str,
    attributes: Optional[Dict] = None
) -> str:
    """
    Create natural language text for edge embedding.
    
    This text will be embedded as a vector for semantic search.
    
    Example:
        "CircuitBreaker CB-001 rated 630A feeds Transformer TR-001 rated 1000kVA 
         via Cable CABLE-001 3x240mm² XLPE"
    """
    parts = [
        f"{entity1_type.value} {entity1_name}",
        relation.value.replace('_', ' '),
        f"{entity2_type.value} {entity2_name}"
    ]
    
    if attributes:
        attr_parts = []
        for key, value in attributes.items():
            attr_parts.append(f"{key.replace('_', ' ')}: {value}")
        
        if attr_parts:
            parts.append("with " + ", ".join(attr_parts))
    
    return " ".join(parts)


# ============================================================================
# EXPORT
# ============================================================================

__all__ = [
    'EntityType',
    'VoltageClass',
    'RelationType',
    'CircuitBreakerAttributes',
    'TransformerAttributes',
    'CableAttributes',
    'BusbarAttributes',
    'PanelAttributes',
    'ENTITY_ATTRIBUTES',
    'ValidationRule',
    'create_edge_embedding_text',
]