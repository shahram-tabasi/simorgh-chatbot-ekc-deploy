"""
TPMS Project Data Models
========================
Python equivalents of C# TPMS models for project data.

These models map to TPMS database tables and are used for:
- Fetching project data from TPMS
- Storing in project-specific PostgreSQL databases
- Building Neo4j project graphs

Author: Simorgh Industrial Assistant
"""

from typing import Optional, List, Any, Dict
from datetime import datetime, date
from pydantic import BaseModel, Field
from enum import IntEnum


# =============================================================================
# TECHNICAL PROPERTY TYPES (Code Mapping)
# =============================================================================

class TechnicalPropertyType(IntEnum):
    """
    Maps to TechnicalProperty.Type column in TPMS.
    Used for resolving integer codes to human-readable values.
    """
    PROJECT_GROUP = 1
    PROJECT_TYPE = 2
    PACKING_TYPE = 3
    ISOLATION = 4
    ISOLATION_TYPE = 5
    PLATING_TYPE = 6
    HOW_TO_PLATING = 7
    COLOR_TYPE = 8
    CONTROL_WIRE_SIZE = 9
    CT_WIRE_SIZE = 10
    PT_WIRE_SIZE = 11
    PHASE_WIRE_COLOR_AC = 12
    NEUTRAL_WIRE_COLOR_AC = 13
    DC_PLUS_WIRE_COLOR = 14
    DC_MINUS_WIRE_COLOR = 15
    DIGITAL_INLET_WIRE_COLOR = 16
    DIGITAL_OUTLET_WIRE_COLOR = 17
    THREE_PHASE_WIRE_COLOR = 18
    PLC_FEEDING_WIRE_SIZE = 19
    INLET_WIRE_SIZE = 20
    OUTLET_WIRE_SIZE = 21
    DC_PLUS_PHASE_WIRE_COLOR = 22
    DC_MINUS_NEUTRAL_WIRE_COLOR = 23
    AC_PLUS_PHASE_WIRE_COLOR = 24
    AC_PLUS_NEUTRAL_WIRE_COLOR = 25
    LABEL_WRITING_COLOR = 26
    LABEL_BACKGROUND_COLOR = 27
    PANEL_TYPE = 28
    INLET_CONTACT = 29
    OUTLET_CONTACT = 30
    ACCESS_FROM = 31
    IP_PROTECTION = 32
    COLOR_REAL = 33
    COLOR_THICKNESS = 34
    CELL_TYPE = 35
    CELL_DEPTH = 36
    CELL_FEEDERS = 37
    CELL_WIDTH = 38
    CELL_HEIGHT = 39
    VERTICAL_BUSBAR_SIZE = 40
    PANEL_BASE = 41
    DRAWER_POLE_COUNT = 42
    MV_PANEL_LAYOUT = 43
    PADLOCK = 44
    MV_CELL_TYPES = 45
    LV_CHAMBER_HEIGHT = 46
    MV_BACK_DUCT = 47
    MV_CELL_WIDTH = 48
    EQUIPMENT_TALL_FRAME = 49
    MILAD_TYPE = 50  # Milad-specific
    MV_CELL_TYPE = 51


# =============================================================================
# TPMS DATA MODELS
# =============================================================================

class ViewProjectMain(BaseModel):
    """
    Main project information from TPMS View_Project_Main.
    This is the entry point - all other data links via IdprojectMain.
    """
    id_project_main: int = Field(..., alias="IdprojectMain")
    oenum: str = Field(..., alias="Oenum")
    order_category: str = Field("", alias="OrderCategory")
    oe_date: str = Field("", alias="Oedate")
    project_name: str = Field("", alias="ProjectName")
    project_name_fa: str = Field("", alias="ProjectNameFa")
    project_expert_label: str = Field("", alias="ProjectExpertLabel")
    technical_supervisor_label: str = Field("", alias="TechnicalSupervisorLabel")
    technical_expert_label: str = Field("", alias="TechnicalExpertLabel")

    class Config:
        populate_by_name = True


class TechnicalProjectIdentity(BaseModel):
    """
    Technical identity/specifications for a project.
    Contains wire specs, colors, isolation, plating, etc.
    """
    id: int = Field(..., alias="Id")
    id_project_main: Optional[int] = Field(None, alias="IdprojectMain")
    project_group: Optional[int] = Field(None, alias="ProjectGroup")
    delivery_date: Optional[date] = Field(None, alias="DeliveryDate")
    above_sea_level: Optional[str] = Field(None, alias="AboveSeaLevel")
    average_temperature: Optional[str] = Field(None, alias="AverageTemperature")
    average_temperature_remark: Optional[str] = Field(None, alias="AverageTemperatureRemarkDescription")

    # Packing & Isolation
    packing_type: Optional[int] = Field(None, alias="PackingType")
    packing_type_remark: Optional[str] = Field(None, alias="PackingTypeRemarkDescription")
    revision: Optional[int] = Field(None, alias="Revision")
    isolation: Optional[int] = Field(None, alias="Isolation")
    isolation_remark: Optional[str] = Field(None, alias="IsolationRemarkDescription")
    isolation_type: Optional[int] = Field(None, alias="IsolationType")
    isolation_type_remark: Optional[str] = Field(None, alias="IsolationTypeRemarkDescription")

    # Plating & Color
    plating_type: Optional[int] = Field(None, alias="PlatingType")
    plating_type_remark: Optional[str] = Field(None, alias="PlatingTypeRemarkDescription")
    how_to_plating: Optional[int] = Field(None, alias="HowToPlating")
    how_to_plating_remark: Optional[str] = Field(None, alias="HowToPlatingRemarkDescription")
    color_thickness: Optional[int] = Field(None, alias="ColorThickness")
    color_thickness_remark: Optional[str] = Field(None, alias="ColorThicknessRemarkDescription")
    color_type: Optional[int] = Field(None, alias="ColorType")
    color_type_remark: Optional[str] = Field(None, alias="ColorTypeRemarkDescription")

    # Wire Sizes
    control_wire_size: Optional[int] = Field(None, alias="ControlWireSize")
    control_wire_size_remark: Optional[str] = Field(None, alias="ControlWireSizeRemarkDescription")
    ct_wire_size: Optional[int] = Field(None, alias="CtWireSize")
    ct_wire_size_remark: Optional[str] = Field(None, alias="CtWireSizeRemarkDescription")
    pt_wire_size: Optional[int] = Field(None, alias="PtWireSize")
    pt_wire_size_remark: Optional[str] = Field(None, alias="PtWireSizeRemarkDescription")
    plc_feeding_wire_size: Optional[int] = Field(None, alias="PlcFeedingWireSize")
    plc_feeding_wire_size_remark: Optional[str] = Field(None, alias="PlcFeedingWireSizeRemarkDescription")
    inlet_wire_size: Optional[int] = Field(None, alias="InletWireSize")
    inlet_wire_size_remark: Optional[str] = Field(None, alias="InletWireSizeRemarkDescription")
    outlet_wire_size: Optional[int] = Field(None, alias="OutletWireSize")
    outlet_wire_size_remark: Optional[str] = Field(None, alias="OutletWireSizeRemarkDescription")

    # Wire Colors - AC
    phase_wire_color: Optional[int] = Field(None, alias="PhaseWireColor")
    phase_wire_color_remark: Optional[str] = Field(None, alias="PhaseWireColorRemarkDescription")
    natural_wire_color: Optional[int] = Field(None, alias="NaturalWireColor")
    natural_wire_color_remark: Optional[str] = Field(None, alias="NaturalWireColorRemarkDescription")
    three_phase_wire_color: Optional[int] = Field(None, alias="ThreePhaseWireColor")
    three_phase_wire_color_remark: Optional[str] = Field(None, alias="ThreePhaseWireColorRemarkDescription")

    # Wire Colors - DC
    dc_plus_wire_color: Optional[int] = Field(None, alias="DcPlusWireColor")
    dc_plus_wire_color_remark: Optional[str] = Field(None, alias="DcPlusWireColorRemarkDescription")
    dc_minus_wire_color: Optional[int] = Field(None, alias="DcMinesWireColor")
    dc_minus_wire_color_remark: Optional[str] = Field(None, alias="DcMinesWireColorRemarkDescription")
    dc_plus_phase_wire_color: Optional[int] = Field(None, alias="DcPlusPhaseWireColor")
    dc_plus_phase_wire_color_remark: Optional[str] = Field(None, alias="DcPlusPhaseWireColorRemarkDescription")
    dc_minus_natural_wire_color: Optional[int] = Field(None, alias="DcMinesNaturalWireColor")
    dc_minus_natural_wire_color_remark: Optional[str] = Field(None, alias="DcMinesNaturalWireColorRemarkDescription")

    # Wire Colors - Digital
    digital_inlet_wire_color: Optional[int] = Field(None, alias="DigitalInletWireColor")
    digital_inlet_wire_color_remark: Optional[str] = Field(None, alias="DigitalInletWireColorRemarkDescription")
    digital_outlet_wire_color: Optional[int] = Field(None, alias="DigitalOutletWireColor")
    digital_outlet_wire_color_remark: Optional[str] = Field(None, alias="DigitalOutletWireColorRemarkDescription")

    # Wire Colors - AC Extended
    ac_plus_phase_wire_color: Optional[int] = Field(None, alias="AcPlusPhaseWireColor")
    ac_plus_phase_wire_color_remark: Optional[str] = Field(None, alias="AcPlusPhaseWireColorRemarkDescription")
    ac_plus_natural_wire_color: Optional[int] = Field(None, alias="AcPlusNaturalWireColor")
    ac_plus_natural_wire_color_remark: Optional[str] = Field(None, alias="AcPlusNaturalWireColorRemarkDescription")

    # Label Colors
    label_writing_color: Optional[int] = Field(None, alias="LabelWritingColor")
    label_writing_color_remark: Optional[str] = Field(None, alias="LabelWritingColorRemarkDescription")
    label_background_color: Optional[int] = Field(None, alias="LabelBackgroundColor")
    label_background_color_remark: Optional[str] = Field(None, alias="LabelBackgroundColorRemarkDescription")

    # Wire Brands
    wire_brand: Optional[str] = Field(None, alias="WireBrand")
    control_wire_brand: Optional[str] = Field(None, alias="ControlWireBrand")

    # Metadata
    type: Optional[int] = Field(None, alias="Type")  # 0=for build, 1=for info
    finished: Optional[int] = Field(None, alias="Finished")
    usr_username: Optional[str] = Field(None, alias="UsrUsername")
    date_created: Optional[datetime] = Field(None, alias="DateCreated")

    class Config:
        populate_by_name = True


class TechnicalProjectIdentityAdditionalField(BaseModel):
    """Additional custom fields for project identity."""
    id: int = Field(..., alias="Id")
    id_technical_project_identity: Optional[int] = Field(None, alias="IdtechnicalProjectIdentity")
    id_project_main: Optional[int] = Field(None, alias="IdprojectMain")
    field_title: Optional[str] = Field(None, alias="FieldTitle")
    field_descriptions: Optional[str] = Field(None, alias="FieldDescriptions")
    date_u: Optional[datetime] = Field(None, alias="DateU")
    status: Optional[int] = Field(None, alias="Status")

    class Config:
        populate_by_name = True


class TechnicalPanelIdentity(BaseModel):
    """
    Panel/Switchgear identity and specifications.
    Each project can have multiple panels.
    """
    id: int = Field(..., alias="Id")
    id_project_main: int = Field(..., alias="IdprojectMain")
    id_project_scope: Optional[int] = Field(None, alias="IdprojectScope")  # Panel ID
    product_type_label: Optional[str] = Field(None, alias="ProductTypeLabel")

    # Panel Basic Info
    plane_name_1: Optional[str] = Field(None, alias="PlaneName1")
    plane_type: Optional[str] = Field(None, alias="PlaneType")
    plane_type_remark: Optional[str] = Field(None, alias="PlaneTypeRemarkDescription")
    cell_count: Optional[int] = Field(None, alias="CellCount")

    # Padlock & Layout
    padlock_key_contactor: Optional[int] = Field(None, alias="PadLockKeyContactor")
    padlock_key_test: Optional[int] = Field(None, alias="PadlockKeyTest")
    padlock_switch_test: Optional[int] = Field(None, alias="PadlockSwitchTest")
    layout_type: Optional[int] = Field(None, alias="LayoutType")
    layout_type_remark: Optional[str] = Field(None, alias="LayoutTypeRemarkDescription")

    # Plating & Isolation (Panel-specific)
    how_to_plating: Optional[int] = Field(None, alias="HowToPlating")
    how_to_plating_remark: Optional[str] = Field(None, alias="HowToPlatingRemarkDescription")
    packing_type_remark: Optional[str] = Field(None, alias="PackingTypeRemarkDescription")
    isolation_type: Optional[int] = Field(None, alias="IsolationType")
    isolation_type_remark: Optional[str] = Field(None, alias="IsolationTypeRemarkDescription")
    plating_type: Optional[int] = Field(None, alias="PlatingType")
    plating_type_remark: Optional[str] = Field(None, alias="PlatingTypeRemarkDescription")
    isolation: Optional[int] = Field(None, alias="Isolation")
    isolation_remark: Optional[str] = Field(None, alias="IsolationRemarkDescription")

    # Dimensions
    height: Optional[str] = Field(None, alias="Height")
    width: Optional[str] = Field(None, alias="Width")
    depth: Optional[str] = Field(None, alias="Depth")

    # Electrical Ratings
    voltage_rate: Optional[str] = Field(None, alias="VoltageRate")
    voltage_rate_remark: Optional[str] = Field(None, alias="VoltageRateRemarkDescription")
    switch_amperage: Optional[str] = Field(None, alias="SwitchAmperage")
    rated_voltage: Optional[str] = Field(None, alias="RatedVoltage")
    rated_voltage_remark: Optional[str] = Field(None, alias="RatedVoltageRemarkDescription")
    frequency: int = Field(50, alias="Frequency")
    frequency_remark: Optional[str] = Field(None, alias="FrequencyRemarkDescription")

    # Busbar
    kabus: Optional[str] = Field(None, alias="Kabus")  # kA busbar rating
    abus: Optional[str] = Field(None, alias="Abus")  # A busbar rating
    main_busbar_size: Optional[str] = Field(None, alias="MainBusbarSize")
    earth_size: Optional[str] = Field(None, alias="EarthSize")
    neutral_size: Optional[str] = Field(None, alias="NeutralSize")
    type_busbar: int = Field(0, alias="TypeBusbar")

    # Contacts
    inlet_contact: Optional[int] = Field(None, alias="InletContact")
    inlet_contact_remark: Optional[str] = Field(None, alias="InletContactRemarkDescription")
    outlet_contact: Optional[int] = Field(None, alias="OutletContact")
    outlet_contact_remark: Optional[str] = Field(None, alias="OutletContactRemarkDescription")

    # Access & Protection
    access_from: Optional[int] = Field(None, alias="AccessFrom")
    access_from_remark: Optional[str] = Field(None, alias="AccessFromRemarkDescription")
    ip: Optional[int] = Field(None, alias="Ip")
    ip_remark: Optional[str] = Field(None, alias="IpRemarkDescription")

    # Color
    color_real: Optional[int] = Field(None, alias="ColorReal")
    color_real_remark: Optional[str] = Field(None, alias="ColorRealRemarkDescription")

    # Short Circuit & Protection
    cpcts: Optional[str] = Field(None, alias="Cpcts")  # Conditional peak withstand current
    scm: Optional[str] = Field(None, alias="Scm")  # Short-circuit making capacity
    plsh: Optional[str] = Field(None, alias="Plsh")  # Peak let-through short-circuit current
    msh: Optional[str] = Field(None, alias="Msh")  # Short-circuit withstand capacity
    mbc: Optional[int] = Field(None, alias="Mbc")  # Main busbar capacity
    mbc_remark: Optional[str] = Field(None, alias="MbcRemarkDescription")

    # Withstand Voltages
    rpfwv: Optional[str] = Field(None, alias="Rpfwv")  # Rated power-frequency withstand voltage
    riwv: Optional[str] = Field(None, alias="Riwv")  # Rated impulse withstand voltage

    # Metadata
    project_identity_id: int = Field(0, alias="ProjectIdentityid")
    revision: int = Field(0, alias="Revision")
    usr_username: str = Field("", alias="UsrUsername")
    date_created: datetime = Field(default_factory=datetime.now, alias="DateCreated")

    class Config:
        populate_by_name = True


class TechnicalPanelIdentityAdditionalField(BaseModel):
    """Additional custom fields for panel identity."""
    id: int = Field(..., alias="Id")
    id_technical_panel_identity: Optional[int] = Field(None, alias="IdtechnicalPanelIdentity")
    id_project_main: Optional[int] = Field(None, alias="IdprojectMain")
    id_project_scope: Optional[int] = Field(None, alias="IdprojectScope")
    field_title: Optional[str] = Field(None, alias="FieldTitle")
    field_descriptions: Optional[str] = Field(None, alias="FieldDescriptions")
    date_u: Optional[datetime] = Field(None, alias="DateU")
    status: Optional[int] = Field(None, alias="Status")

    class Config:
        populate_by_name = True


class TechnicalProperty(BaseModel):
    """
    Property lookup table for code-to-value resolution.
    Type field indicates which property category.
    """
    id: int = Field(..., alias="Id")
    category_id: int = Field(..., alias="CategoryId")
    type: Optional[int] = Field(None, alias="Type")
    title: Optional[str] = Field(None, alias="Title")

    class Config:
        populate_by_name = True


class ViewDraft(BaseModel):
    """
    Feeder/Load list entry for a panel.
    Contains all feeder specifications.
    """
    id: int = Field(..., alias="Id")
    project_id: Optional[int] = Field(None, alias="ProjectId")  # IdprojectMain
    tablo_id: Optional[int] = Field(None, alias="TabloId")  # IdprojectScope (Panel ID)
    tmp_id: Optional[int] = Field(None, alias="TmpId")
    scope_name: Optional[str] = Field(None, alias="ScopeName")

    # Feeder Identification
    bus_section: Optional[str] = Field(None, alias="BusSection")
    feeder_no: Optional[str] = Field(None, alias="FeederNo")  # FL_line
    tag: Optional[str] = Field(None, alias="Tag")  # FL_tag
    designation: Optional[str] = Field(None, alias="Designation")  # FL_feeder_des

    # Feeder Specifications
    wiring_type: Optional[str] = Field(None, alias="WiringType")  # FL_type
    rating_power: Optional[str] = Field(None, alias="RatingPower")  # FL_rating
    flc: Optional[str] = Field(None, alias="Flc")  # FL_flc (Full Load Current)
    module: Optional[str] = Field(None, alias="Module")  # FL_position
    module_type: Optional[str] = Field(None, alias="ModuleType")
    size: Optional[str] = Field(None, alias="Size")  # FL_size
    cable_size: Optional[str] = Field(None, alias="CableSize")  # FL_cable_size

    # Protection
    cb_rating: Optional[str] = Field(None, alias="CbRating")
    overload_rating: Optional[str] = Field(None, alias="OverLoadRating")
    contactor_rating: Optional[str] = Field(None, alias="ContactorRating")

    # Additional
    sfd_hfd: Optional[str] = Field(None, alias="SfdHfd")
    template_name: Optional[str] = Field(None, alias="TemplateName")
    description: Optional[str] = Field(None, alias="Description")
    revision: Optional[int] = Field(None, alias="Revision")
    ordering: int = Field(0, alias="Ordering")

    class Config:
        populate_by_name = True


class ViewDraftEquipment(BaseModel):
    """
    Equipment details for a feeder/draft entry.
    Links via DraftId.
    """
    draft_id: Optional[int] = Field(None, alias="DraftId")
    label: Optional[str] = Field(None, alias="Label")
    ecode: Optional[str] = Field(None, alias="Ecode")  # Equipment code
    equipment: Optional[int] = Field(None, alias="Equipment")
    qty: Optional[int] = Field(None, alias="Qty")
    priority: Optional[int] = Field(None, alias="Priority")
    color: Optional[str] = Field(None, alias="Color")

    # Equipment Details
    sec_des: Optional[str] = Field(None, alias="SecDes")  # Secondary group
    type_des: Optional[str] = Field(None, alias="TypeDes")  # Sub-type
    brand_des: Optional[str] = Field(None, alias="BrandDes")  # Brand
    shr_des: Optional[str] = Field(None, alias="ShrDes")  # Short description
    shr_des_2: Optional[str] = Field(None, alias="ShrDes2")  # EPLAN description
    scode: Optional[str] = Field(None, alias="Scode")  # Manufacturer code
    eng_des: Optional[str] = Field(None, alias="EngDes")  # English description

    class Config:
        populate_by_name = True


class ViewDraftColumn(BaseModel):
    """Brand/column mapping for equipment."""
    id: int = Field(..., alias="Id")
    level: Optional[int] = Field(None, alias="Level")
    name: Optional[str] = Field(None, alias="Name")
    project_id: Optional[int] = Field(None, alias="ProjectId")

    class Config:
        populate_by_name = True


# =============================================================================
# AGGREGATED PROJECT DATA MODEL
# =============================================================================

class TPMSProjectData(BaseModel):
    """
    Complete project data aggregated from all TPMS tables.
    This is what gets synced to project-specific databases.
    """
    # Core project info
    project_main: ViewProjectMain

    # Technical identity (1:1 with project)
    project_identity: Optional[TechnicalProjectIdentity] = None
    project_identity_additional_fields: List[TechnicalProjectIdentityAdditionalField] = []

    # Panels (1:N with project)
    panels: List[TechnicalPanelIdentity] = []
    panel_additional_fields: List[TechnicalPanelIdentityAdditionalField] = []

    # Feeders/Drafts (1:N with panels)
    drafts: List[ViewDraft] = []
    draft_equipment: List[ViewDraftEquipment] = []
    draft_columns: List[ViewDraftColumn] = []

    # Metadata
    fetched_at: datetime = Field(default_factory=datetime.utcnow)
    sync_status: str = "pending"  # pending, synced, error

    def get_panel_by_id(self, panel_id: int) -> Optional[TechnicalPanelIdentity]:
        """Get panel by IdprojectScope."""
        for panel in self.panels:
            if panel.id_project_scope == panel_id:
                return panel
        return None

    def get_feeders_for_panel(self, panel_id: int) -> List[ViewDraft]:
        """Get all feeders for a specific panel."""
        return [d for d in self.drafts if d.tablo_id == panel_id]

    def get_equipment_for_draft(self, draft_id: int) -> List[ViewDraftEquipment]:
        """Get all equipment for a specific draft/feeder."""
        return [e for e in self.draft_equipment if e.draft_id == draft_id]


# =============================================================================
# RESOLVED DATA MODELS (With Property Values)
# =============================================================================

class ResolvedProperty(BaseModel):
    """A property with both code and resolved value."""
    code: Optional[int] = None
    value: Optional[str] = None
    resolved: bool = False
    remark: Optional[str] = None


class ResolvedProjectIdentity(BaseModel):
    """Project identity with resolved property values."""
    id: int
    id_project_main: int
    delivery_date: Optional[date] = None
    above_sea_level: Optional[str] = None
    average_temperature: Optional[str] = None

    # Resolved properties
    project_group: ResolvedProperty = Field(default_factory=ResolvedProperty)
    packing_type: ResolvedProperty = Field(default_factory=ResolvedProperty)
    isolation: ResolvedProperty = Field(default_factory=ResolvedProperty)
    isolation_type: ResolvedProperty = Field(default_factory=ResolvedProperty)
    plating_type: ResolvedProperty = Field(default_factory=ResolvedProperty)
    how_to_plating: ResolvedProperty = Field(default_factory=ResolvedProperty)
    color_type: ResolvedProperty = Field(default_factory=ResolvedProperty)
    color_thickness: ResolvedProperty = Field(default_factory=ResolvedProperty)

    # Wire sizes (resolved)
    control_wire_size: ResolvedProperty = Field(default_factory=ResolvedProperty)
    ct_wire_size: ResolvedProperty = Field(default_factory=ResolvedProperty)
    pt_wire_size: ResolvedProperty = Field(default_factory=ResolvedProperty)

    # Wire colors (resolved)
    phase_wire_color: ResolvedProperty = Field(default_factory=ResolvedProperty)
    natural_wire_color: ResolvedProperty = Field(default_factory=ResolvedProperty)
    dc_plus_wire_color: ResolvedProperty = Field(default_factory=ResolvedProperty)
    dc_minus_wire_color: ResolvedProperty = Field(default_factory=ResolvedProperty)

    # Brands (direct values)
    wire_brand: Optional[str] = None
    control_wire_brand: Optional[str] = None


class ResolvedPanelIdentity(BaseModel):
    """Panel identity with resolved property values."""
    id: int
    id_project_main: int
    id_project_scope: Optional[int] = None
    plane_name: Optional[str] = None
    plane_type: Optional[str] = None
    cell_count: Optional[int] = None

    # Dimensions
    height: Optional[str] = None
    width: Optional[str] = None
    depth: Optional[str] = None

    # Electrical (direct values)
    voltage_rate: Optional[str] = None
    rated_voltage: Optional[str] = None
    switch_amperage: Optional[str] = None
    frequency: int = 50

    # Busbar (direct values)
    kabus: Optional[str] = None
    abus: Optional[str] = None
    main_busbar_size: Optional[str] = None
    earth_size: Optional[str] = None
    neutral_size: Optional[str] = None

    # Short circuit (direct values)
    scm: Optional[str] = None
    cpcts: Optional[str] = None

    # Resolved properties
    layout_type: ResolvedProperty = Field(default_factory=ResolvedProperty)
    ip: ResolvedProperty = Field(default_factory=ResolvedProperty)
    access_from: ResolvedProperty = Field(default_factory=ResolvedProperty)
    inlet_contact: ResolvedProperty = Field(default_factory=ResolvedProperty)
    outlet_contact: ResolvedProperty = Field(default_factory=ResolvedProperty)
    color_real: ResolvedProperty = Field(default_factory=ResolvedProperty)
    isolation: ResolvedProperty = Field(default_factory=ResolvedProperty)
    isolation_type: ResolvedProperty = Field(default_factory=ResolvedProperty)
    plating_type: ResolvedProperty = Field(default_factory=ResolvedProperty)
