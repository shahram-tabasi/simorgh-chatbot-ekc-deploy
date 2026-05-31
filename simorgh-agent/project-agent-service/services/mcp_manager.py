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
import re
import time
from typing import Optional, Dict, List, Any
from contextlib import AsyncExitStack

import httpx

# Stopwords scrubbed from the user query before tool-name overlap
# scoring. Just the cheap English filler — nothing fancy. Reduces
# false-positive matches like "the" matching every tool description.
_STOPWORDS = {
    "the", "a", "an", "is", "are", "was", "were", "of", "in", "on", "at",
    "to", "for", "with", "by", "from", "this", "that", "these", "those",
    "i", "me", "my", "we", "us", "our", "you", "your", "he", "she", "it",
    "be", "as", "or", "and", "but", "not", "no", "yes", "what", "which",
    "who", "whose", "where", "when", "why", "how", "do", "does", "did",
    "can", "could", "would", "should", "shall", "will", "may", "might",
    "have", "has", "had", "tell", "show", "give", "find", "get", "list",
    "please", "thanks", "thank", "specification", "specifications",
}
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
        # Last-activity timestamp per session. Used by call_tool to
        # proactively re-handshake before the MCP server's idle reaper
        # kills the session — that path otherwise costs a full
        # MCP_CALL_TIMEOUT_SEC wait per stale call (the streamable-http
        # client doesn't propagate the server's 400 as an exception
        # to the in-flight call_tool future).
        self._last_used_ts: Dict[str, float] = {}
        # Background keepalive task — pings each connected session on a
        # short interval so the server's idle reaper never fires.
        # Upstream-recommended pattern for Streamable-HTTP MCP transport
        # (fastmcp#120, mcp spec § session lifecycle).
        self._keepalive_task: Optional[asyncio.Task] = None
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

        # Start the background keepalive loop once at least one server
        # is up. Stays alive for the lifetime of the manager.
        if self._connected and self._keepalive_task is None:
            self._keepalive_task = asyncio.create_task(self._keepalive_loop())

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

            # Discover tools from this server. If list_tools fails the
            # session's transport is dead; let the outer connect_all
            # retry loop create a fresh streamablehttp_client.
            #
            # Important: do NOT put `session` into self.sessions until
            # list_tools succeeds. The transport is sometimes alive
            # enough to negotiate a session id but dies on the first
            # JSON-RPC call (runtime-broker has shown this pattern at
            # startup). If we store the broken session early, the
            # status summary reports `connected=True, tools=[]` — a
            # lie that hides the failure from the CoT planner and
            # turns into "tool not available" errors at chat time.
            tools_result = await session.list_tools()
            tool_names_for_log: list[str] = []
            for tool in tools_result.tools:
                self.tools[tool.name] = name
                self.tool_schemas[tool.name] = tool
                tool_names_for_log.append(tool.name)
                logger.debug(f"  Tool discovered: {tool.name} (from {name})")

            # A successful list_tools that returns zero entries is
            # almost always a partial-init failure too — every server
            # in this stack exposes at least one tool. Treat as
            # failure so connect_all's retry loop creates a fresh
            # transport.
            if not tools_result.tools:
                raise RuntimeError(
                    f"MCP server {name} returned empty tool list; "
                    "treating as transport failure"
                )

            # Only commit to self.sessions after we know the session
            # is functionally alive.
            self.sessions[name] = session
            self._server_stacks[name] = server_stack
            self._last_used_ts[name] = time.monotonic()
            logger.debug(
                f"  Tools for {name}: {tool_names_for_log}"
            )
        except BaseException:
            # Clean up both the per-server stack AND any half-populated
            # entries we leaked into the shared maps. Without the
            # tools-map cleanup, a partially-discovered server can
            # leave entries in self.tools pointing at a dead session.
            self.sessions.pop(name, None)
            self._server_stacks.pop(name, None)
            for tname in [t for t, srv in self.tools.items() if srv == name]:
                self.tools.pop(tname, None)
                self.tool_schemas.pop(tname, None)
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

    def get_tools_for_cot(
        self, *,
        compact: bool = True,
        query: Optional[str] = None,
        top_n: Optional[int] = None,
        always_include: Optional[List[str]] = None,
        exclude_prefixes: Optional[List[str]] = None,
    ) -> str:
        """
        Get tool descriptions formatted for the COT system prompt.

        Two-axis filtering (per 2026 best practices — Anthropic Tool
        Search Tool / OpenAI ToolSearchTool / "rule of thumb: ≤15
        tools at a time"):

          format:
            compact=True  (DEFAULT) — `- name: desc. Input keys: …`
            compact=False           — `- name: desc. Input: {schema}`

          selection:
            query=None             — return every connected tool
            query=<user input>     — score tools by token overlap with
                                      the query against each tool's
                                      name + description, return the
                                      top_n highest scorers PLUS the
                                      always_include set. Score is a
                                      cheap bag-of-words count so no
                                      embedding round-trip is needed
                                      on the planner hot path.

        always_include is the small set of tools the planner ALWAYS
        needs for the common retrieval ladder (project tree walk,
        read artifact, search context, llm synth). Without them the
        scoring can drop critical infrastructure tools when the user
        query is about a domain topic that doesn't lexically match
        the tool names.

        Operator hit gpt-oss-20b's 16K context limit (2026-05-24)
        with all 67 tools in the prompt; top_n=15 + always-include
        brings it down to ~3-4K chars and the planner accuracy goes
        up too (validated by Anthropic's 49%→74% MCP-eval jump
        when they shipped Tool Search Tool).
        """
        # Default always-include — the planner's bread and butter.
        if always_include is None:
            always_include = [
                "get_project_tree",
                "read_artifact_mcp", "read_file_mcp",
                "search_context", "search_blobs",
                "llm",
                "session_read_file_tool", "session_read_artifact_tool",
                "session_write_file_tool",
                "graph_query",
            ]

        all_tools = list(self.tool_schemas.values())

        # Exclude entire tool families up-front (e.g. exclude_prefixes=["tpms"]
        # for repo-backed projects that have no TPMS OENUM — the planner
        # otherwise picks tpms_fetch / tpms_get_text and gets "Project
        # <oenum> not found in TPMS" on every call). This filter runs
        # BEFORE scoring so excluded tools can't even win a relevance
        # slot.
        if exclude_prefixes:
            all_tools = [
                t for t in all_tools
                if not any(t.name.startswith(p) for p in exclude_prefixes)
            ]

        # Score + select.
        if query and top_n is not None and top_n < len(all_tools):
            query_words = {w for w in re.findall(r"[a-z0-9_]{2,}", query.lower())
                           if w not in _STOPWORDS}
            scored: List[tuple[int, Any]] = []
            for tool in all_tools:
                text = f"{tool.name} {tool.description or ''}".lower()
                # Substring match per word (cheap, no tokeniser needed).
                score = sum(1 for w in query_words if w in text)
                scored.append((score, tool))
            scored.sort(key=lambda x: x[0], reverse=True)
            chosen_names = set(always_include)
            for score, tool in scored:
                if len(chosen_names) >= top_n + len(always_include):
                    break
                chosen_names.add(tool.name)
            selected = [t for t in all_tools if t.name in chosen_names]
        else:
            selected = all_tools

        # Format.
        lines = []
        for tool in selected:
            desc = tool.description or "No description"
            if compact:
                props = {}
                required = []
                if hasattr(tool, "inputSchema") and tool.inputSchema:
                    props = tool.inputSchema.get("properties", {}) or {}
                    required = tool.inputSchema.get("required", []) or []
                if props:
                    keys = list(props.keys())
                    keys_str = ", ".join(keys[:12])
                    if len(keys) > 12:
                        keys_str += ", …"
                    if required:
                        req_in_view = [k for k in required if k in keys[:12]]
                        if req_in_view:
                            input_part = (
                                f"Input keys: {keys_str} "
                                f"(required: {', '.join(req_in_view)})"
                            )
                        else:
                            input_part = f"Input keys: {keys_str}"
                    else:
                        input_part = f"Input keys: {keys_str}"
                else:
                    input_part = "Input: {}"
                lines.append(f"- {tool.name}: {desc}. {input_part}")
            else:
                props = {}
                if hasattr(tool, "inputSchema") and tool.inputSchema:
                    props = tool.inputSchema.get("properties", {})
                schema_str = json.dumps(props) if props else "{}"
                lines.append(
                    f"- {tool.name}: {desc}. Input: {schema_str}"
                )

        # Hint at the bottom so the planner knows other tools exist
        # if the selected ones don't fit the task.
        omitted = len(all_tools) - len(selected)
        if omitted > 0:
            lines.append(
                f"# {omitted} additional tools omitted by relevance "
                f"filter — if you need a capability not shown, re-phrase "
                f"the request so the right tool surfaces, or fall back "
                f"to llm.synthesize with a direct answer."
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
        # after idle (operator-observed: context-search and gitlab-mcp both
        # reap idle sessions; the next POST then 400s but the streamable-
        # http client doesn't propagate that to the call_tool future, so
        # we burn the full per_call_timeout per stale call). Two defences:
        #
        #   1. Proactive idle re-handshake — if it's been more than
        #      MCP_SESSION_MAX_IDLE_SEC since the last successful call,
        #      tear the session down and rebuild BEFORE issuing the call.
        #      Re-handshake costs ~20 ms; the alternative is waiting the
        #      full timeout.
        #   2. Tight per-call timeout for the call itself. Healthy round-
        #      trip is sub-100ms; the previous 30s was a stale-session
        #      latency, not a real upper bound on tool latency.
        per_call_timeout = float(os.getenv("MCP_CALL_TIMEOUT_SEC", "15"))
        max_idle = float(os.getenv("MCP_SESSION_MAX_IDLE_SEC", "25"))

        last_ts = self._last_used_ts.get(server_name, 0.0)
        if last_ts and (time.monotonic() - last_ts) > max_idle:
            logger.info(
                "MCP session %s idle %.1fs > %.1fs — refreshing before call",
                server_name, time.monotonic() - last_ts, max_idle,
            )

            reconnect_timeout = float(os.getenv("MCP_RECONNECT_TIMEOUT_SEC", "10"))

            async def _refresh() -> bool:
                cfg_pre = self.servers.get(server_name)
                if cfg_pre is None:
                    return False
                stale_pre = self._server_stacks.pop(server_name, None)
                self.sessions.pop(server_name, None)
                if stale_pre is not None:
                    # aclose on a server-reaped session can hang waiting
                    # for the SSE close handshake — wrap it tightly and
                    # drop the stack on the floor if the close stalls.
                    try:
                        await asyncio.wait_for(stale_pre.aclose(), timeout=2.0)
                    except (asyncio.TimeoutError, Exception):
                        pass
                await self._connect_server(server_name, cfg_pre)
                return True

            try:
                ok = await asyncio.wait_for(_refresh(), timeout=reconnect_timeout)
                if ok:
                    refreshed = self.sessions.get(server_name)
                    if refreshed is not None:
                        session = refreshed
            except (asyncio.TimeoutError, Exception) as e_pre:
                # Refresh failed or hung — fall through. The regular
                # _do_call below will likely fail with TimeoutError,
                # which triggers the existing reconnect+retry+REST path
                # (which is harder to hang because it doesn't aclose
                # the stale stack synchronously when the new one is
                # already up).
                logger.warning(
                    "MCP proactive refresh of %s failed (%s); "
                    "falling back to in-call retry",
                    server_name, type(e_pre).__name__,
                )

        async def _do_call(s):
            return await asyncio.wait_for(
                s.call_tool(tool_name, clean_args),
                timeout=per_call_timeout,
            )

        try:
            result = await _do_call(session)
            self._last_used_ts[server_name] = time.monotonic()
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
                # Last-ditch: try the REST fallback for servers that have one.
                rest = await self._rest_fallback(server_name, tool_name, clean_args)
                if rest is not None:
                    return rest
                raise
            # Wrap the reconnect with a timeout. The startup `connect_all`
            # path wraps `_connect_server` in `asyncio.wait_for`, but the
            # recovery path here did NOT — and the streamable-HTTP SSE
            # handshake CAN hang indefinitely (operator observed a turn
            # stuck for >8 minutes when this happened). When it does,
            # skip MCP entirely and try REST so the turn at least
            # finishes deterministically.
            reconnect_timeout = float(
                os.getenv("MCP_RECONNECT_TIMEOUT_SEC", "10")
            )
            try:
                await asyncio.wait_for(
                    self._connect_server(server_name, cfg),
                    timeout=reconnect_timeout,
                )
            except (asyncio.TimeoutError, Exception) as e_rec:
                logger.warning(
                    f"MCP reconnect of {server_name} failed/timed out "
                    f"({type(e_rec).__name__}: {e_rec}); trying REST fallback"
                )
                rest = await self._rest_fallback(server_name, tool_name, clean_args)
                if rest is not None:
                    return rest
                raise
            session = self.sessions.get(server_name)
            if session is None:
                rest = await self._rest_fallback(server_name, tool_name, clean_args)
                if rest is not None:
                    return rest
                raise
            try:
                result = await _do_call(session)
                self._last_used_ts[server_name] = time.monotonic()
            except Exception as e2:
                # Second MCP attempt failed too — the streamable-HTTP
                # transport is genuinely down. For servers that expose a
                # REST surface alongside MCP (gitlab-mcp), fall back to
                # plain HTTPS so the CoT step still completes.
                logger.warning(
                    f"MCP call_tool {tool_name} on {server_name} second "
                    f"attempt failed ({type(e2).__name__}: {e2}); "
                    "trying REST fallback"
                )
                rest = await self._rest_fallback(server_name, tool_name, clean_args)
                if rest is not None:
                    return rest
                raise

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

    # =========================================================================
    # REST FALLBACK
    # =========================================================================
    # Some MCP servers (gitlab-mcp today) also publish a plain-HTTP REST
    # surface. The MCP streamable-HTTP transport has a long tail of
    # session-id-stale / SSE-hang failures; when that happens we'd
    # rather degrade to REST than fail the CoT step. Each entry maps
    #
    #   tool_name -> (HTTP method, path_template, query_arg_names,
    #                 optional path-substitution lambda).
    #
    # The MCP tools are intentionally thin wrappers around these REST
    # routes (read_artifact_mcp literally calls the REST handler), so
    # the returned JSON is identical.
    GITLAB_MCP_REST_BASE = os.getenv("GITLAB_MCP_URL", "http://gitlab-mcp:8047")
    TECH_KB_REPO         = os.getenv(
        "GITLAB_TECH_KB_REPO", "simorgh-knowledge/technical-knowledge"
    )

    def _gitlab_rest_recipe(
        self, tool_name: str, args: Dict[str, Any],
    ) -> tuple[str, str, Dict[str, Any]] | None:
        """Translate a gitlab-mcp tool call into (method, url, params).
        Returns None when the tool has no REST equivalent."""
        base = self.GITLAB_MCP_REST_BASE.rstrip("/")
        if tool_name == "list_projects_mcp":
            return ("GET", f"{base}/projects", {
                "group":  args.get("group") or "",
                "search": args.get("search_term") or "",
            })
        if tool_name == "get_project_tree":
            return ("GET", f"{base}/tree", {
                "project":   args.get("project"),
                "ref":       args.get("ref") or "main",
                "path":      args.get("path") or "",
                "recursive": "true",
            })
        if tool_name == "read_file_mcp":
            return ("GET", f"{base}/file", {
                "project": args.get("project"),
                "path":    args.get("path"),
                "ref":     args.get("ref") or "main",
            })
        if tool_name == "read_artifact_mcp":
            return ("GET", f"{base}/artifact", {
                "project": args.get("project"),
                "path":    args.get("path"),
                "ref":     args.get("ref") or "main",
            })
        if tool_name == "search_blobs":
            return ("GET", f"{base}/search", {
                "query":   args.get("query"),
                "project": args.get("project") or "",
                "group":   args.get("group") or "",
                "scope":   "blobs",
            })
        if tool_name == "search_technical_knowledge":
            return ("GET", f"{base}/search", {
                "query":   args.get("query"),
                "project": self.TECH_KB_REPO,
                "scope":   "blobs",
            })
        if tool_name == "list_branches_mcp":
            return ("GET", f"{base}/branches", {
                "project": args.get("project"),
                "search":  args.get("search_term") or "",
            })
        return None

    async def _rest_fallback(
        self, server_name: str, tool_name: str, args: Dict[str, Any],
    ) -> Optional[Dict[str, Any]]:
        """Best-effort REST shadow of an MCP call. Returns None when no
        REST equivalent is registered for the (server, tool) pair."""
        recipe = None
        if server_name == "gitlab_mcp":
            recipe = self._gitlab_rest_recipe(tool_name, args)
        # Other servers can be wired in here in the future.
        if recipe is None:
            return None

        method, url, params = recipe
        # Drop None / empty-string params so we don't push unset filters
        # into GitLab's API.
        params = {k: v for k, v in params.items() if v not in (None, "")}
        try:
            timeout = float(os.getenv("MCP_REST_TIMEOUT_SEC", "15"))
            async with httpx.AsyncClient(timeout=timeout) as c:
                resp = await c.request(method, url, params=params)
            resp.raise_for_status()
            body = resp.json()
        except Exception as e:
            logger.warning(
                "REST fallback %s on %s also failed (%s: %s)",
                tool_name, server_name, type(e).__name__, e,
            )
            return None

        # Match the shape of the MCP path: {"output": str, "metadata": {...}}.
        # CoT consumers parse output as text (often as JSON), so we
        # json.dumps the REST body.
        return {
            "output": json.dumps(body),
            "metadata": {
                "via":    "rest-fallback",
                "server": server_name,
                "tool":   tool_name,
                "url":    url,
            },
        }

    async def _keepalive_loop(self):
        """Periodically ping each connected MCP session to keep it warm.

        Streamable-HTTP MCP servers reap idle sessions aggressively
        (operator-observed: context-search and gitlab-mcp do this within
        ~30s; .NET MCP and proxies like nginx / ALB are 60-75s by
        default). Without a heartbeat, the next user-triggered tool call
        wastes a full MCP_CALL_TIMEOUT_SEC waiting for the streamable-
        http client to surface the server's 400, then takes the
        reconnect-and-retry path. With this heartbeat, the session is
        bumped every MCP_KEEPALIVE_SEC and that path is never reached
        on normal traffic.

        Failure modes are intentionally swallowed: a transient ping
        failure is fine (the next user call will reconnect via the
        existing on-failure retry path); we just want to keep the
        timestamp fresh when things are healthy.
        """
        interval = float(os.getenv("MCP_KEEPALIVE_SEC", "20"))
        if interval <= 0:
            return
        # On consecutive failed pings for the same server, force a
        # reconnect. The "transport is closed" case (ClosedResourceError,
        # BrokenResourceError) means our session is dead but pinned in
        # self.sessions — without a reconnect here, every user call will
        # still hit the slow refresh path.
        max_misses = int(os.getenv("MCP_KEEPALIVE_MAX_MISSES", "2"))
        miss_count: Dict[str, int] = {}
        logger.info("MCP keepalive loop started (interval=%.1fs)", interval)
        try:
            while True:
                await asyncio.sleep(interval)
                # First: try to bring up any registered server that
                # never connected (or got reaped) so we don't sit on a
                # missing-tool state forever. connect_all retries 3
                # times at boot, but a transient BrokenResourceError
                # there is permanent for the lifetime of the process
                # without this — every gitlab_mcp tool then 404s via
                # REST fallback.
                for name, cfg in self.servers.items():
                    if name in self.sessions:
                        continue
                    try:
                        await asyncio.wait_for(
                            self._connect_server(name, cfg),
                            timeout=float(os.getenv("MCP_RECONNECT_TIMEOUT_SEC", "10")),
                        )
                        logger.info("MCP keepalive %s: late connect ok", name)
                        miss_count.pop(name, None)
                    except (asyncio.TimeoutError, Exception) as e_late:
                        logger.debug(
                            "MCP keepalive %s: late connect attempt failed (%s)",
                            name, type(e_late).__name__,
                        )

                for name, session in list(self.sessions.items()):
                    # Try the spec's ping first; if that raises (server
                    # doesn't implement the ping handler, returns an MCP
                    # error, etc.), fall back to a list_tools call. Both
                    # paths bump _last_used_ts on success.
                    ok = False
                    ping = getattr(session, "send_ping", None)
                    if ping is not None:
                        try:
                            await asyncio.wait_for(ping(), timeout=5.0)
                            ok = True
                        except Exception as e:
                            logger.debug(
                                "MCP keepalive %s send_ping failed (%s); "
                                "trying list_tools",
                                name, type(e).__name__,
                            )
                    if not ok:
                        try:
                            await asyncio.wait_for(session.list_tools(), timeout=5.0)
                            ok = True
                        except Exception as e:
                            logger.info(
                                "MCP keepalive %s failed via list_tools "
                                "(%s); will reconnect after %d misses",
                                name, type(e).__name__,
                                max_misses,
                            )
                    if ok:
                        self._last_used_ts[name] = time.monotonic()
                        miss_count.pop(name, None)
                        continue

                    # Failure path — count misses and reconnect when
                    # we cross the threshold. One miss could be a
                    # transient blip; consecutive misses mean the
                    # transport is genuinely dead.
                    miss_count[name] = miss_count.get(name, 0) + 1
                    if miss_count[name] < max_misses:
                        continue
                    cfg = self.servers.get(name)
                    if cfg is None:
                        continue
                    logger.info(
                        "MCP keepalive %s: %d consecutive misses, "
                        "force-reconnecting",
                        name, miss_count[name],
                    )
                    stale = self._server_stacks.pop(name, None)
                    self.sessions.pop(name, None)
                    self._last_used_ts.pop(name, None)
                    if stale is not None:
                        try:
                            await asyncio.wait_for(stale.aclose(), timeout=2.0)
                        except (asyncio.TimeoutError, Exception):
                            pass
                    try:
                        await asyncio.wait_for(
                            self._connect_server(name, cfg),
                            timeout=float(os.getenv("MCP_RECONNECT_TIMEOUT_SEC", "10")),
                        )
                        miss_count.pop(name, None)
                        logger.info("MCP keepalive %s: reconnected", name)
                    except (asyncio.TimeoutError, Exception) as e_rec:
                        logger.warning(
                            "MCP keepalive %s: reconnect failed (%s); "
                            "will retry next cycle",
                            name, type(e_rec).__name__,
                        )
        except asyncio.CancelledError:
            logger.info("MCP keepalive loop cancelled")
            raise

    async def disconnect_all(self):
        """Disconnect from all MCP servers."""
        if self._keepalive_task is not None:
            self._keepalive_task.cancel()
            try:
                await self._keepalive_task
            except (asyncio.CancelledError, Exception):
                pass
            self._keepalive_task = None
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
            "techserver": os.getenv(
                # Legacy techserver (SMB host). Exposes techserver_get_tree
                # (list a project's files by OE number, Drawing/ CAD
                # excluded, no download) and techserver_read_artifact
                # (fetch ONE file as markdown). Replaces bulk techserver_sync.
                "TECHSERVER_MCP_URL", "http://techserver-mcp:8053/mcp"
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
