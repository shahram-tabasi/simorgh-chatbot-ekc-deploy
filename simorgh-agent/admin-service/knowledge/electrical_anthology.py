"""
Electrical Systems Knowledge Base
==================================
Standard knowledge about electrical systems, IEC standards, and common specifications.
This knowledge is injected into LLM context to improve understanding of technical queries.

Author: Simorgh Enhancement Team
Date: 2025-12-21
"""

ELECTRICAL_KNOWLEDGE_BASE = """
# Electrical Engineering Reference Guide

## Voltage Classification (IEC 60038)

**Extra Low Voltage (ELV)**
- AC: ≤ 50V
- DC: ≤ 120V
- Applications: Control circuits, electronics, safety systems

**Low Voltage (LV)**
- AC: 50V - 1000V
- DC: 120V - 1500V
- Applications: Building power, industrial machinery, motor control

**Medium Voltage (MV)**
- Range: 1kV - 35kV
- Common levels: 6.6kV, 11kV, 20kV, 33kV
- Applications: Industrial distribution, substations

**High Voltage (HV)**
- Range: > 35kV
- Common levels: 63kV, 132kV, 230kV, 400kV
- Applications: Power transmission

## Standard Voltage Levels (Iran/IEC)

**Low Voltage Distribution:**
- Single-phase: 230V (phase-neutral)
- Three-phase: 400V (phase-phase)
- Frequency: 50Hz

**Medium Voltage Distribution:**
- 6.6kV - Industrial plants, medium motors
- 11kV - Distribution networks
- 20kV - Primary distribution
- 33kV - Sub-transmission

**High Voltage Transmission:**
- 63kV - Regional distribution
- 132kV - Transmission network
- 230kV - National grid
- 400kV - Main transmission

## Switchgear Technologies

**Air Insulated Switchgear (AIS)**
- Insulation: Air
- Type: Traditional, outdoor installation
- Voltage: MV and HV
- Advantages: Lower cost, easy maintenance
- Disadvantages: Large footprint, weather dependent

**Gas Insulated Switchgear (GIS)**
- Insulation: SF6 gas
- Type: Compact, indoor/outdoor
- Voltage: MV and HV
- Advantages: Compact, reliable, weather-proof
- Disadvantages: Higher cost, SF6 environmental concerns

**Metal-Clad Switchgear**
- Feature: Fully enclosed, withdrawable circuit breakers
- Voltage: Typically MV (up to 38kV)
- Compartments: Circuit breaker, busbar, cable, auxiliary
- Protection: Segregated compartments (IEC 62271-200)

**Metal-Enclosed Switchgear**
- Feature: Fixed equipment, compartmentalized
- Voltage: LV and MV
- Less expensive than metal-clad

## Circuit Breaker Technologies

**Vacuum Circuit Breakers (VCB)**
- Voltage: 3.6kV - 40.5kV (MV)
- Arc quenching: Vacuum
- Advantages: Maintenance-free, long life, environmentally friendly
- Applications: Indoor MV switchgear, motor starters

**SF6 Circuit Breakers**
- Voltage: MV and HV
- Arc quenching: SF6 gas
- Advantages: Excellent arc interruption, compact
- Disadvantages: Environmental concerns (greenhouse gas)

**Air Circuit Breakers (ACB)**
- Voltage: LV (up to 1000V)
- Current: Up to 6300A
- Arc quenching: Compressed air or arc chutes
- Features: Withdrawable, motorized, electronic trip units
- Applications: Main distribution boards, motor control centers

**Molded Case Circuit Breakers (MCCB)**
- Voltage: LV (up to 1000V)
- Current: Up to 2500A
- Features: Compact, thermal-magnetic or electronic trip
- Applications: Distribution panels, branch circuits

**Miniature Circuit Breakers (MCB)**
- Voltage: LV (230V/400V)
- Current: Up to 125A
- Types: B, C, D curves (IEC 60898)
- Applications: Final distribution, lighting, small loads

## Protection Relay Functions (IEC 60255 / IEEE C37.2)

**Overcurrent Protection:**
- 50 - Instantaneous Overcurrent
- 51 - Time Overcurrent
- 50/51 - Combined instantaneous + time delay
- Applications: Feeders, transformers, motors

**Differential Protection:**
- 87 - Differential Protection
- Applications: Transformers (87T), Generators (87G), Busbars (87B)
- Principle: Compares current in/out, trips on imbalance

**Distance Protection:**
- 21 - Distance Relay
- Applications: Transmission lines
- Measures impedance to fault

**Voltage Protection:**
- 27 - Undervoltage
- 59 - Overvoltage
- Applications: Generator protection, motor protection

**Frequency Protection:**
- 81O - Over-frequency
- 81U - Under-frequency
- Applications: Generator protection, load shedding

**Earth Fault:**
- 50N/51N - Neutral/Earth overcurrent
- 67N - Directional earth fault

## Enclosure Protection Ratings (IP Codes - IEC 60529)

**Format: IP XY**
- X: Solid particle protection (0-6)
- Y: Liquid ingress protection (0-9)

**Common Ratings:**
- **IP20**: Indoor panels, finger protection
- **IP42**: Indoor switchgear (dust, dripping water)
- **IP54**: Outdoor panels (dust, splashing water)
- **IP65**: Dust-tight, jet-proof (outdoor harsh environments)
- **IP66**: Dust-tight, powerful jet protection
- **IP67**: Dust-tight, temporary immersion

## Short Circuit Calculations (IEC 60909)

**Breaking Capacity (Icu/Icn)**
- Maximum fault current the breaker can interrupt
- Units: kA RMS
- Typical: 16kA, 25kA, 31.5kA, 40kA, 50kA, 65kA

**Short-Time Withstand Current (Icw)**
- Duration: 1 second or 3 seconds
- Important for coordination and selectivity
- Example: 31.5kA for 1s

**Peak Withstand Current (Ipk)**
- First peak of fault current
- Typically: 2.5 × RMS for AC circuits
- Example: If RMS = 40kA, then Ipk = 100kA

**Making Capacity**
- Ability to close onto a fault
- Typically: 2.5 × Breaking capacity

## Busbar Design

**Materials:**
- Copper (Cu): Higher conductivity, more expensive
- Aluminum (Al): Lower cost, larger cross-section needed

**Current Density:**
- Copper: 0.8 - 1.5 A/mm² (normal), 2-3 A/mm² (short duty)
- Aluminum: 0.6 - 1.0 A/mm²

**Temperature Rise:**
- Maximum: 65°C rise above ambient
- Typical ambient: 40°C
- Total temperature: 105°C maximum

**Configuration:**
- Single busbar: Simple, less reliable
- Double busbar: Maintenance flexibility
- Main + Transfer: Allows breaker maintenance

## Transformer Specifications (IEC 60076)

**Ratings:**
- Power: kVA or MVA
- Voltage: Primary/Secondary (e.g., 11kV/0.4kV)
- Frequency: 50Hz or 60Hz
- Phases: Single-phase or Three-phase

**Vector Group:**
- Dyn11: Delta primary, Star secondary, 11 o'clock phase shift
- Yyn0: Star-Star, 0° phase shift
- Dd0: Delta-Delta, 0° phase shift

**Cooling:**
- ONAN: Oil Natural, Air Natural (passive)
- ONAF: Oil Natural, Air Forced (fans)
- OFAF: Oil Forced, Air Forced (pumps + fans)

**Impedance:**
- Typical: 4-6% for distribution transformers
- Affects fault level and voltage regulation

## Current & Voltage Transformers

**Current Transformers (CT):**
- Ratio: e.g., 100/5A, 500/1A
- Accuracy Class: 0.5, 1, 3, 5P, 10P (IEC 61869)
- Burden: Load on secondary (VA)
- Never open-circuit secondary (dangerous voltage)

**Voltage Transformers (VT/PT):**
- Ratio: e.g., 11000/110V, 6600/110V
- Accuracy Class: 0.5, 1, 3
- Burden: Load on secondary (VA)

## Cable Specifications

**Insulation Types:**
- PVC: Up to 70°C, economical
- XLPE: Up to 90°C, better performance
- EPR: Up to 90°C, flexible

**Conductor Material:**
- Copper: Better conductivity
- Aluminum: Lower cost, larger size

**Armoring:**
- SWA: Steel Wire Armored (mechanical protection)
- AWA: Aluminum Wire Armored
- Unarmored: For conduit/tray installation

## Grounding/Earthing Systems (IEC 60364)

**System Types:**
- **TN-S**: Separate neutral and earth (most common)
- **TN-C**: Combined neutral-earth (PEN conductor)
- **TN-C-S**: Combined then separated
- **TT**: Separate earth electrode at installation
- **IT**: Isolated neutral or impedance grounded

**Earth Fault Loop Impedance:**
- Must be low enough to ensure protective device operates
- Formula: Zs ≤ U₀ / Ia
- U₀: Phase-earth voltage
- Ia: Current to operate protective device

## Common Standards

**IEC Standards:**
- IEC 60038: Standard voltages
- IEC 60947: Low-voltage switchgear and controlgear
- IEC 62271: High-voltage switchgear and controlgear
- IEC 60076: Power transformers
- IEC 60909: Short-circuit current calculation
- IEC 60529: IP codes (enclosure protection)
- IEC 61869: Instrument transformers
- IEC 60364: Low-voltage electrical installations

**IEEE Standards:**
- IEEE 1584: Arc flash hazard calculation
- IEEE C37: Protection relay standards
- IEEE 242: Protection and coordination (Buff Book)
- IEEE 141: Grounding (Green Book)

## Power Quality

**Voltage Variations:**
- Nominal ±10% (IEC 60038)
- Sag: Brief voltage drop
- Swell: Brief voltage increase
- Interruption: Complete loss

**Frequency Variations:**
- Nominal ±2% for 50Hz (49-51Hz acceptable)
- Nominal ±2% for 60Hz (59.4-60.6Hz)

**Harmonics:**
- Caused by non-linear loads
- Total Harmonic Distortion (THD)
- Standards: IEEE 519, IEC 61000-3-2

**Power Factor:**
- Ideal: 1.0 (unity)
- Typical industrial: 0.8-0.95
- Correction: Capacitor banks
"""

COMMON_ABBREVIATIONS = {
    # Circuit Breakers
    "ACB": "Air Circuit Breaker",
    "MCCB": "Molded Case Circuit Breaker",
    "MCB": "Miniature Circuit Breaker",
    "VCB": "Vacuum Circuit Breaker",
    "OCB": "Oil Circuit Breaker",
    "SF6 CB": "SF6 Gas Circuit Breaker",

    # Switchgear
    "AIS": "Air Insulated Switchgear",
    "GIS": "Gas Insulated Switchgear",
    "RMU": "Ring Main Unit",
    "MCC": "Motor Control Center",
    "PCC": "Power Control Center",

    # Transformers & Instruments
    "CT": "Current Transformer",
    "VT": "Voltage Transformer",
    "PT": "Potential Transformer",
    "CVT": "Capacitive Voltage Transformer",

    # Voltage Levels
    "ELV": "Extra Low Voltage",
    "LV": "Low Voltage",
    "MV": "Medium Voltage",
    "HV": "High Voltage",
    "EHV": "Extra High Voltage",

    # Protection
    "O/C": "Overcurrent",
    "E/F": "Earth Fault",
    "REF": "Restricted Earth Fault",
    "IDMT": "Inverse Definite Minimum Time",

    # Electrical Units
    "kV": "kiloVolt (1,000 volts)",
    "kA": "kiloAmpere (1,000 amperes)",
    "MVA": "MegaVoltAmpere (apparent power)",
    "MW": "MegaWatt (real power)",
    "kW": "kiloWatt",
    "kVAr": "kiloVolt-Ampere reactive (reactive power)",
    "Hz": "Hertz (frequency)",

    # Insulation & Protection
    "SF6": "Sulfur Hexafluoride (insulating gas)",
    "XLPE": "Cross-Linked Polyethylene (cable insulation)",
    "PVC": "Polyvinyl Chloride",
    "EPR": "Ethylene Propylene Rubber",
    "IP": "Ingress Protection (enclosure rating)",

    # Standards Bodies
    "IEC": "International Electrotechnical Commission",
    "IEEE": "Institute of Electrical and Electronics Engineers",
    "ANSI": "American National Standards Institute",
    "BS": "British Standard",
    "DIN": "Deutsches Institut für Normung (German)",

    # Other
    "THD": "Total Harmonic Distortion",
    "PF": "Power Factor",
    "UPS": "Uninterruptible Power Supply",
    "AVR": "Automatic Voltage Regulator",
    "SCADA": "Supervisory Control and Data Acquisition",
    "RTU": "Remote Terminal Unit",
    "PLC": "Programmable Logic Controller"
}

IRAN_SPECIFIC_STANDARDS = """
## Iran Electrical Standards Context

**Voltage Standards:**
- LV: 230V/400V, 50Hz (aligned with IEC)
- MV Common: 6.6kV, 11kV, 20kV, 33kV
- Grid Frequency: 50Hz ±0.5Hz

**Regulatory Bodies:**
- Tavanir (Iran Grid Management Company)
- ISIRI (Institute of Standards and Industrial Research of Iran)

**Common Practices:**
- Follow IEC standards primarily
- Some BS (British Standards) legacy
- Increasing adoption of IEEE standards for protection

**Typical Industrial Setup:**
- HV Connection: 63kV or 132kV from grid
- MV Distribution: 20kV or 11kV internal
- LV Distribution: 400V/230V for loads
"""

def get_knowledge_context(include_abbreviations: bool = True, include_iran_context: bool = True) -> str:
    """
    Get electrical engineering knowledge base for LLM context

    Args:
        include_abbreviations: Include common electrical abbreviations
        include_iran_context: Include Iran-specific standards and practices

    Returns:
        Formatted knowledge base string
    """
    context = ELECTRICAL_KNOWLEDGE_BASE

    if include_abbreviations:
        abbrev_section = "\n\n## Common Electrical Abbreviations\n\n"
        for abbr, meaning in COMMON_ABBREVIATIONS.items():
            abbrev_section += f"- **{abbr}**: {meaning}\n"
        context += abbrev_section

    if include_iran_context:
        context += f"\n\n{IRAN_SPECIFIC_STANDARDS}"

    return context


def get_abbreviation_meaning(abbr: str) -> str:
    """
    Get the meaning of an electrical abbreviation

    Args:
        abbr: Abbreviation to look up

    Returns:
        Full meaning or empty string if not found
    """
    return COMMON_ABBREVIATIONS.get(abbr.upper(), "")
