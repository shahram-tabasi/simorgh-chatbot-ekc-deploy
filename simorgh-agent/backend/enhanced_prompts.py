"""
Enhanced System Prompts for Better Switchboard Variable Extraction
"""

# Comprehensive switchboard parameter categories
SWITCHBOARD_CATEGORIES = {
    "electrical_ratings": [
        "Rated Voltage", "Service Voltage", "Nominal Voltage",
        "Power-frequency withstand voltage", "Lightning impulse withstand voltage",
        "Rated Current", "Main Busbar Rated Current",
        "Rated Short Time Withstand Current", "Short Circuit Current",
        "Rated Peak Withstand Current", "Frequency", "Power Rating"
    ],
    "busbar_specifications": [
        "Main Busbar Configuration", "Main Busbar Size", "Main Busbar Material",
        "Neutral Busbar Size", "Earth Busbar Size", "Busbar Type",
        "Busbar Material", "Busbar Arrangement", "Busbar Coating",
        "Thermofit Cover", "Bus Connection"
    ],
    "physical_specifications": [
        "Switchgear Type", "Degree of Protection", "IP Rating",
        "Sheet Thickness", "Sheet Steel Thickness", "Material Thickness",
        "Depth", "Width", "Height", "Dimensions",
        "Number of Cubicle", "Number of Panels", "Incoming Panels", "Outgoing Panels",
        "Panel Configuration"
    ],
    "environmental_protection": [
        "Switchboard Color", "Color Thickness", "Coating", "Paint Thickness",
        "Degree of Protection", "IP Rating", "Sealing Type",
        "Ambient Temperature", "Operating Temperature", "Temperature Range",
        "Humidity", "Ventilation", "Cooling Method", "Altitude"
    ],
    "control_systems": [
        "Control Circuit", "Protection Circuit", "Closing Circuit", "Tripping Circuit",
        "Signalling Circuit", "Control Voltage", "Auxiliary Voltage",
        "Spring Charging Motor", "Motor Control", "Interlock System",
        "Control , Protection , Closing , Tripping & Signalling"
    ],
    "instrumentation": [
        "PT Secondary", "CT Secondary", "CT& PT Secondary",
        "Metering", "Measurement", "Instrument Transformer",
        "Current Transformer Ratio", "Voltage Transformer Ratio"
    ],
    "earthing_grounding": [
        "Earth Busbar Size", "Earth Busbar Material", "Earth Busbar Configuration",
        "Grounding System", "Earthing Arrangement", "Earth", "PE Bar"
    ],
    "standards_compliance": [
        "Standard", "IEC Standard", "IEEE Standard", "BS Standard",
        "Compliance", "Certification", "Type Test", "Routine Test"
    ],
    "auxiliary_systems": [
        "Panel Lighting", "Space Heater", "Heating System",
        "Auxiliary Power", "Battery System", "UPS",
        "Communication System", "SCADA Interface"
    ],
    "connection_specifications": [
        "Connection in Panel", "Connection Type", "Terminal Type",
        "Cable Entry", "Cable Gland", "Busbar Connection Method"
    ]
}

# Flatten all switchboard keywords
ALL_SWITCHBOARD_KEYWORDS = []
for category in SWITCHBOARD_CATEGORIES.values():
    ALL_SWITCHBOARD_KEYWORDS.extend(category)

def get_enhanced_system_prompt() -> str:
    """
    Get enhanced system prompt with better switchboard categorization.
    """
    
    # Create a more detailed keyword list
    keywords_by_category = "\n".join([
        f"  • {category.replace('_', ' ').title()}: {', '.join(params[:5])}..."
        for category, params in SWITCHBOARD_CATEGORIES.items()
    ])
    
    system_prompt = f"""You are an AI assistant specialized in electrical switchboard and panel design specification analysis.

Your task is to extract ALL technical specifications from the provided document section and categorize them into TWO categories:

1. **SWITCHBOARD VARIABLES** - Any parameter related to switchboard/panel design, electrical specifications, or installation
2. **OTHER VARIABLES** - Project metadata, document info, general requirements not specific to switchboard design

═══════════════════════════════════════════════════════════════════
SWITCHBOARD PARAMETER CATEGORIES (Extract if present):
═══════════════════════════════════════════════════════════════════
{keywords_by_category}

═══════════════════════════════════════════════════════════════════
CRITICAL EXTRACTION RULES:
═══════════════════════════════════════════════════════════════════

1. **OUTPUT FORMAT**: MUST be valid JSON with this exact structure:
   {{
     "switchboard": {{}},
     "other": {{}}
   }}

2. **CATEGORIZATION LOGIC**:
   - "switchboard": ANY parameter about electrical/mechanical/physical specifications
   - "other": Project info, dates, references, general notes
   
3. **KEY NAMING**: Use snake_case, be descriptive but concise:
   ✓ GOOD: "rated_voltage_kv", "busbar_material", "ip_rating"
   ✗ BAD: "voltage", "material", "rating"

4. **VALUE EXTRACTION**:
   - Extract EXACT values with units: "33 kV", "50 Hz", "IP 54"
   - For ranges: "20°C to 55°C" or {{"min": 20, "max": 55, "unit": "°C"}}
   - For lists: Use comma-separated string or JSON array
   - For missing but implied: Use "standard" or "as per specification"

5. **FLATTEN NESTED DATA**: Convert nested structures to flat keys:
   ✗ {{"voltage": {{"nominal": 33}}}}
   ✓ {{"voltage_nominal_kv": 33}}

6. **TABLE DATA**: Extract ALL rows from tables as individual parameters:
   - Table headers become key prefixes
   - Each row becomes separate parameter
   - Example: "phase_conductor_size_mm2": 240

7. **COMPREHENSIVE EXTRACTION**: 
   - Extract from: headers, body text, tables, lists, notes
   - Include: ratings, dimensions, materials, colors, standards
   - Don't skip: seemingly minor details (bolt sizes, paint thickness, etc.)

8. **STANDARD RECOGNITION**: Map common variations:
   - "IP 54" = "IP54" = "Degree of Protection IP54"
   - "33kV" = "33 kV" = "33000V"
   - "Cu" = "Copper"
   - "GI" = "Galvanized Iron"

9. **UNIT HANDLING**: Always include units in value or key:
   ✓ {{"rated_voltage_kv": 33}}
   ✓ {{"rated_voltage": "33 kV"}}
   ✗ {{"rated_voltage": 33}}

10. **NO ADDITIONAL TEXT**: Output ONLY the JSON object, no explanations

═══════════════════════════════════════════════════════════════════
EXTRACTION EXAMPLES:
═══════════════════════════════════════════════════════════════════

Example Input:
"The 33kV switchgear shall be metal-enclosed, air-insulated type complying with IEC 62271-200. 
Rated voltage: 36kV, Rated current: 1250A, Short circuit: 31.5kA for 1s. IP54 protection."

Example Output:
{{
  "switchboard": {{
    "voltage_rated_kv": 36,
    "voltage_service_kv": 33,
    "switchgear_type": "metal-enclosed air-insulated",
    "standard": "IEC 62271-200",
    "current_rated_a": 1250,
    "short_circuit_current_ka": 31.5,
    "short_circuit_duration_s": 1,
    "ip_rating": "IP54",
    "insulation_type": "air-insulated"
  }},
  "other": {{}}
}}

═══════════════════════════════════════════════════════════════════
ADVANCED TABLE EXTRACTION:
═══════════════════════════════════════════════════════════════════

If you encounter a table like:

| Circuit | Voltage | Current | Protection |
|---------|---------|---------|------------|
| Main    | 33 kV   | 1250 A  | Relay      |
| Feeder  | 11 kV   | 630 A   | Fuse       |

Extract as:
{{
  "switchboard": {{
    "main_circuit_voltage": "33 kV",
    "main_circuit_current": "1250 A",
    "main_circuit_protection": "Relay",
    "feeder_circuit_voltage": "11 kV",
    "feeder_circuit_current": "630 A",
    "feeder_circuit_protection": "Fuse"
  }},
  "other": {{}}
}}

═══════════════════════════════════════════════════════════════════
REMEMBER:
═══════════════════════════════════════════════════════════════════
- Be exhaustive: Extract EVERYTHING electrical/mechanical/physical
- Be precise: Include units and exact values
- Be consistent: Use same naming patterns
- Be thorough: Don't skip tables, lists, or notes
- Be accurate: Copy values exactly as stated

Now extract from the following section:
"""
    
    return system_prompt

def get_user_prompt(section_title: str, section_content: str) -> str:
    """
    Generate user prompt for specific section.
    """
    return f"""Section Title: {section_title}

Section Content:
{section_content}

Extract all switchboard-related and other variables as JSON."""

# Export
__all__ = ['get_enhanced_system_prompt', 'get_user_prompt', 'SWITCHBOARD_CATEGORIES', 'ALL_SWITCHBOARD_KEYWORDS']