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

from services.project_facts import (
    build_project_facts, resolve_sources_enabled, resolve_repo_path,
)
from services import run_state as _run_state
from services.agent_todos import (
    AgentTodos, get_store as _get_todos_store, clear_store as _clear_todos_store,
    TODOS_OPEN, TODOS_CLOSE,
)

logger = logging.getLogger(__name__)

MAX_STEPS = int(os.getenv("REACT_MAX_STEPS", "8"))
STEP_TIMEOUT = float(os.getenv("REACT_LLM_TIMEOUT_SEC", "90"))
# Char budget for the rolling transcript sent to the model each turn.
# gpt-oss = 16k tokens (~50k chars in/out). Keep the transcript well under
# that so accumulated tool outputs never overflow → no gateway 502s.
HISTORY_BUDGET = int(os.getenv("REACT_HISTORY_BUDGET_CHARS", "36000"))


def _extract_documents_text(messages: List[Dict[str, Any]]) -> str:
    """Pull the concatenated content from every <document_content>
    block in the pinned user message (messages[1]). Used by the
    grounding verifier as the source-of-truth corpus to check claims
    against. Returns '' when no <documents> envelope is present
    (verifier then no-ops)."""
    if not messages or len(messages) < 2:
        return ""
    user_content = messages[1].get("content") or ""
    if not isinstance(user_content, str) or "<document_content>" not in user_content:
        return ""
    import re as _re
    blocks = _re.findall(
        r"<document_content>(.*?)</document_content>",
        user_content, _re.DOTALL,
    )
    return "\n\n".join(blocks).strip()


def _trim_history(messages: List[Dict[str, Any]]) -> None:
    """Anthropic's clear_tool_results context-editing strategy adapted
    for the ReAct loop. Pins messages[0] (system, holds project_facts +
    todos block) and messages[1] (the original user request). Then
    sheds the OLDEST TOOL EXCHANGES BATCHWISE: one batch = one
    `assistant` message with tool_calls + the contiguous `tool` messages
    that carry their results. Dropping a batch atomically avoids
    leaving orphan tool messages with no matching tool_call_id (which
    breaks gpt-oss and a few OpenAI-compat gateways).

    Only after every tool-exchange batch from the oldest end has been
    dropped do we fall back to per-message trimming.

    Reference: https://platform.claude.com/docs/en/build-with-claude/
    context-editing — "tool result clearing" runtime strategy.
    """
    def _size() -> int:
        return sum(len(str(m.get("content") or "")) +
                   len(json.dumps(m.get("tool_calls") or "")) for m in messages)

    def _drop_oldest_batch() -> bool:
        # Find first non-pinned assistant message carrying tool_calls.
        i = 2
        while i < len(messages):
            m = messages[i]
            if m.get("role") == "assistant" and m.get("tool_calls"):
                break
            i += 1
        else:
            return False
        # Walk forward over the contiguous tool replies for this batch.
        j = i + 1
        while j < len(messages) and messages[j].get("role") == "tool":
            j += 1
        # Need to leave at least the most-recent batch intact, so refuse
        # to drop if removing [i:j] would leave 0 non-pinned messages.
        if j >= len(messages):
            return False
        del messages[i:j]
        return True

    while _size() > HISTORY_BUDGET and len(messages) > 4:
        if not _drop_oldest_batch():
            # No tool batch left to drop — fall back to per-message trim
            # from the oldest non-pinned index.
            if len(messages) > 4:
                del messages[2]
            else:
                break


REACT_SYSTEM_PROMPT = """You are Simorgh, an expert engineering assistant that solves the user's request by REASONING and ACTING in a loop.

<use_parallel_tool_calls>
For maximum efficiency, whenever you perform multiple independent operations, invoke all relevant tools simultaneously rather than sequentially. In a single assistant turn you may emit MULTIPLE tool_use blocks at once — the executor dispatches them in parallel via asyncio.gather and returns every result before your next turn. Use this whenever the next steps don't depend on each other (e.g. "list_project_documents + get_project_tree + techserver_get_tree" for a project-tree question; "read fileA + read fileB" to compare two files). Only sequence calls when a later call genuinely needs the prior call's output.
</use_parallel_tool_calls>

HOW YOU WORK:
- Work in one or more steps. In each step you may call ONE OR MORE INDEPENDENT tools (they will run in parallel), OR give your FINAL answer when you have enough.
- After each tool call you WILL SEE its result before deciding the next step. So never guess a value you can obtain from a tool — call the tool, read the real result, then use it.
- NEVER emit placeholder strings as arguments (no "<oenum>", "<output_of_step_2>", "<repo>", "<id>"). Use real values you have actually seen.
- Be efficient: prefer the fewest steps that fully answer the question. You have at most {max_steps} steps.
- When you have enough information, STOP calling tools and write the final answer as normal text (no tool call). Ground every claim in what the tools returned; if the tools returned nothing, say so honestly — do not invent.

PLANNING WITH todo_write (externalised state):
- For ANY multi-step request — fan-out across sources, HITL approval flow, dependent retrievals — your FIRST step SHOULD be `todo_write` with a list of todos covering the whole job. Each todo can declare `depends_on` (other todo ids that must reach 'done' first), so the chain is explicit.
- The current list is shown back to you each turn inside <todos immutable="true">…</todos> in the system prompt. Read it BEFORE every action — that's your plan, not the rolling chat history.
- As you complete each step, call `todo_write` again with the same `id` and `status:"done"` (and update `notes` with the key finding). When you start the next step, mark it `status:"in_progress"`. Only ONE todo should be in_progress at a time.
- If a step fails OR a precondition_blocked envelope tells you a prerequisite is missing, mark the affected todos `status:"blocked"` with `notes:` explaining why, then todo_write the prerequisite as a new pending item with the blocked todo's id in `depends_on`.
- For a single-tool one-shot answer (e.g. "what's the current OE?"), you do NOT need todos — just call the tool and answer.

DO-DON'T (HARD RULES):
- DON'T write shell commands, `find ...`, `grep ...`, code snippets, or "run this on your system" instructions as your answer. You are the agent. You have tools. USE them. Example: when the user asks "where is the spec directory?", the answer is the actual path you find via `gitlab_mcp.get_project_tree` / `techserver_get_tree`, NOT a tutorial on how to run `find -type d`.
- DON'T answer "I can't see / I don't have access" when you actually have a tool that can look. List your tools below — every one of them is something you can call right now.
- DON'T stop at the first empty result. If `list_project_documents` returns [] and the project also has TechServer / GitLab enabled, call those too BEFORE concluding "nothing in the project".
- WHEN A TOOL RETURNS EMPTY, your answer must be the precise "what I checked / what I found": e.g. "I searched the TechServer copy for OE 12065 — the folder is empty; uploads are also empty for this project; check the GitLab repo if one is linked." NOT "the file list is empty in the current view" (that sounds like you didn't try).

LISTING / EXPLORING THE PROJECT — fan-out pattern:
- "what's in my project" / "list files" / "list specs" / "show me the project tree" / "where is X" all mean: enumerate from EVERY enabled source, then synthesize.
  * uploads:    documents_rag.list_project_documents  (always-on; ALWAYS check this first)
  * techserver: techserver_get_tree                    (if techserver is in ALLOWED sources)
  * gitlab:     gitlab_mcp.get_project_tree            (if gitlab is in ALLOWED sources)
- Combine the results into ONE answer organised by source. Don't repeat the source label inside the bullets — group instead.

{source_rules}

DOCUMENT / FILE QUESTIONS — GROUNDING IS NON-NEGOTIABLE:
- The uploaded files' FULL CONTENT is usually already provided in the CONTEXT block below (origin: upload). READ IT THERE FIRST and answer directly — often you need NO tool calls at all.
- When the user mentions a specific filename, the system may have ALREADY pre-fetched its content for you in a `<documents>...<document index="N"><source>...</source><content_kind>extracted</content_kind><document_content>...</document_content></document>...</documents>` block, preceded by a "DOCUMENT-GROUNDED ANSWER CONTRACT" header. When that block is present:
    * FOLLOW THE CONTRACT TO THE LETTER. The contract is the user's instruction, not a suggestion.
    * Quote verbatim spans from the `<document_content>` first; cite `[doc=N, source=...]` after each quote.
    * Write your answer ONLY from the quoted spans. Every numeric value (V, kV, A, kA, Hz, °C, mm, s, %) and every standards reference (IEC/IEEE/ANSI/ISO) in your answer MUST appear VERBATIM in the documents — character-for-character.
    * Missing fields → "Not specified in the provided documents." NEVER substitute a textbook value.
    * Do NOT re-fetch a file that's already in the `<documents>` block — wasted turn.
- ABSOLUTE GROUNDING RULE: When you answer from a `<file>` block or a tool result, every concrete value you report (numbers with units like `kV`, `kA`, `A`, `Hz`; standards like `IEC 62271-2`; named parts; dates; addresses) MUST appear VERBATIM in that source text. Do not paraphrase a value into a "typical" or "textbook" value. Do not pattern-match to a similar-looking number from your training data.
- If the user asks for a specification (e.g. "rated voltage", "short-circuit current") and it is NOT present in the provided source, write EXACTLY: "not specified in the document" — and move on. Never substitute a guess. Reporting a plausible-but-fabricated number is a SERIOUS FAILURE worse than saying "unknown".
- When you state a value, attribute it to its source: e.g. "Short circuit withstand: 40 kA (3 sec) — from page 11 table". Vague phrasings like "approximately" or "around" are red flags that you're inventing.
- If the `<file>` block looks like metadata only (contains keys like `document_id`, `status`, `filename` and no real prose), treat it as EMPTY and call the right read tool — do NOT invent content as if you'd read the file.
- If `list_project_documents` / `read_document` returns empty/no-results AND the user mentioned a filename, the file lives in the GitLab REPO, not in uploads. Call `gitlab_mcp.read_artifact_mcp(project=<repo>, path="<filename>")` IMMEDIATELY — do NOT keep retrying the documents_rag path. Same logic for TechServer projects: call `techserver_read_artifact(oenum=<oe>, path="<filename>")`.
- If you've called the same tool twice and both returned empty, the dispatcher will refuse the third call and return a `precondition_blocked` envelope naming a different tool to try — follow it.
- NEVER use session_read_artifact_tool / workspace file tools to read uploads — uploaded files live in the document store, NOT the sandbox filesystem.
- To COMPARE/aggregate across files: get both files' text (from CONTEXT or read_document), then reason over them; optionally use shell+python to match/sort items precisely.

COMPUTE / VERIFY:
- shell(command="python3 -c '...'") runs Python in an isolated per-project sandbox. Use it to calculate, parse, cross-reference lists, or verify before answering.

WEB:
- web_search(query="...") for current external information when the project's own data is insufficient.

SIMORGH DESIGN SUITE (legacy users only) — HITL flow:
The Design Suite project is built from PROPOSALS. Extractors propose;
the user APPROVES; only then is the spec written. You are the gatekeeper.
When the user asks to CREATE / BUILD / SUBMIT / OPEN their project (incl.
Persian "پروژه سیمرغ دیزاین رو بساز"), follow this recipe:

  1. list_pending_proposals — see every value extractors proposed from
     uploads / TPMS / chat. Each entry has {{proposal_id, field, value,
     source_kind, source_note, confidence}}.
  2. REASON over them. For each pending proposal decide ONE of:
       a. clearly relevant + the value is right     → bundle into approvals
          with action="approve"
       b. clearly irrelevant (e.g. extracted from a doc that wasn't
          actually about this project)             → action="reject"
       c. ambiguous (multiple sources disagree, or unclear if the doc is
          relevant)                                → DO NOT decide; ask
          the user via ask_user, mentioning the field, the proposed value
          and the source (filename / TPMS / chat).
     For (a) and (b) call approve_proposals ONCE with all bundled
     decisions; for (c) call ask_user ONCE with the ambiguous fields
     batched, THEN STOP (the answers arrive on the user's next turn).
  3. After approvals land, call read_soft_spec — confirm gaps=[] and
     conflicts=[]. If gaps remain, ask_user about the missing fields
     (with options when the set is finite, e.g. standard:[IEC,ANSI,GOST]).
  4. When gaps=[] and conflicts=[], call submit_soft_spec. It returns
     {{ready:true, deep_link, soft_project_id}}. Reply with a short
     confirmation and the deep-link as a clickable markdown link.

Rules:
  - NEVER manually compose a `spec` object or pass it to any tool.
    Approvals + the reconciler own that.
  - NEVER approve a value that came from a document the user did not
    indicate is project-spec input (e.g. a similarity-check upload).
    Reject it instead. When unsure, ask.
  - submit_soft_spec REFUSES when pending proposals exist. Clear them
    first via approve_proposals + ask_user.

EXTERNALISED TOOL OUTPUTS (run_state pattern):
- Tool results longer than the inline threshold come back as a small
  JSON envelope, not raw text:
    {{"output_preview": "<head + tail snippet>", "ref": "<chain>:<call>",
     "full_chars": <N>}}
- The preview almost always contains the IDs / paths / standards /
  numbers you need to plan the next step. ANSWER FROM THE PREVIEW
  whenever possible.
- ONLY call read_run_state(ref=…) when the preview is genuinely
  insufficient (e.g. you need to grep the bulk for a specific value
  buried in the middle). Spurious read_run_state calls re-inflate the
  context window and defeat the whole purpose of the externalisation.
- Refs from earlier turns survive within this chat run for ~24 h
  (Redis TTL). If a ref returns {{"error":"not_found"}}, fall back to
  the preview you already have or re-issue the original tool call.

HANDLING precondition_blocked TOOL RESULTS:
- When a tool returns JSON shaped like
    {{"error":"precondition_blocked","blocked_on":"...","resolver":"<tool>","recipe":[...]}}
  this is NOT a failure. The tool refused because a prerequisite step
  hasn't run yet. You MUST:
    1. READ the `recipe` field — it lists the exact next actions.
    2. CALL the tool named in `resolver` on the very next step (or the
       first step of the recipe).
    3. After resolving, CALL THE ORIGINAL TOOL AGAIN.
- Specifically for submit_soft_spec blocked on pending_proposals: next
  step MUST be list_pending_proposals (the resolver). Do NOT stop the
  loop and write a final answer — the user is asking for the project to
  be created; the recipe tells you exactly how to get there.
- Specifically for submit_soft_spec blocked on spec_gaps: the form has
  already been opened for the user. STOP and write a short final answer
  acknowledging which fields you're waiting on; do NOT re-call
  submit_soft_spec in the same turn.
"""


def _source_rules(project_context: Dict[str, Any], plan_ctx) -> str:
    """Compact allow/deny guidance mirroring the plan-and-execute source
    gating, so the loop reaches for the right tools for THIS project."""
    se = resolve_sources_enabled(project_context)
    lines = ["ALLOWED DATA SOURCES FOR THIS PROJECT (do not use others):"]
    if se.get("gitlab"):
        repo = resolve_repo_path(project_context)
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
    se = resolve_sources_enabled(project_context)
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
    """FOCUSED OpenAI-style function schemas. A small, well-chosen toolset
    keeps the loop on-task — offering all ~40 MCP tools makes the model
    wander (observed: it burned steps on session_read_artifact_tool trying
    to read uploads from the sandbox workspace). We allow only the document
    tools, code/web tools, and the project's actually-enabled source tools.
    """
    se = resolve_sources_enabled(project_context)

    # Always-useful core: uploaded-document tools + web + sandbox code exec
    # + the agent's own todo list (TodoWrite/TodoRead-style state)
    # + read_run_state for fetching externalised tool outputs by ref.
    allow = {
        "list_project_documents", "read_document",
        "search_project_documents", "retrieve_chunks",
        "web_search", "web_search_news",
        "session_exec_tool", "shell",
        "todo_write", "todo_list",
        "read_run_state",
    }
    # Design Suite slot-collector tools (only when the bridge is enabled).
    if os.getenv("SOFT_BRIDGE_ENABLED", "").lower() in ("1", "true", "yes", "on"):
        allow |= {"read_soft_spec", "ask_user", "submit_soft_spec",
                  "list_pending_proposals", "approve_proposals"}
    # Source-conditional tools.
    if se.get("gitlab"):
        allow |= {"get_project_tree", "read_artifact_mcp", "search_blobs",
                  "search_technical_knowledge"}
    if se.get("tpms"):
        allow |= {"get_project_context", "tpms_fetch", "tpms_get_text"}
    if se.get("techserver"):
        allow |= {"techserver_get_tree", "techserver_search",
                  "techserver_fetch_files", "techserver_read_artifact"}

    tools: List[Dict[str, Any]] = []
    schemas = getattr(mcp_manager, "tool_schemas", {}) or {}
    for name, tool in schemas.items():
        if name not in allow:
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
    have = {t["function"]["name"] for t in tools}

    # Design Suite local tools — always synthesised; they are not on any
    # MCP server, just local methods on ProjectManagerAgent.
    if os.getenv("SOFT_BRIDGE_ENABLED", "").lower() in ("1", "true", "yes", "on"):
        if "read_soft_spec" not in have:
            tools.append({"type": "function", "function": {
                "name": "read_soft_spec",
                "description": ("Read the current Simorgh Design Suite project "
                                "spec the background collector has accumulated "
                                "from TPMS / chat / uploads / techserver. "
                                "Returns {spec, prov, gaps, conflicts, "
                                "completeness}. Call this FIRST when the user "
                                "asks to create / build / submit the design "
                                "suite project."),
                "parameters": {"type": "object", "properties": {}}}})
        if "ask_user" not in have:
            tools.append({"type": "function", "function": {
                "name": "ask_user",
                "description": ("Ask the user one or more clarifying questions "
                                "via an inline form. Use ONLY when "
                                "read_soft_spec returned non-empty `gaps` or "
                                "`conflicts`. One question per gap/conflict; "
                                "be concrete. After calling this, STOP — the "
                                "answers come back on the user's next turn."),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "questions": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "field":       {"type": "string", "description":
                                                    "the spec field this answers (e.g. 'projectName')"},
                                    "header":     {"type": "string"},
                                    "question":   {"type": "string"},
                                    "options":    {"type": "array",
                                                   "items": {"type": "string"}},
                                    "multiSelect": {"type": "boolean"}
                                },
                                "required": ["field", "question"]
                            }
                        }
                    },
                    "required": ["questions"]
                }}})
        if "submit_soft_spec" not in have:
            tools.append({"type": "function", "function": {
                "name": "submit_soft_spec",
                "description": ("Submit the collected spec to simorgh-soft "
                                "and return the deep-link the user clicks to "
                                "open the new project. Refuses if `gaps` are "
                                "non-empty — call ask_user first."),
                "parameters": {"type": "object", "properties": {}}}})
        have = {t["function"]["name"] for t in tools}

    # TodoWrite / TodoRead local tools — externalised state for the
    # ReAct loop. Always synthesised (no MCP backend); the dispatcher
    # in project_agent._execute_single_task routes them straight to
    # services.agent_todos.
    if "todo_write" not in have:
        tools.append({"type": "function", "function": {
            "name": "todo_write",
            "description": (
                "Create or update the agent's running todo list for "
                "this turn. Use it when the user request needs MORE "
                "THAN ONE step (e.g. multi-source fan-out, HITL "
                "approval flow, dependent retrievals). Each item may "
                "carry: id (omit on first write — autogenerated), "
                "title, status (pending|in_progress|done|blocked|"
                "cancelled), depends_on (list of OTHER todo ids that "
                "must reach 'done' first), priority (1-10), notes. "
                "The list is shown back to you inside <todos>…</todos> "
                "in the system prompt each turn — read it instead of "
                "re-deriving the plan from the transcript."
            ),
            "parameters": {"type": "object", "properties": {
                "todos": {"type": "array", "items": {
                    "type": "object",
                    "properties": {
                        "id":         {"type": "string"},
                        "title":      {"type": "string"},
                        "status":     {"type": "string",
                                       "enum": ["pending", "in_progress",
                                                "done", "blocked", "cancelled"]},
                        "depends_on": {"type": "array",
                                       "items": {"type": "string"}},
                        "priority":   {"type": "integer", "minimum": 1, "maximum": 10},
                        "notes":      {"type": "string"},
                    },
                    "required": ["title"]
                }}
            }, "required": ["todos"]}}})
    if "todo_list" not in have:
        tools.append({"type": "function", "function": {
            "name": "todo_list",
            "description": (
                "Return the current todo list (same content already "
                "shown in <todos>…</todos>). Call when you need to "
                "double-check IDs before a dependency edit."
            ),
            "parameters": {"type": "object", "properties": {}}}})
    if "read_run_state" not in have:
        tools.append({"type": "function", "function": {
            "name": "read_run_state",
            "description": (
                "Fetch the FULL output of a prior tool call that was "
                "externalised. The transcript shows a condensed envelope "
                "for any tool whose raw output exceeded the inlining "
                "threshold: the envelope carries `output_preview` (head + "
                "tail), a `ref` string, and `full_chars`. Call this with "
                "the same `ref` ONLY when the preview is genuinely "
                "insufficient — most of the time the preview contains "
                "the IDs / paths / standards you need and you should "
                "answer from it directly."
            ),
            "parameters": {"type": "object", "properties": {
                "ref": {"type": "string",
                        "description": "Externalised-output ref from a "
                                       "prior tool envelope."}
            }, "required": ["ref"]}}})

    # Guarantee the document tools + a python sandbox are always present,
    # even if the registry snapshot is incomplete at call time.
    if "list_project_documents" not in have:
        tools.append({"type": "function", "function": {
            "name": "list_project_documents",
            "description": "List uploaded files indexed for this project (filenames + chunk_count).",
            "parameters": {"type": "object", "properties": {}}}})
    if "read_document" not in have:
        tools.append({"type": "function", "function": {
            "name": "read_document",
            "description": "Full text of one uploaded file. Identify by filename (exact attached name).",
            "parameters": {"type": "object", "properties": {
                "filename": {"type": "string"}}, "required": ["filename"]}}})
    if "shell" not in have and "session_exec_tool" not in have:
        tools.append({"type": "function", "function": {
            "name": "shell",
            "description": "Run a shell command (incl. python3) in the project's isolated sandbox.",
            "parameters": {"type": "object", "properties": {
                "command": {"type": "string"}}, "required": ["command"]}}})
    # VLM verifier tools — route to Qwen 2.5-VL on .62 via llm-gateway.
    # Use for high-stakes value confirmation against the source page
    # (fault current, IP class, rated voltage, anything ambiguous from
    # text-only extraction) and for "what does this drawing show?"
    # queries on single-line diagrams / P&IDs. document_id is the UUID
    # returned by list_project_documents; page is 1-based.
    if "verify_value_visible" not in have:
        tools.append({"type": "function", "function": {
            "name": "verify_value_visible",
            "description": (
                "Confirm whether a specific value is visible on a "
                "specific page of an uploaded PDF, by sending the "
                "rendered page image to the local vision model. "
                "Returns {confirmed, evidence_text, confidence, note}. "
                "Use for cross-checking values extracted from text "
                "(table cells, drawings, merged cells) before reporting "
                "them as confirmed."
            ),
            "parameters": {"type": "object", "properties": {
                "document_id": {"type": "string",
                                "description": "UUID from list_project_documents."},
                "page":        {"type": "integer", "minimum": 1,
                                "description": "1-based page number."},
                "field":       {"type": "string",
                                "description": "Name of the field to verify (e.g. 'rated voltage')."},
                "value":       {"type": "string",
                                "description": "The candidate value to confirm (e.g. '6.6 kV')."},
                "language":    {"type": "string",
                                "description": "Optional language hint: 'en', 'fa', 'mixed'."},
            }, "required": ["document_id", "page", "field", "value"]}}})
    if "describe_page" not in have:
        tools.append({"type": "function", "function": {
            "name": "describe_page",
            "description": (
                "Render a specific PDF page through the local vision "
                "model and return a markdown description of its "
                "contents: headings, key values with units, tables as "
                "markdown tables, drawings as prose summaries. Use "
                "when the user asks about a specific page or when "
                "text extraction missed the layout of a diagram."
            ),
            "parameters": {"type": "object", "properties": {
                "document_id": {"type": "string"},
                "page":        {"type": "integer", "minimum": 1},
                "language":    {"type": "string"},
            }, "required": ["document_id", "page"]}}})
    # Apache AGE graph-as-router. The agent calls graph_route(query)
    # BEFORE running search to find which sub-corpora (uploads / TPMS /
    # GitLab) and which specific documents are likely-relevant —
    # constrains the search and prevents the "irrelevant cross-source
    # noise" failure that vanilla top-k can't solve. cypher_query is
    # an escape hatch for ad-hoc graph exploration.
    if "graph_route" not in have:
        tools.append({"type": "function", "function": {
            "name": "graph_route",
            "description": (
                "Look up the user's query in the project entity graph "
                "(Apache AGE). Returns {entities, routed_document_ids, "
                "sources_to_hit, rationale}: WHICH documents and "
                "sub-corpora to search before running search_chunks / "
                "TPMS lookups. Call this FIRST on queries that mention "
                "an IEC/ISO standard, an OE number, a panel number, "
                "or a feeder tag (L11B, INC 2, COUPLING 2/1, etc.)."
            ),
            "parameters": {"type": "object", "properties": {
                "query": {"type": "string"},
            }, "required": ["query"]}}})
    if "cypher_query" not in have:
        tools.append({"type": "function", "function": {
            "name": "cypher_query",
            "description": (
                "Run an arbitrary openCypher query against the project "
                "graph in Apache AGE. Use sparingly for graph "
                "exploration the regex router didn't cover (e.g. "
                "'every document mentioning IEC 62271-200'). Schema: "
                "(:Project)-[:CONTAINS]->(:Document)-[:MENTIONS "
                "{count}]->(:Entity {type, key, name})."
            ),
            "parameters": {"type": "object", "properties": {
                "query":  {"type": "string",
                           "description": "openCypher query string."},
                "params": {"type": "object",
                           "description": "Optional Cypher params."},
                "limit":  {"type": "integer", "minimum": 1, "maximum": 100,
                           "description": "Max rows (default 20)."},
            }, "required": ["query"]}}})
    return tools


async def _llm_step(gateway_url: str, messages: List[Dict[str, Any]],
                    tools: List[Dict[str, Any]], mode: str
                    ) -> Tuple[List[Dict[str, Any]], str]:
    """One LLM turn. Returns (tool_calls, final_text).

    Each entry in `tool_calls` is shaped:
        {"id": <call_id>, "name": <tool_name>, "args": <dict>}

    Anthropic's parallel-tool-use guidance: tool calls in a single
    assistant turn are unordered and SHOULD be dispatched concurrently.
    The previous implementation kept only `tool_calls[0]` which forced
    a sequential ReAct loop even when the model emitted siblings — the
    direct cause of the operator's "12 sequential calls" thrash.

    Retries transient gateway 5xx (the loop makes many calls; the
    gateway 502s under burst)."""
    payload = {
        "messages": messages,
        "mode": mode,
        "force_backend": "text",
        "temperature": 0.3,
        "max_tokens": 4096,
        "tools": tools,
        "tool_choice": "auto",
    }
    # Jittered exponential backoff on transient gateway pressure.
    # Previous code: 3 attempts, fixed 1.5*(n+1)s linear sleep, no
    # jitter, no 429 handling, no Retry-After honoring — under burst
    # every concurrent loop hit "gateway busy" simultaneously and
    # backed off in lockstep, then re-burst together.
    #
    # New behaviour:
    #   - 5 attempts.
    #   - Treat 429 / 502 / 503 / 504 as transient (was only 502/3/4).
    #   - Honor the gateway's Retry-After header if present.
    #   - Otherwise sleep base * 2^attempt * jitter(0.5, 1.5) — full
    #     decorrelated jitter (AWS Architecture Blog pattern) so two
    #     callers that hit 503 at the same instant don't re-burst
    #     in lockstep.
    import asyncio as _asyncio, random as _random
    _TRANSIENT = (429, 502, 503, 504)
    _MAX_ATTEMPTS = int(os.getenv("LLM_GATEWAY_MAX_ATTEMPTS", "5"))
    _BACKOFF_BASE = float(os.getenv("LLM_GATEWAY_BACKOFF_BASE_SEC", "0.8"))
    _BACKOFF_CAP  = float(os.getenv("LLM_GATEWAY_BACKOFF_CAP_SEC", "20.0"))
    body = None
    last_err = None
    for attempt in range(_MAX_ATTEMPTS):
        try:
            async with httpx.AsyncClient(timeout=STEP_TIMEOUT) as c:
                r = await c.post(f"{gateway_url}/generate", json=payload)
                if r.status_code in _TRANSIENT:
                    retry_after = r.headers.get("Retry-After", "")
                    sleep_for = None
                    if retry_after.isdigit():
                        sleep_for = min(float(retry_after), _BACKOFF_CAP)
                    raise httpx.HTTPStatusError(
                        f"gateway busy ({r.status_code})",
                        request=r.request, response=r)
                r.raise_for_status()
                body = r.json()
                break
        except Exception as e:
            last_err = e
            if attempt == _MAX_ATTEMPTS - 1:
                break
            # Sleep: Retry-After if the response carried one (gateway
            # is telling us when to come back), otherwise jittered
            # exponential. Cap at _BACKOFF_CAP so we don't sleep
            # multi-minutes on a long outage.
            sleep_for = None
            resp = getattr(e, "response", None)
            if resp is not None:
                ra = resp.headers.get("Retry-After", "") if hasattr(
                    resp, "headers") else ""
                if ra and ra.isdigit():
                    sleep_for = min(float(ra), _BACKOFF_CAP)
            if sleep_for is None:
                expo = _BACKOFF_BASE * (2 ** attempt)
                sleep_for = min(expo, _BACKOFF_CAP) * _random.uniform(0.5, 1.5)
            logger.info(
                "react: gateway transient err=%s attempt=%d/%d sleep=%.2fs",
                type(e).__name__, attempt + 1, _MAX_ATTEMPTS, sleep_for)
            await _asyncio.sleep(sleep_for)
    if body is None:
        raise last_err or RuntimeError("gateway call failed")

    raw_calls = body.get("tool_calls") or []
    parsed: List[Dict[str, Any]] = []
    for i, tc in enumerate(raw_calls):
        fn = (tc.get("function") or {}) if isinstance(tc, dict) else {}
        name = fn.get("name") or tc.get("name")
        if not name:
            continue
        raw_args = fn.get("arguments") if "arguments" in fn else tc.get("arguments")
        args: Dict[str, Any] = {}
        if isinstance(raw_args, str):
            try:
                args = json.loads(raw_args)
            except Exception:
                args = {}
        elif isinstance(raw_args, dict):
            args = raw_args
        call_id = tc.get("id") or f"call_{i}_{uuid.uuid4().hex[:8]}"
        parsed.append({"id": call_id, "name": name, "args": args})

    if parsed:
        return parsed, ""
    # No tool call → final answer text.
    return [], (body.get("response") or body.get("text") or "").strip()


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
    scope = ((getattr(plan_ctx, "tpms_oenum", None) if plan_ctx else None)
             or (project_context.get("tpms_oenum"))
             or str(project_id) or "").strip()

    # Pre-load the project's uploaded documents DIRECTLY into CONTEXT.
    # We don't rely on the plan's gather_grounding here (it may not fire in
    # this code path), and pre-loading the actual content is what lets the
    # model answer — often in ONE step with no tool calls. Each file is
    # capped; the total is bounded so we never approach the model's context
    # window (gpt-oss = 16k tokens — overflowing it is what made the
    # gateway 502 during long loops).
    grounding_text = ""
    PRELOAD_PER_DOC = int(os.getenv("REACT_PRELOAD_PER_DOC", "14000"))
    PRELOAD_TOTAL = int(os.getenv("REACT_PRELOAD_TOTAL", "30000"))
    try:
        qdrant = getattr(agent.memory, "qdrant", None) if getattr(agent, "memory", None) else None
        if qdrant is not None and scope:
            docs = qdrant.list_documents(user_id="system", project_oenum=scope) or []
            blocks, used = [], 0
            per = max(2000, PRELOAD_TOTAL // max(1, len(docs))) if docs else PRELOAD_PER_DOC
            per = min(per, PRELOAD_PER_DOC)
            for d in docs:
                fn = d.get("filename") or ""
                if not fn or used >= PRELOAD_TOTAL:
                    continue
                doc = qdrant.get_document_text(user_id="system", project_oenum=scope,
                                               filename=fn, max_chars=per)
                txt = (doc or {}).get("text") or ""
                if txt:
                    blocks.append(f"## FILE: {fn}\n{txt}")
                    used += len(txt)
            if blocks:
                grounding_text = ("\n\n# CONTEXT — full text of this project's uploaded "
                                  "files (answer from this directly; you usually need NO "
                                  "tool calls):\n\n" + "\n\n".join(blocks))
                logger.info("react: preloaded %d docs (%d chars) scope=%s",
                            len(blocks), used, scope)
    except Exception as e:
        logger.warning("react: document preload failed: %s", e)

    # Effective step cap: never let a high REACT_MAX_STEPS cause runaway
    # thrashing / gateway load. With content pre-loaded the model should
    # finish in 1-4 steps; 12 is a generous ceiling.
    steps_cap = min(MAX_STEPS, 12)

    tools = _build_tools(agent.mcp_manager, project_context)
    system = REACT_SYSTEM_PROMPT.format(
        max_steps=steps_cap,
        source_rules=_source_rules(project_context, plan_ctx),
    )
    # Pinned <project_facts> block — pulled out of source_rules into a
    # canonical immutable block so the OE / repo / source flags are
    # ALWAYS visible to the model, even when the rolling transcript
    # sheds older tool exchanges. messages[0] is pinned by _trim_history
    # so this block survives every turn.
    proj_meta = (project_context.get("project") or {}) or project_context
    facts_block = build_project_facts(
        proj_meta,
        user_id=(
            project_context.get("user_id")
            or proj_meta.get("owner_id")
            or proj_meta.get("user_id")
        ),
    )
    proj_line = (f"Project: {project_context.get('name','')}  "
                 f"project_id: {project_id}")

    # TodoWrite-style state externalisation. Allocate a per-chain todo
    # store and seed the system message with the initial (empty) block.
    # Each iteration refreshes the block so the model always sees current
    # state without having to call todo_list explicitly.
    todos_store = _get_todos_store(chain_id)

    # Cross-turn durability: hydrate the todo store from Redis using the
    # CHAT id (stable across chain runs) so a multi-turn task — "open
    # PR, fix CI feedback, re-push" — sees its prior plan instead of
    # starting from an empty list every turn. Best-effort: a memory
    # outage leaves us with the empty in-memory store.
    chat_id = getattr(cot_request, "chat_id", None) or ""
    _todos_key = f"todos:{chat_id}" if chat_id else ""
    if _todos_key:
        try:
            saved = await agent.memory.get_working_memory(
                project_id, _todos_key)
            if isinstance(saved, dict) and saved.get("items"):
                todos_store.load_payload(saved)
                logger.info(
                    "react: hydrated %d todos from chat=%s",
                    len(saved["items"]), chat_id)
        except Exception as e:
            logger.debug("react: todos hydrate skipped: %s", e)

    async def _persist_todos() -> None:
        if not _todos_key:
            return
        try:
            await agent.memory.store_working_memory(
                project_id, _todos_key, todos_store.to_payload())
        except Exception as e:
            logger.debug("react: todos persist skipped: %s", e)

    _base_system = f"{facts_block}\n\n{system}"

    def _system_with_todos() -> str:
        return f"{_base_system}\n\n{todos_store.render()}"

    messages: List[Dict[str, Any]] = [
        {"role": "system", "content": _system_with_todos()},
        {"role": "user",
         "content": f"{proj_line}{grounding_text}\n\nUser request:\n{user_input}"},
    ]

    await agent._notify_progress(project_id, "cot_complete", {
        "chain_id": chain_id, "reasoning": "ReAct loop", "total_steps": 0, "steps": [],
    })

    prev_results: Dict[str, Any] = {}
    steps: List[Dict[str, Any]] = []
    final_response = ""

    import asyncio as _asyncio
    for i in range(1, steps_cap + 1):
        if not gateway_url:
            final_response = "LLM gateway is not configured (LLM_GATEWAY_URL)."
            break
        # Refresh the pinned system prompt with the LATEST todos block.
        # messages[0] is pinned by _trim_history, so the model always
        # sees current todo state without re-deriving from transcript.
        messages[0]["content"] = _system_with_todos()
        try:
            tool_calls, final_text = await _llm_step(
                gateway_url, messages, tools, mode)
        except Exception as e:
            logger.error("react: llm step %d failed: %s", i, e)
            final_response = final_response or f"Reasoning step failed: {e}"
            break

        if not tool_calls:
            final_response = final_text or "(no answer produced)"
            break

        # Parallel tool-call fan-out — Anthropic parallel-tool-use docs:
        # "Tool calls in a single assistant turn are unordered. You can
        # run them concurrently." Dispatch every emitted call in this
        # turn via asyncio.gather; one slow tool no longer blocks
        # independent siblings. The agent's planner is teaching this
        # via the <use_parallel_tool_calls> system-prompt block.
        async def _dispatch_one(call: Dict[str, Any]) -> Dict[str, Any]:
            name = call["name"]
            args = call["args"]
            call_id = call["id"]
            await agent._notify_progress(project_id, "task_executing", {
                "task_id": call_id, "task_title": name,
                "step": i, "total": steps_cap,
                "progress_percent": int(i * 100 / steps_cap),
            })
            task = {
                "id": call_id, "title": name, "description": "",
                "task_type": "shell_command" if name in ("shell", "git") else "query",
                "tool_used": name, "tool_input": args or {},
                "sort_order": i,
                "cot_chain_id": chain_id,
            }
            try:
                result = await agent._execute_single_task(
                    project_id, task, prev_results)
            except Exception as e:
                logger.error("react: tool %s failed: %s", name, e)
                result = {"output": f"[tool {name} failed: {e}]",
                          "metadata": {}}
            # R1 loop-breaker: record (tool, args, was_empty) so the
            # third same-signature call gets refused. No-op when the
            # agent doesn't have the helper (defensive for older
            # project_agent versions during a rolling deploy).
            try:
                if hasattr(agent, "_loop_breaker_record"):
                    agent._loop_breaker_record(
                        chain_id=chain_id, tool=name,
                        tool_input=args or {}, result=result)
            except Exception:
                pass
            output_str = (result or {}).get("output", "") or ""
            await agent._notify_progress(project_id, "task_completed", {
                "task_id": call_id, "tool": name,
                "output_preview": output_str[:200],
            })
            return {"call": call, "result": result, "output": output_str}

        wave = await _asyncio.gather(
            *[_dispatch_one(c) for c in tool_calls],
            return_exceptions=False,
        )

        # Single assistant message carrying ALL tool_calls, then a
        # single user message carrying ALL tool_results — Anthropic's
        # required shape for parallel tool use. Splitting these into
        # one-per-tool messages actively teaches the model to be
        # sequential in subsequent turns.
        assistant_tool_calls = []
        for w in wave:
            c = w["call"]
            assistant_tool_calls.append({
                "id": c["id"], "type": "function",
                "function": {"name": c["name"],
                             "arguments": json.dumps(c["args"] or {})},
            })
        messages.append({
            "role": "assistant", "content": "",
            "tool_calls": assistant_tool_calls,
        })
        # Persist the todo list when this wave mutated it. todo_write
        # is the only mutator; checking presence in the wave avoids
        # an unconditional Redis write every turn.
        if any(c["name"] == "todo_write" for c in tool_calls):
            await _persist_todos()

        # Externalise long outputs to run-state (Redis). The transcript
        # gets a condensed envelope; the full output is fetchable by
        # ref via the read_run_state local tool. Short outputs inline
        # verbatim (no extra hop needed).
        for w in wave:
            call = w["call"]
            output_str = w["output"] or ""
            envelope = await _run_state.stash_output(
                getattr(agent, "memory", None),
                project_id=project_id,
                chain_id=chain_id,
                call_id=call["id"],
                output=output_str,
            )
            if envelope is not None:
                body = _run_state.envelope_to_transcript_str(envelope)
            else:
                body = output_str[:2500]
            messages.append({
                "role": "tool", "tool_call_id": call["id"],
                "name": call["name"],
                "content": body,
            })
            prev_results[str(len(prev_results) + 1)] = w["result"]
            steps.append({"title": call["name"], "tool": call["name"]})

        # Keep the running transcript within the model's context window.
        # The system message (with the pre-loaded document CONTEXT) and the
        # original user request are pinned; older tool exchanges are dropped
        # when the transcript grows too large. Without this the history
        # outgrows gpt-oss's 16k-token window and the gateway 502s.
        _trim_history(messages)

        # Convergence nudge: once the model has had a few tool turns, remind
        # it that the file content is already in CONTEXT and it should
        # answer rather than keep exploring. This stops the observed
        # thrashing (repeated session_exec/search with no progress).
        if i >= 3:
            messages.append({"role": "user", "content": (
                "You now have enough information (the files' content is in the "
                "CONTEXT above). If you can answer the user's request, STOP "
                "calling tools and give the FINAL answer now. Only call another "
                "tool if it is strictly necessary.")})
    else:
        # Hit the step cap without a final answer — make one last synthesis.
        try:
            messages.append({"role": "user",
                             "content": "Stop using tools. Give your best final answer now "
                                        "from what you have gathered above."})
            _, final_response = await _llm_step(gateway_url, messages, [], mode)
        except Exception as e:
            final_response = f"(reached step limit; synthesis failed: {e})"

    # Final persist before releasing the per-chain in-memory store,
    # so any mid-loop updates that didn't trigger a persist (e.g. a
    # status change made by an iteration that crashed before its
    # wave check) still survive into the next chat turn.
    await _persist_todos()

    # Release the per-chain todo store so we don't accumulate state
    # across runs in long-lived workers.
    try:
        _clear_todos_store(chain_id)
    except Exception:
        pass

    # Commit C: numeric / standards verbatim verification post-pass.
    # Pull the source corpus from the prefetched <documents> block in
    # the pinned user message (messages[1]). Fail-open: if sources can't
    # be reconstructed or the verifier raises, the original final_response
    # is preserved.
    grounding_meta: Dict[str, Any] = {}
    try:
        if os.getenv("GROUNDING_VERIFY", "1") not in ("0", "false", "off"):
            from services.grounding_verifier import (
                verify_answer_against_sources, summarise_for_metadata)
            sources_text = _extract_documents_text(messages)
            if sources_text and final_response:
                vr = verify_answer_against_sources(
                    final_response, sources_text,
                    rewrite_unverified=True)
                grounding_meta = summarise_for_metadata(vr)
                if not vr.ok and vr.answer_redacted:
                    logger.info(
                        "grounding verifier: rewriting answer — "
                        "%d/%d claims unverified",
                        len(vr.unverified), vr.claims_total,
                    )
                    final_response = vr.answer_redacted
    except Exception as _ve:
        logger.debug("grounding verifier skipped: %s", _ve)

    return {
        "response": final_response,
        "grounding": grounding_meta,
        "chain_id": chain_id,
        "reasoning": "react",
        "tasks_created": len(steps),
        "tasks": [{"id": str(uuid.uuid4()), "title": s["title"], "status": "completed"}
                  for s in steps],
        "execution_results": [{"status": "completed", "tool": s["tool"]} for s in steps],
        "commit": {},
    }
