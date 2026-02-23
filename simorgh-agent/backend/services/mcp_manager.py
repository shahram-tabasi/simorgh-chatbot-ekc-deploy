"""
MCP Manager
============
Central MCP client that manages connections to all MCP servers,
discovers available tools, and routes tool calls.

This implements the MCP Host/Client pattern where the Project Manager Agent
acts as the host, connecting to multiple MCP servers (microservices)
via the Streamable HTTP transport.

Architecture:
    ProjectManagerAgent (Host)
        └── MCPManager (this module)
             ├── search-service      → web_search, web_search_news
             ├── tpms-fetcher        → tpms_fetch, tpms_get_text
             ├── project-init        → project_init
             ├── project-analysis    → project_analyze
             ├── command-gen         → command_generate, command_validate
             ├── file-export         → export_excel, export_word, export_pdf
             └── eplan-bridge        → eplan_draw, eplan_resolve_port
"""

import asyncio
import json
import logging
import os
from typing import Optional, Dict, List, Any
from contextlib import AsyncExitStack

from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client
from mcp.types import TextContent, ImageContent, EmbeddedResource

logger = logging.getLogger(__name__)


class MCPServerConfig:
    """Configuration for an MCP server connection."""

    def __init__(self, name: str, url: str, description: str = ""):
        self.name = name
        self.url = url  # Streamable HTTP endpoint (e.g., http://search-service:8020/mcp)
        self.description = description


class MCPManager:
    """
    Manages connections to multiple MCP servers and provides
    unified tool discovery and execution.

    Usage:
        manager = MCPManager()
        manager.register_server("search", "http://search-service:8020/mcp")
        await manager.connect_all()

        # Dynamic tool discovery
        tools = manager.get_all_tools()

        # Call a tool by name (auto-routed to correct server)
        result = await manager.call_tool("web_search", {"query": "test"})
    """

    def __init__(self):
        self.servers: Dict[str, MCPServerConfig] = {}
        self.sessions: Dict[str, ClientSession] = {}
        self.tools: Dict[str, str] = {}  # tool_name -> server_name
        self.tool_schemas: Dict[str, Any] = {}  # tool_name -> Tool schema
        self._exit_stack = AsyncExitStack()
        self._connected = False

    def register_server(self, name: str, url: str, description: str = ""):
        """Register an MCP server for connection."""
        self.servers[name] = MCPServerConfig(name, url, description)

    async def connect_all(self):
        """Connect to all registered MCP servers and discover tools."""
        connected = 0
        for name, config in self.servers.items():
            try:
                await self._connect_server(name, config)
                connected += 1
                logger.info(f"MCP connected: {name} ({config.url})")
            except Exception as e:
                logger.warning(f"MCP server {name} unavailable: {e}")

        self._connected = connected > 0
        logger.info(
            f"MCP Manager: {connected}/{len(self.servers)} servers connected, "
            f"{len(self.tools)} tools available"
        )

    async def _connect_server(self, name: str, config: MCPServerConfig):
        """Connect to a single MCP server via Streamable HTTP."""
        # streamablehttp_client returns (read_stream, write_stream, get_session_id)
        streams = await self._exit_stack.enter_async_context(
            streamablehttp_client(config.url)
        )
        # Unpack: streams is (read_stream, write_stream, get_session_id_fn)
        read_stream, write_stream = streams[0], streams[1]

        session = await self._exit_stack.enter_async_context(
            ClientSession(read_stream, write_stream)
        )
        await session.initialize()

        self.sessions[name] = session

        # Discover tools from this server
        tools_result = await session.list_tools()
        for tool in tools_result.tools:
            self.tools[tool.name] = name
            self.tool_schemas[tool.name] = tool
            logger.debug(f"  Tool discovered: {tool.name} (from {name})")

    def get_all_tools(self) -> List[Dict[str, Any]]:
        """Get all available tools across all MCP servers."""
        result = []
        for tool in self.tool_schemas.values():
            result.append({
                "name": tool.name,
                "description": tool.description or "",
                "input_schema": tool.inputSchema if hasattr(tool, 'inputSchema') else {},
                "server": self.tools.get(tool.name, "unknown"),
            })
        return result

    def get_tools_for_cot(self) -> str:
        """
        Get tool descriptions formatted for the COT system prompt.
        This enables dynamic tool discovery - the COT engine sees
        whatever tools are actually available from connected MCP servers.
        """
        lines = []
        for tool in self.tool_schemas.values():
            props = {}
            if hasattr(tool, 'inputSchema') and tool.inputSchema:
                props = tool.inputSchema.get("properties", {})
            schema_str = json.dumps(props) if props else "{}"
            lines.append(
                f"- {tool.name}: {tool.description or 'No description'}. "
                f"Input: {schema_str}"
            )
        return "\n".join(lines)

    def has_tool(self, tool_name: str) -> bool:
        """Check if a tool is available via MCP."""
        return tool_name in self.tools

    @property
    def is_connected(self) -> bool:
        return self._connected

    async def call_tool(
        self, tool_name: str, arguments: Dict[str, Any]
    ) -> Dict[str, Any]:
        """
        Call a tool on the appropriate MCP server.
        Auto-routes to the correct server based on tool name.

        Returns:
            Dict with "output" (str) and "metadata" (dict)
        """
        if tool_name not in self.tools:
            raise ValueError(f"Unknown MCP tool: {tool_name}")

        server_name = self.tools[tool_name]
        session = self.sessions.get(server_name)
        if not session:
            raise ConnectionError(f"MCP server '{server_name}' not connected")

        # Remove internal keys (e.g., _previous_results) before sending to MCP
        clean_args = {k: v for k, v in arguments.items() if not k.startswith("_")}

        result = await session.call_tool(tool_name, clean_args)

        # Parse result content blocks
        output_parts = []
        for content in result.content:
            if isinstance(content, TextContent):
                output_parts.append(content.text)
            elif isinstance(content, ImageContent):
                output_parts.append(f"[Image: {content.mimeType}]")
            elif isinstance(content, EmbeddedResource):
                output_parts.append(f"[Resource: {content.resource.uri}]")
            else:
                output_parts.append(str(content))

        output = "\n".join(output_parts)

        return {
            "output": output,
            "metadata": {
                "via": "mcp",
                "server": server_name,
                "tool": tool_name,
                "is_error": getattr(result, 'isError', False),
            },
        }

    async def disconnect_all(self):
        """Disconnect from all MCP servers."""
        try:
            await self._exit_stack.aclose()
        except Exception as e:
            logger.warning(f"Error during MCP disconnect: {e}")
        self.sessions.clear()
        self.tools.clear()
        self.tool_schemas.clear()
        self._connected = False
        logger.info("MCP Manager: all servers disconnected")

    async def reconnect_server(self, name: str):
        """Reconnect to a specific MCP server (e.g., after it restarts)."""
        config = self.servers.get(name)
        if not config:
            raise ValueError(f"Unknown MCP server: {name}")

        # Remove old tool registrations for this server
        old_tools = [t for t, s in self.tools.items() if s == name]
        for t in old_tools:
            self.tools.pop(t, None)
            self.tool_schemas.pop(t, None)
        self.sessions.pop(name, None)

        # Reconnect
        await self._connect_server(name, config)
        logger.info(f"MCP server '{name}' reconnected")

    def get_server_status(self) -> Dict[str, Any]:
        """Get connection status of all MCP servers."""
        status = {}
        for name, config in self.servers.items():
            connected = name in self.sessions
            tools = [t for t, s in self.tools.items() if s == name]
            status[name] = {
                "url": config.url,
                "connected": connected,
                "tools": tools,
                "tool_count": len(tools),
            }
        return status


# =============================================================================
# SINGLETON & FACTORY
# =============================================================================

_mcp_manager: Optional[MCPManager] = None


def get_mcp_manager() -> MCPManager:
    """Get or create the MCP Manager singleton."""
    global _mcp_manager
    if _mcp_manager is None:
        _mcp_manager = MCPManager()

        # Register servers from environment variables
        # Each microservice exposes MCP at /mcp endpoint
        servers = {
            "search": os.getenv(
                "SEARCH_MCP_URL", "http://search-service:8020/mcp"
            ),
            "tpms_fetcher": os.getenv(
                "TPMS_FETCHER_MCP_URL", "http://tpms-fetcher:8021/mcp"
            ),
            "project_init": os.getenv(
                "PROJECT_INIT_MCP_URL", "http://project-init:8022/mcp"
            ),
            "project_analysis": os.getenv(
                "PROJECT_ANALYSIS_MCP_URL", "http://project-analysis:8023/mcp"
            ),
            "command_gen": os.getenv(
                "COMMAND_GEN_MCP_URL", "http://command-gen:8024/mcp"
            ),
            "file_export": os.getenv(
                "FILE_EXPORT_MCP_URL", "http://file-export:8025/mcp"
            ),
            "eplan_bridge": os.getenv(
                "EPLAN_BRIDGE_MCP_URL", "http://eplan-bridge:8026/mcp"
            ),
        }

        for name, url in servers.items():
            _mcp_manager.register_server(name, url)

    return _mcp_manager


async def shutdown_mcp_manager():
    """Shutdown the MCP Manager (call on app shutdown)."""
    global _mcp_manager
    if _mcp_manager:
        await _mcp_manager.disconnect_all()
        _mcp_manager = None
