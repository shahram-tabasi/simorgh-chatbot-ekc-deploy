"""
Document Classifier
===================
Classifies electrical engineering documents into project structure categories.
Uses filename patterns, keywords, and LLM for classification.

Author: Simorgh Industrial Assistant
"""

import os
import re
import logging
from typing import Dict, List, Tuple, Optional
from enum import Enum
from pathlib import Path

logger = logging.getLogger(__name__)


class DocumentCategory(str, Enum):
    """Main document categories"""
    CLIENT = "Client"
    EKC = "Ekc"
    DRAWING = "Drawing"
    IDENTITY = "Identity"
    UNKNOWN = "Unknown"


class ClientDocType(str, Enum):
    """Client document types"""
    CABLE_LIST = "CableList"
    COMMENT = "Comment"
    COVER = "Cover"
    DATASHEET = "DataSheet"
    IO_LIST = "IoList"
    LOAD_LIST = "LoadList"
    LOGIC = "Logic"
    OTHER = "Other"
    SITE_LAYOUT = "SiteLayout"
    SLD_OLD = "SLD_OLD"
    SPEC = "Spec"
    STATUS_OF_DOCUMENT = "StatusOfDocument"


class EKCDocType(str, Enum):
    """EKC document types"""
    # DocumentIndex subcategories
    CLAIM_LIST = "ClaimList"
    CLARIFICATION = "Clarification"
    DATASHEET = "DataSheet"
    MINUTES_OF_MEETING = "MinutesOfMeeting"
    NAMEPLATE = "NamePlate"
    OTHER = "Other"
    PARTLIST = "PartList"
    REPLY_SHEET = "ReplySheet"
    SPARE_PART = "SparePart"
    TRANSMITTAL = "Transmittal"
    VENDOR_LIST = "VendorList"
    VPIS = "VPIS"
    # OrderList subcategories
    DRAFT = "Draft"
    MTO = "Mto"
    ORDER_LIST_PROFORMA = "OrderListProforma"
    # TechnicalCalculation subcategories
    CALCULATION = "Calculation"
    DC_AC_CONSUMPTION = "DC_AC_Consumption"
    HEAT_DISSIPATION = "HeatDissipation"


class DrawingType(str, Enum):
    """Drawing types"""
    # LV drawings
    LV_OUTLINE = "LV_Outline"
    LV_SIMARIS = "LV_Simaris"
    LV_SINGLE_LINE = "LV_SingleLine"
    LV_WIRING = "LV_Wiring"
    # MV drawings
    MV_OUTLINE = "MV_Outline"
    MV_SINGLE_LINE = "MV_SingleLine"
    MV_WIRING = "MV_Wiring"


class DocumentClassifier:
    """
    Classifies electrical engineering documents
    """

    def __init__(self):
        """Initialize classifier with pattern dictionaries"""

        # Client document patterns
        self.client_patterns = {
            ClientDocType.CABLE_LIST: [
                r'cable.*list', r'cablelist', r'-cbl-', r'_cbl_', r'کابل.*لیست', r'لیست.*کابل'
            ],
            ClientDocType.DATASHEET: [
                r'data.*sheet', r'datasheet', r'-ds-', r'_ds_', r'دیتا.*شیت', r'برگه.*داده'
            ],
            ClientDocType.IO_LIST: [
                r'i/?o.*list', r'io.*list', r'input.*output', r'ورودی.*خروجی'
            ],
            ClientDocType.LOAD_LIST: [
                r'load.*list', r'loadlist', r'بار.*لیست', r'لیست.*بار'
            ],
            ClientDocType.SPEC: [
                r'spec(ification)?', r'spc', r'technical.*spec', r'-spc-', r'_spc_', r'مشخصات.*فنی'
            ],
            ClientDocType.SLD_OLD: [
                r'sld', r'single.*line.*diagram', r'دیاگرام.*تک.*خط'
            ],
            ClientDocType.SITE_LAYOUT: [
                r'site.*layout', r'layout', r'چیدمان.*سایت', r'طرح.*سایت'
            ],
            ClientDocType.LOGIC: [
                r'logic.*diagram', r'control.*logic', r'منطق.*کنترل'
            ],
        }

        # EKC document patterns
        self.ekc_patterns = {
            EKCDocType.CLAIM_LIST: [
                r'claim.*list', r'claimlist', r'لیست.*ادعا'
            ],
            EKCDocType.CLARIFICATION: [
                r'clarification', r'توضیح', r'شفاف.*سازی'
            ],
            EKCDocType.MINUTES_OF_MEETING: [
                r'mom', r'minutes.*of.*meeting', r'صورت.*جلسه', r'meeting.*minutes'
            ],
            EKCDocType.PARTLIST: [
                r'part.*list', r'partlist', r'لیست.*قطعات', r'bom'
            ],
            EKCDocType.TRANSMITTAL: [
                r'transmittal', r'رسید', r'transmit'
            ],
            EKCDocType.VENDOR_LIST: [
                r'vendor.*list', r'vendorlist', r'لیست.*تامین.*کننده'
            ],
            EKCDocType.MTO: [
                r'mto', r'material.*take.*off'
            ],
            EKCDocType.CALCULATION: [
                r'calc(ulation)?', r'محاسبه', r'محاسبات'
            ],
            EKCDocType.HEAT_DISSIPATION: [
                r'heat.*dissipation', r'thermal.*calc', r'اتلاف.*حرارت'
            ],
        }

        # Drawing patterns
        self.drawing_patterns = {
            DrawingType.LV_OUTLINE: [
                r'lv.*outline', r'low.*voltage.*outline', r'طرح.*کلی.*lv'
            ],
            DrawingType.LV_SIMARIS: [
                r'simaris', r'lv.*simaris'
            ],
            DrawingType.LV_SINGLE_LINE: [
                r'lv.*sld', r'lv.*single.*line', r'تک.*خط.*lv'
            ],
            DrawingType.LV_WIRING: [
                r'lv.*wiring', r'lv.*wire', r'سیم.*کشی.*lv'
            ],
            DrawingType.MV_OUTLINE: [
                r'mv.*outline', r'medium.*voltage.*outline', r'طرح.*کلی.*mv'
            ],
            DrawingType.MV_SINGLE_LINE: [
                r'mv.*sld', r'mv.*single.*line', r'تک.*خط.*mv'
            ],
            DrawingType.MV_WIRING: [
                r'mv.*wiring', r'mv.*wire', r'سیم.*کشی.*mv'
            ],
        }

        # Keywords for category detection
        self.category_keywords = {
            DocumentCategory.DRAWING: [
                'dwg', 'drawing', 'diagram', 'layout', 'plan', 'schematic',
                'نقشه', 'طرح', 'دیاگرام'
            ],
            DocumentCategory.CLIENT: [
                'client', 'customer', 'owner', 'requirement',
                'مشتری', 'مالک'
            ],
            DocumentCategory.EKC: [
                'ekc', 'vendor', 'supplier', 'purchase', 'order',
                'تامین', 'سفارش', 'خرید'
            ],
        }

    def classify(
        self,
        filename: str,
        content: Optional[str] = None
    ) -> Tuple[DocumentCategory, str, float]:
        """
        Classify document based on filename and optionally content

        Args:
            filename: Name of the file
            content: Optional document content (markdown)

        Returns:
            Tuple of (category, doc_type, confidence)
            - category: Main category (Client/EKC/Drawing/Identity/Unknown)
            - doc_type: Specific document type
            - confidence: Classification confidence (0.0 to 1.0)
        """
        filename_lower = filename.lower()

        # Try drawing classification first (most specific)
        drawing_result = self._classify_drawing(filename_lower, content)
        if drawing_result:
            return (DocumentCategory.DRAWING, drawing_result[0], drawing_result[1])

        # Try client document classification
        client_result = self._classify_client(filename_lower, content)
        if client_result:
            return (DocumentCategory.CLIENT, client_result[0], client_result[1])

        # Try EKC document classification
        ekc_result = self._classify_ekc(filename_lower, content)
        if ekc_result:
            return (DocumentCategory.EKC, ekc_result[0], ekc_result[1])

        # If still unknown, use content keywords
        if content:
            category_guess = self._guess_category_from_content(content)
            if category_guess:
                return (category_guess, "Other", 0.5)

        # Default to Unknown
        logger.warning(f"Could not classify document: {filename}")
        return (DocumentCategory.UNKNOWN, "Other", 0.0)

    def _classify_drawing(
        self,
        filename: str,
        content: Optional[str]
    ) -> Optional[Tuple[str, float]]:
        """Classify as drawing type"""
        for drawing_type, patterns in self.drawing_patterns.items():
            for pattern in patterns:
                if re.search(pattern, filename, re.IGNORECASE):
                    confidence = 0.9 if len(patterns) > 1 else 0.7
                    logger.info(f"Classified as {drawing_type.value} (confidence: {confidence})")
                    return (drawing_type.value, confidence)
        return None

    def _classify_client(
        self,
        filename: str,
        content: Optional[str]
    ) -> Optional[Tuple[str, float]]:
        """Classify as client document type"""
        for doc_type, patterns in self.client_patterns.items():
            for pattern in patterns:
                if re.search(pattern, filename, re.IGNORECASE):
                    confidence = 0.85
                    logger.info(f"Classified as Client/{doc_type.value} (confidence: {confidence})")
                    return (doc_type.value, confidence)
        return None

    def _classify_ekc(
        self,
        filename: str,
        content: Optional[str]
    ) -> Optional[Tuple[str, float]]:
        """Classify as EKC document type"""
        for doc_type, patterns in self.ekc_patterns.items():
            for pattern in patterns:
                if re.search(pattern, filename, re.IGNORECASE):
                    confidence = 0.85
                    logger.info(f"Classified as EKC/{doc_type.value} (confidence: {confidence})")
                    return (doc_type.value, confidence)
        return None

    def _guess_category_from_content(self, content: str) -> Optional[DocumentCategory]:
        """Guess main category from content keywords"""
        content_lower = content.lower()
        scores = {category: 0 for category in DocumentCategory}

        for category, keywords in self.category_keywords.items():
            for keyword in keywords:
                if keyword in content_lower:
                    scores[category] += 1

        max_score = max(scores.values())
        if max_score > 0:
            best_category = max(scores, key=scores.get)
            return best_category

        return None

    def get_neo4j_path(
        self,
        category: DocumentCategory,
        doc_type: str,
        project_oenum: str
    ) -> List[Dict[str, str]]:
        """
        Get Neo4j node path for document

        Returns list of nodes to create:
        [
            {"label": "Project", "properties": {"oenum": "..."}},
            {"label": "DocumentCategory", "properties": {"name": "Client"}},
            {"label": "DocumentType", "properties": {"name": "Spec"}},
        ]
        """
        path = [
            {
                "label": "Project",
                "properties": {"project_number": project_oenum}
            }
        ]

        if category == DocumentCategory.DRAWING:
            path.append({
                "label": "DrawingCategory",
                "properties": {"name": "Drawing"}
            })
            # Determine LV or MV
            voltage_type = "LV" if "LV_" in doc_type else "MV"
            path.append({
                "label": "VoltageType",
                "properties": {"name": voltage_type}
            })
            path.append({
                "label": "DrawingType",
                "properties": {"name": doc_type}
            })

        elif category in [DocumentCategory.CLIENT, DocumentCategory.EKC]:
            path.append({
                "label": "DocumentCategory",
                "properties": {"name": category.value}
            })
            path.append({
                "label": "DocumentType",
                "properties": {"name": doc_type}
            })

        return path
