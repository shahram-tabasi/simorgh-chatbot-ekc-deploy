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
        self.llm_service = None
        self.email_service = None
        # Callbacks for streaming progress to frontend
        self._progress_callbacks: Dict[str, Callable] = {}

    def initialize(self, llm_service=None, email_service=None,
                   redis=None, postgres=None, qdrant=None, neo4j=None):
        """Initialize all agent dependencies."""
        self.llm_service = llm_service

        # COT Engine
        self.cot_engine = get_cot_engine()
        if llm_service:
            self.cot_engine.set_llm_service(llm_service)

        # Memory
        self.memory = get_project_memory_service()
        self.memory.set_services(redis=redis, postgres=postgres,
                                 qdrant=qdrant, neo4j=neo4j)

        # Shell
        self.shell = get_shell_service()

        # Email
        self.email_service = email_service

        logger.info("Project Manager Agent initialized")

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

        # 7. Try to commit changes if shell tasks were executed
        commit_result = None
        has_shell_tasks = any(
            t.get("tool_used") == "shell" or t.get("task_type") == "shell_command"
            for t in tasks_created
        )
        if has_shell_tasks:
            commit_result = await self._auto_commit(
                project_id, f"Agent: {user_input[:80]}"
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
                r.get("content", "")[:2000] for r in project_context["semantic_results"][:5]
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

        # Inject previous results into context (3000 char limit per result)
        if prev_results:
            tool_input["_previous_results"] = {
                k: v.get("output", "")[:3000] for k, v in prev_results.items()
            }

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
                    {"content": r.get("content", "")[:1500], "score": r.get("score", 0)}
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
        """Process a document - extract/convert content to markdown."""
        content = tool_input.get("content", "")
        filename = tool_input.get("filename", "document")
        document_id = tool_input.get("document_id")

        # Use LLM to convert content to clean markdown
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

                return {
                    "output": markdown,
                    "metadata": {"document_id": document_id, "filename": filename, "format": "markdown"},
                }
            except Exception as e:
                return {"output": f"Document processing error: {e}", "metadata": {"error": True}}

        return {
            "output": content[:2000] if content else "No content to process",
            "metadata": {"document_id": document_id},
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
            doc_uuid = document_id or str(uuid.uuid4())
            success = self.memory.qdrant.add_document_chunks(
                user_id="project",
                document_id=doc_uuid,
                chunks=chunk_dicts,
                project_oenum=project_id,
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
    # PROJECT LIFECYCLE
    # =========================================================================

    async def initialize_project(self, project_id: str, name: str,
                                 owner_id: str, tpms_oenum: str = None) -> Dict:
        """Initialize all systems for a new project."""
        results = {}

        # 1. Init Neo4j graph (full EKC template only for legacy/TPMS projects)
        results["neo4j"] = await self.memory.init_project_graph(
            project_id, name, owner_id, tpms_oenum=tpms_oenum
        )

        # 2. Init Qdrant collection for project semantic search
        try:
            if self.memory.qdrant:
                self.memory.qdrant.ensure_collection_exists(
                    user_id="project", project_oenum=project_id
                )
                results["qdrant"] = {"status": "initialized"}
        except Exception as e:
            results["qdrant"] = {"status": "error", "error": str(e)}

        # 3. Init git workspace
        try:
            if self.shell:
                git_result = await self.shell.git_init(project_id)
                results["git"] = git_result
                # Update project record
                await self.memory.update_project(
                    project_id, git_repo_initialized=True,
                    git_repo_path=f"/workspace/{project_id}"
                )
        except Exception as e:
            results["git"] = {"status": "error", "error": str(e)}

        # 4. Set initial agent state
        await self.memory.set_agent_state(project_id, {
            "status": "idle",
            "project_name": name,
            "initialized_at": datetime.utcnow().isoformat(),
            "pending_tasks": 0,
        })

        results["agent_state"] = "initialized"
        logger.info(f"Project {project_id} ({name}) initialized: {results}")
        return results

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
