"""
Extension Registry
==================
Modular registry for extending the chatbot system.

Supports:
- Custom dataflows
- Custom tools
- Custom prompt templates
- Plugin system for new features

Author: Simorgh Industrial Assistant
"""

import logging
from typing import Dict, Any, List, Optional, Type, Callable
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum

from .models import ChatType, SessionStage, PromptTemplate
from .cocoindex_dataflow import BaseDataflow
from .external_tools import BaseTool, ExternalToolConfig

logger = logging.getLogger(__name__)


# =============================================================================
# EXTENSION TYPES
# =============================================================================

class ExtensionType(str, Enum):
    """Types of extensions"""
    DATAFLOW = "dataflow"
    TOOL = "tool"
    PROMPT_TEMPLATE = "prompt_template"
    MIDDLEWARE = "middleware"
    HOOK = "hook"
    PLUGIN = "plugin"


# =============================================================================
# EXTENSION METADATA
# =============================================================================

@dataclass
class ExtensionMetadata:
    """Metadata for a registered extension"""
    extension_id: str
    extension_type: ExtensionType
    name: str
    version: str
    author: Optional[str] = None
    description: Optional[str] = None
    enabled: bool = True
    registered_at: datetime = field(default_factory=datetime.utcnow)
    config: Dict[str, Any] = field(default_factory=dict)
    dependencies: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "extension_id": self.extension_id,
            "extension_type": self.extension_type.value,
            "name": self.name,
            "version": self.version,
            "author": self.author,
            "description": self.description,
            "enabled": self.enabled,
            "registered_at": self.registered_at.isoformat(),
            "config": self.config,
            "dependencies": self.dependencies,
        }


# =============================================================================
# HOOK SYSTEM
# =============================================================================

class HookPoint(str, Enum):
    """Available hook points in the system"""
    # Session hooks
    SESSION_CREATED = "session.created"
    SESSION_DESTROYED = "session.destroyed"

    # Message hooks
    MESSAGE_RECEIVED = "message.received"
    MESSAGE_SENT = "message.sent"
    MESSAGE_STORED = "message.stored"

    # LLM hooks
    LLM_PRE_GENERATE = "llm.pre_generate"
    LLM_POST_GENERATE = "llm.post_generate"

    # Document hooks
    DOCUMENT_UPLOADED = "document.uploaded"
    DOCUMENT_PROCESSED = "document.processed"

    # Tool hooks
    TOOL_PRE_EXECUTE = "tool.pre_execute"
    TOOL_POST_EXECUTE = "tool.post_execute"


@dataclass
class Hook:
    """Registered hook"""
    hook_id: str
    hook_point: HookPoint
    callback: Callable
    priority: int = 100  # Lower = higher priority
    enabled: bool = True


# =============================================================================
# MIDDLEWARE SYSTEM
# =============================================================================

class Middleware:
    """
    Base class for middleware.

    Middleware can intercept and modify requests/responses.
    """

    def __init__(self, name: str, priority: int = 100):
        self.name = name
        self.priority = priority

    async def process_request(
        self,
        context: Dict[str, Any],
        next_handler: Callable,
    ) -> Any:
        """
        Process a request.

        Args:
            context: Request context
            next_handler: Next middleware or final handler

        Returns:
            Response from next handler
        """
        return await next_handler(context)

    async def process_response(
        self,
        context: Dict[str, Any],
        response: Any,
    ) -> Any:
        """
        Process a response.

        Args:
            context: Request context
            response: Response from handler

        Returns:
            Modified response
        """
        return response


# =============================================================================
# EXTENSION REGISTRY
# =============================================================================

class ExtensionRegistry:
    """
    Central registry for all system extensions.

    Manages:
    - Dataflows (CocoIndex pipelines)
    - Tools (External tools)
    - Prompt templates
    - Middleware
    - Hooks
    - Plugins
    """

    def __init__(self):
        """Initialize the registry"""
        # Extension storage by type
        self._extensions: Dict[ExtensionType, Dict[str, Any]] = {
            ext_type: {} for ext_type in ExtensionType
        }

        # Metadata storage
        self._metadata: Dict[str, ExtensionMetadata] = {}

        # Hook storage
        self._hooks: Dict[HookPoint, List[Hook]] = {
            hook_point: [] for hook_point in HookPoint
        }

        # Middleware chain
        self._middleware: List[Middleware] = []

        # Initialization callbacks
        self._init_callbacks: List[Callable] = []

        logger.info("ExtensionRegistry initialized")

    # =========================================================================
    # DATAFLOW REGISTRATION
    # =========================================================================

    def register_dataflow(
        self,
        dataflow: BaseDataflow,
        metadata: Optional[ExtensionMetadata] = None,
    ):
        """
        Register a CocoIndex dataflow.

        Args:
            dataflow: Dataflow instance
            metadata: Optional metadata
        """
        extension_id = dataflow.dataflow_id

        self._extensions[ExtensionType.DATAFLOW][extension_id] = dataflow

        if not metadata:
            metadata = ExtensionMetadata(
                extension_id=extension_id,
                extension_type=ExtensionType.DATAFLOW,
                name=dataflow.name,
                version="1.0.0",
            )

        self._metadata[extension_id] = metadata

        logger.info(f"Registered dataflow: {dataflow.name}")

    def get_dataflow(self, dataflow_id: str) -> Optional[BaseDataflow]:
        """Get a registered dataflow"""
        return self._extensions[ExtensionType.DATAFLOW].get(dataflow_id)

    def list_dataflows(self) -> List[str]:
        """List all registered dataflow IDs"""
        return list(self._extensions[ExtensionType.DATAFLOW].keys())

    # =========================================================================
    # TOOL REGISTRATION
    # =========================================================================

    def register_tool(
        self,
        tool: BaseTool,
        metadata: Optional[ExtensionMetadata] = None,
    ):
        """
        Register an external tool.

        Args:
            tool: Tool instance
            metadata: Optional metadata
        """
        extension_id = tool.config.tool_id

        self._extensions[ExtensionType.TOOL][extension_id] = tool

        if not metadata:
            metadata = ExtensionMetadata(
                extension_id=extension_id,
                extension_type=ExtensionType.TOOL,
                name=tool.config.tool_name,
                version="1.0.0",
            )

        self._metadata[extension_id] = metadata

        logger.info(f"Registered tool: {tool.config.tool_name}")

    def get_tool(self, tool_id: str) -> Optional[BaseTool]:
        """Get a registered tool"""
        return self._extensions[ExtensionType.TOOL].get(tool_id)

    def list_tools(self) -> List[str]:
        """List all registered tool IDs"""
        return list(self._extensions[ExtensionType.TOOL].keys())

    # =========================================================================
    # PROMPT TEMPLATE REGISTRATION
    # =========================================================================

    def register_prompt_template(
        self,
        template: PromptTemplate,
        metadata: Optional[ExtensionMetadata] = None,
    ):
        """
        Register a prompt template.

        Args:
            template: Template instance
            metadata: Optional metadata
        """
        extension_id = template.template_id

        self._extensions[ExtensionType.PROMPT_TEMPLATE][extension_id] = template

        if not metadata:
            metadata = ExtensionMetadata(
                extension_id=extension_id,
                extension_type=ExtensionType.PROMPT_TEMPLATE,
                name=template.name,
                version="1.0.0",
            )

        self._metadata[extension_id] = metadata

        logger.info(f"Registered prompt template: {template.name}")

    def get_prompt_template(self, template_id: str) -> Optional[PromptTemplate]:
        """Get a registered prompt template"""
        return self._extensions[ExtensionType.PROMPT_TEMPLATE].get(template_id)

    def list_prompt_templates(self) -> List[str]:
        """List all registered template IDs"""
        return list(self._extensions[ExtensionType.PROMPT_TEMPLATE].keys())

    # =========================================================================
    # MIDDLEWARE REGISTRATION
    # =========================================================================

    def register_middleware(
        self,
        middleware: Middleware,
        metadata: Optional[ExtensionMetadata] = None,
    ):
        """
        Register middleware.

        Args:
            middleware: Middleware instance
            metadata: Optional metadata
        """
        extension_id = f"middleware_{middleware.name}"

        self._extensions[ExtensionType.MIDDLEWARE][extension_id] = middleware
        self._middleware.append(middleware)
        self._middleware.sort(key=lambda m: m.priority)

        if not metadata:
            metadata = ExtensionMetadata(
                extension_id=extension_id,
                extension_type=ExtensionType.MIDDLEWARE,
                name=middleware.name,
                version="1.0.0",
            )

        self._metadata[extension_id] = metadata

        logger.info(f"Registered middleware: {middleware.name}")

    def get_middleware_chain(self) -> List[Middleware]:
        """Get ordered middleware chain"""
        return self._middleware.copy()

    async def execute_middleware_chain(
        self,
        context: Dict[str, Any],
        final_handler: Callable,
    ) -> Any:
        """
        Execute middleware chain with a final handler.

        Args:
            context: Request context
            final_handler: Final handler to call

        Returns:
            Response from chain
        """
        async def build_chain(middlewares: List[Middleware], handler: Callable):
            if not middlewares:
                return await handler(context)

            middleware = middlewares[0]
            remaining = middlewares[1:]

            async def next_handler(ctx):
                return await build_chain(remaining, handler)

            response = await middleware.process_request(context, next_handler)
            return await middleware.process_response(context, response)

        return await build_chain(self._middleware, final_handler)

    # =========================================================================
    # HOOK REGISTRATION
    # =========================================================================

    def register_hook(
        self,
        hook_point: HookPoint,
        callback: Callable,
        hook_id: Optional[str] = None,
        priority: int = 100,
    ):
        """
        Register a hook.

        Args:
            hook_point: Hook point to attach to
            callback: Callback function
            hook_id: Optional hook ID
            priority: Hook priority (lower = higher priority)
        """
        import uuid

        hook = Hook(
            hook_id=hook_id or str(uuid.uuid4()),
            hook_point=hook_point,
            callback=callback,
            priority=priority,
        )

        self._hooks[hook_point].append(hook)
        self._hooks[hook_point].sort(key=lambda h: h.priority)

        logger.info(f"Registered hook at {hook_point.value}")

    async def trigger_hook(
        self,
        hook_point: HookPoint,
        context: Dict[str, Any],
    ) -> List[Any]:
        """
        Trigger all hooks at a hook point.

        Args:
            hook_point: Hook point to trigger
            context: Context to pass to hooks

        Returns:
            List of results from hook callbacks
        """
        results = []

        for hook in self._hooks[hook_point]:
            if not hook.enabled:
                continue

            try:
                import asyncio
                if asyncio.iscoroutinefunction(hook.callback):
                    result = await hook.callback(context)
                else:
                    result = hook.callback(context)
                results.append(result)
            except Exception as e:
                logger.error(f"Hook {hook.hook_id} error: {e}")

        return results

    def unregister_hook(self, hook_id: str):
        """Unregister a hook by ID"""
        for hook_point in self._hooks:
            self._hooks[hook_point] = [
                h for h in self._hooks[hook_point]
                if h.hook_id != hook_id
            ]

    # =========================================================================
    # PLUGIN REGISTRATION
    # =========================================================================

    def register_plugin(
        self,
        plugin_id: str,
        plugin: Any,
        metadata: ExtensionMetadata,
        init_callback: Optional[Callable] = None,
    ):
        """
        Register a plugin.

        Plugins are custom extensions that don't fit other categories.

        Args:
            plugin_id: Plugin identifier
            plugin: Plugin instance or class
            metadata: Plugin metadata
            init_callback: Optional initialization callback
        """
        self._extensions[ExtensionType.PLUGIN][plugin_id] = plugin
        self._metadata[plugin_id] = metadata

        if init_callback:
            self._init_callbacks.append(init_callback)

        logger.info(f"Registered plugin: {metadata.name}")

    def get_plugin(self, plugin_id: str) -> Any:
        """Get a registered plugin"""
        return self._extensions[ExtensionType.PLUGIN].get(plugin_id)

    async def initialize_plugins(self, context: Dict[str, Any] = None):
        """Run all plugin initialization callbacks"""
        for callback in self._init_callbacks:
            try:
                import asyncio
                if asyncio.iscoroutinefunction(callback):
                    await callback(context or {})
                else:
                    callback(context or {})
            except Exception as e:
                logger.error(f"Plugin init error: {e}")

    # =========================================================================
    # GENERAL METHODS
    # =========================================================================

    def get_extension(
        self,
        extension_id: str,
    ) -> Optional[Any]:
        """Get any extension by ID"""
        for ext_type in ExtensionType:
            if extension_id in self._extensions[ext_type]:
                return self._extensions[ext_type][extension_id]
        return None

    def get_metadata(self, extension_id: str) -> Optional[ExtensionMetadata]:
        """Get extension metadata"""
        return self._metadata.get(extension_id)

    def enable_extension(self, extension_id: str):
        """Enable an extension"""
        if extension_id in self._metadata:
            self._metadata[extension_id].enabled = True
            logger.info(f"Enabled extension: {extension_id}")

    def disable_extension(self, extension_id: str):
        """Disable an extension"""
        if extension_id in self._metadata:
            self._metadata[extension_id].enabled = False
            logger.info(f"Disabled extension: {extension_id}")

    def unregister(self, extension_id: str):
        """Unregister an extension"""
        for ext_type in ExtensionType:
            if extension_id in self._extensions[ext_type]:
                del self._extensions[ext_type][extension_id]

        if extension_id in self._metadata:
            del self._metadata[extension_id]

        logger.info(f"Unregistered extension: {extension_id}")

    def list_all(self) -> Dict[str, List[str]]:
        """List all registered extensions by type"""
        return {
            ext_type.value: list(extensions.keys())
            for ext_type, extensions in self._extensions.items()
        }

    def get_summary(self) -> Dict[str, Any]:
        """Get registry summary"""
        return {
            "total_extensions": len(self._metadata),
            "by_type": {
                ext_type.value: len(extensions)
                for ext_type, extensions in self._extensions.items()
            },
            "hooks_registered": sum(len(hooks) for hooks in self._hooks.values()),
            "middleware_count": len(self._middleware),
            "enabled_extensions": len([m for m in self._metadata.values() if m.enabled]),
        }

    def export_config(self) -> Dict[str, Any]:
        """Export registry configuration"""
        return {
            "extensions": [m.to_dict() for m in self._metadata.values()],
            "hooks": {
                hp.value: len(hooks)
                for hp, hooks in self._hooks.items()
            },
        }


# =============================================================================
# SINGLETON
# =============================================================================

_extension_registry: Optional[ExtensionRegistry] = None


def get_extension_registry() -> ExtensionRegistry:
    """Get or create extension registry singleton"""
    global _extension_registry

    if _extension_registry is None:
        _extension_registry = ExtensionRegistry()

    return _extension_registry
