"""
project_facts.py — Build the immutable per-project facts block that
gets pinned at the top of every LLM call (both planner and ReAct).

Background
==========
The live chat reproduced two amnesia bugs:

  1. Model called `tpms_fetch({"table": "..."})` with no `oenum`, even
     though `oenum=12065` had been used successfully two turns earlier.
  2. User asked "do you have techserver file tree?" and the agent
     replied "Could you specify which OE number you're referring to?"
     even though the project's OE was 12065 the whole time.

Root cause (per the architecture map): the OE is injected into the
PLANNER's user message inside a "guardrails" block that's the FIRST
thing trimmed when the prompt exceeds ``COT_PROMPT_BUDGET_CHARS``.
The ReAct loop's system prompt has the OE in `source_rules` and is
pinned by ``_trim_history`` — but only because it lives in
``messages[0]``. CoT doesn't have that pin.

Solution
========
This module produces a single canonical ``<project_facts>`` block
that:
  - is identical across all callers (one source of truth)
  - carries every immutable project identifier the model might need
    (OE number, GitLab repo, sources enabled, user id, etc.)
  - is short (≤500 tokens) so it fits even on a tight budget
  - is marked with explicit "DO NOT FORGET / DO NOT DROP" instructions
    so the model treats it as pinned context

Callers prepend it to the planner user message and to the ReAct
system prompt. Both paths also TAG the block with sentinel markers
``<project_facts immutable="true">`` so the history-trim helpers can
skip blocks that carry this marker.

Mirrors Claude Code's CLAUDE.md / @memory pattern — facts above
history, never truncated as the window fills.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)


# Sentinel markers — both trim helpers check for these and skip the
# block when shedding tokens. Do NOT change the strings without
# updating cot_engine._trim_user_msg and react_engine._trim_history.
PROJECT_FACTS_OPEN  = "<project_facts immutable=\"true\">"
PROJECT_FACTS_CLOSE = "</project_facts>"


def _v(d: Dict[str, Any], *keys: str, default: str = "") -> str:
    """Safe nested-key getter. _v(d, 'a', 'b') ≡ d.get('a',{}).get('b','')."""
    cur: Any = d
    for k in keys:
        if not isinstance(cur, dict):
            return default
        cur = cur.get(k)
    return "" if cur is None else str(cur)


def build_project_facts(
    project: Optional[Dict[str, Any]],
    *,
    user_id: Optional[str] = None,
    extra: Optional[Dict[str, Any]] = None,
) -> str:
    """Render the canonical immutable-facts block for the active project.

    Parameters
    ----------
    project  Project row from memory_service.get_project(). Must include
             at least 'id'; missing keys render as '—' so the block
             stays uniform across projects with different sources.
    user_id  The authenticated user identifier (email / username /
             "anonymous"). Used by the model for output personalisation
             (tag generation, attribution).
    extra    Optional dict of arbitrary key→value pairs to append at
             the end of the block. Useful for short-lived context
             like the active session id.

    Returns
    -------
    A multi-line string starting with ``<project_facts immutable="true">``
    and ending with ``</project_facts>``. Always returns a string —
    never raises — so callers can prepend unconditionally.
    """
    p = project or {}
    se = p.get("sources_enabled") or {}

    lines = []
    # Identity
    name = _v(p, "name") or "—"
    pid  = _v(p, "id")   or "—"
    lines.append(f"Project: {name}")
    lines.append(f"Chatbot project id: {pid}")
    # Caller identity — used by tools like project_tagger to label
    # downstream Design Suite projects.
    lines.append(f"User: {user_id or _v(p, 'owner_id') or 'anonymous'}")
    lines.append("")  # blank line, easier to read in dumps

    # Sources — ONLY the truthy ones. The negative "tpms is DISABLED"
    # phrasing already exists in source_rules; here we just list the
    # facts. The planner / agent figures out which tools to use from
    # the dedicated source_rules block.
    src_lines = []
    if se.get("tpms"):
        oe = _v(p, "tpms_oenum") or _v(se, "techserver_oenum") or "—"
        src_lines.append(f"- tpms enabled  · OE number = {oe}")
    if se.get("techserver"):
        ts_oe = _v(se, "techserver_oenum") or _v(p, "tpms_oenum") or "—"
        src_lines.append(f"- techserver enabled  · OE = {ts_oe}")
    if se.get("gitlab"):
        repo = _v(p, "gitlab_repo_path") or _v(p, "gitlab_repo_url") or "—"
        branch = _v(p, "simorgh_branch") or _v(p, "default_branch") or "main"
        src_lines.append(f"- gitlab enabled  · repo = {repo}  · branch = {branch}")
    if se.get("upload") or se.get("uploads"):
        src_lines.append(f"- uploads always-on  · tenant = project:{pid}")
    if se.get("ekc"):
        src_lines.append("- ekc-technical-knowledge enabled")

    if src_lines:
        lines.append("Data sources allowed for this project:")
        lines.extend(src_lines)
    else:
        lines.append("Data sources: NONE enabled (chat-only fallback).")
    lines.append("")

    # Hard rules the model must respect. Short, declarative, no
    # rationale text — the model has the rationale in the system
    # prompt; here we just remind it of the values.
    lines.append("HARD RULES — DO NOT VIOLATE:")
    lines.append("- Use the values above verbatim in tool arguments.")
    lines.append("- NEVER ask the user for any value listed above; you already have it.")
    lines.append("- NEVER emit placeholders like <oenum>, <repo>, <id>; substitute the real value.")
    lines.append("- NEVER call a tool from a DISABLED source.")

    if extra:
        lines.append("")
        for k, v in extra.items():
            lines.append(f"{k}: {v}")

    # Render as one tagged block. The sentinel markers let the
    # trim helpers identify and PRESERVE this block when shedding
    # tokens. Generation timestamp at the end so consumers can spot
    # stale caches.
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ")
    body = "\n".join(lines)
    return f"{PROJECT_FACTS_OPEN}\n{body}\nGenerated-at: {ts}\n{PROJECT_FACTS_CLOSE}"


def looks_like_project_facts(s: str) -> bool:
    """Cheap detector used by history-trim helpers to skip the block."""
    return PROJECT_FACTS_OPEN in (s or "")


# ---------------------------------------------------------------------------
# Canonical resolvers — DEDUP the project-context lookup chains that
# previously had to be open-coded at every caller (3+ subtly different
# fallback orders in cot_engine.py alone). Single source of truth so
# planner, executor, gate, and prompts all see the same view of "what
# does this project have".
# ---------------------------------------------------------------------------
def resolve_sources_enabled(project_context: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Return the project's sources_enabled dict, regardless of whether the
    caller spread the project row directly or nested it under `project`.

    Replaces the open-coded pattern
        (pc.get("sources_enabled") or
         (pc.get("project") or {}).get("sources_enabled") or {})
    repeated at multiple sites.
    """
    pc = project_context or {}
    return (pc.get("sources_enabled")
            or (pc.get("project") or {}).get("sources_enabled")
            or {})


def resolve_proj_meta(project_context: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """The project row itself. Some call sites pass it spread into
    project_context, others nest it under `project`.
    """
    pc = project_context or {}
    return (pc.get("project") or {}) or pc


def resolve_tpms_oenum(project_context: Optional[Dict[str, Any]]) -> Optional[str]:
    """Canonical TPMS OE number resolver. Order:
        1. project.tpms_oenum            (set at TPMS-source project creation)
        2. project_context.tpms_oenum    (some callers spread it at top level)
        3. sources_enabled.techserver_oenum   (techserver wizard sometimes
           used this column as a stand-in OE before the dedicated
           tpms_oenum field existed).
    Returns None when no OE is known — never the empty string.
    """
    pc = project_context or {}
    meta = resolve_proj_meta(pc)
    se = resolve_sources_enabled(pc)
    val = (meta.get("tpms_oenum")
           or pc.get("tpms_oenum")
           or se.get("techserver_oenum"))
    return str(val) if val else None


def resolve_techserver_oenum(project_context: Optional[Dict[str, Any]]) -> Optional[str]:
    """Canonical TechServer OE resolver. Order:
        1. sources_enabled.techserver_oenum  (set by the techserver wizard)
        2. project.techserver_oenum          (some legacy projects)
        3. project.tpms_oenum                (same OE used for both sources
                                              in single-source-of-truth setups)
        4. project_context.tpms_oenum
    Returns None when nothing is known.
    """
    pc = project_context or {}
    meta = resolve_proj_meta(pc)
    se = resolve_sources_enabled(pc)
    val = (se.get("techserver_oenum")
           or meta.get("techserver_oenum")
           or meta.get("tpms_oenum")
           or pc.get("tpms_oenum"))
    return str(val) if val else None


def resolve_repo_path(project_context: Optional[Dict[str, Any]]) -> Optional[str]:
    """Canonical GitLab repo path resolver (`group/path` form)."""
    pc = project_context or {}
    meta = resolve_proj_meta(pc)
    val = (meta.get("gitlab_repo_path")
           or pc.get("gitlab_repo_path")
           or meta.get("gitlab_repo_url")
           or pc.get("gitlab_repo_url"))
    return str(val) if val else None


# ---------------------------------------------------------------------------
# precondition_blocked envelope — single canonical shape so submit_soft_spec
# (pending), submit_soft_spec (gaps), and the canUseTool gate all emit the
# same JSON. The ReAct loop's "HANDLING precondition_blocked" recipe in
# REACT_SYSTEM_PROMPT pattern-matches on this exact shape; previously each
# call site invented its own field set, which the model had to learn case
# by case.
# ---------------------------------------------------------------------------
def build_precondition_blocked(
    *,
    blocked_on: str,
    resolver: str,
    message: str,
    tool_attempted: Optional[str] = None,
    recipe: Optional[list] = None,
    hint: Optional[str] = None,
    **extra: Any,
) -> Dict[str, Any]:
    """Return the canonical envelope dict the dispatcher serialises into
    a tool result. Fields:
      error             "precondition_blocked" (constant)
      blocked_on        short reason key, e.g. "pending_proposals",
                        "spec_gaps", "source_disabled:tpms"
      resolver          the tool the model should call NEXT to unblock
      message           human-readable explanation (also rendered to user
                        if the model echoes it back)
      tool_attempted    name of the tool that was refused (optional)
      recipe            ordered list of next-step instructions (optional)
      hint              one-line suggestion for the model (optional)
      **extra           anything else the caller wants surfaced in metadata
    """
    out: Dict[str, Any] = {
        "error":      "precondition_blocked",
        "blocked_on": blocked_on,
        "resolver":   resolver,
        "message":    message,
    }
    if tool_attempted:
        out["tool_attempted"] = tool_attempted
    if recipe:
        out["recipe"] = list(recipe)
    if hint:
        out["hint"] = hint
    out.update(extra)
    return out
