"""
react_engine.py — flag-gated ReAct agentic loop
================================================
An alternative to the static plan-and-execute engine. Instead of emitting
a full plan up front (which structurally cannot use a step's output in a
later step — the source of the <oenum> / <output_of_step_N> / document_id
bug class), this runs a Claude-Code-style loop:

    think → call ONE tool → OBSERVE its result → decide next → … → final

Because the model sees each tool result before choosing the next action,
it never has to guess a value it hasn't retrieved yet, and it adapts when
a step returns something unexpected.

Activated by env COT_ENGINE_MODE=react (default unset → existing engine).
Reuses verbatim:
  - agent._execute_single_task(...)  → all dispatcher enforcement
    (scope injection, tpms/upload remaps, gitlab canonicalisation, retries)
  - agent._notify_progress(...)      → identical SSE events to the UI
  - agent.mcp_manager.tool_schemas   → the available tools as function schemas
  - active_plan().gather_grounding() → the pre-loaded document/knowledge context
"""
from __future__ import annotations

import json
import logging
import os
import uuid
from typing import Any, Dict, List, Optional, Tuple

import httpx

logger = logging.getLogger(__name__)

MAX_STEPS = int(os.getenv("REACT_MAX_STEPS", "10"))
STEP_TIMEOUT = float(os.getenv("REACT_LLM_TIMEOUT_SEC", "90"))


REACT_SYSTEM_PROMPT = """You are Simorgh, an expert engineering assistant that solves the user's request by REASONING and ACTING in a loop.

HOW YOU WORK:
- Work ONE step at a time. Either call exactly ONE tool to gather information / take an action, OR give your FINAL answer when you have enough.
- After each tool call you WILL SEE its result before deciding the next step. So never guess a value you can obtain from a tool — call the tool, read the real result, then use it.
- NEVER emit placeholder strings as arguments (no "<oenum>", "<output_of_step_2>", "<repo>", "<id>"). Use real values you have actually seen.
- Be efficient: prefer the fewest steps that fully answer the question. You have at most {max_steps} steps.
- When you have enough information, STOP calling tools and write the final answer as normal text (no tool call). Ground every claim in what the tools returned; if the tools returned nothing, say so honestly — do not invent.

{source_rules}

DOCUMENT / FILE QUESTIONS:
- documents_rag.list_project_documents → see which uploaded files exist (filenames).
- documents_rag.read_document(filename="<exact attached name>") → full text of one file. To compare two files, read EACH by filename.
- documents_rag.search_project_documents(query="...") → find specific passages across files.
- The user's uploaded file content may already be provided in CONTEXT below — use it directly.

COMPUTE / VERIFY:
- shell(command="python3 -c '...'") runs Python in an isolated per-project sandbox. Use it to calculate, parse, cross-reference lists, or verify an idea before answering.

WEB:
- web_search(query="...") for current external information when the project's own data is insufficient.
"""


def _source_rules(project_context: Dict[str, Any], plan_ctx) -> str:
    """Compact allow/deny guidance mirroring the plan-and-execute source
    gating, so the loop reaches for the right tools for THIS project."""
    se = (project_context.get("sources_enabled")
          or (project_context.get("project") or {}).get("sources_enabled") or {})
    lines = ["ALLOWED DATA SOURCES FOR THIS PROJECT (do not use others):"]
    if se.get("gitlab"):
        repo = (project_context.get("gitlab_repo_path")
                or (project_context.get("project") or {}).get("gitlab_repo_path"))
        lines.append(f"- gitlab_mcp on repo `{repo or '(see project)'}` "
                     "(get_project_tree, read_artifact_mcp, search_blobs).")
    else:
        lines.append("- GitLab is DISABLED (no repo). Do NOT call get_project_tree / "
                     "read_artifact_mcp / search_blobs / search_context.")
    oe = getattr(plan_ctx, "tpms_oenum", None)
    if se.get("tpms"):
        lines.append(f"- tpms_context_agent.get_project_context(oenum=\"{oe or ''}\") "
                     "for TPMS records (panels, feeders, customer specs).")
    else:
        lines.append("- TPMS is DISABLED. Do NOT call get_project_context / tpms_fetch.")
    if se.get("techserver"):
        lines.append(f"- techserver_* tools with oenum=\"{getattr(plan_ctx,'techserver_oenum','') or ''}\".")
    else:
        lines.append("- techserver is DISABLED.")
    lines.append("- documents_rag (uploaded files) and web_search are always available.")
    return "\n".join(lines)


def _excluded_prefixes(project_context: Dict[str, Any]) -> List[str]:
    se = (project_context.get("sources_enabled")
          or (project_context.get("project") or {}).get("sources_enabled") or {})
    ex: List[str] = []
    if not se.get("tpms"):
        ex += ["tpms_", "get_project_context"]
    if not se.get("techserver"):
        ex += ["techserver_"]
    if not se.get("gitlab"):
        ex += ["get_project_tree", "read_artifact_mcp", "read_file_mcp",
               "search_blobs", "list_branches_mcp", "list_projects_mcp"]
    return ex


def _build_tools(mcp_manager, project_context: Dict[str, Any]) -> List[Dict[str, Any]]:
    """OpenAI-style function schemas from the live MCP tool registry,
    minus tools that can't apply to this project's sources."""
    ex = _excluded_prefixes(project_context)
    tools: List[Dict[str, Any]] = []
    schemas = getattr(mcp_manager, "tool_schemas", {}) or {}
    for name, tool in schemas.items():
        if any(name.startswith(p) for p in ex):
            continue
        params = getattr(tool, "inputSchema", None) or {"type": "object", "properties": {}}
        tools.append({
            "type": "function",
            "function": {
                "name": name,
                "description": (getattr(tool, "description", "") or "")[:400],
                "parameters": params,
            },
        })
    # Always offer a shell + web_search even if not in the registry snapshot.
    have = {t["function"]["name"] for t in tools}
    if "shell" not in have:
        tools.append({"type": "function", "function": {
            "name": "shell",
            "description": "Run a shell command (incl. python3) in the project's isolated sandbox.",
            "parameters": {"type": "object", "properties": {
                "command": {"type": "string"}}, "required": ["command"]}}})
    return tools


async def _llm_step(gateway_url: str, messages: List[Dict[str, Any]],
                    tools: List[Dict[str, Any]], mode: str
                    ) -> Tuple[Optional[str], Optional[Dict], str]:
    """One LLM turn. Returns (tool_name, tool_args, final_text).
    If the model calls a tool, final_text is "". If it answers, tool_name is None."""
    payload = {
        "messages": messages,
        "mode": mode,
        "force_backend": "text",
        "temperature": 0.3,
        "max_tokens": 4096,
        "tools": tools,
        "tool_choice": "auto",
    }
    async with httpx.AsyncClient(timeout=STEP_TIMEOUT) as c:
        r = await c.post(f"{gateway_url}/generate", json=payload)
        r.raise_for_status()
        body = r.json()
    tool_calls = body.get("tool_calls") or []
    if tool_calls:
        fn = tool_calls[0].get("function", {}) or {}
        name = fn.get("name")
        raw = fn.get("arguments")
        args: Dict[str, Any] = {}
        if isinstance(raw, str):
            try:
                args = json.loads(raw)
            except Exception:
                args = {}
        elif isinstance(raw, dict):
            args = raw
        return name, args, ""
    # No tool call → final answer text.
    return None, None, (body.get("response") or body.get("text") or "").strip()


async def react_loop(agent, project_id: str, cot_request, project_context: Dict[str, Any],
                     instructions: List, user_input: str,
                     llm_mode: Optional[str] = None) -> Dict[str, Any]:
    """Run the ReAct loop. Streams the same SSE events the UI already
    consumes, executes tools through the existing dispatcher, and returns
    handle_input's normal response dict so the caller is unchanged."""
    chain_id = str(uuid.uuid4())
    gateway_url = os.getenv("LLM_GATEWAY_URL")
    # Map the user's llm_mode to the gateway's offline(gpt-oss)/online(gpt-4o).
    mode = (llm_mode or os.getenv("DEFAULT_LLM_MODE", "online")).lower()
    if mode not in ("online", "offline"):
        mode = "offline" if mode in ("local", "gpt-oss") else "online"

    plan_ctx = getattr(agent, "_active_plan_ctx", None)

    # Grounding (reuses the upload document pre-load + knowledge layer).
    grounding_text = ""
    try:
        from services.cot_router import active_plan
        plan = active_plan()
        if plan is not None and plan_ctx is not None:
            g = await plan.gather_grounding(plan_ctx)
            rendered = g.render() if g else ""
            if rendered:
                grounding_text = "\n\n# CONTEXT (pre-loaded; prefer this before searching):\n" + rendered
    except Exception as e:
        logger.warning("react: grounding failed: %s", e)

    tools = _build_tools(agent.mcp_manager, project_context)
    system = REACT_SYSTEM_PROMPT.format(
        max_steps=MAX_STEPS,
        source_rules=_source_rules(project_context, plan_ctx),
    )
    proj_line = (f"Project: {project_context.get('name','')}  "
                 f"project_id: {project_id}")
    messages: List[Dict[str, Any]] = [
        {"role": "system", "content": system},
        {"role": "user",
         "content": f"{proj_line}{grounding_text}\n\nUser request:\n{user_input}"},
    ]

    await agent._notify_progress(project_id, "cot_complete", {
        "chain_id": chain_id, "reasoning": "ReAct loop", "total_steps": 0, "steps": [],
    })

    prev_results: Dict[str, Any] = {}
    steps: List[Dict[str, Any]] = []
    final_response = ""

    for i in range(1, MAX_STEPS + 1):
        if not gateway_url:
            final_response = "LLM gateway is not configured (LLM_GATEWAY_URL)."
            break
        try:
            tool_name, tool_args, final_text = await _llm_step(
                gateway_url, messages, tools, mode)
        except Exception as e:
            logger.error("react: llm step %d failed: %s", i, e)
            final_response = final_response or f"Reasoning step failed: {e}"
            break

        if not tool_name:
            final_response = final_text or "(no answer produced)"
            break

        # Stream the step to the UI.
        task_id = str(uuid.uuid4())
        title = f"{tool_name}"
        await agent._notify_progress(project_id, "task_executing", {
            "task_id": task_id, "task_title": title,
            "step": i, "total": MAX_STEPS,
            "progress_percent": int(i * 100 / MAX_STEPS),
        })

        task = {
            "id": task_id, "title": title, "description": "",
            "task_type": "shell_command" if tool_name in ("shell", "git") else "query",
            "tool_used": tool_name, "tool_input": tool_args or {},
            "sort_order": i,
        }
        try:
            result = await agent._execute_single_task(project_id, task, prev_results)
        except Exception as e:
            logger.error("react: tool %s failed: %s", tool_name, e)
            result = {"output": f"[tool {tool_name} failed: {e}]", "metadata": {}}

        output = (result or {}).get("output", "") or ""
        prev_results[str(i)] = result
        steps.append({"title": title, "tool": tool_name})

        await agent._notify_progress(project_id, "task_completed", {
            "task_id": task_id, "tool": tool_name,
            "output_preview": output[:200],
        })

        # Feed the observation back so the NEXT turn can use the real values.
        messages.append({"role": "assistant", "content": "",
                         "tool_calls": [{"id": task_id, "type": "function",
                                         "function": {"name": tool_name,
                                                      "arguments": json.dumps(tool_args or {})}}]})
        messages.append({"role": "tool", "tool_call_id": task_id,
                         "name": tool_name, "content": output[:6000]})
    else:
        # Hit the step cap without a final answer — make one last synthesis.
        try:
            messages.append({"role": "user",
                             "content": "Stop using tools. Give your best final answer now "
                                        "from what you have gathered above."})
            _, _, final_response = await _llm_step(gateway_url, messages, [], mode)
        except Exception as e:
            final_response = f"(reached step limit; synthesis failed: {e})"

    return {
        "response": final_response,
        "chain_id": chain_id,
        "reasoning": "react",
        "tasks_created": len(steps),
        "tasks": [{"id": str(uuid.uuid4()), "title": s["title"], "status": "completed"}
                  for s in steps],
        "execution_results": [{"status": "completed", "tool": s["tool"]} for s in steps],
        "commit": {},
    }
