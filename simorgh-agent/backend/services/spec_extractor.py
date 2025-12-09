"""
Specification Extractor Service
=================================
Extracts structured electrical specification data from documents using LLM.
Supports both online (OpenAI) and offline (local LLM) modes.

Author: Simorgh Industrial Assistant
"""

import logging
import json
from typing import Dict, Any, Optional, List
from services.llm_service import LLMService

logger = logging.getLogger(__name__)


class SpecExtractor:
    """
    Extracts electrical specifications from documents using LLM
    """

    # Define the complete specification structure
    SPEC_STRUCTURE = {
        "Switchgear_Specifications": [
            "Rated_Short_Time_Withstand_Current",
            "Main_Busbar_Rated_Current",
            "Switchboard_Color",
            "Frequency",
            "Service_Voltage",
            "Rated_Insulation_Voltage",
            "Rated_Impulse_Withstand_Voltage",
            "Rated_Power_Frequency_Withstand_Voltage",
            "Degree_of_Protection",
            "Design_Temperature",
            "Switchgear_Access",
            "Altitude_Above_Sea_Level",
            "Thickness_of_Painting",
            "Type_Of_Entrance",
            "Sheet_Thickness",
            "Type_of_Separation",
            "Internal_Arc_Fault_Duration",
            "Rear_Door_Interlock",
            "Chassis",
            "Lifting_Lugs",
            "Ambient_Humidity_Level"
        ],
        "Busbar_Specifications": [
            "Main_Busbar_Configuration",
            "Main_Earth_Bus",
            "Coating",
            "Thermofit_Cover",
            "Busbar_Type",
            "Color_Coding",
            "Neutral_Busbar_Cross_Section_Ratio",
            "Earthing_Busbar_Cross_Section_Ratio",
            "Minimum_Earthing_Busbar_Cross_Section"
        ],
        "Wire_Size": [
            "Control_Circuit",
            "CT_Secondary",
            "PT_Secondary",
            "PLC_Power_Supply"
        ],
        "Wire_Color": [
            "AC_Phase",
            "AC_Neutral",
            "PLC_Input",
            "PLC_Output",
            "Three_Phase",
            "DC_Positive_Negative"
        ],
        "Wire_Specifications": [
            "Voltage",
            "Insulation_Type",
            "Fire_Resistance",
            "Extra_Flexible_or_CU5"
        ],
        "Label_Color": [
            "Writing_Color",
            "Background_Color",
            "Name_Plate"
        ],
        "Auxiliary_Voltage": [
            "Control_Protection_Closing_Tripping_Signalling",
            "Spring_Charging_Motor",
            "Panel_Lighting_Space_Heater",
            "Motors_Space_Heater"
        ],
        "Accessories": [
            "Mini_Contactor",
            "Hygrostat_or_Thermostat",
            "Earth_Leakage",
            "MCB_Fuse",
            "Socket_Outlet",
            "Bolt_Washer_Stainless_Steel",
            "Bus_Bar_Joints_High_Strength_Bolts",
            "All_Bus_Joints_Vibration_Proof_Lock_Washers",
            "Key_Interlock",
            "MV_Padlock",
            "Mimic_and_ITS_Color",
            "Signal_Lamp_Specifications",
            "Communication",
            "Outgoing_Filter_for_Drives",
            "Fail_Safe_or_Normal_Operation",
            "Semaphore",
            "Discrepancy_Switch",
            "Door_Stopper",
            "Push_Button_with_Signal",
            "Feeder_Space",
            "Spare_Terminals",
            "Cable_Duct_Fill_Ratio",
            "ANSI_Code"
        ],
        "CT_PT": [
            "Accuracy_Class",
            "Ratio",
            "Thermal_Class"
        ],
        "Measuring_Instrument": [
            "Accuracy_Class",
            "Red_Mark",
            "Display_Size",
            "Scale",
            "Frame_Size",
            "Selector_with_Lock"
        ],
        "Circuit_Breaker": [
            "Rated_Operating_Sequence",
            "Ics_Icw_Icu",
            "Coordination_Type"
        ],
        "Network": [
            "Type_of_Software_Protocol",
            "Type_of_Hardware",
            "Needed_Converter",
            "Switch_Requirement"
        ],
        "Vacuum_Contactor": [
            "Latching_System"
        ]
    }

    def __init__(self, llm_service: LLMService):
        """
        Initialize with LLM service

        Args:
            llm_service: LLM service instance for text generation
        """
        self.llm_service = llm_service

    def extract_specifications(
        self,
        markdown_content: str,
        filename: str,
        llm_mode: str = "online"
    ) -> Dict[str, Any]:
        """
        Extract structured specifications from document content

        Args:
            markdown_content: Document content in markdown format
            filename: Original filename
            llm_mode: "online" (OpenAI) or "offline" (local LLM)

        Returns:
            Dictionary with extracted specifications following SPEC_STRUCTURE
        """
        logger.info(f"🔍 Extracting specifications from {filename} using {llm_mode} mode")

        # Build extraction prompt
        prompt = self._build_extraction_prompt(markdown_content)

        try:
            # Generate extraction using LLM
            result = self.llm_service.generate(
                messages=[
                    {
                        "role": "system",
                        "content": "You are an expert electrical engineer specializing in extracting technical specifications from documents. You must return ONLY valid JSON, no additional text."
                    },
                    {
                        "role": "user",
                        "content": prompt
                    }
                ],
                mode=llm_mode,
                temperature=0.1,  # Low temperature for consistent extraction
                max_tokens=4000,
                use_cache=False  # Don't cache spec extraction
            )

            # Parse LLM response
            response_text = result["response"].strip()

            # Try to extract JSON from response (in case LLM adds extra text)
            json_start = response_text.find('{')
            json_end = response_text.rfind('}') + 1

            if json_start >= 0 and json_end > json_start:
                json_text = response_text[json_start:json_end]
                extracted_data = json.loads(json_text)
            else:
                raise ValueError("No JSON found in LLM response")

            # Validate and normalize structure
            normalized_data = self._normalize_extracted_data(extracted_data)

            logger.info(f"✅ Successfully extracted {len(normalized_data)} categories")

            return {
                "status": "success",
                "filename": filename,
                "llm_mode": result.get("mode"),
                "specifications": normalized_data,
                "metadata": {
                    "tokens_used": result.get("tokens"),
                    "extraction_confidence": self._calculate_confidence(normalized_data)
                }
            }

        except json.JSONDecodeError as e:
            logger.error(f"❌ Failed to parse LLM response as JSON: {e}")
            return {
                "status": "error",
                "error": f"Failed to parse specifications: {str(e)}",
                "filename": filename
            }
        except Exception as e:
            logger.error(f"❌ Spec extraction failed: {e}")
            return {
                "status": "error",
                "error": str(e),
                "filename": filename
            }

    def _build_extraction_prompt(self, content: str) -> str:
        """Build LLM prompt for specification extraction"""

        # Create a structured template
        template = {cat: {field: "" for field in fields} for cat, fields in self.SPEC_STRUCTURE.items()}

        prompt = f"""Extract electrical switchgear specifications from the following document.

**IMPORTANT INSTRUCTIONS**:
1. Return ONLY a valid JSON object, no additional text or explanations
2. Use the exact structure provided below
3. Extract values from the document and populate the corresponding fields
4. If a value is not found in the document, use an empty string ""
5. Preserve units and formatting from the original document (e.g., "400V", "50Hz", "RAL 7035")
6. For fields with multiple options separated by "or", extract the actual value mentioned

**Required JSON Structure**:
```json
{json.dumps(template, indent=2)}
```

**Document Content**:
{content[:8000]}

**OUTPUT (ONLY JSON)**:"""

        return prompt

    def _normalize_extracted_data(self, raw_data: Dict[str, Any]) -> Dict[str, Dict[str, str]]:
        """
        Normalize and validate extracted data against SPEC_STRUCTURE

        Args:
            raw_data: Raw extracted data from LLM

        Returns:
            Normalized data matching SPEC_STRUCTURE
        """
        normalized = {}

        for category, fields in self.SPEC_STRUCTURE.items():
            normalized[category] = {}

            # Get category data from raw extraction
            category_data = raw_data.get(category, {})

            for field in fields:
                # Get field value, default to empty string
                value = category_data.get(field, "")

                # Ensure value is string
                if value is None:
                    value = ""
                elif not isinstance(value, str):
                    value = str(value)

                normalized[category][field] = value.strip()

        return normalized

    def _calculate_confidence(self, data: Dict[str, Dict[str, str]]) -> float:
        """
        Calculate extraction confidence based on filled fields

        Args:
            data: Extracted specification data

        Returns:
            Confidence score between 0 and 1
        """
        total_fields = 0
        filled_fields = 0

        for category_data in data.values():
            for value in category_data.values():
                total_fields += 1
                if value and value.strip():
                    filled_fields += 1

        return filled_fields / total_fields if total_fields > 0 else 0.0

    def get_empty_structure(self) -> Dict[str, Dict[str, str]]:
        """
        Get empty specification structure (all fields with empty strings)

        Returns:
            Empty specification structure
        """
        return {
            category: {field: "" for field in fields}
            for category, fields in self.SPEC_STRUCTURE.items()
        }
