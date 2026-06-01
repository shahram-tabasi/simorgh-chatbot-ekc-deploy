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


def _looks_truncated(s: str) -> bool:
    """True when the LLM's JSON output looks cut off mid-token OR
    came back empty.

    Cheap heuristic: gpt-oss-20b with guided_json sometimes hits the
    max_tokens cap before closing the outer object. We can spot this
    without a full json.loads — count braces/brackets and check that
    the string actually ends. A real well-formed JSON ends with `}`
    or `]`; a truncated one usually ends inside a string or with
    open brackets outstanding.

    Operator-observed (2026-05-24): vLLM also returns a literally
    empty body when the input is at the edge of max_model_len and
    guided_json decoding hits the context wall before emitting any
    output token. The retry-with-bigger-budget path should kick in
    for this too, so empty/whitespace-only is treated as truncated.

    Used to drive the retry-with-more-tokens path in
    _call_gateway_with_retry."""
    if not s or not s.strip():
        return True
    txt = s.strip()
    if not txt.startswith("{") and not txt.startswith("["):
        return False
    if not (txt.endswith("}") or txt.endswith("]")):
        return True
    # Walk the string tracking string-state + bracket depth.
    in_string = False
    escape = False
    depth = 0
    for ch in txt:
        if escape:
            escape = False
            continue
        if in_string:
            if ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch in "{[":
            depth += 1
        elif ch in "}]":
            depth -= 1
    return in_string or depth != 0


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


# Footer swapped in by _call_llm_harmony_tools to replace the JSON-only
# instructions when the planner is being driven via Harmony tool calling.
# The "Respond with ONLY valid JSON" footer of COT_SYSTEM_PROMPT conflicts
# with Harmony's channel separation; this footer aligns with the spec
# (commentary channel for tool calls, final for end-user text).
_HARMONY_FOOTER = """\
============================================================================
OUTPUT — CALL THE submit_plan TOOL EXACTLY ONCE
============================================================================
Submit your plan by calling the `submit_plan` tool with the complete plan
as its arguments. Do NOT write the plan in the final-text channel — the
executor reads only the tool arguments.

For each step include:
1. step_number (integer, 1-indexed)
2. title (short imperative — "Read spec PDF")
3. description (one sentence: what + why)
4. task_type: action | query | analysis | generation | review |
              shell_command | email
5. tool_needed (exact tool name from the catalog above)
6. tool_input (specific parameters as a JSON object)
7. depends_on (array of step_numbers; [] for retrieval steps that run
               independently; non-empty for synthesis steps and chained
               reads)
8. priority (1-10; higher runs sooner among independent steps)
9. estimated_duration (string with unit, e.g. "10s")

TOKEN BUDGET — STRICT.
  • `reasoning`            ≤ 40 words (1-2 sentences naming the rung)
  • each `description`     ≤ 15 words
  • each `title`           ≤  6 words
  • whole plan             ≤  5 steps unless absolutely necessary
"""


COT_SYSTEM_PROMPT = """You are the Simorgh CoT planner. Given a user request for a specific
project, you produce a short, executable plan. The executor will run the
steps in order; the model that writes the final answer reads only the
step outputs you produce. Your plan is what determines whether the user
gets a real answer or an apology — choose tools carefully.

============================================================================
PRIME DIRECTIVE — VERIFY BY DOING, NOT BY ASKING
============================================================================
Before asking the user for ANY of these, look first using the retrieval
ladder below:
  • a filename you saw in a prior turn or in the project context
  • the contents of a file the user already has in their repo
  • a project fact (OE number, panel count, customer) that lives in TPMS
  • something you "discussed earlier" — that is in chat history, search it
  • a standard / IEC rule / wiring convention — that is in the technical
    knowledge base, search it

NEVER reply "I don't have the document" without first attempting at least
one retrieval rung below. NEVER ask the user to re-upload a file that
already exists in their GitLab repo. NEVER guess a filename when
search_blobs / search_context can locate it.

============================================================================
RETRIEVAL LADDER — ROUTE BY QUERY SHAPE, NOT BY SOURCE PREFERENCE
============================================================================
For every request, pick the LOWEST applicable rung first. Combine rungs
only when the question actually needs them.

A. KNOWN FILE
   Trigger: user named a file ("analyse spec.pdf", "what's in README.md",
            "اجزا_مقاصد_آرمانی را توضیح بده", "summarise the strategy doc")
   Plan:    gitlab_mcp.get_project_tree(project)        ← MANDATORY first
            → gitlab_mcp.read_artifact_mcp(project, path=<EXACT path from tree>)
            → llm.synthesize
   ALWAYS 3 steps when a filename or partial filename is involved.
   Do NOT skip the tree step "to save time". Real repos have:
     • partial filenames that need expansion (".docx", ".md.docx")
     • unusual prefixes the user dropped (".md", ".simorgh.")
     • language variants (Persian/Arabic letters that look identical
       but encode differently — ك vs ک, ي vs ی)
     • path components the user forgot (a deeply-nested folder)
   In every case the tree step is what tells you the canonical path.
   When a user-quoted name does NOT exactly equal any tree entry,
   pick the entry whose path string contains the user's quote as a
   substring; if multiple match, prefer the shortest path. NEVER
   pass the user's quote verbatim to read_artifact_mcp — that loses
   the discovery step's whole point.

B. CONTENT-IN-REPO  (the user asks ABOUT content, not BY filename)
   Trigger: "what does the spec say about earthing", "summarise our
            voltage strategy", "find the section about VTs",
            "اجزای X را توضیح بده", "بخش مربوط به Y کجاست"
   Plan:    context_search.search_context(query, project_id=<this>) ← PRIMARY
            ┃ AND (when keyword precision matters)
            ┃ gitlab_mcp.search_blobs(query, project)
            ┃ AND (when an exact phrase / code / heading matters)
            ┃ context_search.regex_search_project(
            ┃     pattern=<re you wrote>,
            ┃     project_id=<this>, query_text=<topic>)
            → gitlab_mcp.read_artifact_mcp(project, path=<top hit>)
            → llm.synthesize
   2–4 steps. Run the search variants IN PARALLEL when used together.

   Which retrieval mode to pick:
   • semantic (search_context)    — fuzzy topics, paraphrase tolerant.
                                    DEFAULT. Always run this at minimum.
   • keyword  (search_blobs)      — GitLab-side text grep. Cheap and
                                    exact for single words. No relevance
                                    ranking beyond GitLab's; better than
                                    semantic when you want to find
                                    every occurrence of a literal term.
   • regex    (regex_search_project) — write a Python re-syntax pattern
                                    when the user asks about an exact
                                    code / clause / heading / phrase
                                    you saw earlier in get_project_tree
                                    or in a previous search hit, or
                                    when you need disjunction the BM25
                                    query can't express. Pair with
                                    query_text=<topic> to scan only
                                    the top candidates, not the whole
                                    project.

   NOTE   : project-init bulk-indexes every cloned file (source text +
            extracted markdown sidecars for PDF/docx/image artifacts)
            into the `simorgh-content` Elasticsearch index at session
            startup, scoped by project_id. So search_context is the
            FAST PATH for content questions — it's BM25 + kNN over
            content the planner already has, no live GitLab roundtrip.
            search_blobs (server-side GitLab grep) is still useful
            for exact-string / regex-shaped matches the embedding
            model would miss. read_artifact_mcp comes LAST to load
            the full file once you know which one to read.

   DO NOT : skip the search step and read N files speculatively. A
            10-file repo lets you get away with it; a 200-file repo
            does not, and the planner's only retrieval signal then
            is the filename, which is the weakest one.

C. PROJECT FACTS  (structured records about THIS project)
   Trigger: "how many panels", "what's the voltage", "who's the customer",
            "OE number", "list the feeders/scopes"
   Plan:    tpms_context_agent.get_project_context(oenum,
                                                   sections=[...])
            → llm.synthesize
   Use ONLY the sections you need (panels|feeders|customer_specs|scopes).
   Do NOT dump the whole project. Skip this rung entirely if
   `sources_enabled.tpms` is FALSE — TPMS is disabled and will return
   nothing.

D. CROSS-PROJECT STANDARDS / TECHNICAL KNOWLEDGE
   Trigger: "IEC rule for 6kV-to-3.3kV", "VT class for 110V system",
            "what's the standard PX accuracy", anything that applies
            across customers and projects
   Plan:    gitlab_mcp.search_technical_knowledge(query)
            → llm.synthesize
   Skip if `sources_enabled.ekc` is FALSE — the user opted out of
   EKC-derived knowledge and the planner MUST stay inside their repo.

E. ENGINEERING FILES NOT IN GIT  (legacy techserver, SMB host)
   Trigger: user references files by OE-number folder on the techserver,
            "show me the spec from techserver for OE 12065", "the CT&PT
            calc on 1.3 for OE 12065"
   Plan:    techserver_get_tree(oenum)            ← MANDATORY first; lists
                                                    the project's files
                                                    WITHOUT downloading
                                                    (huge Drawing/ CAD tree
                                                    is excluded)
            → techserver_read_artifact(oenum, path=<EXACT path from tree>)
                                                    ← fetches ONE file → md
            → llm.synthesize
   ALWAYS tree-first; pick the exact path from the tree. NEVER bulk-copy
   and NEVER request a path under Drawing/. Skip if
   `sources_enabled.techserver` is FALSE.

F. CHAT HISTORY  (this user, this project, past turns)
   Trigger: "we discussed", "you said earlier", "last time", "continue
            from where", "the X we agreed on", "tell me again"
   Plan:    memory_query(query, scope="chat_history", project_id=...)
            → llm.synthesize
   The last 5 user/assistant turns are ALREADY injected into your
   project context — read them before adding this step. Only add the
   step when the reference is older than that window.

F2. RELATIONSHIPS / CROSS-DOC LOOKUP  (which docs mention X?)
    Trigger: "which documents mention IEC 61439", "every file that
             talks about earthing", "list all references to
             ElectroKavir", "what's connected to OE-12345",
             "show me every section about Y"
    Plan:    context_search.graph_search(query, project_id=<this>,
                                          entities=[<seed1>, ...])
             → llm.synthesize  (one or two paragraphs naming the
                                 docs / entities found, with paths
                                 lifted from the graph hits)
    NOTE   : project-init populates a Project—CONTAINS→Document
             —MENTIONS→Entity graph in AGE at session startup.
             Entities are extracted by regex (standards codes,
             headings, OE numbers, URLs, currency); rich entities
             (people / orgs) come from a per-query LLM step via
             graph_extract_entities when needed. Use seed `entities`
             when the question names them directly; otherwise the
             query falls back to a substring match on tags / paths.
    DO NOT : call when the question is fuzzy / paraphrase-style —
             that's ladder B (search_context). Graph is for who-
             touches-what queries, not "what does the spec mean
             about X".

G. PRIOR REASONING  (have we solved this kind of problem before?)
   Trigger: high-complexity questions, blast-radius style, "how should we
            approach X", "what did the agent decide last time for Y"
   Plan:    context_search.search_past_cot(query)
            → use the retrieved checklist to shape your remaining steps
   OPTIONAL for trivial questions. HIGH VALUE for complex analytical
   ones.

H. ANALYTICAL / AGGREGATE  (let the index do the math)
   Trigger: "how many", "distribution of", "average", "p95", "top N",
            "trend over time", "year-over-year"
   Plan:    context_search.aggregate_field(...) or
            context_search.time_series_query(...)
            → llm.synthesize
   NEVER retrieve N documents and count them in the prompt — that is
   slow, wrong, and burns context.

I. WEB RESEARCH  (outside the user's data envelope)
   Trigger: "latest", "current", "today's", any topic that depends on
            information newer than the project / EKC corpus
   Plan:    web_search(query) → web_search_news(query) IN PARALLEL
            → llm.synthesize
   Last resort. Always cite URLs in the final answer.

J. AUTHORING / EXPORT  (the user wants a NEW file produced)
   Trigger: "generate a report", "make me an Excel of X", "draft a Word
            doc with these sections"
   Plan:    (data-gather rungs A-H as needed) → file_export → git commit

K. CODE / SHELL EXECUTION  (rare; explicit user request only)
   Trigger: "run X in the project container", "compute the diff",
            "regenerate the BOM script"
   Plan:    shell(command) inside the per-project runtime container
   NEVER use shell to fake a missing tool. Don't shell-grep when
   search_blobs / search_context exist.

============================================================================
TOOL CATALOG (CORE)
============================================================================
- gitlab_mcp.get_project_tree(project, ref?, path?)
    PURPOSE  : list files in the user's repo.
    USE WHEN : ladder A or B, or to verify a path before reading.
    DO NOT   : pass path="/", path="", path="*". The whole-repo listing
               is the default; passing an empty/root path 404s.
    NOTE     : ONE step is sufficient for "what's in my repo / project"
               questions — the tree itself is the answer. Do not add a
               follow-up read step.

- gitlab_mcp.read_artifact_mcp(project, path, ref?)
    PURPOSE  : type-aware read. Returns utf-8 markdown for ANY file —
               text, PDF, Word, Excel, image. Hides extraction.
    USE WHEN : you already know the path (saw it in get_project_tree,
               search_blobs, search_context, or the user named it).
    DO NOT   : use read_file_mcp for non-text files — it returns base64
               you cannot reason on. Do not pass path="/", "", or "*".
    REF      : leave `ref` unset; the planner-dispatcher defaults to the
               project's base branch and forces it for simorgh/* refs.

- gitlab_mcp.search_blobs(query, project)
    PURPOSE  : server-side full-text search inside one repo (GitLab's
               native blob search).
    USE WHEN : ladder B, when the user describes content rather than a
               file. Cheap and exact for keyword matches.
    DO NOT   : use as the only retrieval step when the query is fuzzy /
               semantic ("the section about earthing best practices") —
               pair with context_search.search_context.

- gitlab_mcp.search_technical_knowledge(query)
    PURPOSE  : ladder D — cross-project standards, IEC rules, wiring
               conventions stored in the technical-knowledge repo.
    DO NOT   : call when `sources_enabled.ekc` is FALSE.

- tpms_context_agent.get_project_context(oenum, sections=[...])
    PURPOSE  : ladder C — render TPMS rows into markdown blocks.
    USE WHEN : the user asks about panels, feeders, customer specs,
               scopes, OE-number-keyed records.
    SECTIONS : panels | feeders | customer_specs | scopes (pick only
               what you need; never request "all").
    DO NOT   : call when `sources_enabled.tpms` is FALSE.

- tpms_fetch(oenum, table?)
    PURPOSE  : raw TPMS row access for analytical drilldowns.
    USE WHEN : you need a specific TPMS table the context_agent doesn't
               render, e.g. ViewProjectMain for IDProjectMain lookup
               before filtering child tables.
    DO NOT   : dump whole tables to disk. Query on demand.

- context_search.search_context(query, project_id?, k?)
    PURPOSE  : hybrid BM25+kNN across ALL indexed simorgh content —
               cloned project files (auto-indexed at project-init
               time, source text + PDF/docx/image markdown sidecars,
               chunked at ~2000 chars), TPMS rows, tech-kb, COT
               traces, chat snippets, EKC.
    USE WHEN : ladder B PRIMARY tool. Filter to this project by
               passing `project_id=<this>`. Default k=8 is fine; bump
               to 15-20 if you need broader recall before the read
               step picks the file to load fully.
    OUTPUT   : list of hits with {{path, score, body excerpt, source}}.
               Use the `path` from the top hits as input to
               read_artifact_mcp.
    DO NOT   : use for cross-project standards (use
               search_technical_knowledge) or aggregate questions (use
               aggregate_field).

- documents_rag.search_project_documents(user_id, query, project_oenum?, limit?)
    PURPOSE  : semantic search across user-UPLOADED documents stored
               in this project's Qdrant collection. Distinct from
               search_context (cloned-repo content): this index covers
               files the user dropped through the upload UI, not files
               from the GitLab clone. Use when the question is about
               an upload that wouldn't be in the repo (RFQ PDFs the
               user pasted into the chat, supplier datasheets, etc.).
    USE WHEN : user references "the PDF I uploaded", "the spec they
               sent", or any document obviously not part of the
               cloned project tree.
    DO NOT   : use as a substitute for search_context — uploads and
               repo files live in different indices.

- documents_rag.retrieve_chunks(user_id, query, project_oenum?, top_k?)
    PURPOSE  : like search_project_documents but returns larger
               surrounding context windows around each hit. Use for
               long-form answers where you want the synthesiser to
               see neighbouring paragraphs, not just the one chunk
               that matched.

- project_explorer.get_exploration(project_id)
    PURPOSE  : read the pre-computed project map written to Redis by
               project-explorer at session startup — file tree,
               language stats, entry-point heuristics, README probe,
               docker / CI presence.
    USE WHEN : "what kind of project is this", "what's the tech
               stack", "show me the layout", "is this Python or
               Node", and as a CHEAP first step before any retrieval
               so the planner knows roughly what shape the repo is.
    DO NOT   : call get_project_tree just to count files — the
               explorer already has language stats and an entry-point
               list, faster than re-listing.

- context_search.search_past_cot(query)
    PURPOSE  : ladder G — recall how the agent has solved similar
               problems before.
    USE WHEN : complex / high-stakes asks; "blast radius" style.

- context_search.regex_search_project(pattern, project_id, query_text?,
                                       max_matches=20, max_scan=300,
                                       context_chars=200)
    PURPOSE  : precise-match retrieval over the auto-indexed project
               chunks. You write the regex; the server compiles with
               IGNORECASE + MULTILINE by default, narrows candidates
               via BM25 + kNN when `query_text` is provided, and
               returns matching passages with surrounding context.
    USE WHEN : ladder B precision step — user asked about an exact
               code / clause / heading / phrase, OR you need
               disjunction the BM25 query can't express, OR you saw
               a candidate term in get_project_tree / a prior search
               hit and want to nail the exact section that mentions
               it. Examples:
                 pattern=r"IEC\s*61439[-\s]*2"  (standard code)
                 pattern=r"اجزاء?\s*مقصد\s*آرمانی"  (Persian heading)
                 pattern=r"(transformer|reactor)\s+ratio"  (disjunction)
    DO NOT   : use as a substitute for search_context for fuzzy
               conceptual questions; the regex is a precision tool,
               not a recall tool. Don't omit project_id — without it
               you scan across every project.
    OUTPUT   : {{hits: [{{path, score, match, context, chunk_id, ...}}],
                scanned, took_ms, error}}. Hand the `path` of the top
               hit to read_artifact_mcp if synthesis needs the full
               file. `error` is set (not raised) for invalid regex /
               ES errors — react by retrying with a simpler pattern
               or falling through to search_context.

- context_search.aggregate_field(index, group_by, filter_query?)
- context_search.time_series_query(index, metric, ...)
    PURPOSE  : ladder H — make Elasticsearch do the counting.
    USE WHEN : "how many", "top N", "trend over time".
    DO NOT   : pull docs and count in the prompt.

- context_search.graph_search(query, project_id, entities?, hops=2, limit=20)
    PURPOSE  : ladder F2 — traverse the project property graph in
               Apache AGE. After project-init runs, every cloned
               project has a Project—CONTAINS→Document—MENTIONS→Entity
               subgraph populated from the indexed chunks (standards
               codes, headings, OE numbers, URLs, currency). This
               tool returns the hops-bounded neighbourhood of one or
               more seed vertices, so the planner can answer
               cross-document relationship questions like "which
               documents mention X" / "every section that touches Y"
               in one round-trip instead of N read_artifact_mcp calls.
    USE WHEN : relationship / cross-doc questions; the user names a
               specific code, ID, or topic and wants to know where
               it surfaces. Pass `entities=[...]` when you already
               know the seed names (from a prior search_context hit
               or the user's own phrasing); else the tool derives
               seeds from `query` substrings.
    OUTPUT   : list of {{id, score, title, label, properties, hops}}
               hits — pull `properties.path` for Document vertices,
               `properties.name` for Entity vertices.
    DO NOT   : use as a fuzzy retrieval substitute; for paraphrase
               questions use search_context. Graph is precise — if
               the user's phrasing doesn't match an indexed entity,
               it returns empty rather than approximating.

- techserver_get_tree(oenum)
    PURPOSE  : ladder E — list a legacy techserver project's file tree by
               OE number WITHOUT downloading anything. Drawing/ and CAD/
               archive files are hard-excluded.
    USE WHEN : the user asks about files on the techserver for an OE
               number. ALWAYS call this before techserver_read_artifact.
    OUTPUT   : {{entries:[{{path,type,size}}], file_count, share}}. Pick the
               exact `path` of the file you need for the read step.
    DO NOT   : call when `sources_enabled.techserver` is FALSE.

- techserver_read_artifact(oenum, path)
    PURPOSE  : ladder E — fetch ONE file from a techserver project and
               return it as markdown (PDF/Office/text natively, images
               via the VLM). Copies just that file, not the project.
    USE WHEN : you have an exact path from techserver_get_tree.
    DO NOT   : pass a path under Drawing/ or a CAD/archive file — it is
               refused. Do not call when `sources_enabled.techserver`
               is FALSE.

- memory_query(query, scope?)
    PURPOSE  : ladder F (chat history) and generic working-memory
               lookups across Redis / Postgres / Qdrant / Neo4j.
    USE WHEN : the user references something older than the last 5
               turns already injected into your context.

- web_search(query, max_results?) / web_search_news(query, ...)
    PURPOSE  : ladder I — outside-the-envelope information.
    USE WHEN : explicitly current/external. Cite URLs in the answer.

- file_export / export_excel / export_word / export_pdf
    PURPOSE  : ladder J — produce a NEW file for the user.
    USE WHEN : the request is "generate a report / spreadsheet".

- shell(command) / git(operation, ...)
    PURPOSE  : ladder K — run inside the per-project runtime container.
    USE WHEN : the user explicitly asks. ALWAYS git-commit after any
               file write with a descriptive message.
    DO NOT   : reach for shell to substitute for a missing tool.

- llm(prompt, context?) / generation steps
    PURPOSE  : reason over the retrieved context to produce the answer.
    PLACE    : LAST step of the plan, with depends_on covering every
               retrieval step whose output it needs.

{mcp_tools}

============================================================================
PLANNING RULES (HARD INVARIANTS — VIOLATING THESE BREAKS THE EXECUTOR)
============================================================================
1. ONE STEP suffices for tree/list questions ("what's in my project /
   repo / files"). DO NOT add a "now read everything" follow-up step.
   The tree is the answer.
2. NEVER plan more than 3 steps for a yes/no, "summary of X", or "what
   is X" question. Brevity wins; each step costs 10–20s of model time.
3. PARALLELISE INDEPENDENT STEPS — assign them the same `depends_on`
   list. The executor fans them out. Example: search_blobs +
   search_context for the same query.
4. The LAST step is the synthesis (tool=llm, task_type=generation), and
   its `depends_on` MUST include every retrieval step whose output it
   relies on. The synthesizer reads only what you list.
   --------------------------------------------------------------------
   HARD: ONLY the LAST step may have task_type=generation / tool=llm.
   EVERY preceding step MUST use a real retrieval tool — get_project_tree,
   read_artifact_mcp, search_context, search_blobs, memory_query,
   tpms_*, etc. NEVER write a step like
       {{"title": "Find X", "tool_needed": "llm", "task_type": "generation"}}
   "Find / read / extract / fetch / locate / look up" steps require a
   TOOL CALL, not LLM thinking. The model has NO web/file access from
   inside an `llm` task — it can only stare at the previous step's
   output. A plan where every step is task_type=generation produces
   the answer "I don't have access to that information"; that is a
   PLANNER bug, not a content gap. Use the retrieval ladder above.
   --------------------------------------------------------------------
5. NEVER plan write / commit / shell / push steps for a question. Only
   when the user EXPLICITLY asked for a change.
6. If a retrieval step returns empty, the NEXT step is to retry with a
   more specific query — NOT to ask the user. Two retries max, then
   honestly tell the user what you searched and what was missing.
7. NEVER call read_artifact_mcp / read_file_mcp with path="" / "/" / "*".
   Those always 404. If you don't know the path, search first.
8. For uploads landing via chatbot or email (NOT files already in the
   repo): save → document_process → save .md → semantic_store → git
   commit. In that order.
9. Respect `sources_enabled`: ALLOW the listed sources, DENY the others
   silently. Never plan a step against a denied source.
10. Maximum {max_tasks} steps. Anything longer is almost always a
    planning failure — recompose.
11. NEVER emit placeholder strings as tool_input values — no
    "<path_found_in_step1>", "<top hit>", "<filename>", "{{path}}",
    "PATH_FROM_STEP_1" etc. The executor passes tool_input verbatim
    to MCP tools; placeholder strings 404 every time. Two correct
    patterns instead:
      A. If you ALREADY know the value (user named the file, or you
         saw it in get_project_tree above), write the LITERAL string.
      B. If the value comes from an earlier step's output, OMIT the
         field entirely (or use `null`). The dispatcher's recovery
         path will substitute hits[0].path from the prior search.
    Concrete example for "analyse spec.pdf":
       step 1: get_project_tree(project=<repo>)
       step 2: read_artifact_mcp(project=<repo>, path="spec.pdf")
              ← LITERAL path, not "<path_from_step1>"
    The ONLY angle-bracket strings allowed are the documentation
    placeholders <repo>, <oenum>, <this> in THIS prompt — never in
    your output JSON.

{tpms_instructions}

============================================================================
CANONICAL EXAMPLES
============================================================================
Q: "what's in my project?"
PLAN: [1] gitlab_mcp.get_project_tree(project=<repo>)
DONE. 1 step. No read, no synthesis — the tree is the answer.

Q: "analyse HCS-DD-EL-SP-003.pdf"  (user named the file)
PLAN: [1] gitlab_mcp.read_artifact_mcp(project=<repo>,
                                       path="HCS-DD-EL-SP-003.pdf")
      [2] llm.synthesize  (depends_on=[1])
2 steps.

Q: "tell me what the spec says about VT secondary voltage"  (no filename)
PLAN: [1] gitlab_mcp.search_blobs(query="VT secondary voltage",
                                  project=<repo>)
      [1] context_search.search_context(query="VT secondary voltage",
                                        project=<repo>)              ← parallel
      [2] gitlab_mcp.read_artifact_mcp(path=<top hit>)
                                            (depends_on=[1])
      [3] llm.synthesize  (depends_on=[2])
3 logical, 4 actual steps (two run in parallel).

Q: "how many MV panels does this project have?"  (TPMS-shaped)
PLAN: [1] tpms_context_agent.get_project_context(
                oenum=<oenum>, sections=["panels"])
      [2] llm.synthesize  (depends_on=[1])
2 steps.

Q: "we discussed the earthing strategy two weeks ago — what did we
    decide?"  (chat-history reference older than the last 5 turns)
PLAN: [1] memory_query(query="earthing strategy decision",
                       scope="chat_history", project_id=<id>)
      [2] llm.synthesize  (depends_on=[1])
2 steps.

Q: "switch ABC plant 6.6kV to 3.3kV — blast radius?"  (complex)
PLAN: [1] context_search.search_past_cot("voltage downgrade blast radius")
      [1] tpms_context_agent.get_project_context(
                oenum, sections=["panels","feeders","customer_specs"])
      [1] gitlab_mcp.search_technical_knowledge(
                "6kV to 3.3kV conversion checklist")
                                                  ← three retrievals in parallel
      [2] context_search.aggregate_field(
                index="projects", group_by="motor_type",
                filter_query="oenum:<oenum>")     (depends_on=[1])
      [3] llm.synthesize  (depends_on=[1,2])
5 steps; three of them concurrent.

============================================================================
OUTPUT — VALID JSON ONLY, NO PROSE BEFORE OR AFTER
============================================================================
For each step, specify:
1. step_number (integer, 1-indexed)
2. title (short imperative — "Read spec PDF")
3. description (one sentence: what + why)
4. task_type: one of action | query | analysis | generation | review |
              shell_command | email
5. tool_needed (exact tool name from the catalog above; bare name, no
                "gitlab_mcp." prefix — the dispatcher strips it but the
                planner should emit the bare name to make the plan
                self-documenting)
6. tool_input (specific parameters as a JSON object)
7. depends_on (array of step_numbers; [] for retrieval steps that run
               independently; non-empty for synthesis steps and chained
               reads)
8. priority (1-10; higher runs sooner among independent steps)
9. estimated_duration (string with unit, e.g. "10s")

TOKEN BUDGET — STRICT.
  • `reasoning`            ≤  40 words (1-2 sentences naming the rung)
  • each `description`     ≤  15 words (one verb-phrase, no rationale)
  • each `title`           ≤   6 words
  • whole plan             ≤   5 steps unless absolutely necessary
  • total JSON             ≤ 1500 tokens (gpt-oss-20b's 4096-token cap
                                          on the planner reply runs out
                                          mid-step when this is exceeded
                                          and the WHOLE plan is lost)
Be terse — the agent reads your plan, not your essay. Repeating the
user's question in the reasoning is a waste; assume the executor
knows the context.

Respond with ONLY valid JSON in this exact format:
{{
    "reasoning": "Your routing decision: which ladder rung(s) you picked and why",
    "steps": [
        {{
            "step_number": 1,
            "title": "Step title",
            "description": "What this step does and why",
            "task_type": "query",
            "tool_needed": "get_project_tree",
            "tool_input": {{"project": "group/repo"}},
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
- techserver_get_tree: List a legacy techserver project tree by OE number (Drawing/ CAD excluded; no download). Input: {{"oenum": "12065"}}
- techserver_read_artifact: Fetch ONE techserver file as markdown. Input: {{"oenum": "12065", "path": "Document/Client/Spec/...pdf"}}"""


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

        # Early lookup of sources_enabled — both the tool-catalog
        # filter below AND the later guardrail block need it. (The
        # later block REASSIGNS this to the same value so behaviour is
        # unchanged for that code path.)
        sources_enabled = (
            project_context.get("sources_enabled")
            or (project_context.get("project") or {}).get("sources_enabled")
            or {}
        )

        # Build dynamic tool list from MCP or use fallback. PER-QUERY
        # SELECTION + CAPABILITY-AWARE EXCLUSION:
        #
        # 1. Score tools by token-overlap with the user query, return
        #    top_n + always-include core. (Anthropic Tool Search Tool
        #    pattern — 49→74% MCP-eval improvement.)
        # 2. Detect missing project capabilities and exclude tool
        #    families that can only fail:
        #      • No tpms_oenum → exclude tpms_*, get_project_context,
        #        get_holidays / get_company_directory etc. (the TPMS-
        #        keyed org tools). Operator hit a wizard repo-only
        #        project where the planner picked tpms_fetch and the
        #        whole chain failed with "Project <oenum> not found
        #        in TPMS" / "required oenum field missing".
        proj_meta = (project_context.get("project") or {}) or project_context
        has_tpms = bool(
            proj_meta.get("tpms_oenum")
            or project_context.get("tpms_oenum")
            or sources_enabled.get("tpms")
        )
        exclude_prefixes: list[str] = []
        if not has_tpms:
            exclude_prefixes.extend([
                "tpms_",       # tpms_fetch, tpms_get_text, tpms_context_*
                "get_project_context",  # tpms_context_agent's
                "get_holidays",
                "get_company_directory",
                "get_employee",
                "lookup_employee",
                "list_departments",
                "get_hiring_periods",
                "get_corporate_loan",
                "get_employee_attendance",
            ])

        if self.mcp_manager and self.mcp_manager.is_connected:
            mcp_tool_lines = self.mcp_manager.get_tools_for_cot(
                query=request.user_input,
                top_n=int(os.getenv("COT_MCP_TOPN", "15")),
                exclude_prefixes=exclude_prefixes or None,
            )
            mcp_tools = f"You also have access to these microservice tools (via MCP):\n{mcp_tool_lines}"
            if not has_tpms:
                # Even though the tools are excluded from the catalog,
                # gpt-oss-20b sometimes hallucinates tool calls based
                # on training data. A short explicit hint here cuts
                # those off — pure prompt engineering, no runtime cost.
                mcp_tools += (
                    "\n# IMPORTANT: this project has NO TPMS OENUM. "
                    "DO NOT plan steps against tpms_* tools or "
                    "TPMS-keyed org-data lookups — they will fail "
                    "with 'Project <oenum> not found in TPMS'. Use "
                    "gitlab_mcp.* tools (get_project_tree, "
                    "read_artifact_mcp, search_blobs) plus "
                    "context_search.search_context for ALL content "
                    "questions about this project."
                )
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
                # Surface the techserver OE number so the planner can fill
                # techserver_get_tree(oenum=...) without guessing. It lives
                # in sources_enabled.techserver_oenum (set by the wizard) or
                # falls back to the project's tpms_oenum.
                ts_oenum = (
                    sources_enabled.get("techserver_oenum")
                    or proj_meta.get("techserver_oenum")
                    or proj_meta.get("tpms_oenum")
                    or project_context.get("tpms_oenum")
                    or ""
                )
                oenum_hint = (
                    f" The OE number for this project is {ts_oenum}; pass "
                    f"oenum=\"{ts_oenum}\" to both tools."
                    if ts_oenum else
                    " Extract the OE number from the user's message and pass "
                    "it as oenum."
                )
                allowed_lines.append(
                    "  - techserver_get_tree / techserver_read_artifact — for "
                    "ANY question about this project's files, FIRST call "
                    "techserver_get_tree(oenum) to list the tree (Drawing/ CAD "
                    "excluded), then techserver_read_artifact(oenum, path=<exact "
                    "path from the tree>) to read a specific file." + oenum_hint
                )
            else:
                allowed_lines.append(
                    "  - techserver is DISABLED — do NOT call techserver_get_tree "
                    "or techserver_read_artifact."
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

        # Phase 2: active CoT plan integration. The router installed a
        # plan in the cot_router contextvar at handle_input time;
        # apply its system-prompt addendum and gather its grounding
        # bundle here. None = old code path (no addendum, no
        # grounding) so internal/background callers that bypassed
        # handle_input continue to work.
        plan_addendum = ""
        plan_grounding_text = ""
        try:
            from services.cot_router import active_plan
            from services.cot_plans import PlanContext
            plan = active_plan()
            if plan is not None:
                # Build the minimal PlanContext cot_engine can supply.
                # The richer PlanContext that handle_input built isn't
                # passed down explicitly; plans that need more data
                # pick it up via service singletons (e.g.
                # knowledge_repo_service.retrieve already has its
                # own state). request.project_id is the only field
                # we can pull here without restructuring.
                # Carry techserver source state so TechserverPlan's
                # addendum can emit the OE number. sources_enabled was
                # resolved above; techserver_oenum lives there or on the
                # project meta.
                _ts_oenum = (
                    sources_enabled.get("techserver_oenum")
                    or proj_meta.get("techserver_oenum")
                    or proj_meta.get("tpms_oenum")
                    or project_context.get("tpms_oenum")
                    or None
                )
                plan_ctx = PlanContext(
                    user_input=request.user_input,
                    project_id=getattr(request, "project_id", "") or "",
                    has_techserver=bool(sources_enabled.get("techserver")),
                    techserver_oenum=str(_ts_oenum) if _ts_oenum else None,
                )
                plan_addendum = plan.system_prompt_addendum(plan_ctx) or ""
                grounding = await plan.gather_grounding(plan_ctx)
                rendered = grounding.render() if grounding else ""
                if rendered:
                    plan_grounding_text = (
                        "\n\n# KNOWLEDGE GROUNDING (always-on technical knowledge "
                        "passages — consider these BEFORE running search tools; "
                        "they often already answer the question):\n" + rendered
                    )
        except Exception as e:
            logger.warning("cot plan integration failed (continuing without): %s", e)

        if plan_addendum:
            system_prompt = system_prompt + plan_addendum

        user_msg = (
            f"Project Context:\n{context_str}{plan_grounding_text}"
            f"\n\nUser Request:\n{request.user_input}"
        )

        # Hard safety cap. gpt-oss-20b has a 16,384-token max_model_len
        # which is a HARD limit on input+output. With max_tokens=4096
        # for the planner's reply, the input budget is 16384 - 4096 =
        # 12,288 tokens. Empirical chars-per-token on the planner's
        # actual prompts (English instructions + Persian user input +
        # mixed-language project context + JSON-schema-ish tool list)
        # is ≈ 4.1 — measured from a prior operator log where 72,643
        # chars came back as 17,669 tokens. So 12,288 × 4.1 ≈ 50,400
        # chars. Cap at 49,000 to leave a small margin.
        BUDGET_CHARS = int(os.getenv("COT_PROMPT_BUDGET_CHARS", "49000"))
        total = len(system_prompt) + len(user_msg)
        if total > BUDGET_CHARS:
            over = total - BUDGET_CHARS
            logger.warning(
                "cot prompt over budget by %d chars (total=%d, limit=%d); "
                "trimming to fit",
                over, total, BUDGET_CHARS,
            )
            # Trim 1: drop the KNOWLEDGE GROUNDING block entirely.
            if plan_grounding_text and over > 0:
                saved = len(plan_grounding_text)
                user_msg = user_msg.replace(plan_grounding_text, "")
                over -= saved
                logger.warning("  dropped grounding (-%d chars)", saved)
            # Trim 2: tail-truncate context_str. The most recent rows
            # of project context are usually the most relevant; lop
            # off the HEAD (older / static guardrails) first.
            if over > 0 and context_str in user_msg:
                cut = min(len(context_str), over + 500)
                user_msg = user_msg.replace(
                    f"Project Context:\n{context_str}",
                    f"Project Context:\n[... {cut} chars trimmed for token budget ...]"
                    + context_str[cut:],
                )
                logger.warning("  trimmed project context head (-%d chars)", cut)
                over -= cut
            # Trim 3: if still over, rebuild the system prompt with
            # an ultra-compact MCP-tool list — just "- name: desc",
            # no input keys at all. The planner still knows tools
            # exist; arg schemas land via tool-call validation at
            # dispatch time. Saves ~3-5K chars on a 19-server deploy.
            if over > 0 and self.mcp_manager and getattr(self.mcp_manager, "is_connected", False):
                try:
                    skinny = "\n".join(
                        f"- {t.name}: {(t.description or 'No description').split('.')[0]}"
                        for t in self.mcp_manager.tool_schemas.values()
                    )
                    skinny_block = (
                        "You also have access to these microservice tools "
                        "(via MCP):\n" + skinny
                    )
                    if mcp_tools in system_prompt:
                        delta = len(mcp_tools) - len(skinny_block)
                        if delta > 0:
                            system_prompt = system_prompt.replace(mcp_tools, skinny_block)
                            over -= delta
                            logger.warning(
                                "  swapped mcp_tools to ultra-compact (-%d chars)",
                                delta,
                            )
                except Exception as e:
                    logger.warning("  mcp_tools skinny-swap failed: %s", e)
            # Final report. The 4.1 chars/token estimate gives the
            # planner some tolerance — being a few thousand chars over
            # the budget often still tokenises within the 12K input
            # limit (operator observed 3933-char overage that still
            # returned 200 OK). Only WARN here; the actual planner
            # call will surface a real error via the gateway logger
            # if it does fail.
            if over > 4000:
                logger.warning(
                    "cot prompt STILL over budget after all trims; "
                    "remaining over=%d chars. The 4.1 chars/token "
                    "estimate has some slack, but if the planner "
                    "returns 400 'Input length exceeds…' next, "
                    "consider lowering COT_PROMPT_BUDGET_CHARS or "
                    "COT_MCP_TOPN.", over,
                )

        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_msg}
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

            # PLAN VALIDATION + ONE-SHOT REFLECTIVE REPROMPT.
            # Operator-observed failure: gpt-oss-20b sometimes emits a
            # plan where every step is task_type=generation / tool=llm
            # (e.g. "Find OENUM", "Read OENUM file", "Extract OENUM
            # value"), which the dispatcher routes to _execute_llm_task
            # — pure LLM thinking with NO retrieval. The model then
            # produces "I don't have access to that information"
            # because it has no actual tool output to read.
            #
            # Best practice (multi-agent validation papers): catch the
            # bad plan before execution and re-prompt ONCE with the
            # validation error fed back to the planner. We don't loop
            # forever — one corrective turn is enough; if it still
            # fails, run the (likely-broken) plan rather than burn
            # more model time.
            issues = self._validate_plan(analysis)
            if issues:
                logger.warning(
                    "COT plan validation: %d issue(s) — reprompting once: %s",
                    len(issues), "; ".join(issues),
                )
                corrective = (
                    "\n\n# PLAN REJECTED — fix and resubmit\n"
                    "Your previous plan violated these HARD rules:\n  - "
                    + "\n  - ".join(issues)
                    + "\nResubmit a corrected plan. Reminder: only the "
                    "LAST step may be task_type=generation / tool=llm; "
                    "every earlier step MUST call a real retrieval tool "
                    "(get_project_tree, read_artifact_mcp, search_context, "
                    "search_blobs, memory_query). Steps named 'Find / Read / "
                    "Extract / Fetch / Locate / Look up' REQUIRE a tool call, "
                    "not LLM thinking."
                )
                retry_messages = [
                    {"role": "system", "content": system_prompt + corrective},
                    {"role": "user", "content": user_msg},
                ]
                try:
                    response2 = await self._call_llm(retry_messages)
                    analysis2 = self._parse_llm_response(response2, chain_id, request)
                    issues2 = self._validate_plan(analysis2)
                    if not issues2:
                        logger.info(
                            "COT plan validation: retry produced a clean plan "
                            "(%d steps)", len(analysis2.steps),
                        )
                        analysis = analysis2
                    else:
                        # Pick whichever attempt has fewer issues.
                        if len(issues2) < len(issues):
                            logger.warning(
                                "COT plan validation: retry still has issues "
                                "(%s) but improved; using retry plan",
                                "; ".join(issues2),
                            )
                            analysis = analysis2
                        else:
                            logger.warning(
                                "COT plan validation: retry did not improve "
                                "(%s); using original plan", "; ".join(issues2),
                            )
                except Exception as e:
                    logger.warning(
                        "COT plan validation: retry call failed (%s); "
                        "using original plan", e,
                    )

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

        Routing precedence:
          1. ``LLM_GATEWAY_URL`` + guided_json — PRIMARY. vLLM's
             outlines / xgrammar backend constrains generation to the
             COT_PLAN_SCHEMA at decode time, so the response is
             guaranteed parseable JSON with the right field names.
             Confirmed working on gpt-oss-20b@.61 (finish_reason=stop,
             ~1s, correct shape).
          2. ``LLM_GATEWAY_URL`` + tools=[submit_plan] (Harmony) —
             SECONDARY. vLLM on .61 launches with
             ``--tool-call-parser openai`` but NO guided-decoding
             backend on the tool-call channel, so the inner
             ``arguments`` JSON is unconstrained. gpt-oss-20b
             routinely truncates or hallucinates field names there;
             ``_parse_llm_response`` then silently substitutes a
             "Direct response" stub and the user sees a polite "I
             don't know" apology. Keep this only as a fallback in
             case guided_json is unavailable on a future build.
          3. ``COT_LLM_BASE_URL`` — Qwen2.5-VL-7B on .62. Kept so
             the planner still works if the LLM gateway is wedged.
          4. ``self.llm_service`` — generic legacy path.

        Set ``COT_PLANNER_PRIMARY=harmony`` to opt the old order back
        in for A/B testing.
        """
        gateway_url = os.getenv("LLM_GATEWAY_URL", "").strip().rstrip("/")
        primary = os.getenv("COT_PLANNER_PRIMARY", "guided_json").strip().lower()

        if gateway_url and primary != "harmony":
            try:
                return await self._call_llm_gateway_structured(gateway_url, messages)
            except Exception as e:
                logger.warning(
                    "CoT planner via gateway guided_json (%s) failed: %s; "
                    "falling back to Harmony tool-calls",
                    gateway_url, e,
                )

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
                    "falling back to default llm_service"
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

        Two upstream-informed tweaks vs. the naive shape:

        1. ``tool_choice="auto"`` (not forced submit_plan). vLLM's
           recipe for gpt-oss explicitly states "only tool_choice=auto
           is supported" — forced named-function tool_choice on the
           Chat Completions endpoint is documented as unsupported and
           in practice degrades to the model writing the plan to the
           content channel instead of calling the tool. With auto +
           a strong tool description + the conflicting "respond with
           JSON" footer stripped (see below), gpt-oss reliably picks
           the tool.

        2. The COT_SYSTEM_PROMPT footer that says "Respond with ONLY
           valid JSON in this exact format" is stripped on this code
           path. That instruction conflicts with Harmony's channel
           separation (final vs commentary) and forces the model to
           emit the plan as final-channel content. Replaced with a
           short footer that explicitly directs gpt-oss to call the
           tool.

        Output: the JSON-encoded plan, returned as a string so the
        existing ``_parse_llm_response`` keeps working unchanged. The
        content-channel-recovery branch below is the belt-and-braces
        for cases where the model still skips the tool.
        """
        import httpx
        timeout = float(os.getenv("LLM_GATEWAY_COT_TIMEOUT_SEC", "180"))

        # Strip the "Respond with ONLY valid JSON" footer from the
        # system prompt so Harmony's channel routing isn't fighting
        # an explicit format instruction. Replace with a tool-call-
        # native footer. Anchor is COT_SYSTEM_PROMPT's section header.
        messages = list(messages)
        if messages and messages[0].get("role") == "system":
            sys_txt = messages[0]["content"] or ""
            marker = "OUTPUT — VALID JSON ONLY, NO PROSE BEFORE OR AFTER"
            idx = sys_txt.find(marker)
            if idx > 0:
                sys_txt = sys_txt[:idx].rstrip() + "\n\n" + _HARMONY_FOOTER
                messages[0] = {"role": "system", "content": sys_txt}

        submit_plan_tool = {
            "type": "function",
            "function": {
                "name": "submit_plan",
                "description": (
                    "Submit your chain-of-thought plan. You MUST call this "
                    "tool exactly once — do NOT write the plan as a final "
                    "response. Pass `reasoning` (one paragraph naming the "
                    "retrieval ladder rung you picked) and `steps` (the "
                    "ordered task list; each step has step_number, title, "
                    "description, task_type, tool_needed, tool_input, "
                    "depends_on, priority, estimated_duration)."
                ),
                "parameters": COT_PLAN_SCHEMA,
            },
        }

        payload = {
            "messages":      messages,
            "mode":          "offline",
            "force_backend": "text",
            "temperature":   0.3,
            "max_tokens":    int(os.getenv("COT_LLM_MAX_TOKENS", "4096")),
            "tools":         [submit_plan_tool],
            # vLLM's gpt-oss recipe only supports tool_choice="auto".
            # Forced named-function tool_choice is documented as not
            # working on the Chat Completions endpoint; in production
            # it caused gpt-oss to write the plan to the content
            # channel instead of calling submit_plan.
            "tool_choice":   "auto",
        }

        async with httpx.AsyncClient(timeout=timeout) as client:
            r = await client.post(f"{gateway_url}/generate", json=payload)
            if r.status_code != 200:
                snippet = (r.text or "")[:600]
                logger.error(
                    "harmony planner: gateway %s returned %d; body=%s",
                    gateway_url, r.status_code, snippet,
                )
                r.raise_for_status()
            body = r.json()

        tool_calls = body.get("tool_calls") or []
        if not tool_calls:
            # gpt-oss-20b regularly ignores tool_choice for the planner
            # because COT_SYSTEM_PROMPT ends with "Respond with ONLY
            # valid JSON" — that instruction outranks the tool-call
            # channel and the model writes the plan to `content` as
            # plain JSON. When that happens, recover the content as if
            # it were the tool arguments; _parse_llm_response handles
            # the same shape downstream (outer-brace reparse +
            # _salvage_partial_steps). Falling through to VLM here is
            # wasteful — we already have a usable plan in hand.
            content = (body.get("response") or "").strip()
            if content.startswith("{") and '"steps"' in content:
                logger.info(
                    "harmony: content-channel JSON detected (finish=%s, "
                    "len=%d) — using content as plan",
                    body.get("finish_reason"), len(content),
                )
                return content
            raise RuntimeError(
                "harmony: tool_calls empty, "
                f"finish={body.get('finish_reason')}, "
                f"response[:200]={(body.get('response') or '')[:200]!r}"
            )

        args = tool_calls[0].get("function", {}).get("arguments") or ""
        args_str = args if isinstance(args, str) else json.dumps(args)
        # Sanity-check that the arguments are parseable JSON BEFORE
        # returning. vLLM's openai tool-call parser doesn't enforce
        # COT_PLAN_SCHEMA at decode time, so gpt-oss-20b regularly
        # truncates the arguments mid-object — finish_reason still
        # says "tool_calls" but the JSON is missing its closing brace.
        # Raising here lets _call_llm fall through to guided_json /
        # the VLM planner; swallowing it would surface as the
        # "Direct response" silent fallback.
        try:
            json.loads(args_str)
        except json.JSONDecodeError as je:
            raise RuntimeError(
                f"harmony: tool_call arguments not JSON ({je}); "
                f"finish={body.get('finish_reason')}, "
                f"args_len={len(args_str)}, args[:300]={args_str[:300]!r}"
            ) from je
        return args_str

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
            "max_tokens": int(os.getenv("COT_LLM_MAX_TOKENS", "4096")),
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
        reliability.

        Retries ONCE on apparent truncation: if the returned JSON
        doesn't close cleanly (unterminated string / missing ]/}),
        we re-issue with 2× max_tokens. Operator saw repeated cases
        where 2048 tokens were enough for reasoning + step 1 but
        cut step 2 in half, dropping the plan to 1-step and losing
        the file-read task entirely (2026-05-24)."""
        return await self._call_gateway_with_retry(
            gateway_url, messages,
            initial_tokens=int(os.getenv("COT_LLM_MAX_TOKENS", "4096")),
            retry_multiplier=2,
        )

    async def _call_gateway_with_retry(
        self, gateway_url: str, messages: List[Dict[str, str]],
        initial_tokens: int, retry_multiplier: int,
    ) -> str:
        import httpx
        timeout = float(os.getenv("LLM_GATEWAY_COT_TIMEOUT_SEC", "180"))

        async def _attempt(max_tokens: int) -> str:
            payload = {
                "messages": messages,
                "mode": "offline",
                "force_backend": "text",
                "temperature": 0.3,
                "max_tokens": max_tokens,
                "extra": {"guided_json": COT_PLAN_SCHEMA},
            }
            async with httpx.AsyncClient(timeout=timeout) as c:
                r = await c.post(f"{gateway_url}/generate", json=payload)
                if r.status_code != 200:
                    snippet = (r.text or "")[:600]
                    logger.error(
                        "guided_json planner: gateway %s returned %d; body=%s",
                        gateway_url, r.status_code, snippet,
                    )
                    r.raise_for_status()
                body = r.json()
            return body.get("response", "") or ""

        first = await _attempt(initial_tokens)
        if _looks_truncated(first):
            bumped = initial_tokens * retry_multiplier
            logger.warning(
                "guided_json planner: first attempt looked truncated at "
                "%d tokens; retrying with %d",
                initial_tokens, bumped,
            )
            try:
                second = await _attempt(bumped)
                # Use the longer attempt only if it actually closes cleanly;
                # if it ALSO truncates, return the first so the parser at
                # least sees some valid prefix.
                if not _looks_truncated(second):
                    return second
            except Exception as e:
                logger.warning(
                    "guided_json planner: retry at %d tokens failed: %s; "
                    "falling back to first attempt", bumped, e,
                )
        return first

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
        except json.JSONDecodeError as je_outer:
            # Truncated/malformed JSON. Try in order:
            #   1. Find the outermost {...} braces and reparse.
            #   2. Salvage complete step objects from a partial steps[]
            #      array (gpt-oss-20b truncates mid-step regularly when
            #      the plan is long — the steps BEFORE the truncation
            #      are usually fine).
            #   3. Plan-aware fallback: build a sensible retrieval plan
            #      based on the active CoT plan (single_repo gets a
            #      tree→search→read→synth plan instead of the old
            #      "Direct response" stub that hallucinated answers).
            data = None
            # (1) outer brace reparse
            start = response.find("{")
            end = response.rfind("}") + 1
            if start >= 0 and end > start:
                try:
                    data = json.loads(response[start:end])
                except json.JSONDecodeError:
                    pass
            # (2) salvage complete step objects
            if data is None or not data.get("steps"):
                salvaged = self._salvage_partial_steps(response)
                if salvaged:
                    logger.warning(
                        "COT plan parse: salvaged %d complete step(s) "
                        "from truncated JSON", len(salvaged),
                    )
                    data = {
                        "reasoning": (
                            "Plan JSON was truncated; recovered the steps "
                            "that parsed cleanly."
                        ),
                        "steps": salvaged,
                    }
            # (3) plan-aware fallback
            if data is None or not data.get("steps"):
                logger.warning(
                    "COT LLM response not JSON-parseable (outer=%s), "
                    "raw[:2000]=%r",
                    je_outer, response[:2000],
                )
                data = self._fallback_plan_for_active(request)

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

    def _validate_plan(self, analysis: "COTAnalysis") -> List[str]:
        """Catch the no-tool-call plan pattern before execution.

        Returns a list of human-readable issues. Empty list = OK.

        Rules (HARD — enforced by retry-with-feedback):
          R1. Only the LAST step may be task_type=generation/analysis/review
              with tool=llm. Earlier "thinking" steps mean retrieval was
              skipped.
          R2. A plan with >1 step but ZERO retrieval-tool steps is broken
              — the synth step has nothing to read.
          R3. Step titles starting with action verbs that imply retrieval
              ("find", "read", "extract", "fetch", "locate", "look up",
              "search", "list", "get") MUST use a real tool, not llm.

        Single-step plans are exempt — a single llm step is the
        legitimate "I don't need tools, just answer" shape.
        """
        issues: List[str] = []
        steps = list(getattr(analysis, "steps", []) or [])
        n = len(steps)
        if n <= 1:
            return issues

        def _is_llm_synth(step) -> bool:
            tool = (getattr(step, "tool_needed", "") or "").lower()
            tt = getattr(step, "task_type", None)
            tt_val = getattr(tt, "value", tt)
            tt_str = str(tt_val or "").lower()
            return tool == "llm" or tt_str in {"generation", "analysis", "review"}

        # R1: every non-last step must be a real tool call.
        bad_thinking = []
        for s in steps[:-1]:
            if _is_llm_synth(s):
                bad_thinking.append(
                    f"step {s.step_number} '{s.title}' is "
                    f"tool=llm/task_type=generation — only the LAST step "
                    f"may be synthesis"
                )
        issues.extend(bad_thinking)

        # R2: at least one retrieval step.
        retrieval_count = sum(1 for s in steps if not _is_llm_synth(s))
        if retrieval_count == 0:
            issues.append(
                f"plan has {n} steps but ZERO retrieval-tool calls — every "
                "step is llm thinking; the synthesizer will have no real "
                "data to read"
            )

        # R3: action-verb titles must be real tool calls.
        _RETRIEVAL_VERBS = (
            "find ", "read ", "extract ", "fetch ", "locate ", "look up ",
            "lookup ", "search ", "list ", "get ", "load ", "open ",
            "discover ", "identify ", "retrieve ",
        )
        for s in steps:
            title = (getattr(s, "title", "") or "").strip().lower()
            if _is_llm_synth(s) and any(title.startswith(v) for v in _RETRIEVAL_VERBS):
                issues.append(
                    f"step {s.step_number} '{s.title}' implies retrieval "
                    f"(verb '{title.split()[0]}') but uses tool=llm — must "
                    f"call a real tool (get_project_tree, read_artifact_mcp, "
                    f"search_context, search_blobs, memory_query)"
                )

        return issues

    def _salvage_partial_steps(self, response: str) -> List[Dict[str, Any]]:
        """Pull complete step objects out of a truncated planner reply.

        gpt-oss-20b often emits valid JSON for the first N steps and then
        gets cut off mid-step N+1. The complete steps BEFORE the cut are
        usable — extract them by brace-balancing inside the steps array.
        """
        # Locate the steps array opener.
        steps_at = response.find('"steps"')
        if steps_at < 0:
            return []
        # Find the '[' that opens the array.
        lbracket = response.find("[", steps_at)
        if lbracket < 0:
            return []
        # Walk forward, brace-balancing each {...} object.
        i = lbracket + 1
        n = len(response)
        salvaged: List[Dict[str, Any]] = []
        while i < n:
            # Skip whitespace and commas.
            while i < n and response[i] in " \t\r\n,":
                i += 1
            if i >= n or response[i] == "]":
                break
            if response[i] != "{":
                break
            # Find the matching closing brace, tracking strings.
            depth = 0
            j = i
            in_str = False
            esc = False
            while j < n:
                ch = response[j]
                if in_str:
                    if esc:
                        esc = False
                    elif ch == "\\":
                        esc = True
                    elif ch == '"':
                        in_str = False
                else:
                    if ch == '"':
                        in_str = True
                    elif ch == "{":
                        depth += 1
                    elif ch == "}":
                        depth -= 1
                        if depth == 0:
                            j += 1
                            break
                j += 1
            if depth != 0:
                # Unbalanced — this object is the truncated one. Stop.
                break
            chunk = response[i:j]
            try:
                obj = json.loads(chunk)
                if isinstance(obj, dict) and obj.get("title"):
                    salvaged.append(obj)
            except json.JSONDecodeError:
                break
            i = j
        return salvaged

    def _fallback_plan_for_active(self, request: COTRequest) -> Dict[str, Any]:
        """Hardcoded retrieval plan when the LLM plan parse fails entirely.

        Without this, the fallback was a single ``llm.generation`` step
        that hallucinated answers from training data (operator hit this
        on "CT characteristics" — got a generic table from the LLM's
        prior knowledge instead of the project's PDF). When a CoT plan
        is active, build a real retrieval template instead.
        """
        plan_name = ""
        try:
            from services.cot_router import active_plan
            plan = active_plan()
            if plan is not None:
                plan_name = getattr(plan, "name", "") or ""
        except Exception:
            pass

        q = request.user_input

        if plan_name in {"single_repo", "repo_plus_upload"}:
            return {
                "reasoning": (
                    "Planner output was unparseable; using deterministic "
                    f"{plan_name} retrieval template."
                ),
                "steps": [
                    {"step_number": 1, "title": "List repository files",
                     "description": "Get the project tree to locate relevant files.",
                     "task_type": "query", "tool_needed": "get_project_tree",
                     "tool_input": {"project": "<repo>", "recursive": True},
                     "depends_on": [], "priority": 9},
                    {"step_number": 2, "title": "Semantic search",
                     "description": "Semantic search across project content.",
                     "task_type": "query", "tool_needed": "search_context",
                     "tool_input": {"query": q, "project_id": request.project_id},
                     "depends_on": [], "priority": 8},
                    {"step_number": 3, "title": "Keyword grep",
                     "description": "GitLab blob grep for literal terms.",
                     "task_type": "query", "tool_needed": "search_blobs",
                     "tool_input": {"query": q, "project": "<repo>"},
                     "depends_on": [], "priority": 7},
                    {"step_number": 4, "title": "Read top hit",
                     "description": "Read the file most likely to answer the question.",
                     "task_type": "query", "tool_needed": "read_artifact_mcp",
                     "tool_input": {"project": "<repo>", "path": ""},
                     "depends_on": [1, 2, 3], "priority": 6},
                    {"step_number": 5, "title": "Synthesize answer",
                     "description": "Combine retrieved context into the final answer.",
                     "task_type": "generation", "tool_needed": "llm",
                     "tool_input": {"prompt": q, "use_context": True},
                     "depends_on": [1, 2, 3, 4], "priority": 5},
                ],
            }

        if plan_name == "knowledge_only":
            return {
                "reasoning": "Planner unparseable; falling back to knowledge-only template.",
                "steps": [
                    {"step_number": 1, "title": "Search technical knowledge",
                     "description": "Search the EKC technical knowledge base.",
                     "task_type": "query", "tool_needed": "search_technical_knowledge",
                     "tool_input": {"query": q},
                     "depends_on": [], "priority": 8},
                    {"step_number": 2, "title": "Synthesize answer",
                     "description": "Combine knowledge hits into the final answer.",
                     "task_type": "generation", "tool_needed": "llm",
                     "tool_input": {"prompt": q, "use_context": True},
                     "depends_on": [1], "priority": 5},
                ],
            }

        # Last resort — no active plan, no template. Don't hallucinate;
        # at least tell the user the plan failed.
        return {
            "reasoning": "Plan generation failed and no retrieval template was available.",
            "steps": [{
                "step_number": 1, "title": "Plan generation failed",
                "description": (
                    "I couldn't generate a structured plan for this request. "
                    "Please try rephrasing, or break the question into smaller parts."
                ),
                "task_type": "generation", "tool_needed": "llm",
                "tool_input": {"prompt": (
                    "Reply to the user honestly that the planner failed to "
                    "produce a structured plan; do not invent an answer."
                )},
                "depends_on": [], "priority": 5,
            }],
        }

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
