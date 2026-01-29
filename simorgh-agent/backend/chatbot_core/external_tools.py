"""
External Tools Manager
======================
Manages external tools with stage-based restrictions.

Tools:
- Internet Search
- Wikipedia
- Python Engine (code execution)

Restrictions:
- General chats: All tools allowed
- Project chats: Only allowed in ANALYSIS stage for process documents

Author: Simorgh Industrial Assistant
"""

import logging
import time
from typing import Dict, Any, List, Optional, Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from collections import defaultdict

from .models import (
    ChatType,
    SessionStage,
    ToolCategory,
    DocumentCategory,
    ExternalToolConfig,
    ChatContext,
    GeneralSessionContext,
    ProjectSessionContext,
    ExternalSearchResult,
)

logger = logging.getLogger(__name__)


# =============================================================================
# TOOL IMPLEMENTATIONS
# =============================================================================

@dataclass
class ToolResult:
    """Result from tool execution"""
    success: bool
    tool_id: str
    results: List[ExternalSearchResult] = field(default_factory=list)
    error: Optional[str] = None
    execution_time_ms: float = 0.0
    metadata: Dict[str, Any] = field(default_factory=dict)


class BaseTool:
    """Base class for external tools"""

    def __init__(self, config: ExternalToolConfig):
        self.config = config
        self.call_count = 0
        self.last_call_time: Optional[datetime] = None

    async def execute(
        self,
        query: str,
        context: ChatContext,
        **kwargs
    ) -> ToolResult:
        """Execute the tool"""
        raise NotImplementedError

    def is_rate_limited(self) -> bool:
        """Check if tool is rate limited"""
        if not self.last_call_time:
            return False

        elapsed = datetime.utcnow() - self.last_call_time
        if elapsed < timedelta(minutes=1):
            return self.call_count >= self.config.rate_limit_per_minute
        return False


class InternetSearchTool(BaseTool):
    """Internet search tool"""

    def __init__(self, search_service=None):
        config = ExternalToolConfig(
            tool_id="internet_search",
            tool_name="Internet Search",
            category=ToolCategory.INTERNET_SEARCH,
            enabled=True,
            allowed_stages=[SessionStage.ANALYSIS],
            allowed_document_categories=[DocumentCategory.PROCESS],
            rate_limit_per_minute=10,
        )
        super().__init__(config)
        self.search_service = search_service

    async def execute(
        self,
        query: str,
        context: ChatContext,
        limit: int = 5,
        **kwargs
    ) -> ToolResult:
        """Execute internet search"""
        start_time = time.time()

        try:
            if self.is_rate_limited():
                return ToolResult(
                    success=False,
                    tool_id=self.config.tool_id,
                    error="Rate limit exceeded",
                )

            self.call_count += 1
            self.last_call_time = datetime.utcnow()

            # Perform search (placeholder - integrate with actual search service)
            results = await self._perform_search(query, limit)

            return ToolResult(
                success=True,
                tool_id=self.config.tool_id,
                results=results,
                execution_time_ms=(time.time() - start_time) * 1000,
            )

        except Exception as e:
            logger.error(f"Internet search error: {e}")
            return ToolResult(
                success=False,
                tool_id=self.config.tool_id,
                error=str(e),
                execution_time_ms=(time.time() - start_time) * 1000,
            )

    async def _perform_search(
        self,
        query: str,
        limit: int,
    ) -> List[ExternalSearchResult]:
        """Perform the actual search"""
        # Placeholder - integrate with DuckDuckGo, Google, or other search API
        if self.search_service:
            raw_results = await self.search_service.search(query, limit=limit)
            return [
                ExternalSearchResult(
                    source="internet",
                    title=r.get("title", ""),
                    content=r.get("snippet", ""),
                    url=r.get("url"),
                    relevance_score=r.get("score", 0.0),
                )
                for r in raw_results
            ]
        return []


class WikipediaTool(BaseTool):
    """Wikipedia search tool"""

    def __init__(self):
        config = ExternalToolConfig(
            tool_id="wikipedia",
            tool_name="Wikipedia Search",
            category=ToolCategory.WIKIPEDIA,
            enabled=True,
            allowed_stages=[SessionStage.ANALYSIS],
            allowed_document_categories=[DocumentCategory.PROCESS],
            rate_limit_per_minute=20,
        )
        super().__init__(config)

    async def execute(
        self,
        query: str,
        context: ChatContext,
        limit: int = 3,
        **kwargs
    ) -> ToolResult:
        """Execute Wikipedia search"""
        start_time = time.time()

        try:
            if self.is_rate_limited():
                return ToolResult(
                    success=False,
                    tool_id=self.config.tool_id,
                    error="Rate limit exceeded",
                )

            self.call_count += 1
            self.last_call_time = datetime.utcnow()

            results = await self._search_wikipedia(query, limit)

            return ToolResult(
                success=True,
                tool_id=self.config.tool_id,
                results=results,
                execution_time_ms=(time.time() - start_time) * 1000,
            )

        except Exception as e:
            logger.error(f"Wikipedia search error: {e}")
            return ToolResult(
                success=False,
                tool_id=self.config.tool_id,
                error=str(e),
                execution_time_ms=(time.time() - start_time) * 1000,
            )

    async def _search_wikipedia(
        self,
        query: str,
        limit: int,
    ) -> List[ExternalSearchResult]:
        """Search Wikipedia"""
        try:
            import wikipedia
            search_results = wikipedia.search(query, results=limit)

            results = []
            for title in search_results[:limit]:
                try:
                    page = wikipedia.page(title, auto_suggest=False)
                    results.append(ExternalSearchResult(
                        source="wikipedia",
                        title=page.title,
                        content=page.summary[:500],
                        url=page.url,
                        relevance_score=0.8,
                    ))
                except wikipedia.exceptions.DisambiguationError:
                    continue
                except wikipedia.exceptions.PageError:
                    continue

            return results

        except ImportError:
            logger.warning("Wikipedia package not installed")
            return []
        except Exception as e:
            logger.error(f"Wikipedia error: {e}")
            return []


class PythonEngineTool(BaseTool):
    """Python code execution tool"""

    def __init__(self):
        config = ExternalToolConfig(
            tool_id="python_engine",
            tool_name="Python Code Execution",
            category=ToolCategory.PYTHON_ENGINE,
            enabled=True,
            allowed_stages=[SessionStage.ANALYSIS],
            allowed_document_categories=[DocumentCategory.PROCESS],
            rate_limit_per_minute=5,
            config={
                "timeout_seconds": 30,
                "max_output_length": 10000,
            }
        )
        super().__init__(config)

    async def execute(
        self,
        code: str,
        context: ChatContext,
        **kwargs
    ) -> ToolResult:
        """Execute Python code"""
        start_time = time.time()

        try:
            if self.is_rate_limited():
                return ToolResult(
                    success=False,
                    tool_id=self.config.tool_id,
                    error="Rate limit exceeded",
                )

            self.call_count += 1
            self.last_call_time = datetime.utcnow()

            output = await self._execute_code(code)

            return ToolResult(
                success=True,
                tool_id=self.config.tool_id,
                results=[ExternalSearchResult(
                    source="python_engine",
                    title="Code Execution Result",
                    content=output,
                )],
                execution_time_ms=(time.time() - start_time) * 1000,
            )

        except Exception as e:
            logger.error(f"Python execution error: {e}")
            return ToolResult(
                success=False,
                tool_id=self.config.tool_id,
                error=str(e),
                execution_time_ms=(time.time() - start_time) * 1000,
            )

    async def _execute_code(self, code: str) -> str:
        """Execute code in sandboxed environment"""
        # IMPORTANT: This is a simplified placeholder
        # In production, use a proper sandboxed execution environment
        # like RestrictedPython, docker containers, or external service

        import io
        import sys
        from contextlib import redirect_stdout, redirect_stderr

        # Restrict dangerous operations
        restricted_imports = ['os', 'sys', 'subprocess', 'shutil', 'pathlib']
        for imp in restricted_imports:
            if f"import {imp}" in code or f"from {imp}" in code:
                return f"Error: Import of '{imp}' is not allowed for security reasons"

        # Capture output
        stdout_capture = io.StringIO()
        stderr_capture = io.StringIO()

        try:
            # Create restricted globals
            restricted_globals = {
                '__builtins__': {
                    'print': print,
                    'len': len,
                    'range': range,
                    'str': str,
                    'int': int,
                    'float': float,
                    'list': list,
                    'dict': dict,
                    'sum': sum,
                    'min': min,
                    'max': max,
                    'abs': abs,
                    'round': round,
                    'sorted': sorted,
                    'enumerate': enumerate,
                    'zip': zip,
                    'map': map,
                    'filter': filter,
                },
            }

            with redirect_stdout(stdout_capture), redirect_stderr(stderr_capture):
                exec(code, restricted_globals)

            output = stdout_capture.getvalue()
            errors = stderr_capture.getvalue()

            max_len = self.config.config.get("max_output_length", 10000)
            if len(output) > max_len:
                output = output[:max_len] + "\n... (output truncated)"

            if errors:
                output += f"\nErrors:\n{errors}"

            return output or "Code executed successfully (no output)"

        except Exception as e:
            return f"Execution error: {str(e)}"


# =============================================================================
# EXTERNAL TOOLS MANAGER
# =============================================================================

class ExternalToolsManager:
    """
    Manages external tools with context-aware restrictions.

    Rules:
    - General chats: All enabled tools are available
    - Project chats: Tools only available in ANALYSIS stage
      and only for process documents
    """

    def __init__(self):
        """Initialize tools manager with default tools"""
        self._tools: Dict[str, BaseTool] = {}

        # Register default tools
        self.register_tool(InternetSearchTool())
        self.register_tool(WikipediaTool())
        self.register_tool(PythonEngineTool())

        # Usage statistics
        self._usage_stats: Dict[str, int] = defaultdict(int)

        logger.info(f"ExternalToolsManager initialized with {len(self._tools)} tools")

    def register_tool(self, tool: BaseTool):
        """Register a tool"""
        self._tools[tool.config.tool_id] = tool
        logger.info(f"Registered tool: {tool.config.tool_name}")

    def get_tool(self, tool_id: str) -> Optional[BaseTool]:
        """Get a tool by ID"""
        return self._tools.get(tool_id)

    def list_tools(self) -> List[ExternalToolConfig]:
        """List all registered tools"""
        return [tool.config for tool in self._tools.values()]

    # =========================================================================
    # TOOL AVAILABILITY
    # =========================================================================

    def get_available_tools(
        self,
        context: ChatContext,
        document_category: Optional[DocumentCategory] = None,
    ) -> List[ExternalToolConfig]:
        """
        Get tools available for the given context.

        Args:
            context: Chat context
            document_category: Optional document category

        Returns:
            List of available tool configs
        """
        available = []

        for tool in self._tools.values():
            if self.is_tool_allowed(context, tool.config.tool_id, document_category):
                available.append(tool.config)

        return available

    def is_tool_allowed(
        self,
        context: ChatContext,
        tool_id: str,
        document_category: Optional[DocumentCategory] = None,
    ) -> bool:
        """
        Check if a tool is allowed for the given context.

        Args:
            context: Chat context
            tool_id: Tool identifier
            document_category: Optional document category

        Returns:
            True if tool is allowed
        """
        tool = self._tools.get(tool_id)
        if not tool or not tool.config.enabled:
            return False

        config = tool.config

        # General chats: check chat type allowance
        if isinstance(context, GeneralSessionContext):
            return ChatType.GENERAL in config.allowed_chat_types

        # Project chats: check stage and document restrictions
        if isinstance(context, ProjectSessionContext):
            # Check chat type
            if ChatType.PROJECT not in config.allowed_chat_types:
                return False

            # Check stage (if restrictions exist)
            if config.allowed_stages:
                if context.stage not in config.allowed_stages:
                    return False

            # Check document category (if restrictions exist)
            if config.allowed_document_categories and document_category:
                if document_category not in config.allowed_document_categories:
                    return False

            return True

        return False

    # =========================================================================
    # TOOL EXECUTION
    # =========================================================================

    async def execute_tool(
        self,
        tool_id: str,
        query: str,
        context: ChatContext,
        document_category: Optional[DocumentCategory] = None,
        **kwargs
    ) -> ToolResult:
        """
        Execute a tool if allowed.

        Args:
            tool_id: Tool identifier
            query: Query/input for the tool
            context: Chat context
            document_category: Optional document category
            **kwargs: Additional tool arguments

        Returns:
            ToolResult
        """
        # Check if tool is allowed
        if not self.is_tool_allowed(context, tool_id, document_category):
            stage_info = ""
            if isinstance(context, ProjectSessionContext):
                stage_info = f" (current stage: {context.stage.value})"

            return ToolResult(
                success=False,
                tool_id=tool_id,
                error=f"Tool '{tool_id}' is not allowed in this context{stage_info}",
            )

        # Get and execute tool
        tool = self._tools.get(tool_id)
        if not tool:
            return ToolResult(
                success=False,
                tool_id=tool_id,
                error=f"Tool '{tool_id}' not found",
            )

        # Execute
        result = await tool.execute(query, context, **kwargs)

        # Track usage
        self._usage_stats[tool_id] += 1

        return result

    async def search_internet(
        self,
        query: str,
        context: ChatContext,
        limit: int = 5,
    ) -> ToolResult:
        """Convenience method for internet search"""
        return await self.execute_tool(
            "internet_search",
            query,
            context,
            limit=limit,
        )

    async def search_wikipedia(
        self,
        query: str,
        context: ChatContext,
        limit: int = 3,
    ) -> ToolResult:
        """Convenience method for Wikipedia search"""
        return await self.execute_tool(
            "wikipedia",
            query,
            context,
            limit=limit,
        )

    async def execute_python(
        self,
        code: str,
        context: ChatContext,
    ) -> ToolResult:
        """Convenience method for Python execution"""
        return await self.execute_tool(
            "python_engine",
            code,
            context,
        )

    # =========================================================================
    # BATCH EXECUTION
    # =========================================================================

    async def execute_multiple(
        self,
        tool_queries: List[Dict[str, Any]],
        context: ChatContext,
    ) -> List[ToolResult]:
        """
        Execute multiple tools.

        Args:
            tool_queries: List of {tool_id, query, **kwargs}
            context: Chat context

        Returns:
            List of ToolResults
        """
        import asyncio

        tasks = [
            self.execute_tool(
                tq["tool_id"],
                tq["query"],
                context,
                **{k: v for k, v in tq.items() if k not in ["tool_id", "query"]}
            )
            for tq in tool_queries
        ]

        return await asyncio.gather(*tasks)

    # =========================================================================
    # STATISTICS
    # =========================================================================

    def get_stats(self) -> Dict[str, Any]:
        """Get usage statistics"""
        return {
            "registered_tools": len(self._tools),
            "tool_ids": list(self._tools.keys()),
            "usage_counts": dict(self._usage_stats),
            "total_executions": sum(self._usage_stats.values()),
        }

    def reset_rate_limits(self):
        """Reset rate limits for all tools"""
        for tool in self._tools.values():
            tool.call_count = 0
            tool.last_call_time = None
        logger.info("Reset rate limits for all tools")


# =============================================================================
# SINGLETON
# =============================================================================

_tools_manager: Optional[ExternalToolsManager] = None


def get_tools_manager() -> ExternalToolsManager:
    """Get or create tools manager singleton"""
    global _tools_manager

    if _tools_manager is None:
        _tools_manager = ExternalToolsManager()

    return _tools_manager
