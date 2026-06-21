"""
soft_spec.py — Pydantic schema for a Simorgh Design Suite project.

Mirrors simorgh-soft/simorgh-frontend/src/types/project.ts:90-149 and the
defaults in src/context/ProjectContext.tsx:23-75. v1 covers ONLY the
"minimum required to open cleanly" set: identity + electrical defaults.
Nested design data (templates / devices / equipments / outputTypes / parts
library) is left as empty arrays so the user fills it in the simorgh-soft
UI after the redirect.

Each scalar field is wrapped in FieldValue(value, source, confidence) so
provenance is preserved through extraction → reconciliation → confirmation
UI. The reconciler returns a flat ProjectSpec (just the values); the
sidecar `FieldProvenance` map is what the form renders as "from TPMS
OE-04A12065" pills.
"""
from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional
from pydantic import BaseModel, ConfigDict, Field

# Sources we recognize. The reconciler uses this order as a default tiebreak
# when two sources both supply a value with identical confidence:
#   tpms beats user-input only when explicitly fixed; otherwise user wins.
Source = Literal["user", "tpms", "uploads", "chat", "gitlab", "techserver", "default"]
SOURCE_RANK = {"user": 100, "tpms": 80, "uploads": 70,
               "gitlab": 65, "techserver": 60, "chat": 50, "default": 10}


class FieldValue(BaseModel):
    """One source's proposal for a single field."""
    model_config = ConfigDict(extra="forbid")
    value: Any
    source: Source = "default"
    confidence: float = 0.5   # 0..1; reconciler weights by source*confidence
    note: Optional[str] = None  # short human hint ("from OENUM 04A12065")


# ---------------------------------------------------------------------------
# The Project payload. Field names + nesting MUST match the JS schema.
# ---------------------------------------------------------------------------
class MediumVoltage(BaseModel):
    model_config = ConfigDict(extra="allow")
    nominalVoltage: Optional[str] = None
    maxShortCircuitPower: Optional[str] = None
    minShortCircuitPower: Optional[str] = None
    maxCrossSection: Optional[str] = None
    minCrossSection: Optional[str] = None


class LowVoltage(BaseModel):
    model_config = ConfigDict(extra="allow")
    nominalVoltage: Optional[str] = None
    frequency: Optional[str] = None


class TechnicalSettings(BaseModel):
    model_config = ConfigDict(extra="allow")
    mediumVoltage: MediumVoltage = Field(default_factory=MediumVoltage)
    lowVoltage: LowVoltage = Field(default_factory=LowVoltage)


# ---------------------------------------------------------------------------
# Tier-2 nested types: panels (Equipment) and feeders (DeviceTableRow).
# Mirror simorgh-soft/types/project.ts:222-258 — only the fields the UI
# actually reads. Strings throughout (the UI inputs are <input type="text">).
# ---------------------------------------------------------------------------
class DeviceTableRow(BaseModel):
    model_config = ConfigDict(extra="allow")
    id: str
    rowNumber: int
    templateId: str = ""
    templateName: str = ""
    busSection: str = ""
    feederNo: str = ""
    wiringType: str = ""
    ratingPower: str = ""
    flc: str = ""
    equipmentId: str = ""
    tag: str = ""
    description: str = ""
    cableSize: str = ""
    sfdHfd: str = ""
    moduleNo: str = ""
    size: str = ""


class Equipment(BaseModel):
    model_config = ConfigDict(extra="allow")
    id: str
    name: str
    type: Literal["LV", "MV", "HV"] = "MV"
    power: str = ""
    deviceCount: int = 0
    description: str = ""
    # `properties` carries panel-level facts (rated voltage, busbar,
    # IP rating, etc.) — kept as a free-form dict so we can stuff whatever
    # the source gives us; simorgh-soft tolerates any keys here.
    properties: Dict[str, Any] = Field(default_factory=dict)
    devices: List[DeviceTableRow] = Field(default_factory=list)


class ProjectSpec(BaseModel):
    """The minimum sufficient JSON to POST simorgh-soft /api/projects.
    Keep field names EXACTLY as the JS schema expects; simorgh-soft does
    not validate, but its UI reads these keys."""
    model_config = ConfigDict(extra="allow")

    # Identity (always asked / confirmed)
    projectName: str = Field(..., description="Human project name.")
    projectDescription: str = Field("", description="Short description / scope.")

    # Numbers
    projectId: str = Field("", description="Internal PID (often same as OE).")
    projectNumber: str = Field("", description="OE number (TPMS OENUM).")

    # Dates (ISO 8601 strings — simorgh-soft expects strings)
    noticeToProceedDate: str = ""
    deliveryDate: str = ""

    # Org / context. NO demo defaults — rely on real extracted data only.
    # (Previously "SIMORGH"/"IEC"/"Iran"/etc. were here; they leaked into
    # every project and were almost always wrong.)
    planner: str = ""
    designOffice: str = ""
    location: str = ""
    client: str = ""
    standard: str = ""
    country: str = ""
    language: str = ""
    comment: str = ""

    # Electrical defaults — v1 leaves these empty/strings; UI lets user fill.
    technicalSettings: TechnicalSettings = Field(default_factory=TechnicalSettings)

    # Design data. templates/deviceLibrary/outputTypes start empty (user
    # populates in the UI). equipments + devices CAN be pre-populated from
    # tier-2 sources (TPMS panels/feeders, SLD vision, load lists).
    templates: Dict[str, List[Any]] = Field(
        default_factory=lambda: {"LV": [], "MV": [], "HV": []})
    deviceLibrary: Dict[str, List[Any]] = Field(
        default_factory=lambda: {"LV": [], "MV": [], "HV": []})
    devices: List[Any] = Field(default_factory=list)
    equipments: List[Equipment] = Field(default_factory=list)
    outputTypes: List[Any] = Field(default_factory=list)


def classify_voltage(rated_voltage: Optional[str]) -> Literal["LV", "MV", "HV"]:
    """Map a voltage string (e.g. "6.6 kV", "400V", "33000") to simorgh-soft's
    LV / MV / HV bucket. IEC convention: ≤1 kV = LV, 1-36 kV = MV, >36 kV = HV.
    Returns "MV" on parse failure (most common case)."""
    if not rated_voltage:
        return "MV"
    s = str(rated_voltage).strip().lower().replace(",", ".")
    import re
    m = re.search(r"([0-9]+(?:\.[0-9]+)?)\s*(kv|v)?", s)
    if not m:
        return "MV"
    num = float(m.group(1))
    unit = m.group(2) or ""
    kv = num if unit == "kv" else (num / 1000.0 if unit == "v" or num > 100 else num)
    if kv <= 1.0:
        return "LV"
    if kv <= 36.0:
        return "MV"
    return "HV"


# Fields the user MUST confirm before we POST (no defaults exist for these).
REQUIRED_FIELDS = ["projectName", "projectDescription"]

# Fields surfaced in the confirmation form (in display order). All others
# stay implicit (defaults applied silently).
CONFIRMABLE_FIELDS = [
    "projectName", "projectDescription",
    "projectNumber", "projectId",
    "client", "location",
    "standard", "country", "language",
    "noticeToProceedDate", "deliveryDate",
    "planner", "designOffice",
    "comment",
]


# ---------------------------------------------------------------------------
# Category groups — mirrors simorgh-soft's UI tabs PLUS the IEC 61439-1 /
# 62271-200 / SIMARIS design canonical category taxonomy. The frontend
# proposals viewer renders one collapsible section per group. Categories
# with no pending proposals collapse by default.
#
# Field names use the same dotted shape as the LLM extractor's
# _EXTRACT_KEYS — nested keys (`techSettings.general.designTemperature`)
# group under their owning category, NOT under the top-level
# `techSettings` key.
# ---------------------------------------------------------------------------
CATEGORY_GROUPS = [
    {
        "id":    "identity",
        "label": "Project identity",
        "hint":  "Who, what, by whom — the project's primary headers.",
        "fields": [
            "projectName", "projectNumber", "projectId",
            "projectDescription",
            "client", "planner", "designOffice",
        ],
    },
    {
        "id":    "regional",
        "label": "Regional & dates",
        "hint":  "Standards family, jurisdiction, document language, timeline.",
        "fields": [
            "country", "language", "standard",
            "noticeToProceedDate", "deliveryDate",
        ],
    },
    {
        "id":    "site",
        "label": "Site & environmental",
        "hint":  "Site location + IEC 62271-1 service envelope.",
        "fields": [
            "location",
            "techSettings.general.designTemperature",
            "techSettings.general.altitudeAboveSeaLevel",
        ],
    },
    {
        "id":    "network",
        "label": "Network characteristics",
        "hint":  "System voltage, frequency, short-circuit power (IEC 60909 inputs).",
        "fields": [
            "techSettings.general.nominalVoltage",
            "techSettings.general.ratedFrequency",
            "techSettings.general.shortCircuitCurrent",
            "technicalSettings.mediumVoltage.nominalVoltage",
            "technicalSettings.mediumVoltage.maxShortCircuitPower",
            "technicalSettings.mediumVoltage.minShortCircuitPower",
            "technicalSettings.lowVoltage.nominalVoltage",
            "technicalSettings.lowVoltage.frequency",
            "technicalSettings.lowVoltage.permissibleTouchVoltage",
            "technicalSettings.lowVoltage.ambientTemperature",
            "technicalSettings.lowVoltage.numberOfPoles",
            "technicalSettings.lowVoltage.earthFaultDetection",
        ],
    },
    {
        "id":    "compliance",
        "label": "Type testing & compliance",
        "hint":  "BIL, IAC class, insulation levels per IEC 62271-200.",
        "fields": [
            "techSettings.general.bil",
            "techSettings.general.iacClass",
            "techSettings.general.ipRating",
            "techSettings.general.controlVoltage",
            "techSettings.mainCharacteristic.ratedVoltage",
            "techSettings.mainCharacteristic.ratedPowerFrequencyWithstandVoltage",
            "techSettings.mainCharacteristic.mainBusbarRatedCurrent",
            "techSettings.mainCharacteristic.shortTimeWithstandCurrent",
            "techSettings.mainCharacteristic.switchgearType",
            "techSettings.mainCharacteristic.lscPartitionClass",
        ],
    },
    {
        "id":    "construction",
        "label": "Construction & dimensions",
        "hint":  "Panel envelope, sheet, paint, cable entry — IEC 62271-200 §6 / vendor catalogue.",
        "fields": [
            "techSettings.mainCharacteristic.switchboardColor",
            "techSettings.mainCharacteristic.connectionInPanel",
            "techSettings.mainCharacteristic.sheetThickness",
            "techSettings.dimension.height",
            "techSettings.dimension.width",
            "techSettings.dimension.depth",
            "techSettings.dimension.numberOfCubicles",
            "techSettings.entrance.incomingPanels",
            "techSettings.entrance.outgoingPanels",
        ],
    },
    {
        "id":    "busbar",
        "label": "Busbar",
        "hint":  "Configuration + sizes per ABB/Siemens MV catalogue conventions.",
        "fields": [
            "techSettings.busbar.configuration",
            "techSettings.busbar.coating",
            "techSettings.busbar.thermofitCover",
            "techSettings.busbar.mainBusbarSize",
            "techSettings.busbar.neutralBusbarSize",
            "techSettings.busbar.earthBusbarSize",
        ],
    },
    {
        "id":    "auxiliary_voltage",
        "label": "Auxiliary voltages",
        "hint":  "Rated supply Ua per IEC 62271-1 Tables 6/7 (24/48/110/220 V DC, 120/230 V AC).",
        "fields": [
            "techSettings.auxiliaryVoltage.controlProtectionClosingTrippingSignalling",
            "techSettings.auxiliaryVoltage.springChargingMotor",
            "techSettings.auxiliaryVoltage.panelLightingSpaceHeater",
            "techSettings.auxiliaryVoltage.motorSpaceHeater",
        ],
    },
    {
        "id":    "wiring_size",
        "label": "Cable & wire — sizes",
        "hint":  "Control / CT / PT secondary cross-sections, mm².",
        "fields": [
            "techSettings.wireSize.controlCircuit",
            "techSettings.wireSize.ctSecondary",
            "techSettings.wireSize.ptSecondary",
            "techSettings.wireSize.plcPowerSupply",
        ],
    },
    {
        "id":    "wiring_color",
        "label": "Cable & wire — colour code",
        "hint":  "Per IEC 60446: phases, neutral, DC ±, PLC I/O.",
        "fields": [
            "techSettings.wireColor.acPhase",
            "techSettings.wireColor.acNeutral",
            "techSettings.wireColor.dcPlus",
            "techSettings.wireColor.dcMinus",
            "techSettings.wireColor.plcInput",
            "techSettings.wireColor.plcOutput",
            "techSettings.wireColor.threePhase",
        ],
    },
    {
        "id":    "wiring_manufacturer",
        "label": "Cable & wire — manufacturer",
        "hint":  "Approved cable suppliers for LV / MV.",
        "fields": [
            "techSettings.wireManufacturer.mv",
            "techSettings.wireManufacturer.lv",
        ],
    },
    {
        "id":    "finishes",
        "label": "Finishes & labelling",
        "hint":  "Paint coat, RAL, label background / writing colours.",
        "fields": [
            "techSettings.others.thicknessOfPainting",
            "techSettings.others.colorType",
            "techSettings.others.backgroundColor",
            "techSettings.others.writingColor",
        ],
    },
    {
        "id":    "equipment",
        "label": "Equipment & feeders",
        "hint":  "Panels, feeders, devices (from TPMS or extracted from SLDs).",
        "fields": ["equipments"],
    },
    {
        "id":    "notes",
        "label": "Notes",
        "hint":  "Free-form comment / catch-all.",
        "fields": ["comment"],
    },
]


def category_for_field(field: str) -> str:
    """Return the category id a field belongs to, or 'other' if no
    explicit grouping. Used by the frontend to bucket proposals."""
    for group in CATEGORY_GROUPS:
        if field in group["fields"]:
            return group["id"]
    return "other"


# ---------------------------------------------------------------------------
# Provenance sidecar
# ---------------------------------------------------------------------------
class FieldProvenance(BaseModel):
    """Per-field source + confidence info shown next to each form input.
    Distinct from ProjectSpec so the POST body to simorgh-soft stays a
    plain JSON shape it already understands."""
    field: str
    value: Any
    source: Source
    confidence: float
    note: Optional[str] = None
    # If two sources disagreed, the runner-up is here for the UI to show.
    conflict_with: Optional[Dict[str, Any]] = None
