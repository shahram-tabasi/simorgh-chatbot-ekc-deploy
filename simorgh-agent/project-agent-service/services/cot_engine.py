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
# JSON Schema for the COT plan. Passed to llm-gateway as guided_json so
# gpt-oss-20b's output is constrained to a valid plan at decode time —
# this is what lets us run CoT on the fast LLM instead of the 7B VLM.
COT_PLAN_SCHEMA: Dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["reasoning", "steps"],
    "properties": {
        "reasoning": {"type": "string"},
        "estimated_total_duration": {"type": "string"},
        "steps": {
            "type": "array",
            "minItems": 1,
            "items": {
                "type": "object",
                "additionalProperties": True,
                "required": [
                    "step_number", "title", "description",
                    "task_type", "tool_needed",
                ],
                "properties": {
                    "step_number": {"type": "integer", "minimum": 1},
                    "title": {"type": "string"},
                    "description": {"type": "string"},
                    "task_type": {
                        "type": "string",
                        "enum": [
                            "action", "query", "analysis", "generation",
                            "review", "shell_command", "email",
                        ],
                    },
                    "tool_needed": {"type": "string"},
                    "tool_input": {"type": "object"},
                    "depends_on": {
                        "type": "array",
                        "items": {"type": "integer"},
                    },
                    "priority": {"type": "integer", "minimum": 1, "maximum": 10},
                    "estimated_duration": {"type": "string"},
                },
            },
        },
    },
}


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

REPO ARTIFACT READS — IMPORTANT:
Files inside the user's GitLab repo (PDFs, Word, Excel, images, source code, anything)
are read with `gitlab_mcp.read_artifact_mcp(project, path, ref?)`. This tool always
returns utf-8 markdown:
  • text files → raw contents (same as read_file_mcp)
  • PDF / Office / image → markdown that doc-processor extracted at ingest time and
    cached under .simorgh/extracted/<path>.md, OR re-extracted on demand if the
    cache is missing.

DO NOT ask the user to upload a file that already exists in their repo. If the user
references a filename you saw via get_project_tree (e.g. "analyse HCS-DD-EL-SP-003.pdf"),
the right plan is:
  1. gitlab_mcp.read_artifact_mcp(project=<repo>, path="HCS-DD-EL-SP-003.pdf")
  2. llm.generate(prompt="…analyse this content…", context=<markdown returned in step 1>)
  3. (optional) memory_store / semantic_store the extracted markdown for future queries.

Prefer read_artifact_mcp over read_file_mcp whenever you are not certain the file is
plain text — read_file_mcp returns base64 for binaries, which you cannot reason on.

KEEP PLANS MINIMAL — RULES THAT MUST NOT BE BROKEN:
  • For "what's in my repo / project / files" listing questions: ONE step is enough
    — get_project_tree. Do NOT add a follow-up read step. The tree already lists
    everything; the model writes the answer from that.
  • Never call read_artifact_mcp or read_file_mcp without a specific filename you
    saw in a previous step. Passing path="/", path="", path="*" always 404s.
  • Never plan more than 3 steps for a yes/no, summary, or "what is X" question.
    Extra steps cost real time on gpt-oss; each one is ~10–20s. Brevity wins.

DOCUMENT PROCESSING WORKFLOW (uploads only — when a NEW file lands via chat or email):
When a document arrives via the chatbot upload affordance or email attachment (NOT
already in the user's GitLab repo), create tasks in this order:
1. Save the document to project workspace: documents/<filename> (tool: shell)
2. Process/convert document content to clean markdown (tool: document_process)
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

PROJECT CONTEXT GATHERING (use this pattern for ANY question about a specific project):

  1. RESOLVE the project — if the user references it loosely (name, customer,
     description), call `context_search.search_projects_mcp(query)` first to
     get the oenum. If they gave you the oenum directly, skip this step.

  2. PROCEDURAL MEMORY — call `context_search.search_past_cot(query)` to see
     if you (or another agent) have already solved a similar problem.
     Reuse the working pattern, learn from any failures. This is OPTIONAL
     for trivial questions but HIGH VALUE for complex analytical ones.

  3. STRUCTURED TPMS CONTEXT — call
     `tpms_context_agent.get_project_context(oenum, sections=[...])` with
     ONLY the sections you need (panels, feeders, customer_specs, scopes).
     This renders markdown blocks ready to drop into your reasoning. Do
     NOT dump the whole project.

  4. ENGINEERING ARTEFACTS — if you need files/schematics/BOM, call
     `gitlab_mcp.list_projects_mcp(group="simorgh-projects", search_term=oenum)`
     to find the repo, then `gitlab_mcp.get_project_tree(...)` to find files,
     then `gitlab_mcp.read_file_mcp(project, path)` to read what matters.

  5. CROSS-CUTTING KNOWLEDGE — if you need standards / wiring rules /
     glossaries that apply across projects, call
     `gitlab_mcp.search_technical_knowledge(query)`. Do not duplicate
     this into per-project repos.

  6. ANALYTICAL QUESTIONS — for "how many", "distribution of", "average",
     "p95", "top N", "trend over time" questions, call
     `context_search.aggregate_field(index='projects'|'cot'|'logs', ...)`
     or `context_search.time_series_query(...)`. NEVER retrieve N documents
     and count them in the prompt — let Elasticsearch do the math.

CANONICAL EXAMPLE — "Switch ABC plant 6.6kV to 3.3kV — blast radius?":
   Step 1: search_projects_mcp("ABC plant 6.6kV")        → oenum
   Step 2: search_past_cot("voltage change mid-project") → checklist from prior work
   Step 3: get_project_context(oenum, sections=["panels","feeders","customer_specs"])
   Step 4: get_project_tree(project=oenum/repo, path="schematics")
           + read_file_mcp(... "SLD-main.json")
   Step 5: search_technical_knowledge("6kV to 3.3kV conversion checklist")
   Step 6: aggregate_field(index="projects", group_by="motor_type",
                           filter_query=f"oenum:{{oenum}}")
   Step 7: Synthesize answer with citations.

The reasoning trace is auto-indexed at the end so future runs benefit
from it — you do not need to explicitly call index_cot_trace.

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
        # The project_id is required by many MCP tools as their first
        # positional argument. Without injecting it here the planner
        # emits placeholders like "unknown" and tool calls fail.
        context_parts.append(f"project_id: {request.project_id}")
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

        # NOTE: context_str is joined further down, after the EKC and
        # sources_enabled blocks have appended their guardrails. Joining
        # it here would silently drop those guardrails from the prompt.

        # Build dynamic tool list from MCP or use fallback
        if self.mcp_manager and self.mcp_manager.is_connected:
            mcp_tool_lines = self.mcp_manager.get_tools_for_cot()
            mcp_tools = f"You also have access to these microservice tools (via MCP):\n{mcp_tool_lines}"
        else:
            mcp_tools = _FALLBACK_MCP_TOOLS

        # Inject EKC knowledge context only if the project ticked the EKC
        # source at creation time. Without that flag the project is
        # grounded by the user's own GitLab repo + uploads only — we must
        # NOT leak EKC-derived electrical-domain priors into the prompt.
        # sources_enabled may live at the top level (when callers spread
        # the project dict) or nested under `project` (build_agent_context).
        sources_enabled = (
            project_context.get("sources_enabled")
            or (project_context.get("project") or {}).get("sources_enabled")
            or {}
        )
        # Legacy projects predating the wizard have no sources_enabled at
        # all — default to "EKC on" for backward compatibility.
        ekc_allowed = (not sources_enabled) or bool(sources_enabled.get("ekc"))
        if ekc_allowed:
            ekc_knowledge_str = project_context.get("ekc_knowledge", "")
            if ekc_knowledge_str:
                context_parts.append(
                    f"\nEKC Knowledge Base:\n{ekc_knowledge_str[:3000]}"
                )
        else:
            context_parts.append(
                "\nGrounding scope: USER REPO ONLY. The user did not tick "
                "ekc-technical-knowledge for this project, so do NOT use "
                "gitlab_mcp.search_technical_knowledge or any EKC-derived "
                "electrical-domain assumptions. Answer strictly from the "
                "user's selected GitLab repository and uploaded documents."
            )

        # Source-aware planner guardrails. The CoT system prompt baked in
        # a TPMS-first workflow; if the user didn't tick tpms / techserver
        # at project creation we MUST NOT plan steps against those tools.
        # Likewise, when the user picked a GitLab repo the planner should
        # default to gitlab_mcp.get_project_tree / read_artifact_mcp.
        if sources_enabled:
            allowed_lines = ["\nAllowed data sources for THIS project "
                             "(do not plan steps against any other):"]
            if sources_enabled.get("gitlab"):
                repo = (project_context.get("gitlab_repo_path")
                        or (project_context.get("project") or {})
                            .get("gitlab_repo_path"))
                branch = (project_context.get("simorgh_branch")
                          or (project_context.get("project") or {})
                              .get("simorgh_branch"))
                allowed_lines.append(
                    f"  - gitlab_mcp on repo `{repo or '(see project)'}`"
                    f" branch `{branch or 'simorgh/*'}`. For "
                    "\"what's in my repository\"-class questions, CALL "
                    "gitlab_mcp.get_project_tree(project=repo) first, "
                    "then gitlab_mcp.read_artifact_mcp(project=repo, path=...) "
                    "for any file the user asks about (it returns markdown "
                    "for PDFs / Office / images too — never ask the user to "
                    "re-upload a file that's already in their repo). "
                    "Do NOT call project_analyze unless the user explicitly "
                    "asks for a workspace-wide audit."
                )
            if sources_enabled.get("tpms"):
                allowed_lines.append(
                    "  - tpms_context_agent / tpms_fetcher — only when the "
                    "question is about TPMS project records (oenum, panels, "
                    "feeders, scopes)."
                )
            else:
                allowed_lines.append(
                    "  - TPMS is DISABLED for this project. DO NOT call "
                    "tpms_fetch, tpms_get_text, or tpms_context_agent. "
                    "Ignore the TPMS schema instructions below."
                )
            if sources_enabled.get("techserver"):
                allowed_lines.append(
                    "  - techserver_sync — for SMB-mounted project files."
                )
            else:
                allowed_lines.append(
                    "  - techserver is DISABLED — do NOT call techserver_sync."
                )
            if sources_enabled.get("upload"):
                allowed_lines.append(
                    "  - documents_rag / uploaded files."
                )
            context_parts.append("\n".join(allowed_lines))

        # Now that every guardrail block has been appended, freeze the
        # user-side context.
        context_str = "\n".join(context_parts)

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
        """Call the LLM service for COT analysis.

        Routing precedence (post-Harmony-migration):
          1. ``LLM_GATEWAY_URL`` + tools=[submit_plan] — preferred.
             gpt-oss-20b on .61 (vLLM serve mode with the openai
             tool-call parser) emits a Harmony tool_call to
             ``submit_plan(plan=...)``; we extract the plan JSON
             from ``tool_calls[0].function.arguments``. This is
             what the harmony-test container proved works correctly:
             multi-step plans with the right tools, in ~1 second.
          2. ``COT_LLM_BASE_URL`` — typically Qwen2.5-VL-7B on .62.
             Kept as a fallback so the planner still works if the
             local LLM box is down or if its Harmony surface
             regresses.
          3. ``LLM_GATEWAY_URL`` + guided_json — legacy gateway
             path. Produces degenerate plans for gpt-oss; kept only
             as a last resort.
          4. ``self.llm_service`` — generic legacy path.
        """
        gateway_url = os.getenv("LLM_GATEWAY_URL", "").strip().rstrip("/")
        if gateway_url:
            try:
                return await self._call_llm_harmony_tools(gateway_url, messages)
            except Exception as e:
                logger.warning(
                    "CoT planner via Harmony tools (%s) failed: %s; "
                    "falling back to VLM planner",
                    gateway_url, e,
                )

        cot_base_url = os.getenv("COT_LLM_BASE_URL", "").strip()
        if cot_base_url:
            try:
                return await self._call_llm_openai_compat(
                    messages, base_url=cot_base_url,
                    model=os.getenv("COT_LLM_MODEL", "qwen2.5-vl-7b"),
                )
            except Exception as e:
                logger.warning(
                    f"CoT planner via {cot_base_url} failed: {e}; "
                    "falling back to gateway guided_json"
                )

        if gateway_url:
            try:
                return await self._call_llm_gateway_structured(gateway_url, messages)
            except Exception as e:
                logger.warning(
                    "CoT planner via gateway guided_json (%s) failed: %s; "
                    "falling back to default llm_service",
                    gateway_url, e,
                )

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

    async def _call_llm_harmony_tools(
        self, gateway_url: str, messages: List[Dict[str, str]],
    ) -> str:
        """Plan via Harmony tool calling on gpt-oss-20b.

        Routes through llm-gateway to the LLM box's vLLM serve, which
        runs with `--tool-call-parser openai` so the model emits
        Harmony-native tool_calls in the response. We define a single
        `submit_plan` tool whose `parameters` schema IS the
        ``COT_PLAN_SCHEMA``; the model fills it in one shot.

        Output: the JSON-encoded plan, returned as a string so the
        existing ``_parse_llm_response`` keeps working unchanged.
        """
        import httpx
        timeout = float(os.getenv("LLM_GATEWAY_COT_TIMEOUT_SEC", "180"))

        submit_plan_tool = {
            "type": "function",
            "function": {
                "name": "submit_plan",
                "description": (
                    "Submit your chain-of-thought plan as a JSON object "
                    "with `reasoning` (one paragraph explaining the "
                    "approach) and `steps` (an array of concrete task "
                    "steps, each with step_number, title, description, "
                    "task_type, tool_needed, tool_input, depends_on, "
                    "and optionally priority and estimated_duration). "
                    "Call this tool exactly once with the complete plan."
                ),
                "parameters": COT_PLAN_SCHEMA,
            },
        }

        payload = {
            "messages":      messages,
            "mode":          "offline",
            "force_backend": "text",
            "temperature":   0.3,
            "max_tokens":    int(os.getenv("COT_LLM_MAX_TOKENS", "2048")),
            "tools":         [submit_plan_tool],
            # Force the model to call submit_plan rather than producing
            # free-form text. vLLM's openai parser honours this.
            "tool_choice":   {
                "type": "function",
                "function": {"name": "submit_plan"},
            },
        }

        async with httpx.AsyncClient(timeout=timeout) as client:
            r = await client.post(f"{gateway_url}/generate", json=payload)
            r.raise_for_status()
            body = r.json()

        tool_calls = body.get("tool_calls") or []
        if not tool_calls:
            # gpt-oss didn't tool-call — possibly the gateway is on an
            # old version that strips them, or the model returned plain
            # text. Surface whatever content came back; _parse_llm_response
            # will JSON-extract or fall back to a direct response.
            return body.get("response") or ""

        # tool_calls[0].function.arguments IS the plan JSON (as a string).
        # Return it directly; _parse_llm_response handles JSON decode.
        args = tool_calls[0].get("function", {}).get("arguments") or ""
        return args if isinstance(args, str) else json.dumps(args)

    async def _call_llm_openai_compat(
        self, messages: List[Dict[str, str]], *, base_url: str, model: str
    ) -> str:
        """POST OpenAI-format chat/completions to base_url. Used for the
        VLM-hosted planner (qwen2.5-vl-7b on 192.168.1.62 via nginx)."""
        import httpx
        url = f"{base_url.rstrip('/')}/chat/completions"
        payload = {
            "model": model,
            "messages": messages,
            "temperature": 0.2,
            "max_tokens": int(os.getenv("COT_LLM_MAX_TOKENS", "2048")),
            "stream": False,
        }
        async with httpx.AsyncClient(timeout=120) as c:
            r = await c.post(url, json=payload)
            r.raise_for_status()
            data = r.json()
        return data["choices"][0]["message"]["content"]

    async def _call_llm_gateway_structured(
        self, gateway_url: str, messages: List[Dict[str, str]],
    ) -> str:
        """POST to llm-gateway pinned to the text backend with a JSON
        schema. gpt-oss-20b's vLLM build enforces the schema at decode
        time so the response is guaranteed-parseable JSON — no
        retries, no markdown-fence stripping. Runs on .61 (faster
        than the 7B VLM) without sacrificing structured-output
        reliability."""
        import httpx
        timeout = float(os.getenv("LLM_GATEWAY_COT_TIMEOUT_SEC", "180"))
        payload = {
            "messages": messages,
            "mode": "offline",
            "force_backend": "text",
            "temperature": 0.3,
            "max_tokens": int(os.getenv("COT_LLM_MAX_TOKENS", "2048")),
            "extra": {
                "guided_json": COT_PLAN_SCHEMA,
                "response_format": {"type": "json_object"},
            },
        }
        async with httpx.AsyncClient(timeout=timeout) as c:
            r = await c.post(f"{gateway_url}/generate", json=payload)
            r.raise_for_status()
            body = r.json()
        return body.get("response", "") or ""

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
            # Default to a fallback plan so `data` is always bound, even if
            # neither the json_str parse nor the find-the-braces fallback
            # below succeed.
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
            # Try to find JSON object in the response
            start = response.find("{")
            end = response.rfind("}") + 1
            if start >= 0 and end > start:
                try:
                    data = json.loads(response[start:end])
                except json.JSONDecodeError:
                    logger.warning("Failed to parse COT LLM response as JSON")

        steps = []
        # Map step titles → numbers so we can coerce Qwen-style
        # depends_on=["query tpms"] references into real step indices.
        title_to_num: dict[str, int] = {}
        for s in data.get("steps", []):
            t = (s.get("title") or "").strip().lower()
            n = s.get("step_number")
            if t and isinstance(n, int):
                title_to_num[t] = n

        for step_data in data.get("steps", []):
            # Map task_type string to enum
            task_type_str = step_data.get("task_type", "action")
            try:
                task_type = TaskType(task_type_str)
            except ValueError:
                task_type = TaskType.ACTION

            # depends_on must be list[int]. The planner sometimes emits
            # step titles instead — resolve via the title→number map,
            # drop anything we can't coerce.
            raw_deps = step_data.get("depends_on") or []
            clean_deps: list[int] = []
            for d in raw_deps:
                if isinstance(d, int):
                    clean_deps.append(d)
                elif isinstance(d, str):
                    if d.isdigit():
                        clean_deps.append(int(d))
                    else:
                        n = title_to_num.get(d.strip().lower())
                        if n is not None:
                            clean_deps.append(n)

            steps.append(COTStep(
                step_number=step_data.get("step_number", len(steps) + 1),
                title=step_data.get("title", "Untitled step"),
                description=step_data.get("description", ""),
                task_type=task_type,
                tool_needed=step_data.get("tool_needed"),
                tool_input=step_data.get("tool_input"),
                depends_on=clean_deps,
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
