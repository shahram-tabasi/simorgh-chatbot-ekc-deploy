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

    # Org / context — sensible Iran/IEC defaults match simorgh-soft's UI.
    planner: str = "SIMORGH"
    designOffice: str = "ELECTRO KAVIR"
    location: str = ""
    client: str = ""
    standard: str = "IEC"
    country: str = "Iran"
    language: str = "English"
    comment: str = ""

    # Electrical defaults — v1 leaves these empty/strings; UI lets user fill.
    technicalSettings: TechnicalSettings = Field(default_factory=TechnicalSettings)

    # Design data — empty at creation; user populates in the UI.
    templates: Dict[str, List[Any]] = Field(
        default_factory=lambda: {"LV": [], "MV": [], "HV": []})
    deviceLibrary: Dict[str, List[Any]] = Field(
        default_factory=lambda: {"LV": [], "MV": [], "HV": []})
    devices: List[Any] = Field(default_factory=list)
    equipments: List[Any] = Field(default_factory=list)
    outputTypes: List[Any] = Field(default_factory=list)


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
