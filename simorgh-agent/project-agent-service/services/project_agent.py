"""
Project Manager Agent
======================
Central orchestrator that listens for project input (chat, email, document),
triggers COT analysis, executes tasks, commits changes, and responds.

Workflow:
1. Receive input (chat message, email, document upload)
2. Trigger COT engine → generate task plan
3. Execute tasks sequentially (respecting dependencies)
4. For each task: use appropriate tool (LLM, shell, memory, doc processor)
5. Commit changes to git after meaningful operations
6. Respond via the input channel
"""

import asyncio
import json
import logging
import os
import uuid
from datetime import datetime
from typing import Optional, List, Dict, Any, Callable

from models.project_models import (
    COTRequest, COTAnalysis, TaskStatus, TaskType, TaskTrigger,
    MessageChannel, MessageRole, AgentState,
)
from services.cot_engine import COTEngine, get_cot_engine
from services.project_memory_service import ProjectMemoryService, get_project_memory_service
from services.shell_service import ShellServiceClient, get_shell_service
from services.mcp_manager import MCPManager, get_mcp_manager
from services.microservice_clients import (
    get_search_client, get_tpms_fetcher_client, get_project_init_client,
    get_project_analysis_client, get_command_gen_client,
    get_file_export_client, get_eplan_bridge_client,
    # mail-gateway client deleted in 2026-05 — mail-bridge replaces it.
)
from services.ekc_knowledge_service import EKCKnowledgeService, get_ekc_knowledge_service

logger = logging.getLogger(__name__)


class ProjectManagerAgent:
    """
    Autonomous project manager agent.
    Handles multi-channel input, COT planning, task execution.
    """

    def __init__(self):
        self.cot_engine: Optional[COTEngine] = None
        self.memory: Optional[ProjectMemoryService] = None
        self.shell: Optional[ShellServiceClient] = None
        self.mcp_manager: Optional[MCPManager] = None
        self.llm_service = None
        self.email_service = None
        self.ekc_knowledge: Optional[EKCKnowledgeService] = None
        # Callbacks for streaming progress to frontend
        self._progress_callbacks: Dict[str, Callable] = {}

    def initialize(self, llm_service=None, email_service=None,
                   redis=None, postgres=None, qdrant=None):
        """Initialize all agent dependencies."""
        self.llm_service = llm_service

        # MCP Manager (connects to microservice MCP servers)
        self.mcp_manager = get_mcp_manager()

        # COT Engine (with MCP for dynamic tool discovery)
        self.cot_engine = get_cot_engine()
        if llm_service:
            self.cot_engine.set_llm_service(llm_service)
        self.cot_engine.set_mcp_manager(self.mcp_manager)

        # Memory (Neo4j no longer required - using MCP + Qdrant + git)
        self.memory = get_project_memory_service()
        self.memory.set_services(redis=redis, postgres=postgres,
                                 qdrant=qdrant, neo4j=None)

        # Shell
        self.shell = get_shell_service()

        # Email
        self.email_service = email_service

        # EKC Knowledge Base (shared volume for general technical info)
        self.ekc_knowledge = get_ekc_knowledge_service()
        if self.ekc_knowledge.is_available():
            logger.info("EKC Knowledge Base loaded: %d documents", self.ekc_knowledge.get_document_count())
        else:
            logger.warning("EKC Knowledge Base not available (volume not mounted)")

        logger.info("Project Manager Agent initialized")

    async def connect_mcp(self):
        """Connect to all MCP servers (call after event loop is running)."""
        if self.mcp_manager:
            try:
                await self.mcp_manager.connect_all()
            except (Exception, asyncio.CancelledError) as e:
                logger.warning(f"MCP connect_all failed (non-fatal): {e}")
            logger.info(f"MCP: {self.mcp_manager.get_server_status()}")

    def register_progress_callback(self, project_id: str, callback: Callable):
        """Register a callback for streaming progress updates."""
        self._progress_callbacks[project_id] = callback

    def unregister_progress_callback(self, project_id: str):
        """Remove progress callback."""
        self._progress_callbacks.pop(project_id, None)

    async def _notify_progress(self, project_id: str, event: str, data: Dict):
        """Send progress update to registered callback."""
        callback = self._progress_callbacks.get(project_id)
        if callback:
            try:
                await callback({"event": event, "data": data})
            except Exception as e:
                logger.warning(f"Progress callback failed: {e}")

        # Always update Redis state
        try:
            state = await self.memory.get_agent_state(project_id) or {}
            state.update({
                "last_event": event,
                "last_event_data": data,
                "last_activity": datetime.utcnow().isoformat(),
            })
            await self.memory.set_agent_state(project_id, state)
        except Exception:
            pass

    # =========================================================================
    # MAIN ENTRY POINT
    # =========================================================================

    async def handle_input(
        self,
        project_id: str,
        user_input: str,
        channel: MessageChannel = MessageChannel.CHAT,
        chat_id: str = None,
        user_id: str = None,
        document_id: str = None,
        document_filename: str = None,
        email_from: str = None,
        email_subject: str = None,
        auto_execute: bool = True,
        stream: bool = True,
    ) -> Dict[str, Any]:
        """
        Handle any input to the project.
        This is the main entry point for all channels.

        Returns:
            Dict with response, tasks created, and execution results
        """
        logger.info(
            f"Agent handling input: project={project_id}, "
            f"channel={channel.value}, input_len={len(user_input)}"
        )

        # 1. Store the incoming message
        await self.memory.store_message(
            project_id=project_id,
            role="user",
            content=user_input,
            channel=channel.value,
            chat_id=chat_id,
            email_from=email_from,
            email_subject=email_subject,
            document_id=document_id,
            document_filename=document_filename,
        )

        await self._notify_progress(project_id, "input_received", {
            "channel": channel.value,
            "input_preview": user_input[:100],
        })

        # 2. Build project context from all memory layers
        await self._notify_progress(project_id, "building_context", {})
        project_context = await self.memory.build_agent_context(
            project_id, query=user_input
        )

        # 2a. Check Redis for project structure analysis — re-run if missing (data loss recovery)
        await self._ensure_project_analysis(project_id, project_context)

        # 2b. Inject EKC general technical knowledge into context
        if self.ekc_knowledge and self.ekc_knowledge.is_available():
            ekc_context = self.ekc_knowledge.get_knowledge_context_for_agent()
            if ekc_context:
                project_context["ekc_knowledge"] = ekc_context

        # 3. Trigger COT analysis
        await self._notify_progress(project_id, "cot_analyzing", {
            "status": "Analyzing request and creating plan..."
        })

        cot_request = COTRequest(
            project_id=uuid.UUID(project_id) if isinstance(project_id, str) else project_id,
            user_input=user_input,
            channel=channel,
            chat_id=chat_id,
            document_id=uuid.UUID(document_id) if document_id else None,
            email_subject=email_subject,
            email_from=email_from,
            auto_execute=auto_execute,
        )

        instructions = project_context.get("instructions", [])
        analysis = await self.cot_engine.analyze(
            cot_request, project_context, instructions
        )

        # Cache the analysis
        await self.memory.cache_cot_analysis(
            str(analysis.chain_id),
            analysis.model_dump(mode='json'),
        )

        await self._notify_progress(project_id, "cot_complete", {
            "chain_id": str(analysis.chain_id),
            "reasoning": analysis.reasoning,
            "total_steps": analysis.total_steps,
            "steps": [{"title": s.title, "type": s.task_type.value} for s in analysis.steps],
        })

        # 4. Create tasks from COT steps
        tasks_created = []
        for step in analysis.steps:
            task_data = {
                "title": step.title,
                "description": step.description,
                "task_type": step.task_type.value,
                "cot_chain_id": str(analysis.chain_id),
                "priority": step.priority,
                "tool_used": step.tool_needed,
                "tool_input": step.tool_input,
                "sort_order": step.step_number,
                "triggered_by": TaskTrigger.USER.value if channel == MessageChannel.CHAT
                    else TaskTrigger.EMAIL.value if channel == MessageChannel.EMAIL
                    else TaskTrigger.DOCUMENT.value if channel == MessageChannel.DOCUMENT
                    else TaskTrigger.USER.value,
            }
            task = await self.memory.create_task(project_id, task_data)
            if task:
                tasks_created.append(task)

        await self._notify_progress(project_id, "tasks_created", {
            "count": len(tasks_created),
            "tasks": [{"id": str(t["id"]), "title": t["title"]} for t in tasks_created],
        })

        # 5. Execute tasks if auto_execute
        execution_results = []
        final_response = ""

        if auto_execute and tasks_created:
            execution_results, final_response = await self._execute_task_chain(
                project_id, str(analysis.chain_id), tasks_created,
                project_context=project_context,
            )
        elif not auto_execute:
            final_response = (
                f"Plan created with {len(tasks_created)} steps:\n\n"
                + "\n".join(
                    f"{i+1}. {t['title']}" for i, t in enumerate(tasks_created)
                )
                + "\n\nApprove to start execution."
            )

        # 6. Store agent response
        await self.memory.store_message(
            project_id=project_id,
            role="assistant",
            content=final_response,
            channel=channel.value,
            chat_id=chat_id,
        )

        # 7. End-of-chain rollup commit — captures any leftover changes that
        # weren't committed per-task (rare; shouldn't normally fire). The
        # per-task commits inside _execute_task_chain do the heavy lifting.
        commit_result = await self._auto_commit(
            project_id,
            f"cot(chain|rollup): {user_input[:80]}",
        )

        await self._notify_progress(project_id, "complete", {
            "response_preview": final_response[:200],
            "tasks_completed": len([r for r in execution_results if r.get("status") == "completed"]),
            "tasks_failed": len([r for r in execution_results if r.get("status") == "failed"]),
        })

        return {
            "response": final_response,
            "chain_id": str(analysis.chain_id),
            "reasoning": analysis.reasoning,
            "tasks_created": len(tasks_created),
            "tasks": [{"id": str(t["id"]), "title": t["title"], "status": t.get("status")}
                      for t in tasks_created],
            "execution_results": execution_results,
            "commit": commit_result,
        }

    # =========================================================================
    # TASK EXECUTION
    # =========================================================================

    async def _execute_task_chain(
        self,
        project_id: str,
        chain_id: str,
        tasks: List[Dict],
        project_context: Dict[str, Any] = None,
    ) -> tuple:
        """Execute a chain of COT tasks sequentially."""
        results = []
        accumulated_context = {}  # Results from previous tasks for chaining
        final_response = ""

        # Pre-seed context with semantic search results from project_context
        if project_context and project_context.get("semantic_results"):
            semantic_text = "\n\n".join(
                (r.get("text") or r.get("content") or "")[:2000]
                for r in project_context["semantic_results"][:5]
            )
            if semantic_text.strip():
                accumulated_context["_semantic_context"] = {
                    "output": semantic_text,
                    "metadata": {"source": "qdrant_semantic_search"},
                }

        for i, task in enumerate(tasks):
            task_id = str(task["id"])

            await self._notify_progress(project_id, "task_executing", {
                "task_id": task_id,
                "task_title": task["title"],
                "step": i + 1,
                "total": len(tasks),
                "progress_percent": round((i / len(tasks)) * 100),
            })

            # Mark as in_progress
            await self.memory.update_task(
                task_id, project_id, status=TaskStatus.IN_PROGRESS.value
            )

            try:
                result = await self._execute_single_task(
                    project_id, task, accumulated_context
                )

                # Store result
                await self.memory.update_task(
                    task_id, project_id,
                    status=TaskStatus.COMPLETED.value,
                    result=result.get("output", ""),
                    result_metadata=result.get("metadata", {}),
                )

                # Accumulate context for next tasks
                accumulated_context[task["sort_order"]] = result

                # Track the last generation result as the final response
                if task.get("task_type") in ("generation", "analysis"):
                    final_response = result.get("output", "")

                results.append({
                    "task_id": task_id,
                    "title": task["title"],
                    "status": "completed",
                    "output": result.get("output", "")[:500],
                })

                # Per-task auto-commit. We commit after every task that may
                # have modified the workspace, with a meaningful, traceable
                # message — `git log` becomes the audit trail of what the
                # agent did and why. Tools that don't touch the workspace
                # (memory_query, generation, analysis) skip the commit.
                tool = task.get("tool_used", "llm")
                task_type = task.get("task_type", "action")
                touches_workspace = (
                    tool in {
                        "shell", "git", "file_export", "eplan_bridge",
                        "command_gen", "project_init", "project_analysis",
                        "techserver", "tech_kb", "documents_rag",
                    }
                    or task_type in {"shell_command", "git_commit", "document"}
                )
                if touches_workspace:
                    summary = (
                        result.get("summary")
                        or (result.get("output") or "")[:120].replace("\n", " ").strip()
                    )
                    msg = f"cot({task_id[:8]}|{tool}): {task['title']}"
                    if summary:
                        msg = f"{msg}\n\n{summary}"
                    try:
                        await self._auto_commit(project_id, msg)
                    except Exception:
                        # Commit failures are non-fatal — the data is still
                        # on disk. Logged inside _auto_commit.
                        pass

                await self._notify_progress(project_id, "task_completed", {
                    "task_id": task_id,
                    "task_title": task["title"],
                    "step": i + 1,
                    "total": len(tasks),
                    "progress_percent": round(((i + 1) / len(tasks)) * 100),
                })

            except Exception as e:
                error_msg = str(e)
                logger.error(f"Task {task_id} failed: {error_msg}", exc_info=True)

                await self.memory.update_task(
                    task_id, project_id,
                    status=TaskStatus.FAILED.value,
                    error_message=error_msg,
                )

                results.append({
                    "task_id": task_id,
                    "title": task["title"],
                    "status": "failed",
                    "error": error_msg,
                })

                await self._notify_progress(project_id, "task_failed", {
                    "task_id": task_id,
                    "task_title": task["title"],
                    "error": error_msg,
                })

                # Continue with next task instead of stopping
                continue

        # If no generation task produced a response, summarize results
        if not final_response:
            completed = [r for r in results if r["status"] == "completed"]
            failed = [r for r in results if r["status"] == "failed"]

            parts = []
            if completed:
                parts.append(f"Completed {len(completed)} task(s):")
                for r in completed:
                    output_preview = r.get("output", "")[:150]
                    parts.append(f"- {r['title']}: {output_preview}")
            if failed:
                parts.append(f"\nFailed {len(failed)} task(s):")
                for r in failed:
                    parts.append(f"- {r['title']}: {r.get('error', 'Unknown error')}")

            final_response = "\n".join(parts) or "Tasks executed but no output generated."

        return results, final_response

    async def _try_gitlab_rest(self, tool: str, tool_input: dict):
        """Fallback path for gitlab_mcp tools when the streamable-HTTP
        transport misbehaves. gitlab-mcp exposes equivalent REST routes
        we can hit directly. Returns the same {output, metadata} shape
        the MCP path returns, or None if the tool isn't covered."""
        import httpx
        base = os.getenv("GITLAB_MCP_URL", "http://gitlab-mcp:8047").rstrip("/")
        project = tool_input.get("project") or tool_input.get("project_id")
        if not project:
            return None
        try:
            async with httpx.AsyncClient(timeout=30) as c:
                if tool == "get_project_tree":
                    r = await c.get(f"{base}/tree", params={
                        "project": project,
                        "ref": tool_input.get("ref", "main"),
                        "path": tool_input.get("path", ""),
                        "recursive": True,
                    })
                elif tool == "read_file_mcp":
                    r = await c.get(f"{base}/file", params={
                        "project": project,
                        "path": tool_input.get("path", ""),
                        "ref": tool_input.get("ref", "main"),
                    })
                elif tool == "list_branches_mcp":
                    r = await c.get(f"{base}/branches", params={
                        "project": project, "per_page": 100,
                    })
                elif tool == "list_projects_mcp":
                    r = await c.get(f"{base}/projects", params={
                        "group": tool_input.get("group", ""),
                        "search": tool_input.get("search_term", ""),
                    })
                elif tool == "search_blobs":
                    r = await c.get(f"{base}/search", params={
                        "project": project,
                        "scope": "blobs",
                        "search": tool_input.get("query", ""),
                    })
                else:
                    return None
                r.raise_for_status()
                import json as _json
                body = r.json()
                return {
                    "output": _json.dumps(body, ensure_ascii=False)[:8000],
                    "metadata": {
                        "via": "gitlab_mcp_rest_fallback",
                        "tool": tool,
                    },
                }
        except Exception as e:
            logger.warning(f"gitlab REST fallback for {tool} failed: {e}")
            return None

    async def _execute_single_task(
        self,
        project_id: str,
        task: Dict,
        prev_results: Dict,
    ) -> Dict[str, Any]:
        """Execute a single task using the appropriate tool."""
        tool = task.get("tool_used", "llm")
        raw_input = task.get("tool_input")
        task_type = task.get("task_type", "action")

        # The planner sometimes prefixes the tool name with the MCP
        # server, e.g. "gitlab_mcp.get_project_tree". The tool registry
        # is keyed by the bare name. Strip the prefix if the dotted form
        # doesn't match but the suffix does.
        if (
            isinstance(tool, str) and "." in tool
            and self.mcp_manager
            and not self.mcp_manager.has_tool(tool)
        ):
            bare = tool.rsplit(".", 1)[-1]
            if self.mcp_manager.has_tool(bare):
                tool = bare

        # Normalize tool_input: LLM may return a string instead of dict
        if isinstance(raw_input, str) and raw_input:
            if tool == "memory_query":
                tool_input = {"query": raw_input}
            elif tool in ("shell", "git") or task_type == "shell_command":
                tool_input = {"command": raw_input}
            else:
                tool_input = {"prompt": raw_input}
        elif isinstance(raw_input, dict):
            tool_input = raw_input
        else:
            tool_input = {}

        # Qwen2.5-VL sometimes wraps the real arg dict as a JSON string
        # inside a "prompt" key, e.g.
        #   tool_input = {"prompt": "{\"depth\":\"medium\",\"project_id\":\"x\"}"}
        # Unwrap that so the MCP tool sees the named arguments it expects.
        if (
            isinstance(tool_input, dict)
            and set(tool_input.keys()) == {"prompt"}
            and isinstance(tool_input.get("prompt"), str)
            and tool_input["prompt"].lstrip().startswith("{")
        ):
            try:
                import json as _json
                parsed = _json.loads(tool_input["prompt"])
                if isinstance(parsed, dict):
                    tool_input = parsed
            except Exception:
                pass

        # Always pass through the canonical project_id when the LLM left
        # a placeholder ("unknown", empty, missing) — MCP tools like
        # project_analyze require it.
        if isinstance(tool_input, dict):
            pid = tool_input.get("project_id")
            if not pid or str(pid).lower() in ("unknown", "none", "null", ""):
                tool_input["project_id"] = str(project_id)

        # gitlab_mcp.* tools take `project` as the GitLab path (e.g.
        # "shahram-tabasi/test"), NOT the chatbot UUID. The planner
        # often substitutes the UUID anyway. Replace it with the
        # project's gitlab_repo_path from memory whenever the value
        # looks like a UUID or is missing.
        if (
            isinstance(tool_input, dict)
            and self.mcp_manager
            and self.mcp_manager.is_connected
        ):
            server_name = self.mcp_manager.tools.get(tool)
            if server_name == "gitlab_mcp":
                proj_arg = tool_input.get("project") or tool_input.get("project_id")
                looks_like_uuid = (
                    isinstance(proj_arg, str)
                    and len(proj_arg) == 36
                    and proj_arg.count("-") == 4
                )
                if not proj_arg or looks_like_uuid:
                    try:
                        meta = await self.memory.get_project(str(project_id))
                    except Exception:
                        meta = None
                    repo_path = (meta or {}).get("gitlab_repo_path")
                    if repo_path:
                        tool_input["project"] = repo_path
                        tool_input.pop("project_id", None)

        # Inject previous results into context (3000 char limit per result)
        if prev_results:
            tool_input["_previous_results"] = {
                k: v.get("output", "")[:3000] for k, v in prev_results.items()
            }

        has_mcp_tool = (
            self.mcp_manager
            and self.mcp_manager.is_connected
            and self.mcp_manager.has_tool(tool)
        )
        logger.info(
            f"dispatch: tool={tool!r} type={task_type!r} "
            f"mcp_match={has_mcp_tool} "
            f"input_keys={list(tool_input.keys()) if isinstance(tool_input, dict) else None}"
        )

        # Try MCP first for microservice tools (dynamic routing)
        if has_mcp_tool:
            try:
                return await self.mcp_manager.call_tool(tool, tool_input)
            except Exception as e:
                logger.warning(f"MCP call failed for {tool}, falling back to HTTP: {e}")
                # gitlab-mcp also exposes REST endpoints that work fine
                # when the streamable-HTTP transport is misbehaving. Try
                # those directly before giving up.
                rest_fallback = await self._try_gitlab_rest(tool, tool_input)
                if rest_fallback is not None:
                    return rest_fallback

        # Direct execution for core tools + HTTP fallback for microservice tools
        if tool == "llm" or task_type in ("generation", "analysis", "review"):
            return await self._execute_llm_task(project_id, task, tool_input)
        elif tool == "shell" or task_type == "shell_command":
            return await self._execute_shell_task(project_id, task, tool_input)
        elif tool == "memory_query":
            return await self._execute_memory_query(project_id, task, tool_input)
        elif tool == "memory_store":
            return await self._execute_memory_store(project_id, task, tool_input)
        elif tool == "document_process":
            return await self._execute_document_task(project_id, task, tool_input)
        elif tool == "semantic_store":
            return await self._execute_semantic_store_task(project_id, task, tool_input)
        elif tool == "email":
            return await self._execute_email_task(project_id, task, tool_input)
        elif tool == "git":
            return await self._execute_git_task(project_id, task, tool_input)
        elif tool == "web_search":
            return await self._execute_web_search_task(project_id, task, tool_input)
        elif tool == "tpms_fetch":
            return await self._execute_tpms_fetch_task(project_id, task, tool_input)
        elif tool == "project_init":
            return await self._execute_project_init_task(project_id, task, tool_input)
        elif tool == "project_analyze":
            return await self._execute_project_analyze_task(project_id, task, tool_input)
        elif tool == "command_gen":
            return await self._execute_command_gen_task(project_id, task, tool_input)
        elif tool == "file_export":
            return await self._execute_file_export_task(project_id, task, tool_input)
        elif tool == "eplan_draw":
            return await self._execute_eplan_draw_task(project_id, task, tool_input)
        elif tool == "sld_analyze":
            return await self._execute_sld_analyze_task(project_id, task, tool_input)
        elif tool == "techserver_sync":
            return await self._execute_techserver_sync_task(project_id, task, tool_input)
        else:
            # Default: use LLM
            return await self._execute_llm_task(project_id, task, tool_input)

    async def _execute_llm_task(self, project_id: str, task: Dict,
                                tool_input: Dict) -> Dict:
        """Execute an LLM-based task."""
        if not self.llm_service:
            return {"output": "LLM service not available", "metadata": {}}

        # Build prompt with context
        prompt = tool_input.get("prompt", task.get("description", task["title"]))

        # Build context from previous results and semantic search
        prev = tool_input.get("_previous_results", {})
        context_parts = []

        # Include EKC general technical knowledge
        if self.ekc_knowledge and self.ekc_knowledge.is_available():
            ekc_results = self.ekc_knowledge.search_fulltext(
                tool_input.get("prompt", task.get("description", task["title"]))
            )
            if ekc_results:
                ekc_summaries = "\n".join(
                    f"- {d['title']}: {d['summary']}" for d in ekc_results[:5]
                )
                context_parts.append(f"EKC Knowledge Base (relevant documents):\n{ekc_summaries}")

        # Include semantic search context (from Qdrant) if available
        semantic_ctx = prev.pop("_semantic_context", None)
        if semantic_ctx:
            context_parts.append(f"Document content from semantic search:\n{semantic_ctx}")

        # Include other previous step results
        if prev:
            for k, v in prev.items():
                context_parts.append(f"Step {k} result: {v}")

        if context_parts:
            context = "\n\n".join(context_parts)
            prompt = f"Context:\n{context}\n\nTask: {prompt}"

        messages = [
            {"role": "system", "content": "You are a project assistant. Answer concisely and accurately based on the available context. Use the document content provided to give specific, detailed answers."},
            {"role": "user", "content": prompt},
        ]

        try:
            if hasattr(self.llm_service, 'async_generate'):
                result = await self.llm_service.async_generate(
                    messages=messages,
                    user_id=f"agent_{project_id}",
                )
                response = result.get('response', '') if isinstance(result, dict) else str(result)
            else:
                result = self.llm_service.generate(messages=messages)
                response = result.get('response', '') if isinstance(result, dict) else str(result)

            return {
                "output": response,
                "metadata": {"model": result.get("model", "unknown") if isinstance(result, dict) else "unknown"},
            }
        except Exception as e:
            logger.error(f"LLM task failed: {e}")
            return {"output": f"LLM error: {str(e)}", "metadata": {"error": True}}

    async def _execute_shell_task(self, project_id: str, task: Dict,
                                  tool_input: Dict) -> Dict:
        """Execute a shell command task."""
        if not self.shell:
            return {"output": "Shell service not available", "metadata": {}}

        command = tool_input.get("command", "")
        if not command:
            command = task.get("description", "echo 'No command specified'")

        try:
            result = await self.shell.exec_command(
                project_id=project_id,
                command=command,
                timeout=tool_input.get("timeout", 30),
            )
            output = result.stdout if result.exit_code == 0 else f"ERROR (exit {result.exit_code}):\n{result.stderr}"
            return {
                "output": output,
                "metadata": {
                    "exit_code": result.exit_code,
                    "duration_ms": result.duration_ms,
                    "command": command,
                },
            }
        except Exception as e:
            return {"output": f"Shell error: {str(e)}", "metadata": {"error": True}}

    async def _execute_memory_query(self, project_id: str, task: Dict,
                                    tool_input: Dict) -> Dict:
        """Execute a memory query task."""
        query = tool_input.get("query", task.get("description", ""))
        results = {}

        # Search across memory layers
        if tool_input.get("search_vectors", True):
            semantic = await self.memory.semantic_search(project_id, query)
            if semantic:
                results["semantic"] = [
                    {"content": (r.get("text") or r.get("content") or "")[:1500], "score": r.get("score", 0)}
                    for r in semantic[:5]
                ]

        if tool_input.get("search_graph", True):
            graph = await self.memory.query_graph(project_id)
            if graph.get("nodes"):
                results["graph_nodes"] = len(graph["nodes"])
                results["graph_summary"] = str(graph)[:500]

        # Recent messages
        messages = await self.memory.get_recent_context(project_id, limit=5)
        if messages:
            results["recent_messages"] = [
                {"role": m["role"], "content": m["content"][:200]} for m in messages
            ]

        output = json.dumps(results, indent=2, default=str)
        return {"output": output, "metadata": {"sources": list(results.keys())}}

    async def _execute_memory_store(self, project_id: str, task: Dict,
                                    tool_input: Dict) -> Dict:
        """Store data in project memory."""
        store_type = tool_input.get("store_type", "working")
        key = tool_input.get("key", "")
        value = tool_input.get("value", "")

        if store_type == "graph_entity":
            result = await self.memory.store_graph_entity(
                project_id,
                tool_input.get("entity_type", "Note"),
                tool_input.get("entity_id", str(uuid.uuid4())),
                tool_input.get("properties", {"content": value}),
            )
            return {"output": f"Stored graph entity: {result}", "metadata": result}
        else:
            await self.memory.store_working_memory(project_id, key, value)
            return {"output": f"Stored in working memory: {key}", "metadata": {"key": key}}

    async def _execute_document_task(self, project_id: str, task: Dict,
                                     tool_input: Dict) -> Dict:
        """
        Process a document - save to project workspace on 1.69, convert to
        markdown, and commit to git.
        """
        content = tool_input.get("content", "")
        filename = tool_input.get("filename", "document")
        document_id = tool_input.get("document_id")

        # 1. Save original document content to project workspace on 1.69
        if self.shell and content:
            try:
                safe_filename = filename.replace("/", "_").replace("\\", "_")
                await self.shell.file_write(
                    project_id=project_id,
                    path=f"documents/{safe_filename}",
                    content=content[:100000],
                )
            except Exception as e:
                logger.warning(f"Failed to save document to workspace: {e}")

        # 2. Use LLM to convert content to clean markdown
        markdown = ""
        if self.llm_service and content:
            prompt = (
                f"Convert the following document content to clean, well-structured markdown. "
                f"Preserve all important information, headings, lists, and tables.\n\n"
                f"Document: {filename}\n\nContent:\n{content[:4000]}"
            )
            messages = [
                {"role": "system", "content": "You are a document processing assistant. Convert document content to clean markdown."},
                {"role": "user", "content": prompt},
            ]
            try:
                if hasattr(self.llm_service, 'async_generate'):
                    result = await self.llm_service.async_generate(
                        messages=messages, user_id=f"agent_{project_id}")
                    markdown = result.get('response', '') if isinstance(result, dict) else str(result)
                else:
                    result = self.llm_service.generate(messages=messages)
                    markdown = result.get('response', '') if isinstance(result, dict) else str(result)
            except Exception as e:
                logger.warning(f"Document markdown conversion failed: {e}")

        # 3. Save markdown version to workspace
        if self.shell and markdown:
            try:
                safe_filename = filename.replace("/", "_").replace("\\", "_")
                md_filename = safe_filename.rsplit(".", 1)[0] + ".md" if "." in safe_filename else safe_filename + ".md"
                await self.shell.file_write(
                    project_id=project_id,
                    path=f"documents/{md_filename}",
                    content=markdown,
                )
            except Exception as e:
                logger.warning(f"Failed to save markdown to workspace: {e}")

        # 4. Commit the uploaded document to git
        if self.shell:
            try:
                await self.shell.git_commit(
                    project_id, f"Add uploaded document: {filename}"
                )
            except Exception as e:
                logger.warning(f"Failed to commit document: {e}")

        output = markdown if markdown else (content[:2000] if content else "No content to process")
        return {
            "output": output,
            "metadata": {"document_id": document_id, "filename": filename, "format": "markdown" if markdown else "raw"},
        }

    async def _execute_semantic_store_task(self, project_id: str, task: Dict,
                                           tool_input: Dict) -> Dict:
        """Chunk text content and store in Qdrant for semantic search."""
        content = tool_input.get("content", "")
        document_id = tool_input.get("document_id")
        filename = tool_input.get("filename", "document")

        # Get content from previous task results if not provided directly
        prev = tool_input.get("_previous_results", {})
        if not content and prev:
            # Look for content from previous document_process or LLM task
            for step_result in prev.values():
                if step_result and len(step_result) > 100:
                    content = step_result
                    break

        if not content:
            return {"output": "No content to index", "metadata": {"error": True}}

        if not self.memory.qdrant:
            return {"output": "Qdrant service not available", "metadata": {"error": True}}

        try:
            # Chunk content into segments (~500 chars each)
            chunk_dicts = []
            chunk_size = 500
            overlap = 50
            text = content.strip()
            i = 0
            chunk_idx = 0
            while i < len(text):
                end = min(i + chunk_size, len(text))
                chunk_text = text[i:end]
                if chunk_text.strip():
                    chunk_dicts.append({
                        "text": chunk_text.strip(),
                        "section_title": filename,
                        "chunk_index": chunk_idx,
                        "metadata": {"filename": filename},
                    })
                    chunk_idx += 1
                i += chunk_size - overlap

            # Store all chunks in Qdrant using add_document_chunks
            # Use OENUM for collection name to match search queries
            agent_state = await self.memory.get_agent_state(project_id)
            oenum = (agent_state or {}).get("tpms_oenum") or project_id
            doc_uuid = document_id or str(uuid.uuid4())
            success = self.memory.qdrant.add_document_chunks(
                user_id="system",
                document_id=doc_uuid,
                chunks=chunk_dicts,
                project_oenum=oenum,
            )
            stored = len(chunk_dicts) if success else 0

            # Update document record if document_id provided
            if document_id:
                try:
                    await self.memory.update_document(
                        document_id,
                        processing_status="completed",
                        chunk_count=stored,
                        content_summary=content[:500],
                    )
                except Exception:
                    pass

            return {
                "output": f"Indexed {stored}/{len(chunk_dicts)} chunks in semantic search for {filename}",
                "metadata": {
                    "document_id": document_id,
                    "chunks_stored": stored,
                    "total_chunks": len(chunk_dicts),
                },
            }
        except Exception as e:
            logger.error(f"Semantic store failed: {e}")
            return {"output": f"Semantic indexing error: {e}", "metadata": {"error": True}}

    async def _execute_email_task(self, project_id: str, task: Dict,
                                  tool_input: Dict) -> Dict:
        """Send an email."""
        if not self.email_service:
            return {"output": "Email service not available", "metadata": {}}

        to_email = tool_input.get("to", "")
        subject = tool_input.get("subject", "Project Update")
        body = tool_input.get("body", task.get("description", ""))

        try:
            await self.email_service.send_email(to_email, subject, body)
            return {
                "output": f"Email sent to {to_email}",
                "metadata": {"to": to_email, "subject": subject},
            }
        except Exception as e:
            return {"output": f"Email failed: {str(e)}", "metadata": {"error": True}}

    async def _execute_git_task(self, project_id: str, task: Dict,
                                tool_input: Dict) -> Dict:
        """Execute a git operation."""
        if not self.shell:
            return {"output": "Shell service not available for git", "metadata": {}}

        operation = tool_input.get("operation", "status")

        try:
            if operation == "init":
                result = await self.shell.git_init(project_id)
                return {"output": f"Git init: {result.get('status')}", "metadata": result}
            elif operation == "commit":
                message = tool_input.get("message", "Agent commit")
                result = await self.shell.git_commit(project_id, message)
                return {"output": f"Committed: {result.get('commit_hash', 'N/A')}", "metadata": result}
            elif operation == "log":
                result = await self.shell.git_log(project_id)
                return {"output": json.dumps(result.get("commits", [])[:5], indent=2), "metadata": result}
            elif operation == "diff":
                result = await self.shell.git_diff(project_id)
                return {"output": result.get("unstaged", "No changes"), "metadata": result}
            else:
                return {"output": f"Unknown git operation: {operation}", "metadata": {}}
        except Exception as e:
            return {"output": f"Git error: {str(e)}", "metadata": {"error": True}}

    # =========================================================================
    # MICROSERVICE TOOL EXECUTORS
    # =========================================================================

    async def _execute_web_search_task(self, project_id: str, task: Dict,
                                       tool_input: Dict) -> Dict:
        """Execute a web search via the search microservice."""
        client = get_search_client()
        query = tool_input.get("query", task.get("description", ""))
        max_results = tool_input.get("max_results", 5)
        try:
            result = await client.search(
                query=query,
                max_results=max_results,
                region=tool_input.get("region", "wt-wt"),
                time_range=tool_input.get("time_range"),
            )
            results_text = "\n\n".join(
                f"**{r.get('title', '')}**\n{r.get('snippet', '')}\nURL: {r.get('url', '')}"
                for r in result.get("results", [])
            )
            return {
                "output": results_text or "No results found.",
                "metadata": {"query": query, "count": len(result.get("results", []))},
            }
        except Exception as e:
            logger.error(f"Web search failed: {e}")
            return {"output": f"Search error: {e}", "metadata": {"error": True}}

    async def _execute_tpms_fetch_task(self, project_id: str, task: Dict,
                                       tool_input: Dict) -> Dict:
        """Fetch project data from TPMS via the fetcher microservice."""
        client = get_tpms_fetcher_client()
        oenum = tool_input.get("oenum", "")
        if not oenum:
            return {"output": "No OENUM provided for TPMS fetch", "metadata": {"error": True}}
        try:
            result = await client.fetch_project(oenum)
            text = await client.get_project_text(oenum)
            return {
                "output": text or json.dumps(result, indent=2, default=str),
                "metadata": {"oenum": oenum, "status": result.get("status", "fetched")},
            }
        except Exception as e:
            logger.error(f"TPMS fetch failed: {e}")
            return {"output": f"TPMS fetch error: {e}", "metadata": {"error": True}}

    async def _execute_project_init_task(self, project_id: str, task: Dict,
                                         tool_input: Dict) -> Dict:
        """Initialize a project workspace via the init microservice."""
        client = get_project_init_client()
        try:
            result = await client.init_project(
                project_id=project_id,
                project_name=tool_input.get("project_name", "Untitled"),
                owner_id=tool_input.get("owner_id", "agent"),
                oenum=tool_input.get("oenum"),
            )
            return {
                "output": f"Project initialized: {result.get('status', 'done')}",
                "metadata": result,
            }
        except Exception as e:
            logger.error(f"Project init failed: {e}")
            return {"output": f"Project init error: {e}", "metadata": {"error": True}}

    async def _execute_project_analyze_task(self, project_id: str, task: Dict,
                                            tool_input: Dict) -> Dict:
        """Analyze project workspace via the analysis microservice."""
        client = get_project_analysis_client()
        depth = tool_input.get("depth", "medium")
        try:
            result = await client.analyze(project_id=project_id, depth=depth)
            report = result.get("report", result)
            output = json.dumps(report, indent=2, default=str) if isinstance(report, dict) else str(report)
            return {
                "output": output,
                "metadata": {"depth": depth, "report_id": result.get("report_id")},
            }
        except Exception as e:
            logger.error(f"Project analysis failed: {e}")
            return {"output": f"Analysis error: {e}", "metadata": {"error": True}}

    async def _execute_command_gen_task(self, project_id: str, task: Dict,
                                        tool_input: Dict) -> Dict:
        """Generate safe shell commands via the command-gen microservice."""
        client = get_command_gen_client()
        description = tool_input.get("task_description", task.get("description", ""))
        task_type = tool_input.get("task_type", "search")
        try:
            result = await client.generate(
                task_description=description,
                project_id=project_id,
                task_type=task_type,
                context=tool_input.get("context"),
            )
            commands = result.get("commands", [])
            output = "\n".join(commands) if isinstance(commands, list) else str(commands)
            return {
                "output": output,
                "metadata": {"task_type": task_type, "command_count": len(commands) if isinstance(commands, list) else 1},
            }
        except Exception as e:
            logger.error(f"Command generation failed: {e}")
            return {"output": f"Command gen error: {e}", "metadata": {"error": True}}

    async def _execute_file_export_task(self, project_id: str, task: Dict,
                                        tool_input: Dict) -> Dict:
        """Generate export files via the file-export microservice."""
        client = get_file_export_client()
        fmt = tool_input.get("format", "excel")
        title = tool_input.get("title", "Export")
        try:
            if fmt == "excel":
                result = await client.export_excel(
                    project_id=project_id,
                    title=title,
                    tables=tool_input.get("tables", tool_input.get("data", {}).get("tables", [])),
                    filename=tool_input.get("filename", "export.xlsx"),
                )
            elif fmt == "word":
                result = await client.export_word(
                    project_id=project_id,
                    title=title,
                    sections=tool_input.get("sections", tool_input.get("data", {}).get("sections", [])),
                    tables=tool_input.get("tables", []),
                    filename=tool_input.get("filename", "report.docx"),
                )
            elif fmt == "pdf":
                prev = tool_input.get("_previous_results", {})
                content = tool_input.get("content", "")
                if not content and prev:
                    for v in prev.values():
                        if v and len(str(v)) > 50:
                            content = str(v)
                            break
                result = await client.export_pdf(
                    project_id=project_id,
                    title=title,
                    content=content,
                    filename=tool_input.get("filename", "report.pdf"),
                )
            else:
                return {"output": f"Unknown export format: {fmt}", "metadata": {"error": True}}

            download_id = result.get("download_id", result.get("id", ""))
            return {
                "output": f"File exported ({fmt}): {result.get('filename', title)} [download_id: {download_id}]",
                "metadata": result,
            }
        except Exception as e:
            logger.error(f"File export failed: {e}")
            return {"output": f"Export error: {e}", "metadata": {"error": True}}

    async def _execute_eplan_draw_task(self, project_id: str, task: Dict,
                                       tool_input: Dict) -> Dict:
        """Trigger EPLAN drawing generation via the bridge microservice."""
        client = get_eplan_bridge_client()
        project_name = tool_input.get("project_name", "")
        eplan_data = tool_input.get("eplan_data", [])
        if not project_name or not eplan_data:
            return {"output": "Missing project_name or eplan_data for drawing", "metadata": {"error": True}}
        try:
            port_info = await client.resolve_port(tool_input.get("username", "agent"))
            port = port_info.get("port", 12000)
            result = await client.draw(
                project_name=project_name,
                eplan_data=eplan_data,
                port=port,
                username=tool_input.get("username", "agent"),
            )
            return {
                "output": f"EPLAN drawing job submitted: {result.get('job_id', 'N/A')} - status: {result.get('status', 'submitted')}",
                "metadata": result,
            }
        except Exception as e:
            logger.error(f"EPLAN draw failed: {e}")
            return {"output": f"EPLAN draw error: {e}", "metadata": {"error": True}}

    async def _execute_sld_analyze_task(self, project_id: str, task: Dict,
                                        tool_input: Dict) -> Dict:
        """Analyze a Single Line Diagram using GPT-4o vision."""
        document_id = tool_input.get("document_id")
        filename = tool_input.get("filename", "sld.png")

        if not document_id:
            return {"output": "No document_id provided for SLD analysis", "metadata": {"error": True}}

        # Read the document from shell workspace
        try:
            if self.shell:
                file_data = await self.shell.file_read(project_id, f"documents/{filename}")
                if not file_data:
                    return {"output": f"Document {filename} not found in workspace", "metadata": {"error": True}}

                # Determine MIME type
                ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else "png"
                mime_map = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
                            "pdf": "application/pdf", "bmp": "image/bmp", "tiff": "image/tiff"}
                mime_type = mime_map.get(ext, "image/png")

                result = await self.analyze_sld(
                    project_id=project_id,
                    image_bytes=file_data.encode("latin-1") if isinstance(file_data, str) else file_data,
                    mime_type=mime_type,
                    filename=filename,
                )

                if result.get("success"):
                    output = json.dumps(result, indent=2, default=str)
                    return {"output": output, "metadata": {"analysis_id": result.get("analysis_id")}}
                else:
                    return {"output": f"SLD analysis failed: {result.get('error')}", "metadata": {"error": True}}
        except Exception as e:
            return {"output": f"SLD analysis error: {e}", "metadata": {"error": True}}

        return {"output": "SLD analysis not available", "metadata": {"error": True}}

    async def _execute_techserver_sync_task(self, project_id: str, task: Dict,
                                             tool_input: Dict) -> Dict:
        """Sync files from techserver (192.168.1.3) via SMB for a project."""
        oenum = tool_input.get("oenum", "")
        if not oenum:
            return {"output": "No OENUM provided for techserver sync", "metadata": {"error": True}}

        project_name = tool_input.get("project_name", "")
        result = await self._copy_from_techserver(project_id, oenum, project_name=project_name)

        # Run structure analysis after copy if successful
        if result.get("status") == "copied":
            analysis = await self._analyze_project_structure(project_id, project_name, oenum)
            result["structure_analysis"] = analysis

        output = json.dumps(result, indent=2, default=str)
        return {"output": output, "metadata": result}

    async def _auto_commit(self, project_id: str, message: str) -> Optional[Dict]:
        """Auto-commit changes after shell operations."""
        if not self.shell:
            return None
        try:
            result = await self.shell.git_commit(project_id, message)
            if result.get("status") == "committed":
                # Record in database
                await self.memory.record_git_commit(
                    project_id=project_id,
                    task_id=None,
                    commit_hash=result["commit_hash"],
                    message=message,
                    files_changed=result.get("files_changed", []),
                )
                return result
            return None
        except Exception as e:
            logger.warning(f"Auto-commit failed: {e}")
            return None

    # =========================================================================
    # REDIS DATA LOSS RECOVERY
    # =========================================================================

    async def _ensure_project_analysis(
        self, project_id: str, project_context: Dict[str, Any],
    ) -> None:
        """
        Check if the project structure analysis exists in Redis.
        If Redis data was lost (e.g., restart, eviction), re-run the analysis
        so COT always has access to project structure insights.

        Only applies to legacy projects that had techserver files copied.
        """
        try:
            # Get agent state to check if this is a legacy project
            agent_state = await self.memory.get_agent_state(project_id)
            if not agent_state:
                return

            is_legacy = agent_state.get("is_legacy", False)
            if not is_legacy:
                return

            # Check if project_structure cache exists in Redis
            cache_key = f"project_structure:{project_id}"
            cached = await self.memory.get_working_memory(project_id, cache_key)

            if cached:
                # Data exists, inject into project context for COT
                try:
                    project_context["project_structure"] = json.loads(cached)
                except (json.JSONDecodeError, TypeError):
                    project_context["project_structure"] = cached
                return

            # Redis data is missing — check if structure_analysis.json exists on disk
            logger.warning(
                f"Redis project_structure cache missing for {project_id}, "
                f"attempting recovery..."
            )

            project_name = agent_state.get("project_name", "")
            oenum = agent_state.get("tpms_oenum", "")

            # Try to recover from saved file on 1.69 first
            recovered = False
            if self.shell:
                try:
                    file_result = await self.shell.file_read(
                        project_id, "documents/metadata/structure_analysis.json"
                    )
                    file_content = file_result.get("content", "") if isinstance(file_result, dict) else str(file_result)
                    if file_content and len(file_content) > 10:
                        # Restore to Redis
                        await self.memory.store_working_memory(
                            project_id, cache_key, file_content,
                        )
                        try:
                            project_context["project_structure"] = json.loads(file_content)
                        except (json.JSONDecodeError, TypeError):
                            project_context["project_structure"] = file_content
                        recovered = True
                        logger.info(
                            f"Recovered project_structure from disk for {project_id}"
                        )
                except Exception:
                    pass

            # If disk recovery failed, re-run the full analysis
            if not recovered and project_name and oenum:
                await self._notify_progress(project_id, "recovering_analysis", {
                    "status": "Redis data lost, re-analyzing project structure..."
                })
                analysis_result = await self._analyze_project_structure(
                    project_id, project_name, oenum,
                )
                if analysis_result.get("status") == "analyzed":
                    project_context["project_structure"] = analysis_result
                    logger.info(
                        f"Re-ran project structure analysis for {project_id} "
                        f"after Redis data loss"
                    )

            # Also recover TPMS mapping if missing
            tpms_key = f"tpms_mapping:{project_id}"
            tpms_cached = await self.memory.get_working_memory(project_id, tpms_key)
            if not tpms_cached and oenum:
                logger.warning(f"Redis tpms_mapping missing for {project_id}, re-verifying...")
                await self._verify_tpms_project(project_id, oenum)

        except Exception as e:
            logger.error(f"Project analysis recovery failed for {project_id}: {e}")

    # =========================================================================
    # PROJECT LIFECYCLE
    # =========================================================================

    async def initialize_project(self, project_id: str, name: str,
                                 owner_id: str, tpms_oenum: str = None,
                                 is_legacy: bool = False) -> Dict:
        """
        Initialize lightweight per-project state.

        Heavy lifting (session container, repo clone, TPMS pull, techserver
        SMB copy, EKC clone, explorer kick-off) now lives in
        project-init-service. This method is kept for the bookkeeping the
        in-process agent state needs:
          * a Qdrant collection for project semantic search
          * (legacy) sanity-check the TPMS oenum exists in the cache

        The previous implementation tried to:
          * git_init via shell-service /run        — 404 (deleted in 2026-05)
          * mkdir/ln -s via shell.exec_command     — 404
          * create_project_email via mail-gateway  — 503 (deleted)
          * shell.file_write + git_commit          — 404
        all of which generated log noise on every create. Those paths are
        removed; the work is now performed by project-init-service when
        the wizard ticks the relevant sources.
        """
        results: Dict = {}

        # 1. Qdrant collection for project semantic search.
        try:
            if self.memory.qdrant:
                qdrant_oenum = tpms_oenum or project_id
                self.memory.qdrant.ensure_collection_exists(
                    user_id="system", project_oenum=qdrant_oenum
                )
                results["qdrant"] = {"status": "initialized"}
        except Exception as e:
            results["qdrant"] = {"status": "error", "error": str(e)}

        # 2. (legacy) verify the TPMS oenum and cache the mapping. The
        #    actual project data is now pulled into the session container
        #    by project-init-service when the user ticks `tpms`.
        if tpms_oenum and is_legacy:
            try:
                tpms_result = await self._verify_tpms_project(project_id, tpms_oenum)
                results["tpms"] = tpms_result
            except Exception as e:
                results["tpms"] = {"status": "error", "error": str(e)}

        # Set initial agent state for the in-process scheduler.
        try:
            agent_state_data = {
                "status": "idle",
                "project_name": name,
                "initialized_at": datetime.utcnow().isoformat(),
                "pending_tasks": 0,
                "is_legacy": is_legacy,
                "tpms_oenum": tpms_oenum,
            }
            await self.memory.set_agent_state(project_id, agent_state_data)
        except Exception as e:
            logger.warning("set_agent_state failed: %s", e)

        results["agent_state"] = "initialized"
        logger.info(f"Project {project_id} ({name}) initialized: {results}")
        return results

    async def _verify_tpms_project(self, project_id: str, oenum: str) -> Dict:
        """
        Verify the project exists in TPMS and cache the IDProjectMain mapping.
        Does NOT dump TPMS data to files — the COT engine queries TPMS on-demand
        via the tpms_fetch tool using the TPMS Schema Instructions.

        Only fetches: ViewProjectMain (for IDProjectMain) + a text summary for
        Qdrant semantic indexing so the agent can answer general project questions.
        """
        try:
            tpms_text = ""
            id_project_main = None

            # Fetch project overview to get IDProjectMain
            if (self.mcp_manager and self.mcp_manager.is_connected
                    and self.mcp_manager.has_tool("tpms_fetch")):
                result = await self.mcp_manager.call_tool("tpms_fetch", {"oenum": oenum})
                tpms_data = result.get("output", "")
                if isinstance(tpms_data, str):
                    try:
                        parsed = json.loads(tpms_data)
                        id_project_main = parsed.get("IDProjectMain")
                    except json.JSONDecodeError:
                        pass
            else:
                client = get_tpms_fetcher_client()
                fetch_result = await client.fetch_project(oenum)
                id_project_main = fetch_result.get("IDProjectMain")

            # Get readable text summary for Qdrant indexing
            if (self.mcp_manager and self.mcp_manager.is_connected
                    and self.mcp_manager.has_tool("tpms_get_text")):
                text_result = await self.mcp_manager.call_tool("tpms_get_text", {"oenum": oenum})
                tpms_text = text_result.get("output", "")
            else:
                client = get_tpms_fetcher_client()
                tpms_text = await client.get_project_text(oenum)

            # Cache the OENUM → IDProjectMain mapping in Redis for COT use
            tpms_mapping = {
                "oenum": oenum,
                "id_project_main": id_project_main,
                "verified": True,
            }
            await self.memory.store_working_memory(
                project_id, f"tpms_mapping:{project_id}",
                json.dumps(tpms_mapping),
            )

            # Index TPMS text summary in Qdrant for semantic search
            if tpms_text and self.memory.qdrant:
                try:
                    chunks = []
                    text = tpms_text.strip()
                    i, idx = 0, 0
                    while i < len(text):
                        end = min(i + 500, len(text))
                        chunk = text[i:end].strip()
                        if chunk:
                            chunks.append({
                                "text": chunk,
                                "section_title": f"TPMS Data - {oenum}",
                                "chunk_index": idx,
                                "metadata": {"source": "tpms", "oenum": oenum},
                            })
                            idx += 1
                        i += 450
                    if chunks:
                        self.memory.qdrant.add_document_chunks(
                            user_id="system",
                            document_id=f"tpms-{oenum}",
                            chunks=chunks,
                            project_oenum=oenum,
                        )
                except Exception as e:
                    logger.warning(f"TPMS indexing in Qdrant failed: {e}")

            return {
                "status": "verified",
                "oenum": oenum,
                "id_project_main": id_project_main,
            }

        except Exception as e:
            logger.error(f"TPMS verification failed for {oenum}: {e}")
            return {"status": "error", "error": str(e)}

    async def _copy_from_techserver(self, project_id: str, oenum: str,
                                    project_name: str = "") -> Dict:
        """
        Connect to techserver (192.168.1.3) via SMB and copy project files
        to the project workspace on 1.69. Uses smbclient to list shares and
        find the project directory, then smbget to recursively download files.

        The project folder name on the techserver typically contains the project
        name that the legacy user used when creating the project.

        Credentials are read from TECHSERVER_USER / TECHSERVER_PASSWORD env vars.
        """
        if not self.shell:
            return {"status": "skip", "reason": "shell_unavailable"}

        techserver_ip = os.environ.get("TECHSERVER_IP", "192.168.1.3")
        techserver_user = os.environ.get("TECHSERVER_USER", "EKC\\tech")
        techserver_password = os.environ.get("TECHSERVER_PASSWORD", "")

        if not techserver_password:
            logger.warning("TECHSERVER_PASSWORD not set, cannot connect via SMB")
            return {"status": "skip", "reason": "techserver_credentials_missing"}

        # Build search patterns from OENUM and project name
        search_patterns = [oenum]
        digits = ''.join(c for c in oenum if c.isdigit())
        if digits:
            search_patterns.append(f"OE{digits}")
            search_patterns.append(digits)
        if project_name:
            search_patterns.append(project_name)

        try:
            # 1. Ensure smbclient is available
            await self.shell.exec_command(
                project_id=project_id,
                command="which smbclient || apt-get update -qq && apt-get install -y -qq smbclient 2>/dev/null",
                timeout=60,
            )

            # 2. List available shares on techserver
            list_cmd = (
                f"smbclient -L //{techserver_ip} "
                f"-U '{techserver_user}%{techserver_password}' "
                f"--no-pass 2>/dev/null || "
                f"smbclient -L //{techserver_ip} "
                f"-U '{techserver_user}' '{techserver_password}' 2>/dev/null"
            )
            list_result = await self.shell.exec_command(
                project_id=project_id, command=list_cmd, timeout=30,
            )
            shares_output = list_result.stdout

            # 3. Search for project directory across shares
            # Parse share names from smbclient output
            share_names = []
            for line in shares_output.split("\n"):
                line = line.strip()
                if "Disk" in line and not line.startswith("---"):
                    # Extract share name (first column before "Disk")
                    parts = line.split("Disk")
                    if parts:
                        share_name = parts[0].strip().rstrip()
                        if share_name and not share_name.startswith("IPC"):
                            share_names.append(share_name)

            if not share_names:
                return {"status": "error", "error": "No SMB shares found on techserver"}

            found_share = None
            found_path = None

            for share in share_names:
                # Search each share for a directory matching our patterns
                for pattern in search_patterns:
                    search_cmd = (
                        f"smbclient '//{techserver_ip}/{share}' "
                        f"-U '{techserver_user}%{techserver_password}' "
                        f"-c 'recurse; ls *{pattern}*' 2>/dev/null | head -20"
                    )
                    search_result = await self.shell.exec_command(
                        project_id=project_id, command=search_cmd, timeout=30,
                    )
                    output = search_result.stdout.strip()
                    if output and "NT_STATUS" not in output and pattern.lower() in output.lower():
                        found_share = share
                        # Extract the matching directory name
                        for out_line in output.split("\n"):
                            out_line = out_line.strip()
                            if pattern.lower() in out_line.lower() and "D" in out_line:
                                # smbclient ls format: "dirname    D    0  ..."
                                dir_name = out_line.split()[0] if out_line.split() else ""
                                if dir_name:
                                    found_path = dir_name
                                    break
                        if found_path:
                            break
                if found_path:
                    break

            if not found_share:
                # Fallback: try the OENUM directly as share name
                for pattern in search_patterns:
                    test_cmd = (
                        f"smbclient '//{techserver_ip}/{pattern}' "
                        f"-U '{techserver_user}%{techserver_password}' "
                        f"-c 'ls' 2>/dev/null"
                    )
                    test_result = await self.shell.exec_command(
                        project_id=project_id, command=test_cmd, timeout=15,
                    )
                    if test_result.exit_code == 0 and "NT_STATUS" not in test_result.stdout:
                        found_share = pattern
                        found_path = ""
                        break

            if not found_share:
                return {
                    "status": "not_found",
                    "patterns": search_patterns,
                    "shares_checked": share_names,
                }

            # 4. Download project files recursively using smbget
            smb_source = f"smb://{techserver_ip}/{found_share}"
            if found_path:
                smb_source += f"/{found_path}"

            download_cmd = (
                f"cd documents && "
                f"smbget --recursive '{smb_source}' "
                f"-U '{techserver_user}%{techserver_password}' "
                f"--dots 2>&1; "
                f"echo '---DOWNLOAD_DONE---'; "
                f"find . -type f | wc -l"
            )
            download_result = await self.shell.exec_command(
                project_id=project_id, command=download_cmd, timeout=300,
            )
            output_lines = download_result.stdout.strip().split("---DOWNLOAD_DONE---")
            file_count = output_lines[-1].strip() if len(output_lines) > 1 else "0"

            # 5. Create file manifest metadata
            meta_cmd = (
                "find documents/ -type f "
                "-exec stat --format='%n|%s|%Y' {} \\; 2>/dev/null"
            )
            meta_result = await self.shell.exec_command(
                project_id=project_id, command=meta_cmd, timeout=30,
            )
            files_meta = []
            for line in meta_result.stdout.strip().split("\n"):
                if "|" in line:
                    parts = line.split("|")
                    if len(parts) >= 3:
                        files_meta.append({
                            "path": parts[0],
                            "size_bytes": int(parts[1]) if parts[1].isdigit() else 0,
                            "modified_ts": parts[2],
                        })

            if files_meta:
                meta_json = json.dumps(files_meta, indent=2)
                await self.shell.file_write(
                    project_id=project_id,
                    path="documents/metadata/file_manifest.json",
                    content=meta_json,
                )

            # 6. Commit the copied techserver files
            await self.shell.git_commit(
                project_id, f"Import project files from techserver ({found_share})"
            )

            return {
                "status": "copied",
                "source": smb_source,
                "share": found_share,
                "path": found_path or "/",
                "file_count": file_count,
                "files": len(files_meta),
            }

        except Exception as e:
            logger.error(f"Techserver SMB copy failed for {oenum}: {e}")
            return {"status": "error", "error": str(e)}

    async def _analyze_project_structure(
        self, project_id: str, project_name: str, oenum: str,
    ) -> Dict[str, Any]:
        """
        Deep analysis of project structure after files are copied from techserver.
        Uses shell commands (tree, find, file, wc) to inspect the workspace,
        then LLM to summarize the structure. Results are cached in Redis as
        hot-tier data for the COT engine to use in subsequent chains.
        """
        if not self.shell:
            return {"status": "skip", "reason": "shell_unavailable"}

        try:
            analysis_parts = {}

            # 1. Tree view of the project (max depth 4)
            tree_result = await self.shell.exec_command(
                project_id=project_id,
                command="tree -L 4 --dirsfirst -h 2>/dev/null || find . -maxdepth 4 -print | sort",
                timeout=30,
            )
            analysis_parts["tree"] = tree_result.stdout[:5000]

            # 2. File type summary
            filetypes_result = await self.shell.exec_command(
                project_id=project_id,
                command=(
                    "find documents/ -type f 2>/dev/null | "
                    "sed 's/.*\\.//' | sort | uniq -c | sort -rn | head -20"
                ),
                timeout=15,
            )
            analysis_parts["file_types"] = filetypes_result.stdout

            # 3. Largest files
            largest_result = await self.shell.exec_command(
                project_id=project_id,
                command=(
                    "find documents/ -type f -printf '%s %p\\n' 2>/dev/null | "
                    "sort -rn | head -15"
                ),
                timeout=15,
            )
            analysis_parts["largest_files"] = largest_result.stdout

            # 4. Directory sizes
            dirsizes_result = await self.shell.exec_command(
                project_id=project_id,
                command="du -sh documents/*/ 2>/dev/null | sort -rh | head -15",
                timeout=15,
            )
            analysis_parts["directory_sizes"] = dirsizes_result.stdout

            # 5. Count totals
            counts_result = await self.shell.exec_command(
                project_id=project_id,
                command=(
                    "echo 'Total files:' && find documents/ -type f 2>/dev/null | wc -l && "
                    "echo 'Total dirs:' && find documents/ -type d 2>/dev/null | wc -l && "
                    "echo 'Total size:' && du -sh documents/ 2>/dev/null"
                ),
                timeout=15,
            )
            analysis_parts["totals"] = counts_result.stdout

            # 6. Check for specific EKC file types (EPLAN, DWG, SLD, etc.)
            ekc_files_result = await self.shell.exec_command(
                project_id=project_id,
                command=(
                    "echo '=== EPLAN files ===' && "
                    "find documents/ -iname '*.zw1' -o -iname '*.epl' -o -iname '*.elk' 2>/dev/null | head -10 && "
                    "echo '=== CAD files ===' && "
                    "find documents/ -iname '*.dwg' -o -iname '*.dxf' 2>/dev/null | head -10 && "
                    "echo '=== PDF files ===' && "
                    "find documents/ -iname '*.pdf' 2>/dev/null | head -10 && "
                    "echo '=== Excel files ===' && "
                    "find documents/ -iname '*.xlsx' -o -iname '*.xls' 2>/dev/null | head -10 && "
                    "echo '=== Word files ===' && "
                    "find documents/ -iname '*.docx' -o -iname '*.doc' 2>/dev/null | head -10"
                ),
                timeout=15,
            )
            analysis_parts["ekc_files"] = ekc_files_result.stdout

            # 7. Use LLM to summarize the structure analysis
            llm_summary = ""
            if self.llm_service:
                structure_text = "\n\n".join(
                    f"### {k}\n{v}" for k, v in analysis_parts.items() if v.strip()
                )
                messages = [
                    {
                        "role": "system",
                        "content": (
                            "You are an EKC (Electrokavir) project analyst. "
                            "Analyze the project structure from a techserver copy and provide "
                            "a structured summary for the project manager agent. "
                            "Focus on: what type of project this is (MV switchgear, LV panel, etc.), "
                            "what deliverables exist, what EPLAN/CAD/PDF drawings are present, "
                            "and what the overall organization looks like."
                        ),
                    },
                    {
                        "role": "user",
                        "content": (
                            f"Project: {project_name} (OENUM: {oenum})\n\n"
                            f"File structure analysis:\n{structure_text}\n\n"
                            "Provide a structured JSON summary with fields: "
                            "project_type, deliverables, key_directories, "
                            "eplan_files_count, cad_files_count, pdf_count, "
                            "observations, and recommended_next_steps."
                        ),
                    },
                ]
                try:
                    if hasattr(self.llm_service, "async_generate"):
                        result = await self.llm_service.async_generate(
                            messages=messages, user_id=f"agent_{project_id}",
                        )
                        llm_summary = result.get("response", "") if isinstance(result, dict) else str(result)
                    else:
                        result = self.llm_service.generate(messages=messages)
                        llm_summary = result.get("response", "") if isinstance(result, dict) else str(result)
                except Exception as e:
                    logger.warning(f"LLM structure analysis failed: {e}")
                    llm_summary = ""

            # 8. Build final analysis result
            analysis_result = {
                "status": "analyzed",
                "project_name": project_name,
                "oenum": oenum,
                "raw_analysis": analysis_parts,
                "llm_summary": llm_summary,
            }

            # 9. Store analysis in Redis as hot-tier cache
            try:
                cache_key = f"project_structure:{project_id}"
                await self.memory.store_working_memory(
                    project_id, cache_key, json.dumps(analysis_result, default=str),
                )
            except Exception as e:
                logger.warning(f"Failed to cache structure analysis: {e}")

            # 10. Write analysis to project workspace and commit
            try:
                await self.shell.file_write(
                    project_id=project_id,
                    path="documents/metadata/structure_analysis.json",
                    content=json.dumps(analysis_result, indent=2, default=str),
                )
                await self.shell.git_commit(
                    project_id, f"Add project structure analysis for {project_name}"
                )
            except Exception as e:
                logger.warning(f"Failed to write/commit structure analysis: {e}")

            logger.info(f"Project structure analysis complete for {project_id}")
            return analysis_result

        except Exception as e:
            logger.error(f"Project structure analysis failed for {oenum}: {e}")
            return {"status": "error", "error": str(e)}

    async def analyze_sld(
        self, project_id: str, image_bytes: bytes,
        mime_type: str = "image/png", filename: str = "sld.png",
        additional_context: str = "",
    ) -> Dict[str, Any]:
        """
        Analyze a Single Line Diagram image/PDF using GPT-4o vision.
        Stores results in project workspace and indexes in Qdrant.
        """
        from services.sld_processor import get_sld_processor
        processor = get_sld_processor()

        # Determine if PDF or image
        if mime_type == "application/pdf" or filename.lower().endswith(".pdf"):
            result = await processor.analyze_multi_page_pdf(
                pdf_bytes=image_bytes,
                additional_context=additional_context,
            )
        else:
            result = await processor.analyze_image(
                image_bytes=image_bytes,
                mime_type=mime_type,
                additional_context=additional_context,
            )

        if result.get("success"):
            # Store analysis in project workspace
            try:
                if self.shell:
                    analysis_json = json.dumps(result, indent=2, default=str)
                    safe_name = filename.rsplit(".", 1)[0] if "." in filename else filename
                    await self.shell.file_write(
                        project_id=project_id,
                        path=f"documents/{safe_name}_sld_analysis.json",
                        content=analysis_json,
                    )

                    # Store metadata
                    meta = {
                        "filename": filename,
                        "type": "sld_analysis",
                        "analyzed_at": datetime.utcnow().isoformat(),
                        "model": result.get("model", "gpt-4o"),
                        "confidence": result.get("confidence", 0),
                    }
                    await self.shell.file_write(
                        project_id=project_id,
                        path=f"documents/metadata/{safe_name}_meta.json",
                        content=json.dumps(meta, indent=2),
                    )

                    await self.shell.git_commit(
                        project_id, f"Add SLD analysis: {filename}"
                    )

                # Index in Qdrant for semantic search
                if self.memory.qdrant:
                    analysis_text = json.dumps(result, indent=2, default=str)
                    chunks = [{
                        "text": analysis_text[:2000],
                        "section_title": f"SLD Analysis: {filename}",
                        "chunk_index": 0,
                        "metadata": {"source": "sld_analysis", "filename": filename},
                    }]
                    # Use OENUM for collection name to match search queries
                    agent_state = await self.memory.get_agent_state(project_id)
                    sld_oenum = (agent_state or {}).get("tpms_oenum") or project_id
                    self.memory.qdrant.add_document_chunks(
                        user_id="system",
                        document_id=f"sld-{uuid.uuid4()}",
                        chunks=chunks,
                        project_oenum=sld_oenum,
                    )

            except Exception as e:
                logger.warning(f"Failed to store SLD analysis: {e}")

        return result

    async def get_status(self, project_id: str) -> AgentState:
        """Get current agent status for a project."""
        state = await self.memory.get_agent_state(project_id) or {}

        # Get task counts
        tasks = await self.memory.get_tasks(project_id, limit=100)
        pending = sum(1 for t in tasks if t.get("status") == "pending")
        in_progress = sum(1 for t in tasks if t.get("status") == "in_progress")

        return AgentState(
            project_id=uuid.UUID(project_id),
            is_active=state.get("status") != "paused",
            current_task_id=uuid.UUID(state["current_task_id"]) if state.get("current_task_id") else None,
            current_cot_chain_id=uuid.UUID(state["current_cot_chain_id"]) if state.get("current_cot_chain_id") else None,
            status=state.get("status", "idle"),
            last_activity=datetime.fromisoformat(state["last_activity"]) if state.get("last_activity") else None,
            pending_tasks=pending,
            completed_tasks_today=sum(
                1 for t in tasks
                if t.get("status") == "completed"
                and t.get("completed_at")
                and str(t["completed_at"]).startswith(datetime.utcnow().strftime("%Y-%m-%d"))
            ),
            error_count=state.get("error_count", 0),
        )


# Singleton
_project_agent: Optional[ProjectManagerAgent] = None


def get_project_agent() -> ProjectManagerAgent:
    global _project_agent
    if _project_agent is None:
        _project_agent = ProjectManagerAgent()
    return _project_agent
