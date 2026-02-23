"""
COT (Chain of Thoughts) Engine
===============================
Analyzes user requests and generates structured TODO task lists.
Uses LLM to reason about the request in context of project instructions,
then produces executable task steps.
"""

import json
import logging
import uuid
from datetime import datetime
from typing import List, Optional, Dict, Any, Tuple

from models.project_models import (
    COTAnalysis, COTStep, COTRequest, TaskType,
    TaskCreate, TaskTrigger, TaskStatus
)

logger = logging.getLogger(__name__)

# System prompt for COT analysis
COT_SYSTEM_PROMPT = """You are a Project Manager Agent analyzing a user request for a project.
Your job is to break down the request into concrete, executable task steps.

You have access to these tools:
- llm: Ask questions, generate text, analyze data, reason about problems
- shell: Execute Linux commands, run scripts, manage files in project workspace (on remote server 1.69)
- git: Version control operations (commit, diff, log) in project workspace
- memory_query: Search project memory (Redis cache, PostgreSQL data, Qdrant vectors, Neo4j graph)
- memory_store: Store data in project memory (graph entities, working memory)
- document_process: Process uploaded documents - convert to markdown, extract text
- semantic_store: Chunk text content and store in Qdrant for semantic search. Input: {{"content": "text to chunk and index", "document_id": "doc-uuid", "filename": "name.pdf"}}
- email: Send email responses
- web_search: Search the internet using DuckDuckGo. Input: {{"query": "search query", "max_results": 5}}
- tpms_fetch: Fetch project data from TPMS database by OENUM. Input: {{"oenum": "12345"}}
- project_init: Initialize a new project workspace (git, dirs, TPMS data). Input: {{"project_name": "name", "oenum": "optional"}}
- project_analyze: Analyze project workspace structure and contents. Input: {{"depth": "medium"}}
- command_gen: Generate safe shell commands from task description. Input: {{"task_description": "what to do", "task_type": "search|file_ops|analysis|git"}}
- file_export: Generate Excel/Word/PDF files. Input: {{"format": "excel|word|pdf", "title": "Report Title", "data": {{...}}}}
- eplan_draw: Trigger EPLAN drawing generation via TCP bridge. Input: {{"project_name": "name", "eplan_data": [...]}}

DOCUMENT PROCESSING WORKFLOW:
When a document is uploaded, create tasks in this order:
1. Process/convert document content to clean markdown (tool: llm, type: generation)
2. Save markdown to project workspace for version control (tool: shell, command: write to documents/filename.md)
3. Index content in semantic search for future queries (tool: semantic_store)
4. Commit document files to git (tool: git, operation: commit)

PROJECT ANALYSIS WORKFLOW:
When a new project is created or user asks to understand the project:
1. Fetch TPMS data if OENUM is available (tool: tpms_fetch)
2. Run project workspace analysis (tool: project_analyze)
3. Summarize findings (tool: llm)

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
- After shell/file operations, always commit to git
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


class COTEngine:
    """Chain of Thoughts engine for analyzing requests and generating task plans."""

    def __init__(self, llm_service=None):
        self.llm_service = llm_service

    def set_llm_service(self, llm_service):
        self.llm_service = llm_service

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

        # Build messages for LLM
        system_prompt = COT_SYSTEM_PROMPT.format(max_tasks=request.max_tasks)
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
            return analysis

        except Exception as e:
            logger.error(f"COT analysis failed: {e}", exc_info=True)
            # Return a minimal plan on failure
            return COTAnalysis(
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
