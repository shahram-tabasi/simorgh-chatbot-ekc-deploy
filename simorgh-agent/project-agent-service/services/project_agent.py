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
import contextvars
import json
import logging
import os
import uuid
from datetime import datetime
from typing import Optional, List, Dict, Any, Callable

# Per-request LLM mode override threaded from the route layer
# (ProjectMessageCreate.llm_mode) down to _execute_llm_task without
# having to add the parameter to every function in the call chain
# (handle_input → _execute_task_chain → _execute_single_task →
# _execute_llm_task). ContextVar is asyncio-task-scoped so
# concurrent requests don't trample each other. None = use the
# llm_service default (whatever its env-configured mode is).
_llm_mode_var: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar(
    "_project_agent_llm_mode", default=None,
)

# Per-request image perception (describe-then-reason). Set in handle_input
# when an image is attached; read by _execute_llm_task so the SYNTH step
# always sees the VLM's structured description as authoritative ground
# truth — regardless of which plan the planner produced. Task-scoped so
# concurrent requests don't trample each other.
_image_desc_var: contextvars.ContextVar[str] = contextvars.ContextVar(
    "_project_agent_image_desc", default="",
)

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


def _format_tool_output_for_synth(tool_or_title: str, output: Any) -> str:
    """Compact common tool result shapes before they hit the synth prompt.

    Raw JSON dumps are 5-10× more verbose than the user-relevant
    payload — for ``get_project_tree`` especially, every file becomes
    a ~150-char ``{"id":"...","name":"...","type":"blob","path":"...","mode":"..."}``
    object, so a flat per-output cap chops the listing at ~25 files
    and the synthesizer dutifully reports "tool output was truncated".

    Shape-aware compaction keeps the per-output budget meaningful:
      • tree-shaped results  → newline-separated paths (with ``/``
        suffix for directories), preserving order.
      • everything else      → str(output) (the caller still applies
        a tail truncation as a final guard).
    """
    if output is None:
        return ""
    if isinstance(output, str):
        body = output
        # MCP and the REST fallback both wrap results in JSON strings;
        # unwrap once so we can shape-detect the inner payload.
        s = body.strip()
        if (s.startswith("{") and s.endswith("}")) or (
            s.startswith("[") and s.endswith("]")
        ):
            try:
                parsed = json.loads(s)
            except Exception:
                return body
            output = parsed
        else:
            return body

    # Tree shape: {"project": ..., "ref": ..., "entries": [{...}]}
    if isinstance(output, dict) and isinstance(output.get("entries"), list):
        entries = output["entries"]
        lines = []
        for e in entries:
            if not isinstance(e, dict):
                continue
            path = e.get("path") or e.get("name") or ""
            if not path:
                continue
            if e.get("type") == "tree":
                path = path.rstrip("/") + "/"
            lines.append(path)
        header_bits = []
        if output.get("ref"):
            header_bits.append(f"ref={output['ref']}")
        if output.get("path"):
            header_bits.append(f"under={output['path']}")
        header_bits.append(f"count={len(lines)}")
        header = "(" + ", ".join(header_bits) + ")\n"
        return header + "\n".join(lines)

    # read_artifact / read_file shape — return the content verbatim.
    if isinstance(output, dict) and "content" in output:
        meta = []
        for k in ("path", "ref", "via", "artifact_class"):
            v = output.get(k)
            if v:
                meta.append(f"{k}={v}")
        prefix = "(" + ", ".join(meta) + ")\n" if meta else ""
        return prefix + str(output.get("content") or "")

    # Default: JSON-stringify with utf-8 so Persian / Arabic survive.
    try:
        return json.dumps(output, ensure_ascii=False)
    except Exception:
        return str(output)


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
        llm_mode: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Handle any input to the project.
        This is the main entry point for all channels.

        Returns:
            Dict with response, tasks created, and execution results
        """
        # Install the per-request mode into the contextvar so any
        # async_generate call deeper in the chain
        # (_execute_task_chain → _execute_single_task →
        # _execute_llm_task) can pick it up without a parameter
        # change in every function signature.
        if llm_mode is not None:
            _llm_mode_var.set(llm_mode)

        # Phase 2/3: master CoT router. Builds a PlanContext from
        # what we know about the request, picks a CotPlan via the
        # heuristic router, and installs it in the cot_router
        # contextvar so cot_engine can pick it up at message-build
        # time.
        # Source/modality detection (Phase 3):
        #   * has_selected_repo = True for any project_id that resolves
        #     (project chats are always repo-backed). Pulled from the
        #     project memory row's repo metadata so we don't false-
        #     positive on placeholder rows.
        #   * input_modality = "voice" when the route layer flagged
        #     this turn as transcribed (ProjectMessageCreate.metadata
        #     carries the hint).
        #   * upload_size_chars stays 0 here — Phase 4's
        #     upload_investigator will probe doc-processor and update
        #     when the file is read.
        try:
            from services.cot_router import route as cot_route, set_active_plan
            from services.cot_plans import PlanContext

            project_for_ctx = await self.memory.get_project(project_id)
            repo_path = (project_for_ctx or {}).get("gitlab_repo_path") if project_for_ctx else None
            selected_repos = [repo_path] if repo_path else []
            modality = "voice" if (channel.value == "voice"
                                    or (channel.value == "chat" and False)) else "text"

            # Techserver source: the project ticked the legacy SMB source
            # at creation. sources_enabled lives at the top level or nested
            # under `project`. techserver_oenum (wizard) → tpms_oenum.
            _se = (
                (project_for_ctx or {}).get("sources_enabled")
                or ((project_for_ctx or {}).get("project") or {}).get("sources_enabled")
                or {}
            )
            has_techserver = bool(_se.get("techserver"))
            techserver_oenum = (
                _se.get("techserver_oenum")
                or (project_for_ctx or {}).get("techserver_oenum")
                or (project_for_ctx or {}).get("tpms_oenum")
                or None
            )

            # TPMS source. tpms_oenum is set by the wizard (and stored on
            # the projects row). The executor uses it to swap the literal
            # "<oenum>" placeholder the planner LLM emits — the canonical
            # CoT prompt examples use angle-bracket conventions throughout,
            # so the LLM faithfully copies them as tool arguments.
            has_tpms = bool(_se.get("tpms"))
            tpms_oenum = (
                (project_for_ctx or {}).get("tpms_oenum")
                or _se.get("techserver_oenum")
                or None
            )

            plan_ctx = PlanContext(
                user_input=user_input,
                project_id=project_id,
                user_id=user_id,
                chat_id=chat_id,
                has_selected_repo=bool(repo_path),
                selected_repos=selected_repos,
                has_upload=bool(document_id or document_filename),
                upload_filenames=[document_filename] if document_filename else [],
                upload_size_chars=0,
                input_modality=modality,
                has_techserver=has_techserver,
                techserver_oenum=str(techserver_oenum) if techserver_oenum else None,
                has_tpms=has_tpms,
                tpms_oenum=str(tpms_oenum) if tpms_oenum else None,
                repo_path=str(repo_path) if repo_path else None,
                has_documents=bool((project_for_ctx or {}).get("has_documents")),
            )
            chosen_plan = cot_route(plan_ctx)
            set_active_plan(chosen_plan)
            self._active_plan_ctx = plan_ctx
        except Exception as e:
            logger.warning("cot_router setup failed (continuing with no plan): %s", e)
            chosen_plan = None

        logger.info(
            f"Agent handling input: project={project_id}, "
            f"channel={channel.value}, input_len={len(user_input)}, "
            f"llm_mode={llm_mode or 'default'}, "
            f"cot_plan={chosen_plan.name if chosen_plan else 'none'}"
        )
        # Phase 5: surface the chosen plan to the UI as the FIRST SSE
        # event so the chat bubble can paint a plan chip ("plan:
        # single_repo") before the planner even starts thinking.
        # Goes through the same progress-callback mechanism as the
        # rest of the streaming events.
        if chosen_plan is not None:
            await self._notify_progress(project_id, "cot_plan_chosen", {
                "plan": chosen_plan.name,
                "signals": {
                    "has_selected_repo": getattr(plan_ctx, "has_selected_repo", False),
                    "selected_repos_count": len(getattr(plan_ctx, "selected_repos", [])),
                    "has_upload": getattr(plan_ctx, "has_upload", False),
                    "upload_size_chars": getattr(plan_ctx, "upload_size_chars", 0),
                    "input_modality": getattr(plan_ctx, "input_modality", "text"),
                },
            })

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

        # 1b. IMAGE PERCEPTION (describe-then-reason / VIPER pattern).
        # The text-only CoT planner cannot see pixels, so the VLM on .62
        # acts as a perception agent: it translates the attached image
        # into a structured Markdown description, which we inject as
        # grounding into the CoT. The planner then REASONS over that
        # description as text and can combine it with repo/TPMS/knowledge
        # retrieval — e.g. "compare this SLD to the spec in my repo".
        # Returns "" when there's no usable image this turn.
        image_grounding = await self._perceive_image(
            project_id=project_id,
            user_input=user_input,
            document_id=document_id,
            document_filename=document_filename,
        )

        # The input the CoT pipeline reasons over. When an image was
        # perceived, the structured description rides along so the
        # planner, retrieval-query builder and synth all see it. The
        # stored user message (above) keeps the user's original text.
        cot_input = user_input
        _image_desc_var.set(image_grounding or "")
        if image_grounding:
            cot_input = (
                f"{user_input}\n\n"
                f"[Attached image — vision model description below; treat it "
                f"as ground truth about the image and combine it with any "
                f"retrieved project data when answering]\n{image_grounding}"
            )

        # 2. Build project context from all memory layers
        await self._notify_progress(project_id, "building_context", {})
        project_context = await self.memory.build_agent_context(
            project_id, query=cot_input
        )
        if image_grounding:
            project_context["image_description"] = image_grounding

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
            user_input=cot_input,
            channel=channel,
            chat_id=chat_id,
            document_id=uuid.UUID(document_id) if document_id else None,
            email_subject=email_subject,
            email_from=email_from,
            auto_execute=auto_execute,
        )

        instructions = project_context.get("instructions", [])

        # ReAct engine (opt-in via COT_ENGINE_MODE=react). Replaces the
        # static plan-and-execute flow with a reason→tool→observe loop so
        # the model sees each tool result before choosing the next action —
        # eliminating the value-threading bug class (placeholders / can't
        # use a prior step's output) and adding flexibility. Reuses the
        # same tool dispatcher, streaming events and grounding. Default
        # (flag unset) leaves the existing path completely untouched.
        if os.getenv("COT_ENGINE_MODE", "").lower() == "react":
            try:
                from services.react_engine import react_loop
                result = await react_loop(
                    self, project_id, cot_request, project_context,
                    instructions, cot_input, llm_mode=llm_mode,
                )
                await self.memory.store_message(
                    project_id=project_id, role="assistant",
                    content=result.get("response", ""),
                    channel=channel.value, chat_id=chat_id,
                )
                await self._notify_progress(project_id, "complete", {
                    "response_preview": (result.get("response") or "")[:200],
                    "tasks_completed": result.get("tasks_created", 0),
                    "tasks_failed": 0,
                })
                return result
            except Exception as e:
                logger.error("react engine failed, falling back to plan-execute: %s", e)
                # fall through to the existing engine on any error

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
                user_input=cot_input,
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

        # Background slot-collector: keep the Design Suite spec fresh after
        # every turn. Fire-and-forget; never blocks the chat response. Only
        # runs when SOFT_BRIDGE_ENABLED is set (collector itself short-
        # circuits on a stable sources_signature, so this is cheap).
        try:
            from services.soft_collector import schedule_refresh
            schedule_refresh(project_id)
        except Exception as e:
            logger.debug("soft_collector schedule_refresh failed: %s", e)

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
        user_input: str = "",
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

                # Accumulate context for next tasks. Stamp the task's
                # tool + title into metadata so downstream LLM synth
                # steps can label "Step 4 ← read_artifact_mcp: …"
                # instead of seeing anonymous "Step 4 result: …".
                _meta = dict(result.get("metadata") or {})
                _meta.setdefault("tool", task.get("tool_used") or "")
                _meta.setdefault("title", task.get("title") or "")
                result["metadata"] = _meta

                # PER-STEP COMPACTION (context-window survival). gpt-oss
                # (16K) and the VLM (32K) have small windows; a single big
                # step output (a 1273-file tree, a 500KB spec → markdown)
                # would blow the next step's budget. Following Anthropic's
                # context-engineering guidance, compact a large step result
                # into a TASK-CONDITIONED summary (conditioned on the user's
                # question + the steps still to run) and hand the SUMMARY to
                # downstream steps — while keeping the full output on the
                # `results` list so the final synth can still quote it
                # verbatim. Small outputs pass through untouched.
                remaining_titles = [
                    t.get("title") or "" for t in tasks[i + 1:]
                ]
                ctx_result = await self._compact_step_result(
                    project_id=project_id,
                    step_no=task["sort_order"],
                    title=task.get("title") or "",
                    tool=task.get("tool_used") or "",
                    result=result,
                    user_input=user_input,
                    remaining_titles=remaining_titles,
                )
                accumulated_context[task["sort_order"]] = ctx_result

                # Track the last generation result as the final response
                if task.get("task_type") in ("generation", "analysis"):
                    final_response = result.get("output", "")

                # Keep BOTH the full output (so the synthesizer can
                # reason over it / compact tree-shaped results into a
                # path list) and a short preview (used for progress
                # notifications and the bullet-fallback at the end of
                # the chain when LLM synthesis fails). The previous
                # version stored only `output[:500]`, which silently
                # capped every get_project_tree result at ~2-3 files
                # before the synthesizer ever ran.
                full_output = result.get("output", "")
                results.append({
                    "task_id": task_id,
                    "title": task["title"],
                    "tool_used": task.get("tool_used"),
                    "status": "completed",
                    "output": full_output,
                    "output_preview": (
                        full_output[:500] if isinstance(full_output, str)
                        else str(full_output)[:500]
                    ),
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

        # If no generation task produced a response, synthesize one with
        # the LLM using all the tool outputs so the user gets natural
        # language instead of a raw JSON dump.
        if not final_response:
            completed = [r for r in results if r["status"] == "completed"]
            failed = [r for r in results if r["status"] == "failed"]

            if completed:
                synth_parts = [
                    "The user asked:", user_input or "(unknown request)",
                    "",
                    "Tool results from the plan:",
                ]
                for r in completed:
                    out = _format_tool_output_for_synth(
                        r.get("tool_used") or r.get("title", ""),
                        r.get("output", ""),
                    )
                    # 24000 chars ≈ 6k tokens. With other prompt overhead
                    # this leaves ~8k tokens for the model to write the
                    # answer inside the 16k vLLM max_model_len. Tighter
                    # caps silently dropped tree entries past the first
                    # ~25 files and triggered the "tool output was
                    # truncated" footnote in user-facing answers.
                    synth_parts.append(f"\n## {r['title']}\n{out[:24000]}")
                synth_parts.append(
                    "\n\nWrite a concise, natural-language answer for the "
                    "user using ONLY the tool results above. Use markdown "
                    "lists / code fences where helpful. If a tool returned "
                    "structured data like a file tree, present it clearly. "
                    "Do not ask the user for information already shown above."
                )
                try:
                    synth = await self._execute_llm_task(
                        project_id,
                        {"title": "synthesize", "description": "compose final answer",
                         "task_type": "generation"},
                        {"prompt": "\n".join(synth_parts)},
                    )
                    final_response = synth.get("output", "") if isinstance(synth, dict) else str(synth)
                except Exception as e:
                    logger.warning(f"final synthesis LLM call failed: {e}")
                    final_response = ""

            if not final_response:
                parts = []
                if completed:
                    parts.append(f"Completed {len(completed)} task(s):")
                    for r in completed:
                        output_preview = (
                            r.get("output_preview")
                            or (str(r.get("output", ""))[:150])
                        )
                        parts.append(f"- {r['title']}: {output_preview}")
                if failed:
                    parts.append(f"\nFailed {len(failed)} task(s):")
                    for r in failed:
                        parts.append(f"- {r['title']}: {r.get('error', 'Unknown error')}")
                final_response = "\n".join(parts) or "Tasks executed but no output generated."

        return results, final_response

    async def _maybe_fuzzy_retry_read(
        self, tool: str, tool_input: dict, result: Any,
    ) -> Optional[dict]:
        """When a read_artifact / read_file call returns 404-ish or empty,
        try ONCE more with a fuzzy-matched path from the actual project
        tree. Returns the retried result, or None if no useful retry
        happened (caller keeps the original result).

        Rationale. The planner LLM often passes a path that doesn't
        exactly match what's in GitLab — drops a file extension,
        strips a leading dot, normalises Persian letters that look
        identical but encode differently (ك vs ک, ي vs ی). The user's
        question already implies the answer is in some file; refusing
        with "couldn't locate" when the file is right there but one
        character off is a poor experience. So: when the read came
        back empty, we list the tree (cheap, cached server-side),
        score every entry's path against the planner-supplied path
        using a substring + character-set match, and retry with the
        best scorer if it's clearly above the noise floor.

        Bounded: max ONE retry per dispatch — no recursive ladders,
        no per-result spinning.
        """
        requested = (tool_input.get("path") or "").strip()
        if not requested or requested in ("/", "*", ""):
            return None
        if not self._read_returned_nothing(result):
            return None

        project = tool_input.get("project") or tool_input.get("project_id")
        if not project:
            return None

        try:
            tree = await self._try_gitlab_rest(
                "get_project_tree",
                {"project": project, "ref": tool_input.get("ref") or "main",
                 "recursive": True},
            )
        except Exception as e:
            logger.warning("fuzzy-retry tree fetch failed: %s", e)
            return None
        if not tree:
            return None

        # `tree` from _try_gitlab_rest is {"output": <json-string>, ...}.
        # Parse out the entries list.
        try:
            import json as _json
            tree_body = tree.get("output") if isinstance(tree, dict) else None
            tree_data = _json.loads(tree_body) if isinstance(tree_body, str) else tree
            entries = (tree_data or {}).get("entries", [])
        except Exception:
            return None
        candidate_paths = [
            e.get("path") for e in entries
            if isinstance(e, dict)
            and (e.get("type") in (None, "blob"))
            and e.get("path")
        ]
        if not candidate_paths:
            return None

        best = self._best_fuzzy_match(requested, candidate_paths)
        if not best or best == requested:
            # No useful retry to make.
            return None

        logger.info(
            "dispatch: fuzzy-retrying %s: requested path=%r → matched=%r",
            tool, requested, best,
        )
        retry_input = dict(tool_input)
        retry_input["path"] = best
        try:
            return await self.mcp_manager.call_tool(tool, {
                k: v for k, v in retry_input.items()
                if not k.startswith("_") and k != "project_id"
            })
        except Exception:
            # MCP path failed for the retry too — try REST.
            return await self._try_gitlab_rest(tool, retry_input)

    @staticmethod
    def _read_returned_nothing(result: Any) -> bool:
        """True when the result of a read tool indicates 404 / empty
        content (the kinds of return shapes our two transports use)."""
        if result is None:
            return True
        if isinstance(result, dict):
            output = result.get("output", "")
            if isinstance(output, str):
                if not output.strip():
                    return True
                s = output.strip()
                if (s.startswith("{") and s.endswith("}")) or \
                   (s.startswith("[") and s.endswith("]")):
                    import json as _json
                    try:
                        parsed = _json.loads(s)
                    except Exception:
                        return False
                    if isinstance(parsed, dict):
                        # gitlab-mcp returns {"content": "...", ...} on
                        # success; missing or empty content == 404-ish.
                        content = parsed.get("content")
                        if content in (None, ""):
                            return True
                        # Some error shapes use {"error": "..."} or
                        # {"detail": "..."} — treat as failure.
                        if parsed.get("error") or parsed.get("detail"):
                            return True
            # MCP path returns the raw inner dict; same check.
            content = result.get("content")
            if content in (None, "") and "error" not in result:
                # No content key at all means non-read shape; only
                # flag empty when an explicit empty content was set.
                return "content" in result
        return False

    @staticmethod
    def _best_fuzzy_match(
        requested: str, candidates: list[str],
    ) -> Optional[str]:
        """Pick the best-scoring candidate for the requested path.

        Heuristic, NOT semantic — we only need to recover from the
        planner dropping an extension or a prefix:
          • Exact match wins immediately.
          • Otherwise score = (substring containment * 100) +
                              (longest common subsequence ratio * 50)
                              − (length-difference penalty).
          • Prefer the SHORTEST winning path (deepest specificity).
        Returns None if no candidate scores meaningfully above the
        noise floor (avoids picking a wildly-unrelated file).
        """
        if not candidates:
            return None
        req = requested.strip()
        for c in candidates:
            if c == req:
                return c

        # Normalise Persian/Arabic letter variants that the planner LLM
        # sometimes substitutes ("ك" Arabic kaf ↔ "ک" Persian kaf;
        # "ي" Arabic ya  ↔ "ی" Persian ya).
        def _norm(s: str) -> str:
            return (s.replace("ك", "ک").replace("ي", "ی")
                     .replace("‌", "").lower())
        req_n = _norm(req)

        def _score(c: str) -> tuple[int, int]:
            c_n = _norm(c)
            base = 0
            if req_n in c_n:
                base += 100
            elif c_n in req_n:
                base += 60
            # Cheap LCS-ratio approximation: count matching tokens
            # (split on common separators), normalised by max length.
            import re as _re
            req_tok = set(t for t in _re.split(r"[\s/._-]+", req_n) if t)
            c_tok = set(t for t in _re.split(r"[\s/._-]+", c_n) if t)
            if req_tok and c_tok:
                overlap = len(req_tok & c_tok)
                base += int(50 * overlap / max(len(req_tok), len(c_tok)))
            # Length penalty: prefer paths whose length is close to
            # the requested length when overlap is similar (avoids
            # matching "README.md" for a request like "spec").
            base -= min(20, abs(len(c) - len(req)) // 4)
            # Tie-break: shorter wins (more specific).
            return (base, -len(c))

        scored = sorted(((s, c) for c, s in
                         ((c, _score(c)) for c in candidates)), reverse=True)
        if not scored:
            return None
        top_score, top_path = scored[0]
        # Demand a meaningful margin over a "no overlap" baseline so
        # we don't substitute an unrelated file.
        if top_score[0] < 40:
            return None
        return top_path

    async def _not_found_payload(
        self, tool: str, tool_input: dict,
    ) -> dict:
        """Structured 'file not found' result. Returned only when both
        the MCP read and the REST fallback failed AND the fuzzy
        matcher couldn't find a close enough candidate in the project
        tree. The synth step reads `output` like any other tool
        result, so the user-facing message becomes a clear "tried X,
        no match; available files are: ..." instead of an empty LLM
        apology.
        """
        requested = (tool_input.get("path") or "").strip()
        # Best-effort tree fetch for the suggestion list. If even
        # this fails we degrade gracefully — the synth just sees
        # the bare "not found" line.
        sample_paths: list[str] = []
        try:
            tree = await self._try_gitlab_rest(
                "get_project_tree",
                {"project": tool_input.get("project")
                            or tool_input.get("project_id"),
                 "ref": tool_input.get("ref") or "main",
                 "recursive": True},
            )
            if isinstance(tree, dict):
                import json as _json
                body = tree.get("output")
                if isinstance(body, str):
                    tree_data = _json.loads(body)
                    entries = tree_data.get("entries", []) or []
                    sample_paths = [
                        e["path"] for e in entries
                        if isinstance(e, dict)
                        and e.get("type") in (None, "blob")
                        and e.get("path")
                    ][:50]
        except Exception:
            pass

        msg_lines = [
            f"{tool} could not locate the requested path "
            f"({requested!r}). The fuzzy matcher also could not find a "
            "close enough candidate in the project tree.",
        ]
        if sample_paths:
            msg_lines.append("")
            msg_lines.append("Available files in this project:")
            for p in sample_paths:
                msg_lines.append(f"  - {p}")
        return {
            "output": "\n".join(msg_lines),
            "metadata": {
                "via": "dispatcher_not_found",
                "tool": tool,
                "requested_path": requested,
                "candidate_count": len(sample_paths),
            },
        }

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
                elif tool in ("read_artifact_mcp", "read_artifact"):
                    # Type-aware read — returns markdown for PDFs / Office /
                    # images via the .simorgh/extracted cache or the
                    # doc-processor on demand. The CoT's hot path; without
                    # this REST equivalent, a disconnected MCP session
                    # turns every "summarise this file" plan into a silent
                    # no-op (the read step is skipped, the llm step gets
                    # no context and apologises about not having the text).
                    r = await c.get(f"{base}/artifact", params={
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

    async def _compact_step_result(
        self, project_id: str, step_no: Any, title: str, tool: str,
        result: Dict[str, Any], user_input: str,
        remaining_titles: List[str],
    ) -> Dict[str, Any]:
        """Task-conditioned compaction of a single step's output.

        Small context windows (gpt-oss 16K, VLM 32K) can't carry a big
        step output (a 1273-file tree, a 500KB spec → markdown) into the
        next step. Per Anthropic's context-engineering guidance we COMPACT
        — not clear — because the downstream steps can't re-fetch the
        reasoning: produce a summary conditioned on the user's question
        and the steps still to run, preserving the facts those steps need
        (paths, IDs, ratings, standards, numbers) while dropping bulk.

        Returns a result dict for accumulated_context. When the output is
        below the threshold it's returned unchanged. When compacted, the
        returned dict's `output` is the summary, and metadata records that
        plus the original length so the synth knows it's a digest. The
        FULL output stays on the chain's `results` list (caller keeps it),
        so the final answer can still quote specifics.
        """
        output = result.get("output")
        if not isinstance(output, str):
            return result
        threshold = int(os.getenv("COT_STEP_COMPACT_CHARS", "6000"))
        if len(output) <= threshold:
            return result

        gateway_url = os.getenv("LLM_GATEWAY_URL", "").strip().rstrip("/")
        if not gateway_url:
            # No summarizer available — fall back to a head+tail trim so we
            # at least don't overflow the next step. Lossy but bounded.
            head = output[: threshold // 2]
            tail = output[-threshold // 2:]
            trimmed = dict(result)
            trimmed["output"] = (
                head + "\n\n[… middle trimmed for context budget …]\n\n" + tail
            )
            md = dict(trimmed.get("metadata") or {})
            md["compacted"] = "trim"
            md["original_chars"] = len(output)
            trimmed["metadata"] = md
            return trimmed

        await self._notify_progress(project_id, "compacting_step", {
            "step": step_no, "title": title, "chars": len(output),
        })

        remaining = "; ".join(t for t in remaining_titles if t) or "(final synthesis)"
        system_prompt = (
            "You are a context compaction engine in a multi-step agent. "
            "Summarize ONE step's tool output so later steps can use it "
            "WITHOUT the full text. This is lossy ONLY for bulk/boilerplate "
            "— you MUST preserve every concrete fact a later step could "
            "need: file paths, IDs/OE numbers, names, ratings, standards "
            "(e.g. IEC 60044), numeric values, table rows, error messages, "
            "and which items exist. Prefer compact lists/tables over prose. "
            "Do NOT invent anything. Do NOT add commentary."
        )
        user_prompt = (
            f"USER'S OVERALL QUESTION:\n{user_input[:1500]}\n\n"
            f"THIS STEP: #{step_no} — {title} (tool={tool})\n"
            f"STEPS STILL TO RUN (compaction must keep what they'll need):\n"
            f"  {remaining}\n\n"
            f"STEP OUTPUT TO COMPACT (len={len(output)} chars):\n"
            f"{output[:int(os.getenv('COT_STEP_COMPACT_INPUT_CAP', '40000'))]}\n\n"
            "Return ONLY the faithful compacted summary."
        )
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ]
        payload = {
            "messages": messages,
            "mode": "offline",
            "force_backend": "text",   # summarization is text-only → gpt-oss .61
            "temperature": 0.1,
            "max_tokens": int(os.getenv("COT_STEP_COMPACT_MAX_TOKENS", "1200")),
        }
        import httpx
        timeout = float(os.getenv("LLM_GATEWAY_COT_TIMEOUT_SEC", "180"))
        try:
            async with httpx.AsyncClient(timeout=timeout) as c:
                r = await c.post(f"{gateway_url}/generate", json=payload)
                r.raise_for_status()
                summary = (r.json().get("response") or "").strip()
        except Exception as e:
            logger.warning("step compaction failed (%s); using head trim", e)
            summary = ""

        if not summary:
            head = output[: threshold // 2]
            tail = output[-threshold // 2:]
            summary = head + "\n\n[… middle trimmed …]\n\n" + tail

        logger.info(
            "step compaction: #%s %r %d -> %d chars",
            step_no, title, len(output), len(summary),
        )
        compacted = dict(result)
        compacted["output"] = summary
        md = dict(compacted.get("metadata") or {})
        md["compacted"] = "llm"
        md["original_chars"] = len(output)
        compacted["metadata"] = md
        return compacted

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
        # is keyed by the bare name. Strip the prefix when it matches a
        # known MCP server.
        #
        # This MUST work even when the MCP manager is disconnected —
        # otherwise the moment one MCP call drops, every subsequent
        # dotted-prefix tool fails the strip check (has_tool returns
        # False on a disconnected manager), so mcp_match=False, REST
        # fallback is never invoked (it's gated on mcp_match=True), and
        # the read step silently no-ops while the next LLM step happily
        # tries to summarise empty context.
        _KNOWN_MCP_PREFIXES = (
            "gitlab_mcp.", "context_search.", "runtime_broker.",
            "tpms_context_agent.", "tpms_fetcher.", "project_init.",
            "project_analysis.", "command_gen.", "file_export.",
            "eplan_bridge.", "specification_agent.", "hr_kb.",
            "org_data.", "eplan_sql.", "documents_rag.", "graph_rag.",
            "search.",
        )
        if isinstance(tool, str):
            for prefix in _KNOWN_MCP_PREFIXES:
                if tool.startswith(prefix):
                    tool = tool[len(prefix):]
                    break
            # techserver_* may also arrive dotted.
            if tool.startswith("techserver."):
                tool = tool[len("techserver."):]

        # TECHSERVER REMAP. When the active plan is techserver, the
        # planner sometimes still reaches for the generic gitlab tools
        # (get_project_tree / read_artifact_mcp) because the base prompt
        # features them heavily — those 404 on a repo-less techserver
        # project. Remap them to the techserver equivalents and inject
        # the OE number so the chain actually runs. Safety net on top of
        # the TechserverPlan addendum.
        try:
            from services.cot_router import active_plan as _active_plan
            _ap = _active_plan()
            _ap_name = getattr(_ap, "name", "") if _ap else ""
        except Exception:
            _ap_name = ""
        if _ap_name == "techserver" and isinstance(tool, str):
            _ts_oe = getattr(self, "_active_plan_ctx", None)
            _oe = getattr(_ts_oe, "techserver_oenum", None) if _ts_oe else None
            _ts_q = getattr(_ts_oe, "user_input", "") if _ts_oe else ""

            ri = dict(raw_input) if isinstance(raw_input, dict) else {}
            for k in ("project", "project_id", "ref"):
                ri.pop(k, None)
            if _oe and not ri.get("oenum"):
                ri["oenum"] = str(_oe)

            # Search tools → techserver_search. gpt-oss reaches for the
            # gitlab/ES search tools (search_context/search_blobs), which
            # don't run on a repo-less techserver project. Map them to the
            # techserver path search, carrying the query.
            _search_tools = {
                "search_context", "search_blobs", "regex_search_project",
                "search", "search_technical_knowledge",
            }
            _tree_tools = {"get_project_tree": "techserver_get_tree"}
            _read_tools = {"read_artifact_mcp", "read_file_mcp",
                           "read_artifact", "read_file"}

            new_tool = None
            if tool in _search_tools:
                new_tool = "techserver_search"
                q = ri.get("query") or ri.get("pattern") or ri.get("q") or _ts_q
                ri = {"oenum": str(_oe) if _oe else ri.get("oenum"),
                      "query": q}
            elif tool in _tree_tools:
                new_tool = _tree_tools[tool]
                # keep path/recursive if present
            elif tool in _read_tools:
                # A read with a concrete path → read that one file.
                # A read with NO usable path → retrieve-then-read by query
                # (techserver_fetch_files resolves the best files itself).
                p = (ri.get("path") or "").strip()
                if p and "<" not in p and p not in ("", "/", "*", "."):
                    new_tool = "techserver_read_artifact"
                    ri = {"oenum": str(_oe) if _oe else ri.get("oenum"),
                          "path": p}
                else:
                    new_tool = "techserver_fetch_files"
                    q = ri.get("query") or _ts_q
                    ri = {"oenum": str(_oe) if _oe else ri.get("oenum"),
                          "query": q, "top_n": 3}

            if new_tool:
                raw_input = ri
                logger.info(
                    "techserver remap: %s -> %s (oenum=%s, keys=%s)",
                    tool, new_tool, _oe, list(ri.keys()),
                )
                tool = new_tool

        # TPMS REMAP. Parallel to the techserver block above. When the
        # active plan is `tpms`, the planner LLM regularly:
        #   (a) calls a forbidden gitlab/repo tool (search_context,
        #       search_blobs, regex_search_project, get_project_tree,
        #       read_artifact_mcp, search_technical_knowledge) as a
        #       "find the OE" first step — even though the addendum
        #       lists those as ❌ FORBIDDEN.
        #   (b) calls the right tool (get_project_context / tpms_fetch /
        #       tpms_get_text) but drops the `oenum` argument — passing
        #       project_id instead, or just omitting it entirely. The
        #       addendum hardcodes the OE; the LLM ignores it.
        # Both end in either 404 or an empty result, then the synthesizer
        # apologises with "no project info". Hard-fix at the dispatcher:
        # always inject ctx.tpms_oenum into TPMS-tool calls, and skip
        # forbidden tools that have no chance of succeeding for a TPMS-
        # only project.
        if _ap_name == "tpms" and isinstance(tool, str):
            _tpms_pc = getattr(self, "_active_plan_ctx", None)
            _tpms_oe = (getattr(_tpms_pc, "tpms_oenum", None)
                        if _tpms_pc else None)

            _tpms_tools = {
                "get_project_context", "tpms_fetch", "tpms_get_text",
            }
            _forbidden_for_tpms = {
                "get_project_tree", "read_artifact_mcp", "read_file_mcp",
                "search_blobs", "search_context", "regex_search_project",
                "search_technical_knowledge", "project_analyze",
                "techserver_get_tree", "techserver_search",
                "techserver_fetch_files", "techserver_read_artifact",
            }

            if tool in _tpms_tools:
                # Inject the OE if missing. The LLM also often passes
                # project_id where it should have passed oenum; strip it
                # so tpms-context-agent's pydantic schema doesn't reject
                # the call.
                ri = dict(raw_input) if isinstance(raw_input, dict) else {}
                for k in ("project", "project_id", "ref", "_previous_results"):
                    ri.pop(k, None)
                if _tpms_oe and not ri.get("oenum"):
                    ri["oenum"] = str(_tpms_oe)
                # Default to the broadest sections if the LLM didn't pick
                # any — "brief overview" needs identity+panels+feeders.
                if "sections" not in ri:
                    ri["sections"] = ["panels", "feeders"]
                raw_input = ri
                logger.info(
                    "tpms inject: tool=%s oenum=%s keys=%s",
                    tool, _tpms_oe, list(ri.keys()),
                )
            elif tool in _forbidden_for_tpms:
                # Convert the forbidden retrieval into the canonical TPMS
                # retrieval so the chain still produces real data instead
                # of silently no-opping into the synthesizer.
                logger.info(
                    "tpms remap: %s -> get_project_context (oenum=%s)",
                    tool, _tpms_oe,
                )
                tool = "get_project_context"
                raw_input = {
                    "oenum": str(_tpms_oe) if _tpms_oe else None,
                    "sections": ["panels", "feeders"],
                }

        # UNCONDITIONAL ARG-FILL — the plan-gated remap blocks above only
        # fire when the active plan name matches the chosen tool's family.
        # In a multi-source project (gitlab + techserver + tpms + uploads),
        # the planner may pick `tpms_fetch` while the active plan is
        # `upload_deep`, and the TPMS injection is skipped → tool runs
        # without `oenum`. This block injects the canonical project facts
        # for any tool that clearly needs them, regardless of plan name.
        # The values mirror what the pinned <project_facts> block tells
        # the model is true for this project.
        _pc_fill = getattr(self, "_active_plan_ctx", None)
        if isinstance(tool, str) and _pc_fill and isinstance(raw_input, (dict, type(None))):
            _ri = dict(raw_input) if isinstance(raw_input, dict) else {}
            _tpms_family = {
                "get_project_context", "tpms_fetch", "tpms_get_text",
            }
            _ts_family = {
                "techserver_get_tree", "techserver_search",
                "techserver_fetch_files", "techserver_read_artifact",
            }
            _filled = False
            if tool in _tpms_family:
                _oe = (getattr(_pc_fill, "tpms_oenum", None)
                       or getattr(_pc_fill, "techserver_oenum", None))
                if _oe and not _ri.get("oenum"):
                    _ri["oenum"] = str(_oe); _filled = True
            elif tool in _ts_family:
                _oe = (getattr(_pc_fill, "techserver_oenum", None)
                       or getattr(_pc_fill, "tpms_oenum", None))
                if _oe and not _ri.get("oenum"):
                    _ri["oenum"] = str(_oe); _filled = True
            if _filled:
                raw_input = _ri
                logger.info(
                    "unconditional arg-fill tool=%s injected oenum -> %s",
                    tool, _ri.get("oenum"),
                )

        # UPLOAD REMAP. When the active plan is upload_deep, the planner
        # still reaches for gitlab/repo tools (search_blobs, search_context,
        # read_artifact_mcp, get_project_tree) which 404 on a repo-less
        # upload project — observed even with the addendum forbidding them.
        # The document content is already pre-loaded into grounding, but
        # remap these to the documents_rag equivalents so any retrieval step
        # the planner DOES run returns real data instead of a 404.
        if _ap_name == "upload_deep" and isinstance(tool, str):
            _u_search = {"search_context", "search_blobs", "regex_search_project",
                         "search", "search_technical_knowledge"}
            _u_tree = {"get_project_tree", "list_projects_mcp"}
            _u_read = {"read_artifact_mcp", "read_file_mcp", "read_artifact",
                       "read_file"}
            ri = dict(raw_input) if isinstance(raw_input, dict) else {}
            _uq = ri.get("query") or ri.get("pattern") or ri.get("q") \
                or getattr(getattr(self, "_active_plan_ctx", None), "user_input", "")
            if tool in _u_search:
                logger.info("upload remap: %s -> search_project_documents", tool)
                tool, raw_input = "search_project_documents", {"query": _uq}
            elif tool in _u_tree:
                logger.info("upload remap: %s -> list_project_documents", tool)
                tool, raw_input = "list_project_documents", {}
            elif tool in _u_read:
                # A read with a usable filename → read that file; otherwise
                # list the documents so the planner/synth can see them.
                p = (ri.get("path") or ri.get("filename") or "").strip()
                if p and "<" not in p and p not in ("", "/", "*", "."):
                    logger.info("upload remap: %s -> read_document(filename=%s)", tool, p)
                    tool, raw_input = "read_document", {"filename": p}
                else:
                    logger.info("upload remap: %s -> list_project_documents (no path)", tool)
                    tool, raw_input = "list_project_documents", {}

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

        # SOFT-BRIDGE INTENT REMAP — embedding-based, not keyword. When the
        # user's input semantically matches "create my Simorgh Design Suite
        # project" (paraphrases incl. Persian work), and the planner picked
        # a project-creator-shaped tool that would fail or do the wrong
        # thing here (project_init, tpms_fetch, tpms_get_text), redirect
        # to submit_soft_spec. The classifier itself falls back to a
        # keyword check when the embeddings-service is unreachable, so
        # this never silently fails.
        if (os.getenv("SOFT_BRIDGE_ENABLED", "").lower() in ("1", "true", "yes", "on")
                and isinstance(tool, str)
                and tool in ("project_init", "create_project",
                             "tpms_fetch", "tpms_get_text")):
            _pc = getattr(self, "_active_plan_ctx", None)
            _uin = (getattr(_pc, "user_input", "") or "")
            try:
                from services.intent_classifier import is_design_suite_create
                _design_create = is_design_suite_create(_uin)
            except Exception as e:
                logger.debug("intent_classifier failed (%s); skipping remap", e)
                _design_create = False
            if _design_create:
                logger.info(
                    "soft-bridge remap: %s -> submit_soft_spec "
                    "(intent_classifier matched design_suite_create)", tool)
                tool = "submit_soft_spec"
                raw_input = {}
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

        # Defensive placeholder scrubber. The CoT system prompt uses
        # angle-bracket placeholders (<oenum>, <repo>, <id>, <top hit>,
        # <path_from_step1>) as documentation conventions, and the LLM
        # faithfully copies them as actual tool arguments — yielding URLs
        # like /project/%3Coenum%3E/text → 404. Replace the known ones
        # from PlanContext before crossing the MCP boundary; leave
        # unknown placeholders alone so the resulting 404 surfaces the
        # planner bug instead of silently calling with garbage.
        _pc = getattr(self, "_active_plan_ctx", None)
        if _pc and isinstance(tool_input, dict):
            _subs: Dict[str, str] = {}
            if getattr(_pc, "tpms_oenum", None):
                _subs["<oenum>"] = _pc.tpms_oenum
                _subs["<OENUM>"] = _pc.tpms_oenum
            elif getattr(_pc, "techserver_oenum", None):
                _subs["<oenum>"] = _pc.techserver_oenum
                _subs["<OENUM>"] = _pc.techserver_oenum
            if getattr(_pc, "repo_path", None):
                _subs["<repo>"]  = _pc.repo_path
                _subs["<REPO>"]  = _pc.repo_path
            if project_id:
                _subs["<id>"]   = str(project_id)
                _subs["<ID>"]   = str(project_id)
            if _subs:
                _scrubbed: list = []
                for k, v in list(tool_input.items()):
                    if isinstance(v, str) and v in _subs:
                        tool_input[k] = _subs[v]
                        _scrubbed.append((k, v, _subs[v]))
                if _scrubbed:
                    logger.info(
                        "tool_input placeholder scrub tool=%s subs=%s",
                        tool, _scrubbed,
                    )

        # Always pass through the canonical project_id when the LLM left
        # a placeholder ("unknown", empty, missing) — MCP tools like
        # project_analyze require it.
        if isinstance(tool_input, dict):
            pid = tool_input.get("project_id")
            if not pid or str(pid).lower() in ("unknown", "none", "null", ""):
                tool_input["project_id"] = str(project_id)

        # chat_history_search needs user_id + project_id scoping and should
        # skip the current chat (its recent turns are already in context).
        # The planner rarely knows the real user_id/chat_id, so inject them
        # from the active PlanContext.
        if isinstance(tool_input, dict) and tool == "chat_history_search":
            _pc = getattr(self, "_active_plan_ctx", None)
            _uid = getattr(_pc, "user_id", None) if _pc else None
            _cid = getattr(_pc, "chat_id", None) if _pc else None
            if _uid and not tool_input.get("user_id"):
                tool_input["user_id"] = str(_uid)
            if _cid and not tool_input.get("exclude_chat_id"):
                tool_input["exclude_chat_id"] = str(_cid)

        # documents_rag tools (search_project_documents / retrieve_chunks)
        # search the per-project Qdrant collection, named
        # user_{user_id}_project_{project_oenum}. They REQUIRE a scope key
        # or fail with "Either session_id or project_oenum must be provided
        # for collection isolation". The planner almost never supplies it
        # (and sometimes emits "<oenum>"/"<this>" placeholders), so the
        # search hits no collection and the chatbot reports "document not
        # retrieved" even though the upload indexed fine.
        #
        # Uploads are stored by the upload route with user_id="system" and
        # project_oenum = (project.tpms_oenum or project_id). Mirror that
        # EXACTLY here so retrieval targets the same collection.
        if isinstance(tool_input, dict) and tool in (
            "search_project_documents", "retrieve_chunks",
            "list_project_documents", "read_document",
        ):
            # Tenant key = chatbot project UUID, ALWAYS. We used to fall
            # back to tpms_oenum, which broke multi-tenant isolation when
            # different chatbot projects shared the same OE. The OE stays
            # available to TPMS-specific tools via _pc.tpms_oenum.
            _scope = str(project_id)
            # The planner's value may be missing, empty, or a placeholder.
            _cur = str(tool_input.get("project_oenum") or "")
            if (not _cur) or _cur.lower() in ("none", "null", "unknown") \
                    or ("<" in _cur):
                tool_input["project_oenum"] = _scope
            # Documents are indexed under the synthetic "system" user, not
            # the human user_id — override whatever the planner guessed.
            tool_input["user_id"] = "system"
            # session_id would route to the wrong (general-chat) collection;
            # drop it so project_oenum wins the isolation key.
            tool_input.pop("session_id", None)
            logger.info(
                "documents_rag scope inject tool=%s project_oenum=%s",
                tool, tool_input["project_oenum"],
            )

        # gitlab_mcp.* tools take `project` as the GitLab path (e.g.
        # "shahram-tabasi/test") or a numeric GitLab project id — NEVER
        # the chatbot UUID or the friendly project name. The planner
        # has shown all three failure modes:
        #   - omits `project` entirely
        #   - passes the chatbot UUID
        #   - passes the friendly project name ("aws-t01")
        # Whenever the value isn't shaped like a GitLab path or numeric
        # id, replace it with the project's stored gitlab_repo_path.
        #
        # IMPORTANT: this canonicalization must run whether or not the
        # MCP transport is currently connected, because the REST
        # fallback in _try_gitlab_rest also calls gitlab-mcp and needs
        # the exact same `project`/`ref` shape. Identify gitlab-mcp
        # tools from a static list (mcp_manager.tools is empty when
        # MCP is disconnected, so the old `tools.get(tool)` lookup
        # silently skipped this whole block and the REST fallback then
        # 404'd on the chatbot UUID).
        _GITLAB_MCP_TOOLS = {
            "get_project_tree", "read_file_mcp", "read_artifact_mcp",
            "read_artifact", "list_branches_mcp", "list_projects_mcp",
            "list_user_projects_mcp", "search_blobs",
            "search_technical_knowledge", "create_branch_mcp",
            "commit_file_mcp", "open_mr_mcp", "merge_mr_mcp",
        }
        if isinstance(tool_input, dict) and tool in _GITLAB_MCP_TOOLS:
            # The planner sometimes uses `branch` (intuitive) instead of
            # the gitlab-mcp parameter name `ref`. Alias before any of
            # the ref-aware logic below runs.
            if "branch" in tool_input and "ref" not in tool_input:
                tool_input["ref"] = tool_input.pop("branch")
            proj_arg = tool_input.get("project") or tool_input.get("project_id")
            # Acceptable shapes for gitlab-mcp:
            #   "group/path"           — most common
            #   "group/sub/path"       — nested groups
            #   "123"                  — numeric GitLab project id
            looks_like_path = (
                isinstance(proj_arg, str) and "/" in proj_arg
            )
            looks_like_numeric_id = (
                isinstance(proj_arg, str) and proj_arg.isdigit()
            )
            # Operator-observed planner failure mode (2026-05-24): the
            # planner copy-pastes placeholder strings out of the system
            # prompt or LLM training corpus instead of substituting the
            # real project path. "group/repo" passes the simple "/" check
            # but gitlab-mcp 404s on it. Detect these explicitly and
            # treat as needs_substitution. Set is open — add more if new
            # ones appear in logs.
            _PLACEHOLDER_PATHS = {
                "group/repo", "group/project", "group/path",
                "org/repo", "org/project",
                "user/repo", "user/project", "username/repository",
                "owner/repo", "owner/project",
                "namespace/project", "namespace/repo",
                "your-org/your-repo", "your-group/your-repo",
                "example/example", "example/repo", "example/project",
                "team/myrepo", "my-org/my-repo",
            }
            is_placeholder = (
                isinstance(proj_arg, str) and (
                    proj_arg.lower() in _PLACEHOLDER_PATHS
                    # template syntax (e.g. "<group>/<repo>", "{org}/{repo}")
                    or "<" in proj_arg or ">" in proj_arg
                    or "{" in proj_arg or "}" in proj_arg
                )
            )
            needs_substitution = is_placeholder or not (
                looks_like_path or looks_like_numeric_id
            )
            if needs_substitution:
                try:
                    meta = await self.memory.get_project(str(project_id))
                except Exception:
                    meta = None
                repo_path = (meta or {}).get("gitlab_repo_path")
                if repo_path:
                    if proj_arg and proj_arg != repo_path:
                        logger.info(
                            "gitlab_mcp: substituting project arg %r -> %r "
                            "(project_id=%s)",
                            proj_arg, repo_path, project_id,
                        )
                    tool_input["project"] = repo_path
                    tool_input.pop("project_id", None)

            # Default ref to the project's *base* branch when the
            # planner omitted one. Important: prefer the base branch
            # (always exists on origin) over simorgh_branch — the
            # simorgh working branch may not have been pushed yet
            # if the deploy key wasn't granted at clone time, which
            # would make every read fail with "404 Commit Not Found".
            # Reads should target the user's canonical state, not
            # the agent's in-flight workspace.
            base_branch = None
            if not tool_input.get("ref"):
                try:
                    meta = locals().get("meta") or await self.memory.get_project(
                        str(project_id)
                    )
                except Exception:
                    meta = None
                base_branch = (meta or {}).get("gitlab_base_branch") or "main"
                tool_input["ref"] = base_branch

            # Hard override: if the planner explicitly passed a
            # simorgh/* working branch, force the base branch for
            # READ-side calls. Working branches frequently don't
            # exist on origin (push deferred) and produce
            # "404 Commit Not Found"; the user's intent on a read
            # is always "what's in my repo on the canonical branch".
            # Write/commit tools (commit_file, create_branch,
            # merge_mr) keep whatever ref the planner picked.
            read_only_tools = {
                "get_project_tree", "read_file_mcp", "read_artifact_mcp",
                "search_blobs", "search_technical_knowledge",
                "list_branches_mcp", "list_projects_mcp",
            }
            cur_ref = tool_input.get("ref")
            if (
                tool in read_only_tools
                and isinstance(cur_ref, str)
                and cur_ref.startswith("simorgh/")
            ):
                if base_branch is None:
                    try:
                        meta = locals().get("meta") or await self.memory.get_project(
                            str(project_id)
                        )
                    except Exception:
                        meta = None
                    base_branch = (meta or {}).get("gitlab_base_branch") or "main"
                logger.info(
                    "gitlab_mcp: overriding read ref %r -> %r for %s "
                    "(simorgh working branches aren't reliably pushed "
                    "to origin)",
                    cur_ref, base_branch, tool,
                )
                tool_input["ref"] = base_branch

        # Inject previous results into context (3000 char limit per result).
        # Operator hit: planner's synth step said "no CT info found" even
        # though step 4 (read_artifact_mcp) returned a 1861-char markdown
        # containing every CT spec. Root cause: the synth saw 3 empty
        # search results and 1 anonymous "Step 4 result: …" with no clue
        # which step was the authoritative file read, so it hedged.
        # Carry the producing tool + title alongside each output so the
        # synth in _execute_llm_task can label and filter them.
        if prev_results:
            labelled: Dict[str, Any] = {}
            for k, v in prev_results.items():
                if not isinstance(v, dict):
                    labelled[k] = {"output": str(v)[:3000]}
                    continue
                meta = v.get("metadata") or {}
                labelled[k] = {
                    "output": (v.get("output", "") or "")[:3000],
                    "tool": meta.get("tool") or meta.get("via") or "",
                    "title": meta.get("title") or "",
                }
            tool_input["_previous_results"] = labelled

        has_mcp_tool = (
            self.mcp_manager
            and self.mcp_manager.is_connected
            and self.mcp_manager.has_tool(tool)
        )
        # Operator hit recurring "Project Not Found" failures on
        # follow-up turns where the planner picked tools NOT in
        # _GITLAB_MCP_TOOLS (so the project-arg canonicalisation
        # didn't run and the wrong identifier propagated). Surface
        # the actual project value being passed so we can trace
        # which tool/arg shape needs canonicalisation added.
        proj_dbg = "?"
        if isinstance(tool_input, dict):
            proj_dbg = (tool_input.get("project")
                        or tool_input.get("project_id")
                        or tool_input.get("repo")
                        or tool_input.get("repository")
                        or "(none)")
        logger.info(
            f"dispatch: tool={tool!r} type={task_type!r} "
            f"mcp_match={has_mcp_tool} project_arg={proj_dbg!r} "
            f"input_keys={list(tool_input.keys()) if isinstance(tool_input, dict) else None}"
        )

        # Short-circuit known-invalid file-read calls before they hit MCP.
        # The LLM sometimes plans a redundant "read project files" step
        # after get_project_tree and fills `path` with '/' or '' (i.e.
        # "the whole repo"), which always 404s. Catch it here, return a
        # synthetic no-op that nudges the model toward get_project_tree
        # for tree-shaped questions.
        if (
            tool in ("read_file_mcp", "read_artifact_mcp", "session_read_file_tool",
                     "session_read_artifact_tool")
            and isinstance(tool_input, dict)
        ):
            raw_path = (tool_input.get("path") or "").strip()
            # Placeholder strings sneaked in by the planner ("<path_found_in_step1>",
            # "<top hit>", "{path}" etc). These always 404 in the field — guard them
            # here and synthesise a hint so the planner's salvage path can recover
            # using the prior step's actual output.
            looks_like_placeholder = (
                ("<" in raw_path and ">" in raw_path)
                or ("{" in raw_path and "}" in raw_path)
                or raw_path.lower() in {
                    "top hit", "top_hit", "path", "filename",
                    "the file", "the pdf", "<path>", "<top hit>",
                }
            )
            if raw_path in ("", "/", "*", "."):
                logger.info(
                    "dispatch: short-circuiting %s with invalid path=%r "
                    "(suggesting tree listing instead)",
                    tool, raw_path,
                )
                return {
                    "output": (
                        f"{tool} was called with no specific file path "
                        f"(path={raw_path!r}). To list repository contents "
                        "use get_project_tree; to read a file pass its "
                        "exact path from the tree (e.g. "
                        "'README.md', 'docs/spec.pdf')."
                    ),
                    "metadata": {
                        "via":  "dispatcher_guard",
                        "tool": tool,
                        "reason": "invalid_path_for_file_read",
                    },
                }
            if looks_like_placeholder:
                # Try to resolve from prior step outputs before failing.
                # search_context returns hits[0].path, get_project_tree
                # returns a list of {path,type} — pick the first plausible
                # file path we can find. This recovers the chain without
                # needing a planner reprompt.
                prev = tool_input.get("_previous_results") or {}
                resolved = None
                for k in sorted(prev.keys()):
                    blob = prev[k] or {}
                    out = blob.get("output") if isinstance(blob, dict) else None
                    if not out:
                        continue
                    try:
                        parsed = json.loads(out) if isinstance(out, str) else out
                    except Exception:
                        parsed = None
                    if isinstance(parsed, dict):
                        hits = parsed.get("hits")
                        if isinstance(hits, list) and hits:
                            p = hits[0].get("path") if isinstance(hits[0], dict) else None
                            if isinstance(p, str) and p and "<" not in p:
                                resolved = p
                                break
                if resolved:
                    logger.info(
                        "dispatch: resolved %s placeholder path %r -> %r "
                        "from previous step outputs",
                        tool, raw_path, resolved,
                    )
                    tool_input["path"] = resolved
                else:
                    logger.warning(
                        "dispatch: short-circuiting %s — planner emitted "
                        "placeholder path=%r and no prior step output had "
                        "a usable hits[0].path to substitute",
                        tool, raw_path,
                    )
                    return {
                        "output": (
                            f"{tool} was called with placeholder path={raw_path!r}. "
                            "The planner emitted a template string instead of a "
                            "concrete file path; no prior search step returned a "
                            "hit to substitute. To answer the user, retry the "
                            "plan: run get_project_tree first, then read the "
                            "specific file by its exact path."
                        ),
                        "metadata": {
                            "via":  "dispatcher_guard",
                            "tool": tool,
                            "reason": "placeholder_path",
                        },
                    }

        # Try MCP first for microservice tools (dynamic routing). Both
        # transport failures (MCP exception, REST 404) and successful-
        # but-empty responses (we got a 200 with `{"content": ""}`)
        # funnel into the same recovery path: for read_artifact /
        # read_file tools we fuzzy-match the planner's path against
        # the actual project tree and retry once with the matched
        # path. The structure below threads BOTH the "we got something
        # back" and "we got None back" branches into that recovery so
        # a 404 doesn't silently drop the read.
        is_read_tool = tool in ("read_artifact_mcp", "read_artifact",
                                "read_file_mcp")
        if has_mcp_tool:
            initial_result: Any = None
            try:
                # Strip dispatcher-internal keys before crossing the MCP
                # boundary. gitlab-mcp tools are typed as e.g.
                # read_artifact_mcp(project, path, ref=...) — strict
                # pydantic, no **kwargs — so dispatcher-side bookkeeping
                # like `project_id` (we already pass `project`) and
                # `_previous_results` (multi-step chain context for the
                # LLM, not for tools) trips MCP argument validation
                # with HTTP 400 "Bad Request". The chain then sits
                # silently because the failure surfaces below the
                # task-loop's error path. Same convention all MCP
                # callers should follow; centralised here as the
                # last hop before call_tool.
                mcp_input = {
                    k: v for k, v in tool_input.items()
                    if not k.startswith("_") and k != "project_id"
                }
                initial_result = await self.mcp_manager.call_tool(tool, mcp_input)
            except Exception as e:
                logger.warning(f"MCP call failed for {tool}, falling back to HTTP: {e}")
                # gitlab-mcp also exposes REST endpoints that work fine
                # when the streamable-HTTP transport is misbehaving. Try
                # those directly before giving up.
                initial_result = await self._try_gitlab_rest(tool, tool_input)

            if is_read_tool and (
                initial_result is None
                or self._read_returned_nothing(initial_result)
            ):
                # Both paths failed or returned empty content — the
                # planner-supplied path almost certainly doesn't match
                # any real file. Fuzzy-retry against the tree before
                # surrendering.
                retried = await self._maybe_fuzzy_retry_read(
                    tool, tool_input, initial_result,
                )
                if retried is not None:
                    return retried
                # No fuzzy match either. Synthesise a structured
                # "file not found" payload so the downstream synth
                # step has SOMETHING to summarise — better than
                # falling through to a content-less LLM call that
                # produces "I don't have the text" and looks like
                # the agent broke. Includes the tree paths the
                # planner can offer the user as alternatives.
                return await self._not_found_payload(tool, tool_input)

            if initial_result is not None:
                return initial_result
        elif tool in {
            "get_project_tree", "read_file_mcp", "read_artifact_mcp",
            "read_artifact", "list_branches_mcp", "list_projects_mcp",
            "search_blobs",
        }:
            # MCP not connected (or this tool not registered) but the
            # gitlab-mcp REST equivalent exists. Hit it directly instead
            # of dropping into the default no-op handler — without this,
            # any disconnect of the MCP transport silently turns every
            # "read this file then summarise" plan into a no-op read
            # followed by an llm step that has no document content.
            rest_fallback = await self._try_gitlab_rest(tool, tool_input)
            if is_read_tool and (
                rest_fallback is None
                or self._read_returned_nothing(rest_fallback)
            ):
                retried = await self._maybe_fuzzy_retry_read(
                    tool, tool_input, rest_fallback,
                )
                if retried is not None:
                    return retried
                return await self._not_found_payload(tool, tool_input)
            if rest_fallback is not None:
                return rest_fallback

        # Design Suite slot-collector tools. Local (not MCP) so the ReAct
        # loop can read the live spec state, ask the user for clarifications
        # via a structured SSE event, and finally submit to simorgh-soft.
        # All three are no-ops when SOFT_BRIDGE_ENABLED is unset.
        if tool in ("read_soft_spec", "ask_user", "submit_soft_spec",
                    "list_pending_proposals", "approve_proposals"):
            try:
                return await self._execute_soft_bridge_tool(
                    project_id, tool, tool_input)
            except Exception as e:
                logger.warning("soft-bridge tool %s failed: %s", tool, e)
                return {"output": f"[{tool} failed: {e}]",
                        "metadata": {"tool": tool, "via": "soft_bridge"}}

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

    # ------------------------------------------------------------------
    # Design Suite slot-collector tools (local; gated by SOFT_BRIDGE_ENABLED)
    # ------------------------------------------------------------------
    async def _execute_soft_bridge_tool(
            self, project_id: str, tool: str, tool_input: Dict) -> Dict:
        """Three pseudo-tools the ReAct loop drives the spec collection +
        submission with:

          read_soft_spec()
            → returns the persisted SoftSpecState (forces a fresh refresh
              on miss so the very first call still works).

          ask_user(questions=[{header, question, options[], multiSelect}])
            → records a pending_ask row, emits an SSE event the chat UI
              renders as an inline form, and returns
              {status: "asked", pending_id}. The loop typically ENDS the
              turn after this; on the user's next message we re-read the
              state (the answer endpoint will have merged answers into
              the spec) and continue.

          submit_soft_spec()
            → if state.gaps is non-empty: returns the gaps so the model
              calls ask_user. Otherwise POSTs to simorgh-soft and returns
              the deep-link.
        """
        # Hot import: avoids a startup-time hard dep on these modules when
        # SOFT_BRIDGE_ENABLED is unset (and they may not be present in some
        # build flavors).
        from services import soft_spec_state as sss
        from services.soft_collector import refresh as collector_refresh

        if tool == "read_soft_spec":
            state = await sss.get_state(project_id)
            if state is None:
                state = await collector_refresh(project_id, force=True)
            return {
                "output": json.dumps((state or {}), default=str)[:3000],
                "metadata": {
                    "tool": "read_soft_spec", "via": "soft_bridge",
                    "completeness": (state or {}).get("completeness", 0),
                    "gaps": (state or {}).get("gaps", []),
                },
            }

        if tool == "ask_user":
            questions = tool_input.get("questions") or []
            if not isinstance(questions, list) or not questions:
                return {"output": "ask_user: `questions` must be a non-empty list",
                        "metadata": {"tool": "ask_user", "via": "soft_bridge",
                                     "error": "bad_input"}}
            # Best-effort chat_id from the active PlanContext.
            _pc = getattr(self, "_active_plan_ctx", None)
            chat_id = getattr(_pc, "chat_id", None) if _pc else None
            pending_id = await sss.create_pending_ask(
                project_id, str(chat_id) if chat_id else None, questions)
            # Tell the UI to render the inline form. The event piggybacks on
            # the existing progress-callback transport — useChat.ts's event
            # parser already handles arbitrary event names.
            await self._notify_progress(project_id, "ask_user", {
                "pending_id": pending_id,
                "questions":  questions,
            })
            return {
                "output": (f"Asked the user {len(questions)} clarifying "
                           f"question(s). pending_id={pending_id}. The user "
                           "will submit answers via the form; STOP calling "
                           "tools and end the turn with a short "
                           "acknowledgement."),
                "metadata": {"tool": "ask_user", "via": "soft_bridge",
                             "pending_id": pending_id},
            }

        if tool == "list_pending_proposals":
            # CoT inspects what extractors proposed for review. Returns
            # one row per (field, proposal); the CoT then either approves
            # specific ones (approve_proposals) or asks the user about
            # ambiguous ones (ask_user). NEVER writes anything.
            from services import soft_proposals as sp
            pending = await sp.list_pending(project_id)
            approved = await sp.list_approved(project_id)
            return {
                "output": json.dumps({
                    "pending": pending, "approved_count": len(approved)},
                    default=str)[:3500],
                "metadata": {"tool": "list_pending_proposals",
                             "via": "soft_bridge",
                             "pending_count": len(pending)},
            }

        if tool == "approve_proposals":
            # User-driven write gate, callable by the CoT once it has had
            # the user confirm specific values via ask_user. Input:
            #   {"approvals": [{"proposal_id": "...", "action": "approve"
            #                    |"reject"|"edit", "value": ...}, ...]}
            from services import soft_proposals as sp
            from services import soft_spec_state as sss
            approvals = tool_input.get("approvals") or []
            if not isinstance(approvals, list) or not approvals:
                return {"output": "approve_proposals: `approvals` must be a "
                        "non-empty list of {proposal_id, action[, value]}",
                        "metadata": {"tool": "approve_proposals",
                                     "via": "soft_bridge",
                                     "error": "bad_input"}}
            written = 0
            for a in approvals:
                if not isinstance(a, dict):
                    continue
                pid = a.get("proposal_id")
                action = str(a.get("action") or "").lower()
                if not pid:
                    continue
                if action == "approve":
                    r = await sp.approve(pid)
                    if r:
                        written += 1
                elif action == "edit":
                    r = await sp.approve(pid, approved_value=a.get("value"))
                    if r:
                        written += 1
                elif action == "reject":
                    await sp.reject(pid)
            # Re-derive the spec from the now-approved set.
            try:
                from routes.project_agent_routes import _rederive_spec_from_approved
                await _rederive_spec_from_approved(project_id)
            except Exception as e:
                logger.warning("rederive after approve failed: %s", e)
            return {
                "output": f"Recorded {written} approved values; rejected the "
                          f"rest. Call read_soft_spec or submit_soft_spec to "
                          f"continue.",
                "metadata": {"tool": "approve_proposals",
                             "via": "soft_bridge", "written": written},
            }

        # VLM verifier tools — route to Qwen 2.5-VL on .62 via llm-gateway.
        # See services/vlm_verifier.py. Best-effort; failures return
        # structured error dicts so the CoT can gracefully fall back to
        # text-only evidence.
        if tool == "verify_value_visible":
            from services.vlm_verifier import verify_value
            doc_id = str(tool_input.get("document_id") or "").strip()
            try:
                page = int(tool_input.get("page") or 0)
            except (TypeError, ValueError):
                page = 0
            field = str(tool_input.get("field") or "").strip()
            value = str(tool_input.get("value") or "").strip()
            language = tool_input.get("language") or None
            if not (doc_id and page > 0 and field and value):
                return {
                    "output": "verify_value_visible: require document_id, "
                              "page>=1, field, value",
                    "metadata": {"tool": "verify_value_visible",
                                 "error": "bad_input"},
                }
            result = await verify_value(
                document_id=doc_id, page=page,
                field=field, value=value, language=language,
            )
            return {
                "output": json.dumps(result, ensure_ascii=False)[:2500],
                "metadata": {"tool": "verify_value_visible",
                             "ok": bool(result.get("ok")),
                             "confirmed": result.get("confirmed"),
                             "confidence": result.get("confidence")},
            }

        if tool == "describe_page":
            from services.vlm_verifier import describe_page
            doc_id = str(tool_input.get("document_id") or "").strip()
            try:
                page = int(tool_input.get("page") or 0)
            except (TypeError, ValueError):
                page = 0
            language = tool_input.get("language") or None
            if not (doc_id and page > 0):
                return {
                    "output": "describe_page: require document_id and page>=1",
                    "metadata": {"tool": "describe_page",
                                 "error": "bad_input"},
                }
            result = await describe_page(
                document_id=doc_id, page=page, language=language,
            )
            return {
                "output": (result.get("markdown") or
                           f"[describe_page failed: {result.get('error')}]")[:3500],
                "metadata": {"tool": "describe_page",
                             "ok": bool(result.get("ok"))},
            }

        # Apache AGE graph-as-router. graph_route runs the populator's
        # entity regex over the query and walks the graph to find
        # likely-relevant documents + sub-corpora. cypher_query is an
        # ad-hoc escape hatch — both return structured dicts; on any
        # failure the agent gets a clear "ok=false" signal and can fall
        # back to plain search.
        if tool == "graph_route":
            from services.graph_router import route_query
            q = str(tool_input.get("query") or "").strip()
            if not q:
                return {"output": "graph_route: require non-empty query",
                        "metadata": {"tool": "graph_route", "error": "bad_input"}}
            decision = route_query(q, project_id=project_id)
            return {
                "output": json.dumps(decision.to_dict(), ensure_ascii=False)[:2500],
                "metadata": {"tool": "graph_route",
                             "entities": len(decision.entities),
                             "routed_docs": len(decision.routed_document_ids),
                             "sources": decision.sources_to_hit,
                             "fallback": decision.fallback},
            }

        if tool == "cypher_query":
            from services.graph_router import cypher_query as _cq
            q = str(tool_input.get("query") or "").strip()
            params = tool_input.get("params") or {}
            try:
                limit = int(tool_input.get("limit") or 20)
            except (TypeError, ValueError):
                limit = 20
            if not q:
                return {"output": "cypher_query: require non-empty query",
                        "metadata": {"tool": "cypher_query", "error": "bad_input"}}
            res = _cq(q, params=params if isinstance(params, dict) else {}, limit=limit)
            return {
                "output": json.dumps(res, ensure_ascii=False, default=str)[:3500],
                "metadata": {"tool": "cypher_query",
                             "ok": bool(res.get("ok")),
                             "rows": len(res.get("rows") or [])},
            }

        if tool == "submit_soft_spec":
            state = await sss.get_state(project_id)
            if state is None:
                state = await collector_refresh(project_id, force=True)
            if not state:
                return {"output": "submit_soft_spec: no state available",
                        "metadata": {"tool": "submit_soft_spec",
                                     "via": "soft_bridge", "error": "no_state"}}
            # HITL gate: under the new contract every field that ends up in
            # the spec MUST have a corresponding APPROVED proposal. If there
            # are pending (un-reviewed) proposals, refuse: the user must
            # approve / reject them first. This is what stops irrelevant
            # uploads from silently mutating the project.
            try:
                from services import soft_proposals as sp
                pending = await sp.list_pending(project_id)
            except Exception:
                pending = []
            if pending:
                # Surface the pending list to the chat UI so the user can
                # review (the existing inline form will render it).
                await self._notify_progress(project_id, "ask_user", {
                    "kind": "proposals_pending",
                    "pending_count": len(pending),
                })
                # Typed precondition_blocked envelope. The agent has an
                # explicit `resolver` (next tool to call) and a `recipe`
                # the model can follow — turns the previous prose-only
                # "blocked" reply into a directly actionable signal so the
                # ReAct loop continues instead of stopping with the user
                # confused.
                blocked = {
                    "error": "precondition_blocked",
                    "blocked_on": "pending_proposals",
                    "pending_count": len(pending),
                    "resolver": "list_pending_proposals",
                    "recipe": [
                        "1. Call list_pending_proposals to see every "
                        "field, value, source, and confidence.",
                        "2. For each: action='approve' if relevant + "
                        "correct, action='reject' if irrelevant, OR "
                        "call ask_user when ambiguous.",
                        "3. Call approve_proposals ONCE with the bundle.",
                        "4. Re-attempt submit_soft_spec.",
                    ],
                    "message": (f"Cannot submit yet — {len(pending)} "
                                "extracted value(s) are waiting for "
                                "review. Resolve them via "
                                "list_pending_proposals + "
                                "approve_proposals, then re-submit."),
                }
                return {
                    "output": json.dumps(blocked, ensure_ascii=False,
                                         default=str),
                    "metadata": {"tool": "submit_soft_spec",
                                 "via": "soft_bridge",
                                 "blocked_on": "pending_proposals",
                                 "pending_count": len(pending),
                                 "resolver": "list_pending_proposals"},
                }
            gaps = state.get("gaps") or []
            if gaps:
                # Auto-create a pending_ask with one question per gap so the
                # chat UI shows the form immediately, even if the planner
                # doesn't follow the "call ask_user explicitly" recipe.
                try:
                    from services import soft_spec_state as sss
                    _pc = getattr(self, "_active_plan_ctx", None)
                    chat_id = getattr(_pc, "chat_id", None) if _pc else None
                    _LABELS = {
                        "projectName":        ("Project name",
                                               "What should this project be called in Design Suite?"),
                        "projectDescription": ("Project description",
                                               "One or two sentences describing the project scope."),
                        "client":             ("Client",
                                               "Which client / customer is this project for?"),
                        "location":           ("Location",
                                               "Site city / plant location."),
                        "standard":           ("Standard",
                                               "Which standard governs the design?"),
                        "country":            ("Country",
                                               "Country where the project will be installed."),
                        "language":           ("Language",
                                               "Document language."),
                        "projectNumber":      ("OE / project number",
                                               "Internal OE / order number for this project."),
                    }
                    _OPTIONS = {
                        "standard": ["IEC", "ANSI", "GOST", "BS"],
                        "language": ["English", "Persian", "Other"],
                    }
                    questions = []
                    for g in gaps:
                        header, qtext = _LABELS.get(
                            g, (g, f"Please provide a value for `{g}`."))
                        q = {"field": g, "header": header, "question": qtext}
                        if g in _OPTIONS:
                            q["options"] = _OPTIONS[g]
                        questions.append(q)
                    pid = await sss.create_pending_ask(
                        project_id, str(chat_id) if chat_id else None, questions)
                    await self._notify_progress(project_id, "ask_user", {
                        "pending_id": pid, "questions": questions,
                    })
                except Exception as e:
                    logger.warning("auto ask_user for gaps failed: %s", e)
                blocked = {
                    "error": "precondition_blocked",
                    "blocked_on": "spec_gaps",
                    "gaps": gaps,
                    "resolver": "ask_user",
                    "recipe": [
                        "1. The fields above are missing from the spec.",
                        "2. The chat has auto-opened a form; the user "
                        "will answer in the next turn.",
                        "3. STOP and wait — do NOT call submit_soft_spec "
                        "again until the form has been submitted.",
                    ],
                    "message": (
                        "Cannot submit yet — these spec fields need user "
                        "input: " + ", ".join(gaps) +
                        ". A form has been opened; please fill it in."),
                }
                return {
                    "output": json.dumps(blocked, ensure_ascii=False,
                                         default=str),
                    "metadata": {"tool": "submit_soft_spec",
                                 "via": "soft_bridge",
                                 "blocked_on": "spec_gaps",
                                 "gaps": gaps,
                                 "resolver": "ask_user"},
                }
            try:
                from services.simorgh_soft_client import create_project, deep_link
                spec = state.get("spec") or {}
                # Phase E: docker-image-tag-style projectName so each
                # Design Suite project from this chatbot project gets a
                # traceable tag (<chatbot-project>:<user>-<YYYYMMDD-HHMM>).
                # Best-effort: any failure falls through to the verbatim
                # extracted name. Pull chatbot project + user identifier
                # from the agent context for the tag components.
                try:
                    from services.project_tagger import apply_tag_to_spec
                    proj_row = await self.memory_service.get_project(project_id)
                    user_hint = (proj_row or {}).get("owner_id") or "anonymous"
                    spec = apply_tag_to_spec(
                        spec,
                        chatbot_project=(proj_row or {}).get("name"),
                        user=user_hint,
                    )
                except Exception as e:  # noqa: BLE001
                    logger.warning(
                        "project_tagger (submit_soft_spec): tagging failed (%s) — verbatim name",
                        e,
                    )
                created = await create_project(spec)
            except Exception as e:
                logger.error("submit_soft_spec POST failed: %s", e)
                return {"output": f"submit failed: {e}",
                        "metadata": {"tool": "submit_soft_spec",
                                     "via": "soft_bridge", "error": str(e)}}
            soft_id = str(created.get("_id") or "")
            if soft_id:
                await sss.mark_submitted(project_id, soft_id)
                try:
                    await self.memory.update_project(
                        project_id, simorgh_soft_project_id=soft_id)
                except Exception:
                    pass
            url = deep_link(soft_id) if soft_id else ""
            # Surface to UI so the chat can render a clickable button.
            await self._notify_progress(project_id, "soft_submitted", {
                "soft_project_id": soft_id, "deep_link": url,
            })
            return {
                "output": json.dumps({
                    "ready": True, "soft_project_id": soft_id, "deep_link": url},
                    default=str),
                "metadata": {"tool": "submit_soft_spec", "via": "soft_bridge",
                             "deep_link": url},
            }

        return {"output": f"unknown soft-bridge tool: {tool}",
                "metadata": {"tool": tool, "via": "soft_bridge"}}

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

        # Image perception grounding (describe-then-reason). When this turn
        # carried an image, the VLM's structured description is the most
        # authoritative source for the answer — inject it FIRST so the
        # synth sees it regardless of what (possibly empty) retrieval steps
        # the planner scheduled. This is what makes "describe this image" /
        # "compare this image to my repo" work end-to-end even when the
        # project has no repo to search.
        _img_desc = ""
        try:
            _img_desc = _image_desc_var.get()
        except Exception:
            _img_desc = ""
        image_present = bool(_img_desc)
        if image_present:
            context_parts.append(
                "=== Attached image (vision model transcription — "
                "AUTHORITATIVE for anything about the image) ===\n"
                + _img_desc
            )

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

        # Include other previous step results. _previous_results is now
        # {step_num: {"output": str, "tool": str, "title": str}} (see
        # _execute_single_task labelling block) — render each with the
        # producing tool so the synth can tell "step 4 = read_artifact"
        # from "step 2 = search_context (empty)". Empty / trivial
        # outputs are SKIPPED entirely; otherwise the synth weights
        # them as "no data found" and hedges the answer even when a
        # later step returned the goods.
        kept = 0
        skipped = 0
        if prev:
            for k, v in prev.items():
                if isinstance(v, dict):
                    out = (v.get("output") or "").strip()
                    tool_name = v.get("tool") or ""
                    title = v.get("title") or ""
                else:
                    out = str(v).strip()
                    tool_name = ""
                    title = ""
                if not out or len(out) < 20:
                    skipped += 1
                    continue
                label_parts = [f"Step {k}"]
                if tool_name:
                    label_parts.append(f"tool={tool_name}")
                if title:
                    label_parts.append(f"title={title!r}")
                header = " | ".join(label_parts)
                context_parts.append(f"=== {header} ===\n{out}")
                kept += 1

        if context_parts:
            context = "\n\n".join(context_parts)
            prompt = f"Retrieved context:\n{context}\n\nUser question: {prompt}"

        # Synth system prompt — anti-hedging.
        # gpt-oss-20b is hedge-happy: on a single-repo plan it sees
        # several empty search hits + one file read with the content,
        # then concludes "no information available". Explicit rules
        # below stop that: trust non-empty retrievals, quote specifics,
        # never claim "not found" when a labelled retrieval CONTAINS
        # the asked-about terms.
        synth_system = (
            "You are the Simorgh synthesizer. Your job is to answer the "
            "user's question using the RETRIEVED CONTEXT below.\n\n"
            "HARD RULES:\n"
            "1. If any retrieval block above contains content relevant to "
            "the question, USE IT. Quote specifics: numbers, classes, "
            "standards (e.g. IEC 60044), tolerances, ratings.\n"
            "2. Empty retrieval blocks were ALREADY filtered out before "
            "you saw them. EVERY block in 'Retrieved context' contains "
            "real content — do not dismiss any of them.\n"
            "3. If a `read_artifact*` or `read_file*` block exists, treat "
            "it as AUTHORITATIVE — it's the literal file content. A "
            "search_context / search_blobs block that came back without "
            "hits does NOT mean the data is absent; the file-read block "
            "is the ground truth.\n"
            "4. NEVER reply 'I couldn't find any X' / 'no X-specific "
            "details were present' when an X-related term appears in any "
            "retrieval block. Quote the block.\n"
            "5. When citing, name the source file/path so the user can "
            "verify.\n"
            "6. When an 'Attached image' transcription block is present, it "
            "is the AUTHORITATIVE description of the image the user sent — "
            "answer the user's question about the image directly from it "
            "(quote the table rows, device tags, ratings). Combine it with "
            "any other retrieval blocks when the question spans both.\n"
            "Be concise but specific."
        )
        if kept == 0 and skipped == 0 and not image_present:
            # No prior retrieval at all and no image — degrade to the
            # generic assistant role (e.g. simple "rephrase this" task).
            synth_system = (
                "You are a project assistant. Answer concisely and "
                "accurately."
            )
        messages = [
            {"role": "system", "content": synth_system},
            {"role": "user", "content": prompt},
        ]

        try:
            # Per-request mode override installed by handle_input via
            # the _llm_mode_var ContextVar. None = use llm_service's
            # configured default.
            requested_mode = _llm_mode_var.get()
            if hasattr(self.llm_service, 'async_generate'):
                result = await self.llm_service.async_generate(
                    messages=messages,
                    user_id=f"agent_{project_id}",
                    mode=requested_mode,
                )
                response = result.get('response', '') if isinstance(result, dict) else str(result)
            else:
                result = self.llm_service.generate(messages=messages, mode=requested_mode)
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

    async def _perceive_image(
        self, project_id: str, user_input: str,
        document_id: Optional[str], document_filename: Optional[str],
    ) -> str:
        """Perception stage of describe-then-reason. If this turn carries
        an image, ask the local VLM on .62 (via llm-gateway) for a
        structured Markdown description and return it as a string for the
        CoT to reason over. Returns "" when there's no usable image.

        The image bytes are stashed in Redis at upload time
        (set_uploaded_image). We base64-data-URL them into an OpenAI-shape
        image_url message and POST to the gateway in offline mode — the
        gateway's _has_image sniff routes image content to the VLM backend
        automatically. The VLM is used as a PERCEPTION agent (pixels →
        structured text), not as the final answerer; gpt-oss then reasons
        over the description plus any retrieval the planner schedules.
        """
        fn = (document_filename or "").lower()
        looks_image = fn.endswith(
            (".png", ".jpg", ".jpeg", ".bmp", ".tiff", ".gif", ".webp")
        )
        if not document_id and not looks_image:
            return ""

        try:
            from services.redis_service import get_redis_service
            stash = get_redis_service().get_uploaded_image(str(document_id)) if document_id else None
        except Exception as e:
            logger.warning("perceive_image: redis lookup failed: %s", e)
            stash = None

        if not stash or not stash.get("b64"):
            if looks_image:
                logger.info(
                    "perceive_image: %s looks like an image but no bytes "
                    "were stashed (doc_id=%s); skipping perception",
                    fn or document_filename, document_id,
                )
            return ""

        mime = stash.get("mime") or "image/png"
        b64 = stash["b64"]
        fname = stash.get("filename") or document_filename or "image"

        await self._notify_progress(project_id, "vlm_vision", {
            "status": f"Reading image {fname} with the vision model…",
            "filename": fname,
        })

        gateway_url = os.getenv("LLM_GATEWAY_URL", "").strip().rstrip("/")
        if not gateway_url:
            logger.warning("perceive_image: LLM_GATEWAY_URL unset; cannot reach VLM")
            return ""

        # Perception prompt: extract, don't answer. The downstream gpt-oss
        # synth produces the user-facing reply; the VLM's job is a faithful
        # structured transcription so the planner can reason + retrieve.
        system_prompt = (
            "You are a vision extraction engine in an electrical-engineering "
            "pipeline. Convert the attached image into clean, structured "
            "Markdown that a downstream text model will reason over. If it is "
            "a single-line diagram, panel schematic, or feeder drawing: "
            "transcribe every table row as a Markdown table (field | value), "
            "and list device tags, ratings, bus data, and labels verbatim. "
            "Preserve exact codes, part numbers and units. When a field is "
            "blank on the drawing write '(blank)' rather than guessing. For "
            "non-technical images give a concise factual description. Output "
            "ONLY the Markdown — no preamble, do not answer the user's "
            "question, just transcribe what is visible."
        )
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": [
                {"type": "text",
                 "text": f"Transcribe this image to structured Markdown. "
                         f"Filename: {fname}. (User asked: {user_input[:200]})"},
                {"type": "image_url",
                 "image_url": {"url": f"data:{mime};base64,{b64}"}},
            ]},
        ]
        payload = {
            "messages": messages,
            "mode": "offline",            # → local backends
            "temperature": 0.1,
            "max_tokens": int(os.getenv("VLM_VISION_MAX_TOKENS", "1800")),
        }

        import httpx
        timeout = float(os.getenv("LLM_GATEWAY_COT_TIMEOUT_SEC", "180"))
        try:
            async with httpx.AsyncClient(timeout=timeout) as c:
                r = await c.post(f"{gateway_url}/generate", json=payload)
                r.raise_for_status()
                body = r.json()
        except Exception as e:
            logger.error("perceive_image: gateway call failed: %s", e)
            await self._notify_progress(project_id, "vlm_vision_error", {
                "error": str(e)[:200],
            })
            return ""

        desc = (body.get("response") or "").strip()
        backend = body.get("backend") or body.get("mode") or "offline_vlm"
        if not desc:
            logger.warning(
                "perceive_image: empty description (backend=%s)", backend
            )
            return ""

        logger.info(
            "perceive_image: described %s via %s (%d chars) → CoT grounding",
            fname, backend, len(desc),
        )
        return desc

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
