"""
Knowledge Base Module
=====================
Contains domain-specific knowledge for electrical systems and industrial equipment,
and TPMS database schema instructions for the COT engine.
"""

from .electrical_anthology import get_knowledge_context, COMMON_ABBREVIATIONS
from .tpms_schema_instructions import get_tpms_instructions

__all__ = ['get_knowledge_context', 'COMMON_ABBREVIATIONS', 'get_tpms_instructions']
