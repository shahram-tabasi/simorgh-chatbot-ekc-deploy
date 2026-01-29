"""
Chatbot Core Module
===================
Enhanced chatbot architecture with:
- General-Session and Project-Session chat types
- Unified Memory Management with Redis-first caching
- CocoIndex integration for persistent storage
- LLM wrapper with context-aware prompts
- Modular and extensible design

Author: Simorgh Industrial Assistant
"""

from .models import (
    ChatType,
    SessionStage,
    ChatContext,
    GeneralSessionContext,
    ProjectSessionContext,
    MemoryTier,
    DocumentContext,
    ExternalToolConfig,
    PromptTemplate,
)

from .memory_manager import (
    MemoryManager,
    get_memory_manager,
)

from .session_manager import (
    ChatSessionManager,
    get_session_manager,
)

from .llm_wrapper import (
    EnhancedLLMWrapper,
    get_llm_wrapper,
)

from .external_tools import (
    ExternalToolsManager,
    get_tools_manager,
)

from .document_ingestion import (
    DocumentIngestionPipeline,
    get_ingestion_pipeline,
)

from .cocoindex_dataflow import (
    CocoIndexDataflowManager,
    get_dataflow_manager,
)

from .monitoring import (
    ChatbotMonitor,
    get_monitor,
)

from .registry import (
    ExtensionRegistry,
    get_extension_registry,
)

__all__ = [
    # Models
    "ChatType",
    "SessionStage",
    "ChatContext",
    "GeneralSessionContext",
    "ProjectSessionContext",
    "MemoryTier",
    "DocumentContext",
    "ExternalToolConfig",
    "PromptTemplate",
    # Memory
    "MemoryManager",
    "get_memory_manager",
    # Sessions
    "ChatSessionManager",
    "get_session_manager",
    # LLM
    "EnhancedLLMWrapper",
    "get_llm_wrapper",
    # Tools
    "ExternalToolsManager",
    "get_tools_manager",
    # Documents
    "DocumentIngestionPipeline",
    "get_ingestion_pipeline",
    # CocoIndex
    "CocoIndexDataflowManager",
    "get_dataflow_manager",
    # Monitoring
    "ChatbotMonitor",
    "get_monitor",
    # Registry
    "ExtensionRegistry",
    "get_extension_registry",
]
