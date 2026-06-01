"""CoT plan base class — the contract every specialized plan implements.

A plan is a lightweight strategy object — NOT a long-running agent.
It produces two outputs per request:

  1. system_prompt_addendum() — a short text block appended to
     COT_SYSTEM_PROMPT so the planner LLM knows the constraints of
     this strategy ("you have an upload, treat it as primary source",
     "no source selected, lean on the knowledge repo", etc.).

  2. gather_grounding() — a list of grounding blocks (passages with
     citations) that get woven into the user message before the
     planner runs. ALWAYS includes top-K from knowledge_repo (the
     silent always-on layer) plus whatever per-plan sources the
     plan considers primary.

The router calls one plan per request. Plans have no state of their
own — all per-request data lives in PlanContext (passed to
gather_grounding) so the same plan instance can serve concurrent
requests safely.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Protocol


@dataclass
class PlanContext:
    """Everything the router gathered about the request that a plan
    needs in order to decide its grounding strategy. Built once per
    request by the router and passed verbatim to the plan.

    Keeps the plan signatures stable across phase additions — when
    Phase 4's UploadDeep plan needs `upload_size_chars`, it just
    reads it off this object instead of getting a new function arg
    threaded through five layers.
    """
    user_input: str
    project_id: str
    user_id: Optional[str] = None
    chat_id: Optional[str] = None
    # Source state
    has_selected_repo: bool = False
    selected_repos: List[str] = field(default_factory=list)
    # Upload state — populated when the user attached a file to the
    # current turn. Future Phase-4 work uses upload_size_chars to
    # decide MapReduce vs inline.
    has_upload: bool = False
    upload_filenames: List[str] = field(default_factory=list)
    upload_size_chars: int = 0
    # Legacy techserver (SMB) source. Set when the project ticked the
    # techserver source at creation; techserver_oenum is the OE number
    # used to resolve the SMB share. Routed to TechserverPlan so the
    # planner uses techserver_get_tree / techserver_read_artifact rather
    # than the gitlab tools (which 404 on a repo-less project).
    has_techserver: bool = False
    techserver_oenum: Optional[str] = None
    # Modality
    input_modality: str = "text"   # "text" | "voice" | "mixed"
    # Recent history hint — useful for "follow-up to previous plan"
    # heuristics. Phase 5 wires this up; for now plans can leave it
    # alone.
    prior_plan_name: Optional[str] = None


@dataclass
class PlanGrounding:
    """A bundle of grounding passages that the plan wants the planner
    LLM to consider. Rendered into the user message as labelled
    blocks so the LLM can cite them by source.

    Shape kept generic on purpose — each block carries enough
    metadata that the synth step can quote it with a citation, but
    plans aren't forced to fill every field. `text` and `source`
    are the only required ones.
    """
    blocks: List[Dict[str, Any]] = field(default_factory=list)

    def add(self, *, text: str, source: str,
            section: Optional[str] = None,
            score: Optional[float] = None,
            origin: Optional[str] = None) -> None:
        """origin is a short label like "knowledge_repo" or "upload"
        or "selected_repo" that lets the synth prompt say "according
        to <origin>: …" without leaking implementation details."""
        self.blocks.append({
            "text": text, "source": source,
            "section": section, "score": score,
            "origin": origin or "unknown",
        })

    def is_empty(self) -> bool:
        return not self.blocks

    def render(self, max_chars: int = 2200) -> str:
        """Render as a labelled context block for the user message.
        Defaults sized to keep us comfortably under gpt-oss-20b's
        16384-token context (~12K chars header + 4K plans + ~3K
        grounding + ~1K user message). Operator hit a 17669-token
        prompt with the previous 6000-char default. Truncates per-
        block at PROMPT_CHUNK_CHAR_CAP-equivalent and the whole
        bundle at max_chars so a single bloated plan can't blow the
        context window. Returns "" when empty so callers can skip
        the section entirely."""
        if not self.blocks:
            return ""
        lines: List[str] = []
        total = 0
        per_block_cap = 450    # was 1200 — tight enough for 4-5 blocks
        for i, b in enumerate(self.blocks, start=1):
            text = (b.get("text") or "")
            if len(text) > per_block_cap:
                text = text[:per_block_cap].rstrip() + " …"
            header = f"[G{i}] {b.get('origin') or '?'}: {b.get('source') or '?'}"
            section = b.get("section")
            if section and section != b.get("source"):
                header += f" — {section}"
            piece = f"{header}\n{text}"
            if total + len(piece) > max_chars:
                lines.append("…(grounding truncated for token budget)")
                break
            lines.append(piece)
            total += len(piece) + 2
        return "\n\n".join(lines)


class CotPlan(Protocol):
    """Implement two methods. The router picks an instance and the
    cot_engine layer calls both methods exactly once per request."""

    @property
    def name(self) -> str: ...

    def system_prompt_addendum(self, ctx: PlanContext) -> str:
        """A short instruction block describing the plan's strategy
        in plain English. Appended to COT_SYSTEM_PROMPT after the
        retrieval-ladder section. Keep it under ~600 chars — the
        planner reads it on every turn, longer = slower + costlier.
        Return "" to skip the addendum."""

    async def gather_grounding(self, ctx: PlanContext) -> PlanGrounding:
        """Fetch the grounding passages this plan wants the planner
        and synth steps to consider. Always includes the silent
        knowledge_repo layer; per-plan additions go on top."""
