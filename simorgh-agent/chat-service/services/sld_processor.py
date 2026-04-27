"""
SLD (Single Line Diagram) Processor
=====================================
Processes electrical single-line diagrams using GPT-4o vision.
Accepts PDF pages or images and returns structured JSON with:
- Circuit breakers (CBs), feeders, transformers
- Ratings, specifications
- Engineering analysis

Uses OpenAI GPT-4o vision API for image understanding.
"""

import base64
import json
import logging
import os
import uuid
from typing import Dict, Any, Optional, List

import httpx

logger = logging.getLogger(__name__)

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
OPENAI_VISION_MODEL = os.getenv("OPENAI_VISION_MODEL", "gpt-4o")
OPENAI_API_BASE = os.getenv("OPENAI_API_BASE", "https://api.openai.com/v1")

SLD_ANALYSIS_PROMPT = """You are an expert electrical engineer analyzing a Single Line Diagram (SLD)
of an industrial plant's power distribution system.

Analyze this single line diagram and provide a detailed structured JSON response with:

1. **Equipment Identification**: Identify all electrical equipment visible:
   - Circuit Breakers (CBs): type (ACB/MCCB/MCB), rating, position
   - Feeders: name, source, destination, cable details if visible
   - Transformers: type, voltage ratio, rating (kVA/MVA)
   - Busbars: voltage level, sections
   - Motor starters / VFDs
   - Capacitor banks
   - Protection relays

2. **Power Flow**: Trace the power flow from source to loads

3. **Voltage Levels**: All voltage levels present in the diagram

4. **Protection Scheme**: Protection devices and coordination

5. **Engineering Notes**: Any observations about the design

Respond ONLY with valid JSON in this exact structure:
{
    "diagram_type": "single_line_diagram",
    "voltage_levels": ["20kV", "400V"],
    "main_source": {
        "type": "utility/generator/transformer",
        "description": "..."
    },
    "busbars": [
        {
            "id": "BUS-1",
            "voltage": "400V",
            "sections": 1,
            "description": "Main LV busbar"
        }
    ],
    "transformers": [
        {
            "id": "TR-1",
            "type": "power/distribution",
            "primary_voltage": "20kV",
            "secondary_voltage": "400V",
            "rating_kva": 1000,
            "vector_group": "Dyn11",
            "description": "..."
        }
    ],
    "circuit_breakers": [
        {
            "id": "CB-1",
            "type": "ACB/MCCB/MCB",
            "rated_current_a": 1600,
            "breaking_capacity_ka": 50,
            "position": "incoming/outgoing",
            "feeds": "BUS-1",
            "description": "Main incoming breaker"
        }
    ],
    "feeders": [
        {
            "id": "F-1",
            "name": "Feeder name",
            "source_bus": "BUS-1",
            "load_type": "motor/lighting/distribution",
            "rated_current_a": 100,
            "cable_type": "...",
            "protection": "CB-2",
            "description": "..."
        }
    ],
    "motors": [
        {
            "id": "M-1",
            "name": "Motor name",
            "power_kw": 75,
            "voltage": "400V",
            "starter_type": "DOL/Star-Delta/VFD",
            "feeder": "F-1"
        }
    ],
    "protection_devices": [
        {
            "id": "REL-1",
            "type": "overcurrent/earth_fault/differential",
            "settings": "...",
            "protects": "TR-1"
        }
    ],
    "power_flow": [
        "Utility 20kV -> TR-1 -> BUS-1 (400V) -> Feeders F-1..F-n"
    ],
    "engineering_notes": [
        "Observation about the design..."
    ],
    "confidence": 0.85,
    "unreadable_areas": ["description of any unclear areas"]
}"""


class SLDProcessor:
    """Processes Single Line Diagrams using GPT-4o vision."""

    def __init__(self, api_key: str = None, model: str = None):
        self.api_key = api_key or OPENAI_API_KEY
        self.model = model or OPENAI_VISION_MODEL
        self.api_base = OPENAI_API_BASE

    async def analyze_image(
        self,
        image_bytes: bytes,
        mime_type: str = "image/png",
        additional_context: str = "",
    ) -> Dict[str, Any]:
        """
        Analyze a single SLD image using GPT-4o vision.

        Args:
            image_bytes: Raw image bytes (PNG, JPEG, etc.)
            mime_type: MIME type of the image
            additional_context: Optional context about the plant/project

        Returns:
            Structured JSON with equipment, ratings, analysis
        """
        if not self.api_key:
            return {"error": "OpenAI API key not configured", "success": False}

        base64_image = base64.b64encode(image_bytes).decode("utf-8")

        user_text = "Analyze this single line diagram."
        if additional_context:
            user_text += f"\n\nProject context: {additional_context}"

        messages = [
            {
                "role": "system",
                "content": SLD_ANALYSIS_PROMPT,
            },
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": user_text},
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:{mime_type};base64,{base64_image}",
                            "detail": "high",
                        },
                    },
                ],
            },
        ]

        try:
            async with httpx.AsyncClient(timeout=120.0) as client:
                response = await client.post(
                    f"{self.api_base}/chat/completions",
                    headers={
                        "Authorization": f"Bearer {self.api_key}",
                        "Content-Type": "application/json",
                    },
                    json={
                        "model": self.model,
                        "messages": messages,
                        "max_tokens": 4096,
                        "temperature": 0.1,
                    },
                )
                response.raise_for_status()
                data = response.json()

            content = data["choices"][0]["message"]["content"]
            analysis = self._parse_json_response(content)
            analysis["success"] = True
            analysis["model"] = self.model
            analysis["analysis_id"] = str(uuid.uuid4())
            return analysis

        except httpx.HTTPStatusError as e:
            logger.error(f"OpenAI API error: {e.response.status_code} - {e.response.text}")
            return {"error": f"API error: {e.response.status_code}", "success": False}
        except Exception as e:
            logger.error(f"SLD analysis failed: {e}", exc_info=True)
            return {"error": str(e), "success": False}

    async def analyze_pdf_page(
        self,
        pdf_bytes: bytes,
        page_number: int = 0,
        additional_context: str = "",
    ) -> Dict[str, Any]:
        """
        Analyze a specific page from a PDF as SLD.

        Converts the PDF page to an image, then analyzes with vision.
        """
        try:
            import fitz  # PyMuPDF
        except ImportError:
            return {"error": "PyMuPDF not installed. Install with: pip install PyMuPDF", "success": False}

        try:
            doc = fitz.open(stream=pdf_bytes, filetype="pdf")
            if page_number >= len(doc):
                return {"error": f"Page {page_number} out of range (total: {len(doc)})", "success": False}

            page = doc.load_page(page_number)
            # Render at high resolution for better analysis
            mat = fitz.Matrix(3.0, 3.0)  # 3x zoom
            pix = page.get_pixmap(matrix=mat)
            image_bytes = pix.tobytes("png")
            doc.close()

            result = await self.analyze_image(
                image_bytes=image_bytes,
                mime_type="image/png",
                additional_context=additional_context,
            )
            result["source_page"] = page_number
            return result

        except Exception as e:
            logger.error(f"PDF page analysis failed: {e}", exc_info=True)
            return {"error": str(e), "success": False}

    async def analyze_multi_page_pdf(
        self,
        pdf_bytes: bytes,
        pages: List[int] = None,
        additional_context: str = "",
    ) -> Dict[str, Any]:
        """Analyze multiple pages from a PDF, each as a potential SLD."""
        try:
            import fitz
        except ImportError:
            return {"error": "PyMuPDF not installed", "success": False}

        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        total_pages = len(doc)

        if pages is None:
            pages = list(range(min(total_pages, 10)))  # Max 10 pages

        results = []
        for page_num in pages:
            if page_num >= total_pages:
                continue
            result = await self.analyze_pdf_page(
                pdf_bytes, page_num, additional_context
            )
            results.append({"page": page_num, "analysis": result})

        doc.close()

        return {
            "success": True,
            "total_pages": total_pages,
            "analyzed_pages": len(results),
            "pages": results,
        }

    def _parse_json_response(self, content: str) -> Dict[str, Any]:
        """Parse JSON from LLM response, handling markdown code blocks."""
        text = content.strip()
        if text.startswith("```"):
            lines = text.split("\n")
            json_lines = []
            in_block = False
            for line in lines:
                if line.startswith("```") and not in_block:
                    in_block = True
                    continue
                elif line.startswith("```") and in_block:
                    break
                elif in_block:
                    json_lines.append(line)
            text = "\n".join(json_lines)

        try:
            return json.loads(text)
        except json.JSONDecodeError:
            start = content.find("{")
            end = content.rfind("}") + 1
            if start >= 0 and end > start:
                try:
                    return json.loads(content[start:end])
                except json.JSONDecodeError:
                    pass
            return {"raw_analysis": content, "parse_error": True}


# Singleton
_sld_processor: Optional[SLDProcessor] = None


def get_sld_processor() -> SLDProcessor:
    global _sld_processor
    if _sld_processor is None:
        _sld_processor = SLDProcessor()
    return _sld_processor
