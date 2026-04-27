"""
Specification Agent Service
===========================
Standalone microservice for electrical specification extraction:
- pull specs out of PDF/Excel/Word docs (delegated through doc-processor + LLM)
- classify equipment (transformer, MCC, switchgear, etc.)
- ground the answers in retrieved sections

REST + MCP. Per the agreed contract: AI/COT clients use the /mcp endpoint;
other backend code can call /api/v2/specs/* over REST.
"""
import logging
import os
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from mcp.server.fastmcp import FastMCP

from services.specification_agent import SpecificationAgent
from services.enhanced_spec_extractor import EnhancedSpecExtractor
from services.spec_extractor import SpecExtractor
from services.document_classifier import DocumentClassifier
from services.llm_service import get_llm_service

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("specification-agent-service")

app = FastAPI(title="Simorgh Specification Agent", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ALLOW_ORIGINS", "*").split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ExtractRequest(BaseModel):
    text: str
    equipment_hint: Optional[str] = None
    mode: Optional[str] = None


class ClassifyRequest(BaseModel):
    text: str


@app.get("/health")
def health():
    return {"status": "healthy", "service": "specification-agent-service"}


@app.post("/api/v2/specs/extract")
def specs_extract(req: ExtractRequest) -> Dict[str, Any]:
    """REST: extract structured specifications from a block of text."""
    try:
        llm = get_llm_service()
        extractor = EnhancedSpecExtractor(llm_service=llm)
        return {"specs": extractor.extract(req.text, equipment_hint=req.equipment_hint)}
    except Exception as e:
        logger.exception("extract failed")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/v2/specs/classify")
def specs_classify(req: ClassifyRequest) -> Dict[str, Any]:
    """REST: classify equipment type from a text snippet."""
    try:
        classifier = DocumentClassifier()
        return classifier.classify(req.text)
    except Exception as e:
        logger.exception("classify failed")
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# MCP
# ---------------------------------------------------------------------------
mcp = FastMCP(
    "specification-agent-service",
    instructions="Electrical specification extraction and equipment classification.",
)


@mcp.tool()
async def extract_specifications(text: str, equipment_hint: Optional[str] = None) -> Dict[str, Any]:
    """Extract structured electrical specifications from a text block."""
    llm = get_llm_service()
    extractor = EnhancedSpecExtractor(llm_service=llm)
    return {"specs": extractor.extract(text, equipment_hint=equipment_hint)}


@mcp.tool()
async def classify_equipment(text: str) -> Dict[str, Any]:
    """Classify the equipment type referenced in a text snippet."""
    classifier = DocumentClassifier()
    return classifier.classify(text)


@mcp.tool()
async def extract_specs_from_document(document_id: str, scope: Optional[str] = None) -> Dict[str, Any]:
    """Run the full specification agent over an indexed document."""
    agent = SpecificationAgent()
    return await agent.run(document_id=document_id, scope=scope)


app.mount("/mcp", mcp.streamable_http_app())
