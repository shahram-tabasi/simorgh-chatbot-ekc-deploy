"""
Comprehensive Specification Extraction Scope (ITEM 1 to ITEM 11)
For Electrical Switchgear and Panel Systems

This module defines the complete extraction template for electrical specifications.
Each item contains multiple sub-parameters with semantic-safe matching.
"""

from typing import List, Dict, Any
from enum import Enum

class ParameterClassification(str, Enum):
    VALUE_PARAMETER = "VALUE_PARAMETER"  # Numerical or coded value (e.g., "400V", "IP54")
    PRESENCE_ONLY = "PRESENCE_ONLY"      # Mentioned without value (e.g., "MCB not used")
    CONSTRAINT = "CONSTRAINT"            # Mandatory/forbidden requirement


# Complete specification extraction scope
SPECIFICATION_EXTRACTION_SCOPE = {
    "ITEM_1": {
        "name": "GENERAL SPECIFICATIONS",
        "sub_parameters": [
            {
                "param_id": "1.1",
                "name": "Switchgear Type",
                "classification": ParameterClassification.VALUE_PARAMETER,
                "synonyms": ["panel type", "switchboard type", "switchgear category"],
                "examples": ["MDB", "SMDB", "MCC", "Distribution Board"],
                "unit": None
            },
            {
                "param_id": "1.2",
                "name": "Rated Voltage",
                "classification": ParameterClassification.VALUE_PARAMETER,
                "synonyms": ["voltage rating", "nominal voltage", "system voltage"],
                "examples": ["400V", "690V", "11kV", "33kV"],
                "unit": "V or kV"
            },
            {
                "param_id": "1.3",
                "name": "Rated Frequency",
                "classification": ParameterClassification.VALUE_PARAMETER,
                "synonyms": ["frequency", "nominal frequency", "system frequency"],
                "examples": ["50Hz", "60Hz"],
                "unit": "Hz"
            },
            {
                "param_id": "1.4",
                "name": "Number of Phases",
                "classification": ParameterClassification.VALUE_PARAMETER,
                "synonyms": ["phases", "phase configuration"],
                "examples": ["3-phase", "single-phase"],
                "unit": None
            },
            {
                "param_id": "1.5",
                "name": "Rated Current",
                "classification": ParameterClassification.VALUE_PARAMETER,
                "synonyms": ["current rating", "main busbar current", "rated amperage"],
                "examples": ["630A", "1600A", "2500A"],
                "unit": "A"
            },
            {
                "param_id": "1.6",
                "name": "Short Circuit Rating",
                "classification": ParameterClassification.VALUE_PARAMETER,
                "synonyms": ["fault level", "short circuit current", "Isc", "SCCR"],
                "examples": ["25kA", "42kA", "50kA"],
                "unit": "kA"
            },
            {
                "param_id": "1.7",
                "name": "Enclosure IP Rating",
                "classification": ParameterClassification.VALUE_PARAMETER,
                "synonyms": ["IP protection", "ingress protection", "enclosure rating"],
                "examples": ["IP54", "IP42", "IP65"],
                "unit": None
            },
            {
                "param_id": "1.8",
                "name": "Installation Location",
                "classification": ParameterClassification.VALUE_PARAMETER,
                "synonyms": ["mounting type", "installation type", "location type"],
                "examples": ["Indoor", "Outdoor", "Floor mounted", "Wall mounted"],
                "unit": None
            },
            {
                "param_id": "1.9",
                "name": "Applicable Standards",
                "classification": ParameterClassification.VALUE_PARAMETER,
                "synonyms": ["compliance standards", "design standards", "relevant standards"],
                "examples": ["IEC 61439", "IEEE C37", "IEC 60947"],
                "unit": None
            }
        ]
    },

    "ITEM_2": {
        "name": "BUSBAR SPECIFICATIONS",
        "sub_parameters": [
            {
                "param_id": "2.1",
                "name": "Busbar Material",
                "classification": ParameterClassification.VALUE_PARAMETER,
                "synonyms": ["bus material", "conductor material"],
                "examples": ["Copper", "Aluminum", "Tinned Copper"],
                "unit": None
            },
            {
                "param_id": "2.2",
                "name": "Main Busbar Rating",
                "classification": ParameterClassification.VALUE_PARAMETER,
                "synonyms": ["main bus current", "busbar capacity"],
                "examples": ["630A", "1600A", "2500A"],
                "unit": "A"
            },
            {
                "param_id": "2.3",
                "name": "Busbar Configuration",
                "classification": ParameterClassification.VALUE_PARAMETER,
                "synonyms": ["bus arrangement", "busbar layout"],
                "examples": ["3-phase + N", "3-phase + N + PE", "4-wire"],
                "unit": None
            },
            {
                "param_id": "2.4",
                "name": "Busbar Cross-Section",
                "classification": ParameterClassification.VALUE_PARAMETER,
                "synonyms": ["busbar size", "bus dimensions"],
                "examples": ["40x5mm", "50x10mm", "100x10mm"],
                "unit": "mm"
            },
            {
                "param_id": "2.5",
                "name": "Busbar Insulation",
                "classification": ParameterClassification.VALUE_PARAMETER,
                "synonyms": ["bus insulation type", "busbar coating"],
                "examples": ["PVC sleeved", "Heat shrink", "Bare"],
                "unit": None
            },
            {
                "param_id": "2.6",
                "name": "Earth Busbar Rating",
                "classification": ParameterClassification.VALUE_PARAMETER,
                "synonyms": ["PE busbar", "ground bar", "earthing bar"],
                "examples": ["Copper 40x5mm", "As per main bus", "50% of main"],
                "unit": "A or mm"
            }
        ]
    },

    "ITEM_3": {
        "name": "CIRCUIT BREAKER SPECIFICATIONS",
        "sub_parameters": [
            {
                "param_id": "3.1",
                "name": "Circuit Breaker Type",
                "classification": ParameterClassification.VALUE_PARAMETER,
                "synonyms": ["CB type", "breaker category"],
                "examples": ["ACB", "MCCB", "MCB", "VCB"],
                "unit": None
            },
            {
                "param_id": "3.2",
                "name": "Main CB Rating",
                "classification": ParameterClassification.VALUE_PARAMETER,
                "synonyms": ["incomer breaker", "main circuit breaker"],
                "examples": ["630A", "1600A", "2500A"],
                "unit": "A"
            },
            {
                "param_id": "3.3",
                "name": "CB Breaking Capacity",
                "classification": ParameterClassification.VALUE_PARAMETER,
                "synonyms": ["Icu", "Ics", "breaking current"],
                "examples": ["25kA", "42kA", "65kA"],
                "unit": "kA"
            },
            {
                "param_id": "3.4",
                "name": "Trip Unit Type",
                "classification": ParameterClassification.VALUE_PARAMETER,
                "synonyms": ["release type", "protection unit"],
                "examples": ["Electronic", "Thermal-magnetic", "Microprocessor"],
                "unit": None
            },
            {
                "param_id": "3.5",
                "name": "Number of Poles",
                "classification": ParameterClassification.VALUE_PARAMETER,
                "synonyms": ["poles", "pole configuration"],
                "examples": ["3-pole", "4-pole", "3P+N"],
                "unit": None
            },
            {
                "param_id": "3.6",
                "name": "CB Manufacturer",
                "classification": ParameterClassification.VALUE_PARAMETER,
                "synonyms": ["breaker brand", "CB make"],
                "examples": ["Siemens", "ABB", "Schneider", "Any approved"],
                "unit": None
            },
            {
                "param_id": "3.7",
                "name": "Outgoing Feeders CB Type",
                "classification": ParameterClassification.VALUE_PARAMETER,
                "synonyms": ["feeder breaker", "distribution CB"],
                "examples": ["MCCB", "MCB"],
                "unit": None
            }
        ]
    },

    "ITEM_4": {
        "name": "PROTECTION AND CONTROL",
        "sub_parameters": [
            {
                "param_id": "4.1",
                "name": "Overcurrent Protection",
                "classification": ParameterClassification.VALUE_PARAMETER,
                "synonyms": ["OC protection", "overcurrent relay"],
                "examples": ["Built-in trip unit", "Separate relay", "IDMT"],
                "unit": None
            },
            {
                "param_id": "4.2",
                "name": "Short Circuit Protection",
                "classification": ParameterClassification.VALUE_PARAMETER,
                "synonyms": ["SC protection", "instantaneous trip"],
                "examples": ["Magnetic release", "Electronic trip"],
                "unit": None
            },
            {
                "param_id": "4.3",
                "name": "Earth Fault Protection",
                "classification": ParameterClassification.VALUE_PARAMETER,
                "synonyms": ["ground fault", "EF protection", "CBCT"],
                "examples": ["Built-in", "External CBCT", "RCD"],
                "unit": None
            },
            {
                "param_id": "4.4",
                "name": "Undervoltage Protection",
                "classification": ParameterClassification.VALUE_PARAMETER,
                "synonyms": ["UV protection", "undervoltage trip"],
                "examples": ["UVR coil", "Not required", "Optional"],
                "unit": None
            },
            {
                "param_id": "4.5",
                "name": "Control Voltage",
                "classification": ParameterClassification.VALUE_PARAMETER,
                "synonyms": ["auxiliary voltage", "control supply"],
                "examples": ["24VDC", "110VDC", "230VAC"],
                "unit": "V"
            },
            {
                "param_id": "4.6",
                "name": "Interlocking Scheme",
                "classification": ParameterClassification.VALUE_PARAMETER,
                "synonyms": ["mechanical interlock", "electrical interlock"],
                "examples": ["Kirk key", "Mechanical", "Electrical", "Not required"],
                "unit": None
            },
            {
                "param_id": "4.7",
                "name": "Metering Requirements",
                "classification": ParameterClassification.VALUE_PARAMETER,
                "synonyms": ["energy meter", "power meter", "measurement"],
                "examples": ["Multifunction meter", "kWh meter", "Not required"],
                "unit": None
            }
        ]
    },

    "ITEM_5": {
        "name": "WIRING AND CABLES",
        "sub_parameters": [
            {
                "param_id": "5.1",
                "name": "Control Wiring Type",
                "classification": ParameterClassification.VALUE_PARAMETER,
                "synonyms": ["control cable", "wiring specification"],
                "examples": ["XLPE", "PVC", "FR-LSH"],
                "unit": None
            },
            {
                "param_id": "5.2",
                "name": "Control Wire Size",
                "classification": ParameterClassification.VALUE_PARAMETER,
                "synonyms": ["control conductor size"],
                "examples": ["1.5mm²", "2.5mm²", "4mm²"],
                "unit": "mm²"
            },
            {
                "param_id": "5.3",
                "name": "Power Cable Type",
                "classification": ParameterClassification.VALUE_PARAMETER,
                "synonyms": ["main cable", "power conductor"],
                "examples": ["XLPE Cu", "PVC Al", "FR-LSH"],
                "unit": None
            },
            {
                "param_id": "5.4",
                "name": "Cable Entry Type",
                "classification": ParameterClassification.VALUE_PARAMETER,
                "synonyms": ["cable gland", "entry method"],
                "examples": ["Bottom entry", "Top entry", "Side entry"],
                "unit": None
            },
            {
                "param_id": "5.5",
                "name": "Cable Termination",
                "classification": ParameterClassification.VALUE_PARAMETER,
                "synonyms": ["lug type", "termination method"],
                "examples": ["Compression lug", "Bolted lug", "Pin terminal"],
                "unit": None
            },
            {
                "param_id": "5.6",
                "name": "Wire Identification",
                "classification": ParameterClassification.VALUE_PARAMETER,
                "synonyms": ["cable marking", "labeling"],
                "examples": ["Ferrule markers", "Cable tags", "Heat shrink labels"],
                "unit": None
            }
        ]
    },

    "ITEM_6": {
        "name": "INSTRUMENTATION AND METERING",
        "sub_parameters": [
            {
                "param_id": "6.1",
                "name": "Ammeter Type",
                "classification": ParameterClassification.VALUE_PARAMETER,
                "synonyms": ["current meter", "amp meter"],
                "examples": ["Digital", "Analog", "Not required"],
                "unit": None
            },
            {
                "param_id": "6.2",
                "name": "Voltmeter Type",
                "classification": ParameterClassification.VALUE_PARAMETER,
                "synonyms": ["voltage meter"],
                "examples": ["Digital", "Analog", "Multifunction"],
                "unit": None
            },
            {
                "param_id": "6.3",
                "name": "Power/Energy Meter",
                "classification": ParameterClassification.VALUE_PARAMETER,
                "synonyms": ["kW meter", "kWh meter", "multifunction meter"],
                "examples": ["Multifunction digital", "kWh only", "Not required"],
                "unit": None
            },
            {
                "param_id": "6.4",
                "name": "Current Transformers",
                "classification": ParameterClassification.VALUE_PARAMETER,
                "synonyms": ["CT", "current sensor"],
                "examples": ["5A secondary", "1A secondary", "Split-core"],
                "unit": "A"
            },
            {
                "param_id": "6.5",
                "name": "Voltage Transformers",
                "classification": ParameterClassification.VALUE_PARAMETER,
                "synonyms": ["VT", "PT", "potential transformer"],
                "examples": ["110V secondary", "Not required"],
                "unit": "V"
            },
            {
                "param_id": "6.6",
                "name": "Indicator Lamps",
                "classification": ParameterClassification.VALUE_PARAMETER,
                "synonyms": ["signal lamps", "LED indicators"],
                "examples": ["LED type", "Incandescent", "RGB", "Not required"],
                "unit": None
            }
        ]
    },

    "ITEM_7": {
        "name": "COMMUNICATION AND NETWORKING",
        "sub_parameters": [
            {
                "param_id": "7.1",
                "name": "Communication Protocol",
                "classification": ParameterClassification.VALUE_PARAMETER,
                "synonyms": ["protocol", "communication standard"],
                "examples": ["Modbus RTU", "Modbus TCP", "Profibus", "Not required"],
                "unit": None
            },
            {
                "param_id": "7.2",
                "name": "Communication Interface",
                "classification": ParameterClassification.VALUE_PARAMETER,
                "synonyms": ["communication port", "interface type"],
                "examples": ["RS485", "Ethernet", "Not required"],
                "unit": None
            },
            {
                "param_id": "7.3",
                "name": "Remote Monitoring",
                "classification": ParameterClassification.VALUE_PARAMETER,
                "synonyms": ["SCADA interface", "remote access"],
                "examples": ["Required", "Not required", "Optional"],
                "unit": None
            },
            {
                "param_id": "7.4",
                "name": "Data Logging",
                "classification": ParameterClassification.VALUE_PARAMETER,
                "synonyms": ["event recording", "logger"],
                "examples": ["Built-in", "External", "Not required"],
                "unit": None
            }
        ]
    },

    "ITEM_8": {
        "name": "ENCLOSURE AND CONSTRUCTION",
        "sub_parameters": [
            {
                "param_id": "8.1",
                "name": "Enclosure Material",
                "classification": ParameterClassification.VALUE_PARAMETER,
                "synonyms": ["panel material", "cabinet material"],
                "examples": ["Mild steel", "Stainless steel", "Aluminum"],
                "unit": None
            },
            {
                "param_id": "8.2",
                "name": "Sheet Thickness",
                "classification": ParameterClassification.VALUE_PARAMETER,
                "synonyms": ["panel thickness", "sheet gauge"],
                "examples": ["2mm", "1.5mm", "3mm"],
                "unit": "mm"
            },
            {
                "param_id": "8.3",
                "name": "Surface Treatment",
                "classification": ParameterClassification.VALUE_PARAMETER,
                "synonyms": ["coating", "finish", "painting"],
                "examples": ["Powder coated", "Galvanized", "Paint"],
                "unit": None
            },
            {
                "param_id": "8.4",
                "name": "Color Code",
                "classification": ParameterClassification.VALUE_PARAMETER,
                "synonyms": ["panel color", "RAL color"],
                "examples": ["RAL 7035", "RAL 9002", "As per client"],
                "unit": None
            },
            {
                "param_id": "8.5",
                "name": "Door Type",
                "classification": ParameterClassification.VALUE_PARAMETER,
                "synonyms": ["door configuration"],
                "examples": ["Single door", "Double door", "No door"],
                "unit": None
            },
            {
                "param_id": "8.6",
                "name": "Locking Mechanism",
                "classification": ParameterClassification.VALUE_PARAMETER,
                "synonyms": ["lock type", "door lock"],
                "examples": ["Cam lock", "Key lock", "Padlock provision"],
                "unit": None
            },
            {
                "param_id": "8.7",
                "name": "Ventilation",
                "classification": ParameterClassification.VALUE_PARAMETER,
                "synonyms": ["cooling", "air circulation"],
                "examples": ["Forced fan", "Natural", "Not required"],
                "unit": None
            }
        ]
    },

    "ITEM_9": {
        "name": "ACCESSORIES AND COMPONENTS",
        "sub_parameters": [
            {
                "param_id": "9.1",
                "name": "Terminal Blocks",
                "classification": ParameterClassification.VALUE_PARAMETER,
                "synonyms": ["terminals", "connectors"],
                "examples": ["Phoenix", "Weidmuller", "Screw type"],
                "unit": None
            },
            {
                "param_id": "9.2",
                "name": "Neutral Links",
                "classification": ParameterClassification.VALUE_PARAMETER,
                "synonyms": ["neutral bar", "N-link"],
                "examples": ["Separate bar", "Integrated", "Not required"],
                "unit": None
            },
            {
                "param_id": "9.3",
                "name": "Surge Protection",
                "classification": ParameterClassification.VALUE_PARAMETER,
                "synonyms": ["SPD", "surge arrester", "lightning protection"],
                "examples": ["Type 1", "Type 2", "Not required"],
                "unit": None
            },
            {
                "param_id": "9.4",
                "name": "Space Heaters",
                "classification": ParameterClassification.VALUE_PARAMETER,
                "synonyms": ["anti-condensation heater", "panel heater"],
                "examples": ["Required", "Not required", "Thermostat controlled"],
                "unit": None
            },
            {
                "param_id": "9.5",
                "name": "Cable Glands",
                "classification": ParameterClassification.VALUE_PARAMETER,
                "synonyms": ["cable entry", "gland type"],
                "examples": ["Brass", "Plastic", "EMC type"],
                "unit": None
            },
            {
                "param_id": "9.6",
                "name": "Nameplates and Labels",
                "classification": ParameterClassification.VALUE_PARAMETER,
                "synonyms": ["identification plates", "labeling"],
                "examples": ["Engraved", "Laser printed", "Self-adhesive"],
                "unit": None
            }
        ]
    },

    "ITEM_10": {
        "name": "TESTING AND COMMISSIONING",
        "sub_parameters": [
            {
                "param_id": "10.1",
                "name": "Factory Acceptance Test",
                "classification": ParameterClassification.CONSTRAINT,
                "synonyms": ["FAT", "factory test", "works test"],
                "examples": ["Required", "Not required", "Witness required"],
                "unit": None
            },
            {
                "param_id": "10.2",
                "name": "Insulation Resistance Test",
                "classification": ParameterClassification.VALUE_PARAMETER,
                "synonyms": ["IR test", "megger test"],
                "examples": ["1000V for 1 minute", "As per IEC"],
                "unit": "V"
            },
            {
                "param_id": "10.3",
                "name": "High Voltage Test",
                "classification": ParameterClassification.VALUE_PARAMETER,
                "synonyms": ["HV test", "dielectric test"],
                "examples": ["2.5kV for 1 minute", "As per standard"],
                "unit": "kV"
            },
            {
                "param_id": "10.4",
                "name": "Short Circuit Test",
                "classification": ParameterClassification.CONSTRAINT,
                "synonyms": ["SC test", "type test"],
                "examples": ["Type tested design", "Required", "Not required"],
                "unit": None
            },
            {
                "param_id": "10.5",
                "name": "Temperature Rise Test",
                "classification": ParameterClassification.VALUE_PARAMETER,
                "synonyms": ["thermal test", "heating test"],
                "examples": ["As per IEC 61439", "Not required"],
                "unit": "°C"
            },
            {
                "param_id": "10.6",
                "name": "Functional Testing",
                "classification": ParameterClassification.CONSTRAINT,
                "synonyms": ["operation test", "functional check"],
                "examples": ["Required", "As per test plan"],
                "unit": None
            }
        ]
    },

    "ITEM_11": {
        "name": "DOCUMENTATION AND DELIVERABLES",
        "sub_parameters": [
            {
                "param_id": "11.1",
                "name": "General Arrangement Drawing",
                "classification": ParameterClassification.CONSTRAINT,
                "synonyms": ["GA drawing", "layout drawing"],
                "examples": ["Required", "3 copies", "PDF + DWG"],
                "unit": None
            },
            {
                "param_id": "11.2",
                "name": "Single Line Diagram",
                "classification": ParameterClassification.CONSTRAINT,
                "synonyms": ["SLD", "schematic diagram"],
                "examples": ["Required", "As-built", "Approved copy"],
                "unit": None
            },
            {
                "param_id": "11.3",
                "name": "Wiring Diagram",
                "classification": ParameterClassification.CONSTRAINT,
                "synonyms": ["control wiring", "schematic"],
                "examples": ["Required", "Color coded", "Terminal numbered"],
                "unit": None
            },
            {
                "param_id": "11.4",
                "name": "Bill of Materials",
                "classification": ParameterClassification.CONSTRAINT,
                "synonyms": ["BOM", "parts list", "component list"],
                "examples": ["Required", "Excel format", "With manufacturer data"],
                "unit": None
            },
            {
                "param_id": "11.5",
                "name": "Test Certificates",
                "classification": ParameterClassification.CONSTRAINT,
                "synonyms": ["test reports", "certificates"],
                "examples": ["Required", "Signed copies", "All tests"],
                "unit": None
            },
            {
                "param_id": "11.6",
                "name": "Operation Manual",
                "classification": ParameterClassification.CONSTRAINT,
                "synonyms": ["O&M manual", "user manual", "instructions"],
                "examples": ["Required", "English language", "Soft + hard copy"],
                "unit": None
            },
            {
                "param_id": "11.7",
                "name": "Spare Parts List",
                "classification": ParameterClassification.VALUE_PARAMETER,
                "synonyms": ["recommended spares", "spare parts"],
                "examples": ["2 years", "As per contract", "Not required"],
                "unit": None
            }
        ]
    }
}


def get_all_parameters() -> List[Dict[str, Any]]:
    """Get a flat list of all parameters across all items"""
    all_params = []
    for item_key, item_data in SPECIFICATION_EXTRACTION_SCOPE.items():
        for sub_param in item_data["sub_parameters"]:
            all_params.append({
                "item": item_key,
                "item_name": item_data["name"],
                **sub_param
            })
    return all_params


def get_extraction_prompt() -> str:
    """Generate the extraction prompt for the LLM"""
    prompt = """# SPECIFICATION EXTRACTION TASK

## INSTRUCTIONS
You are extracting electrical switchgear specifications from the provided document(s).

### EXTRACTION RULES:
1. **Semantic Matching**: Use tolerance for wording variations, synonyms, abbreviations, spelling errors
2. **Classification**: Mark each parameter as:
   - VALUE_PARAMETER: Has a numerical/coded value (e.g., "400V", "IP54")
   - PRESENCE_ONLY: Mentioned without specific value (e.g., "MCB not used")
   - CONSTRAINT: Mandatory/forbidden requirement

3. **Scope**: Extract ONLY from items listed below. DO NOT skip any sub-parameter.
4. **Not Found**: Mark "NOT FOUND" if absent. NO assumptions or external standards.
5. **Conflicts**: Detect INTERNAL inconsistencies only (within same document set). Extract all conflicting values and add ⚠️ INTERNAL CONFLICT note with sources.

### OUTPUT FORMAT:
One consolidated Markdown table:

| Item No | Sub-Parameter | Classification | Extracted Value | Unit | Page/Section | Source Text |

- **Source Text**: Verbatim quote from document
- **Page/Section**: Page number or MD heading path

## MANDATORY EXTRACTION SCOPE (ITEM 1 to ITEM 11)

"""

    for item_key in sorted(SPECIFICATION_EXTRACTION_SCOPE.keys()):
        item = SPECIFICATION_EXTRACTION_SCOPE[item_key]
        prompt += f"\n### {item['name']}\n"
        for param in item["sub_parameters"]:
            prompt += f"- **{param['param_id']} {param['name']}**"
            if param.get('synonyms'):
                prompt += f" (Synonyms: {', '.join(param['synonyms'])})"
            if param.get('examples'):
                prompt += f" [Examples: {', '.join(param['examples'])}]"
            prompt += f" — Classification: {param['classification']}\n"

    return prompt


def format_extraction_results_as_table(results: List[Dict[str, Any]]) -> str:
    """Format extraction results as Markdown table"""
    table = "| Item No | Sub-Parameter | Classification | Extracted Value | Unit | Page/Section | Source Text |\n"
    table += "|---------|---------------|----------------|-----------------|------|--------------|-------------|\n"

    for result in results:
        item_no = result.get('param_id', '')
        sub_param = result.get('name', '')
        classification = result.get('classification', '')
        value = result.get('extracted_value', 'NOT FOUND')
        unit = result.get('unit', '') or '-'
        page_section = result.get('page_section', '')
        source_text = result.get('source_text', '')[:100]  # Truncate long text

        table += f"| {item_no} | {sub_param} | {classification} | {value} | {unit} | {page_section} | {source_text} |\n"

    return table
