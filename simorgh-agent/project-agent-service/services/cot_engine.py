"""
COT (Chain of Thoughts) Engine
===============================
Analyzes user requests and generates structured TODO task lists.
Uses LLM to reason about the request in context of project instructions,
then produces executable task steps.
"""

import json
import logging
import os
import uuid
from datetime import datetime
from typing import List, Optional, Dict, Any, Tuple

from models.project_models import (
    COTAnalysis, COTStep, COTRequest, TaskType,
    TaskCreate, TaskTrigger, TaskStatus
)
from knowledge.tpms_schema_instructions import get_tpms_instructions

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Ship completed CoT traces to context-search-service. Fire-and-forget; the
# agent must continue to work when ELK is offline.
# ---------------------------------------------------------------------------
try:
    from simorgh_clients import context_search as _csc
except Exception:
    _csc = None


async def _ship_cot_trace(analysis: COTAnalysis, success: bool) -> None:
    """Best-effort: index the trace so future runs can semantically recall it."""
    if _csc is None:
        return
    try:
        await _csc.index_cot_trace({
            "chain_id":      str(analysis.chain_id),
            "session_id":    "",
            "user_id":       "",
            "project_id":    str(analysis.project_id),
            "question":      analysis.user_input,
            "reasoning":     analysis.reasoning or "",
            "final_answer":  None,
            "success":       success,
            "steps": [
                {
                    "step_number":   s.step_number,
                    "step_type":     "tool_call" if s.tool_needed else "plan",
                    "title":         s.title,
                    "description":   s.description,
                    "tool":          s.tool_needed,
                    "tool_input":    s.tool_input,
                }
                for s in analysis.steps
            ],
            "tags": [],
        })
    except Exception:
        logger.debug("ship_cot_trace_failed", exc_info=True)


# ---------------------------------------------------------------------------
# Admin-managed restrictions file. Read on demand and cached by mtime so the
# hot path costs one stat() call when nothing changed.
# ---------------------------------------------------------------------------
_RESTRICTIONS_PATH = os.getenv("RESTRICTIONS_PATH", "/app/restrictions/system.txt")
_restrictions_cache: Dict[str, Any] = {"mtime": None, "content": ""}


def _read_restrictions() -> str:
    """Return the current contents of RESTRICTIONS_PATH, or '' if missing."""
    try:
        st = os.stat(_RESTRICTIONS_PATH)
    except FileNotFoundError:
        _restrictions_cache["mtime"] = None
        _restrictions_cache["content"] = ""
        return ""
    except Exception:
        return _restrictions_cache.get("content", "") or ""

    if _restrictions_cache["mtime"] == st.st_mtime:
        return _restrictions_cache["content"]

    try:
        with open(_RESTRICTIONS_PATH, "r", encoding="utf-8") as f:
            content = f.read().strip()
    except Exception:
        content = ""

    _restrictions_cache["mtime"] = st.st_mtime
    _restrictions_cache["content"] = content
    return content

# System prompt for COT analysis
COT_SYSTEM_PROMPT = """You are a Project Manager Agent analyzing a user request for a project.
Your job is to break down the request into concrete, executable task steps.

You have access to these core tools:
- llm: Ask questions, generate text, analyze data, reason about problems
- shell: Execute Linux commands, run scripts, manage files in project workspace (on remote server 1.69)
- git: Version control operations (commit, diff, log) in project workspace
- memory_query: Search project memory (Redis cache, PostgreSQL data, Qdrant vectors, Neo4j graph)
- memory_store: Store data in project memory (graph entities, working memory)
- document_process: Process uploaded documents - convert to markdown, extract text
- semantic_store: Chunk text content and store in Qdrant for semantic search. Input: {{"content": "text to chunk and index", "document_id": "doc-uuid", "filename": "name.pdf"}}
- email: Send email responses

{mcp_tools}

DOCUMENT PROCESSING WORKFLOW:
When a document is uploaded (via chatbot or email), create tasks in this order:
1. Save the document to project workspace: documents/<filename> (tool: shell)
2. Process/convert document content to clean markdown (tool: llm, type: generation)
3. Save markdown to project workspace: documents/<filename>.md (tool: shell)
4. Index content in semantic search for future queries (tool: semantic_store)
5. Commit document files to git with descriptive message (tool: git, operation: commit, message: "Add uploaded document: <filename>")

PROJECT ANALYSIS WORKFLOW:
When a new project is created or user asks to understand the project:
1. Query TPMS for project overview using tpms_fetch (tool: tpms_fetch, oenum)
2. Query TPMS for scopes/panels (tool: tpms_fetch, table: ViewScope)
3. Run project workspace analysis with shell commands (tool: shell, command: tree, find, etc.)
4. Summarize findings (tool: llm)
5. Store summary in working memory (tool: memory_store)

PROJECT STRUCTURE RECOVERY:
The system automatically detects when Redis project data is lost (restart, eviction, etc.)
and recovers it before COT analysis runs. It first tries to restore from the saved
structure_analysis.json file on disk, and if that fails, re-runs the full analysis.
TPMS mapping is also recovered automatically. You can rely on project_structure being
available in context for legacy projects.

TPMS DATA ACCESS:
Do NOT dump all TPMS data to files. Instead, query TPMS tables on-demand via the tpms_fetch tool.
Use the TPMS Schema Instructions (provided in context) to know which table to query for what data.
Key pattern: ViewProjectMain (by OENUM) → get IDProjectMain → use it to filter other tables.

{tpms_instructions}

EMAIL PROCESSING WORKFLOW:
When an email is received for the project (via mail gateway):
1. The email content is automatically stored in the project's emails/ directory on 1.69
2. The email is committed to git automatically
3. Analyze the email content to understand what the sender needs (tool: llm)
4. If the email contains documents or requests, create appropriate tasks
5. Generate a response and send via email (tool: email)
6. Store a summary of the email interaction in memory (tool: memory_store)

RESEARCH WORKFLOW:
When user asks about external topics or needs internet information:
1. Search the web (tool: web_search)
2. Analyze search results (tool: llm)
3. Store useful findings in memory (tool: memory_store)

EXPORT WORKFLOW:
When user requests a report, spreadsheet, or document:
1. Gather data from memory/analysis (tool: memory_query)
2. Generate export file (tool: file_export)
3. Commit to git (tool: git)

For each step, specify:
1. A clear title (what to do)
2. Description (how to do it)
3. Task type: action, query, analysis, generation, review, shell_command, email
4. Which tool to use
5. Tool input (specific parameters)
6. Dependencies (which previous steps must complete first)
7. Priority (1-10, higher = more important)

IMPORTANT RULES:
- Break complex requests into small, atomic steps
- Each step should do ONE thing
- Always start with a query/analysis step to gather context
- End with a summary/response step
- Keep the plan practical and executable
- ALWAYS commit to git after ANY file modification with a descriptive message (e.g., "Add uploaded doc: X", "Update panel specs", "Import techserver files")
- Use git diff/log tools to inspect previous work before making changes
- All uploaded documents (chatbot or email) must be stored in the project's documents/ directory on 1.69
- For TPMS data, query tables on-demand via tpms_fetch — do NOT store raw TPMS dumps
- Maximum {max_tasks} steps

Respond with ONLY valid JSON in this exact format:
{{
    "reasoning": "Your analysis of the request and why you chose these steps",
    "steps": [
        {{
            "step_number": 1,
            "title": "Step title",
            "description": "What this step does and how",
            "task_type": "query",
            "tool_needed": "memory_query",
            "tool_input": {{"query": "specific query"}},
            "depends_on": [],
            "priority": 8,
            "estimated_duration": "5s"
        }}
    ],
    "estimated_total_duration": "30s"
}}"""


# Fallback tool list when MCP is not connected
_FALLBACK_MCP_TOOLS = """You also have access to these microservice tools:
- web_search: Search the internet using DuckDuckGo. Input: {{"query": "search query", "max_results": 5}}
- web_search_news: Search recent news. Input: {{"query": "search query", "max_results": 5}}
- tpms_fetch: Fetch project data from TPMS database by OENUM. Input: {{"oenum": "12345"}}
- tpms_get_text: Get project data as readable text by OENUM. Input: {{"oenum": "12345"}}
- project_init: Initialize a new project workspace (git, dirs, TPMS data). Input: {{"project_name": "name", "oenum": "optional"}}
- project_analyze: Analyze project workspace structure and contents. Input: {{"depth": "medium"}}
- command_generate: Generate safe shell commands from task description. Input: {{"task_description": "what to do", "task_type": "search|file_ops|analysis|git"}}
- command_validate: Validate if a shell command is safe. Input: {{"command": "the command"}}
- export_excel: Generate Excel file. Input: {{"project_id": "id", "title": "Title", "tables": "[...]"}}
- export_word: Generate Word document. Input: {{"project_id": "id", "title": "Title", "sections": "[...]"}}
- export_pdf: Generate PDF report. Input: {{"project_id": "id", "title": "Title", "content": "text"}}
- eplan_draw: Trigger EPLAN drawing generation. Input: {{"project_name": "name", "eplan_data": "[...]"}}
- eplan_resolve_port: Find available EPLAN server port. Input: {{"username": "agent"}}
- sld_analyze: Analyze a Single Line Diagram (SLD) image/PDF using GPT-4o vision. Returns structured JSON with CBs, feeders, transformers, ratings. Input: {{"document_id": "doc-uuid", "filename": "sld.pdf"}}
- techserver_sync: Copy project files from techserver (192.168.1.3) via SMB to workspace. For legacy users only. Input: {{"oenum": "12345"}}"""


class COTEngine:
    """Chain of Thoughts engine for analyzing requests and generating task plans."""

    def __init__(self, llm_service=None):
        self.llm_service = llm_service
        self.mcp_manager = None

    def set_llm_service(self, llm_service):
        self.llm_service = llm_service

    def set_mcp_manager(self, mcp_manager):
        self.mcp_manager = mcp_manager

    async def analyze(
        self,
        request: COTRequest,
        project_context: Dict[str, Any],
        instructions: List[Dict[str, Any]] = None,
    ) -> COTAnalysis:
        """
        Analyze a user request and generate a structured task plan.

        Args:
            request: The COT request with user input and context
            project_context: Current project state (name, status, recent messages, etc.)
            instructions: Project instructions/workflow steps

        Returns:
            COTAnalysis with reasoning and task steps
        """
        chain_id = uuid.uuid4()

        # Build context for LLM
        context_parts = []

        # Project info
        context_parts.append(f"Project: {project_context.get('name', 'Unknown')}")
        context_parts.append(f"Status: {project_context.get('status', 'active')}")

        if project_context.get('description'):
            context_parts.append(f"Description: {project_context['description']}")

        # Project instructions
        if instructions:
            context_parts.append("\nProject Instructions/Workflow:")
            for inst in instructions:
                context_parts.append(
                    f"  Step {inst.get('step_number', '?')}: {inst.get('title', '')} "
                    f"- {inst.get('content', '')} [Stage: {inst.get('stage', 'general')}]"
                )

        # Recent context
        if project_context.get('recent_messages'):
            context_parts.append("\nRecent conversation:")
            for msg in project_context['recent_messages'][-5:]:
                role = msg.get('role', 'user')
                content = msg.get('content', '')[:200]
                context_parts.append(f"  [{role}]: {content}")

        # Input channel
        context_parts.append(f"\nInput channel: {request.channel.value}")
        if request.email_subject:
            context_parts.append(f"Email subject: {request.email_subject}")
        if request.email_from:
            context_parts.append(f"Email from: {request.email_from}")
        if request.document_id:
            context_parts.append(f"Document attached: {request.document_id}")

        context_str = "\n".join(context_parts)

        # Build dynamic tool list from MCP or use fallback
        if self.mcp_manager and self.mcp_manager.is_connected:
            mcp_tool_lines = self.mcp_manager.get_tools_for_cot()
            mcp_tools = f"You also have access to these microservice tools (via MCP):\n{mcp_tool_lines}"
        else:
            mcp_tools = _FALLBACK_MCP_TOOLS

        # Inject EKC knowledge context if available
        ekc_knowledge_str = project_context.get("ekc_knowledge", "")
        if ekc_knowledge_str:
            context_parts.append(f"\nEKC Knowledge Base:\n{ekc_knowledge_str[:3000]}")

        # Build messages for LLM
        tpms_instructions = get_tpms_instructions()
        system_prompt = COT_SYSTEM_PROMPT.format(
            max_tasks=request.max_tasks,
            mcp_tools=mcp_tools,
            tpms_instructions=tpms_instructions,
        )

        # Admin-managed restrictions file: free-text constraints that an
        # admin / developer can drop into RESTRICTIONS_PATH and that the
        # agent treats as hard rules on the final response. mtime-cached
        # so the I/O is cheap on the hot path.
        restrictions = _read_restrictions()
        if restrictions:
            system_prompt = (
                "# HARD CONSTRAINTS (admin-managed restrictions — these "
                "OVERRIDE everything else):\n"
                f"{restrictions}\n\n# AGENT INSTRUCTIONS:\n"
                f"{system_prompt}"
            )

        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": f"Project Context:\n{context_str}\n\nUser Request:\n{request.user_input}"}
        ]

        try:
            # Call LLM for analysis
            if self.llm_service:
                response = await self._call_llm(messages)
            else:
                # Fallback: simple task generation without LLM
                response = self._generate_simple_plan(request)

            # Parse LLM response
            analysis = self._parse_llm_response(response, chain_id, request)
            logger.info(
                f"COT analysis complete: chain={chain_id}, "
                f"steps={len(analysis.steps)}, project={request.project_id}"
            )
            # Fire-and-forget: ship the trace to context-search so future
            # CoT runs can recall it via search_past_cot.
            await _ship_cot_trace(analysis, success=True)
            return analysis

        except Exception as e:
            logger.error(f"COT analysis failed: {e}", exc_info=True)
            # Return a minimal plan on failure
            fallback = COTAnalysis(
                chain_id=chain_id,
                project_id=request.project_id,
                user_input=request.user_input,
                reasoning=f"COT analysis encountered an error: {str(e)}. Falling back to direct response.",
                steps=[
                    COTStep(
                        step_number=1,
                        title="Direct response",
                        description="Respond directly to the user request using LLM",
                        task_type=TaskType.GENERATION,
                        tool_needed="llm",
                        tool_input={"prompt": request.user_input},
                        depends_on=[],
                        priority=5,
                    )
                ],
                total_steps=1,
            )
            await _ship_cot_trace(fallback, success=False)
            return fallback

    async def _call_llm(self, messages: List[Dict[str, str]]) -> str:
        """Call the LLM service for COT analysis."""
        try:
            # Try async generation first
            if hasattr(self.llm_service, 'async_generate'):
                result = await self.llm_service.async_generate(
                    messages=messages,
                    user_id="system_cot_engine",
                    temperature=0.3,  # Low temp for structured output
                )
                return result.get('response', '') if isinstance(result, dict) else str(result)
            else:
                result = self.llm_service.generate(
                    messages=messages,
                    temperature=0.3,
                )
                return result.get('response', '') if isinstance(result, dict) else str(result)
        except Exception as e:
            logger.error(f"LLM call failed in COT engine: {e}")
            raise

    def _parse_llm_response(
        self, response: str, chain_id: uuid.UUID, request: COTRequest
    ) -> COTAnalysis:
        """Parse LLM JSON response into COTAnalysis."""
        # Extract JSON from response (handle markdown code blocks)
        json_str = response.strip()
        if json_str.startswith("```"):
            # Remove markdown code block
            lines = json_str.split("\n")
            json_lines = []
            in_block = False
            for line in lines:
                if line.startswith("```") and not in_block:
                    in_block = True
                    continue
                elif line.startswith("```") and in_block:
                    break
                elif in_block:
                    json_lines.append(line)
            json_str = "\n".join(json_lines)

        try:
            data = json.loads(json_str)
        except json.JSONDecodeError:
            # Try to find JSON object in the response
            start = response.find("{")
            end = response.rfind("}") + 1
            if start >= 0 and end > start:
                try:
                    data = json.loads(response[start:end])
                except json.JSONDecodeError:
                    logger.warning("Failed to parse COT LLM response as JSON")
                    data = {
                        "reasoning": "Failed to parse structured plan. Falling back to direct response.",
                        "steps": [{
                            "step_number": 1,
                            "title": "Direct response",
                            "description": "Respond directly using LLM",
                            "task_type": "generation",
                            "tool_needed": "llm",
                            "tool_input": {"prompt": request.user_input},
                            "depends_on": [],
                            "priority": 5,
                        }]
                    }

        steps = []
        for step_data in data.get("steps", []):
            # Map task_type string to enum
            task_type_str = step_data.get("task_type", "action")
            try:
                task_type = TaskType(task_type_str)
            except ValueError:
                task_type = TaskType.ACTION

            steps.append(COTStep(
                step_number=step_data.get("step_number", len(steps) + 1),
                title=step_data.get("title", "Untitled step"),
                description=step_data.get("description", ""),
                task_type=task_type,
                tool_needed=step_data.get("tool_needed"),
                tool_input=step_data.get("tool_input"),
                depends_on=step_data.get("depends_on", []),
                priority=step_data.get("priority", 5),
                estimated_duration=step_data.get("estimated_duration"),
            ))

        return COTAnalysis(
            chain_id=chain_id,
            project_id=request.project_id,
            user_input=request.user_input,
            reasoning=data.get("reasoning", "No reasoning provided"),
            steps=steps,
            total_steps=len(steps),
            estimated_total_duration=data.get("estimated_total_duration"),
        )

    def _generate_simple_plan(self, request: COTRequest) -> str:
        """Generate a simple plan without LLM (fallback)."""
        steps = [
            {
                "step_number": 1,
                "title": "Analyze request",
                "description": f"Analyze the user request: {request.user_input[:100]}",
                "task_type": "analysis",
                "tool_needed": "llm",
                "tool_input": {"prompt": request.user_input},
                "depends_on": [],
                "priority": 8,
            },
            {
                "step_number": 2,
                "title": "Query project memory",
                "description": "Search project memory for relevant context",
                "task_type": "query",
                "tool_needed": "memory_query",
                "tool_input": {"query": request.user_input},
                "depends_on": [1],
                "priority": 7,
            },
            {
                "step_number": 3,
                "title": "Generate response",
                "description": "Generate a response based on analysis and memory context",
                "task_type": "generation",
                "tool_needed": "llm",
                "tool_input": {"prompt": request.user_input, "use_context": True},
                "depends_on": [1, 2],
                "priority": 6,
            },
        ]

        return json.dumps({
            "reasoning": "Simple fallback plan: analyze, gather context, respond.",
            "steps": steps,
            "estimated_total_duration": "15s",
        })

    def cot_steps_to_tasks(
        self,
        analysis: COTAnalysis,
        project_id: uuid.UUID,
        triggered_by: TaskTrigger = TaskTrigger.USER,
    ) -> List[TaskCreate]:
        """Convert COT analysis steps into TaskCreate objects."""
        tasks = []
        for step in analysis.steps:
            tasks.append(TaskCreate(
                title=step.title,
                description=step.description,
                task_type=step.task_type,
                cot_chain_id=analysis.chain_id,
                priority=step.priority,
                tool_used=step.tool_needed,
                tool_input=step.tool_input,
                sort_order=step.step_number,
                triggered_by=triggered_by,
            ))
        return tasks


# Singleton
_cot_engine: Optional[COTEngine] = None


def get_cot_engine() -> COTEngine:
    global _cot_engine
    if _cot_engine is None:
        _cot_engine = COTEngine()
    return _cot_engine
