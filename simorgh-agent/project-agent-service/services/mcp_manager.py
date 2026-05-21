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
try:
    from mcp.client.streamable_http import streamablehttp_client
except ImportError:
    # mcp>=1.9.4 renamed streamablehttp_client → streamable_http_client
    from mcp.client.streamable_http import streamable_http_client as streamablehttp_client
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
        self._server_stacks: Dict[str, AsyncExitStack] = {}
        self._connected = False

    def register_server(self, name: str, url: str, description: str = ""):
        """Register an MCP server for connection."""
        self.servers[name] = MCPServerConfig(name, url, description)

    async def connect_all(self):
        """Connect to all registered MCP servers and discover tools.

        Strategy: fully sequential with a small gap between peers and
        up to 3 retries per peer with backoff. Earlier parallel/bounded
        approaches all hit anyio races (BrokenResourceError /
        ClosedResourceError) in streamablehttp_client when SSE streams
        were established concurrently — moving to sequential plus a
        short cooldown between connects eliminates the race entirely.

        Total wallclock ~19 * 1.5s = ~30s for a clean run, retries add
        up to ~3s per straggler. Fine for a process that runs forever.
        """
        per_server_timeout = float(os.getenv("MCP_CONNECT_TIMEOUT_SEC", "30"))
        retries = int(os.getenv("MCP_CONNECT_RETRIES", "3"))
        gap = float(os.getenv("MCP_CONNECT_GAP_SEC", "0.5"))

        async def _attempt(name: str, config: MCPServerConfig) -> bool:
            for attempt in range(retries):
                # Discard any half-built state from a prior attempt.
                self.sessions.pop(name, None)
                stale = self._server_stacks.pop(name, None)
                if stale is not None:
                    try:
                        await stale.aclose()
                    except Exception:
                        pass
                try:
                    await asyncio.wait_for(
                        self._connect_server(name, config),
                        timeout=per_server_timeout,
                    )
                    logger.info(f"MCP connected: {name} ({config.url})")
                    return True
                except (Exception, asyncio.CancelledError) as e:
                    msg = str(e) or type(e).__name__
                    if attempt + 1 < retries:
                        logger.info(
                            f"MCP server {name} attempt {attempt+1} failed: "
                            f"{msg}; retrying"
                        )
                        await asyncio.sleep(0.5 * (attempt + 1))
                        continue
                    logger.warning(f"MCP server {name} unavailable: {msg}")
                    return False
            return False

        connected = 0
        for name, cfg in self.servers.items():
            ok = await _attempt(name, cfg)
            if ok:
                connected += 1
            # Brief cooldown between peers so the streamable transport
            # has a chance to fully tear down its SSE consumer before
            # we open the next one.
            await asyncio.sleep(gap)

        self._connected = connected > 0
        logger.info(
            f"MCP Manager: {connected}/{len(self.servers)} servers connected, "
            f"{len(self.tools)} tools available"
        )

    async def _connect_server(self, name: str, config: MCPServerConfig):
        """Connect to a single MCP server via Streamable HTTP."""
        # Use a per-server exit stack so failures don't leave broken
        # context managers on the shared stack (prevents cascading errors).
        server_stack = AsyncExitStack()
        try:
            streams = await server_stack.enter_async_context(
                streamablehttp_client(config.url)
            )
            # Unpack: streams is (read_stream, write_stream, get_session_id_fn)
            read_stream, write_stream = streams[0], streams[1]

            session = await server_stack.enter_async_context(
                ClientSession(read_stream, write_stream)
            )
            await session.initialize()

            self.sessions[name] = session
            self._server_stacks[name] = server_stack

            # Discover tools from this server. If list_tools fails the
            # session's transport is dead; let the outer connect_all
            # retry loop create a fresh streamablehttp_client.
            tools_result = await session.list_tools()
            for tool in tools_result.tools:
                self.tools[tool.name] = name
                self.tool_schemas[tool.name] = tool
                logger.debug(f"  Tool discovered: {tool.name} (from {name})")
        except BaseException:
            # Clean up the per-server stack on failure
            try:
                await server_stack.aclose()
            except Exception:
                pass
            raise

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

        # The persistent streamable-HTTP session can be evicted server-side
        # after idle. The first POST then 400s with a stale session id. Try
        # once, then on any failure rebuild the session and retry.
        try:
            result = await session.call_tool(tool_name, clean_args)
        except Exception as e:
            logger.warning(
                f"MCP call_tool {tool_name} on {server_name} failed "
                f"({type(e).__name__}: {e}); reconnecting and retrying"
            )
            cfg = self.servers.get(server_name)
            stale = self._server_stacks.pop(server_name, None)
            self.sessions.pop(server_name, None)
            if stale is not None:
                try:
                    await stale.aclose()
                except Exception:
                    pass
            if cfg is None:
                raise
            await self._connect_server(server_name, cfg)
            session = self.sessions.get(server_name)
            if session is None:
                raise
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
        for name, stack in list(self._server_stacks.items()):
            try:
                await stack.aclose()
            except Exception as e:
                logger.warning(f"Error disconnecting MCP server {name}: {e}")
        self._server_stacks.clear()
        try:
            await self._exit_stack.aclose()
        except Exception as e:
            logger.warning(f"Error during MCP exit stack cleanup: {e}")
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

        # Close old per-server stack
        old_stack = self._server_stacks.pop(name, None)
        if old_stack:
            try:
                await old_stack.aclose()
            except Exception:
                pass

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
            # Original microservices (always present)
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

            # Extracted services that also expose MCP (added during the
            # monolith decomposition). Keep blank to disable any single
            # one; connect_mcp() tolerates a missing/unreachable server.
            "specification_agent": os.getenv(
                "SPECIFICATION_AGENT_MCP_URL",
                "http://specification-agent-service:8036/mcp",
            ),
            "hr_kb": os.getenv(
                "HR_KB_MCP_URL", "http://hr-kb-service:8041/mcp"
            ),
            "org_data": os.getenv(
                "ORG_DATA_MCP_URL", "http://org-data-service:8042/mcp"
            ),
            "eplan_sql": os.getenv(
                "EPLAN_SQL_MCP_URL", "http://eplan-sql-service:8044/mcp"
            ),
            # documents-rag and graph-rag MCP endpoints land in commits 2 + 3
            # of this batch — adding the env names now so the upgrade is
            # purely deploy-config when those services restart.
            "documents_rag": os.getenv(
                "DOCUMENTS_RAG_MCP_URL", "http://documents-rag-service:8033/mcp"
            ),
            "graph_rag": os.getenv(
                "GRAPH_RAG_MCP_URL", "http://graph-rag-service:8037/mcp"
            ),

            # 2026-05 enterprise migration — these were missing from the
            # MCP manager registration, so the CoT engine couldn't see
            # GitLab project files, technical-knowledge, the
            # context-search analytics, or rendered TPMS context.
            "gitlab_mcp": os.getenv(
                # GitLab projects + technical-knowledge — exposes
                # list_projects_mcp, get_project_tree, read_file_mcp,
                # search_blobs, search_technical_knowledge.
                "GITLAB_MCP_URL_MCP", "http://gitlab-mcp:8047/mcp"
            ),
            "context_search": os.getenv(
                # Hybrid (BM25+kNN) search across all indexed simorgh
                # content + analytical aggregations + CoT trace recall.
                # Exposes search_context, search_projects_mcp,
                # search_past_cot, search_logs_mcp, aggregate_field,
                # time_series_query, index_cot_trace.
                "CONTEXT_SEARCH_MCP_URL", "http://context-search:8049/mcp"
            ),
            "tpms_context_agent": os.getenv(
                # Renders requested slices of a project's TPMS data
                # into Markdown blocks for direct inclusion in the
                # prompt. Exposes get_project_context(oenum, sections).
                "TPMS_CONTEXT_MCP_URL", "http://tpms-context-agent:8050/mcp"
            ),
            "runtime_broker": os.getenv(
                # Per-project long-lived shell-runtime containers.
                # Exposes session_start/stop/exec, session_read_file /
                # write_file, session_git_commit / push.
                "RUNTIME_BROKER_MCP_URL", "http://runtime-broker:8048/mcp"
            ),
            "project_explorer": os.getenv(
                # Two-phase project exploration. Exposes explore_tool
                # and get_exploration; result also lives in Redis under
                # project:{id}:exploration for the CoT engine to pull.
                "PROJECT_EXPLORER_MCP_URL", "http://project-explorer:8052/mcp"
            ),
            "mail_bridge": os.getenv(
                # Outbound email via Mailcow's SMTP submission. Exposes
                # send_email(to, subject, body_text, body_html?, cc?,
                # in_reply_to?). Inbound is push-driven via webhook —
                # no MCP tool needed for that direction.
                "MAIL_BRIDGE_MCP_URL", "http://mail-bridge:8051/mcp"
            ),
        }

        for name, url in servers.items():
            if url:
                _mcp_manager.register_server(name, url)

    return _mcp_manager


async def shutdown_mcp_manager():
    """Shutdown the MCP Manager (call on app shutdown)."""
    global _mcp_manager
    if _mcp_manager:
        await _mcp_manager.disconnect_all()
        _mcp_manager = None
