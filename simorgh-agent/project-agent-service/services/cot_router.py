"""Master CoT router — picks a CotPlan per request.

Phase 2 implementation: HEURISTIC ONLY. The router inspects the
PlanContext that handle_input assembled and returns the matching
plan instance. There's no LLM call here — sub-3-second adaptive
routing (per the research) demands a heuristic-first router with
LLM fallback only on ambiguity. Phase 3 will add the per-source
plans; Phase 4 may add an LLM-router fallback for genuinely-
ambiguous cases (e.g. 3 repos AND a 50MB upload — which anchors
the answer?).

Plan resolution is exposed as a `route(ctx) -> CotPlan` function
plus a contextvar so the cot_engine layer can read the active
plan without an extra parameter being threaded through five
function signatures (same pattern as llm_mode in project_agent.py).
"""
from __future__ import annotations

import contextvars
import logging
from typing import Optional

from .cot_plans import (
    CotPlan, PlanContext,
    DefaultPlan,
    KnowledgeOnlyPlan, SingleRepoPlan, MultiRepoPlan,
    UploadDeepPlan, RepoPlusUploadPlan, VoiceFirstPlan,
)

log = logging.getLogger(__name__)

# Plan instances are stateless — one shared instance per class is
# enough and saves an allocation per request. ALL plans live here;
# router just picks which one to return.
_DEFAULT_PLAN          = DefaultPlan()
_KNOWLEDGE_ONLY_PLAN   = KnowledgeOnlyPlan()
_SINGLE_REPO_PLAN      = SingleRepoPlan()
_MULTI_REPO_PLAN       = MultiRepoPlan()
_UPLOAD_DEEP_PLAN      = UploadDeepPlan()
_REPO_PLUS_UPLOAD_PLAN = RepoPlusUploadPlan()
_VOICE_FIRST_PLAN      = VoiceFirstPlan()

# Active plan for the current asyncio task. handle_input installs
# this once per request via set_active_plan(); cot_engine reads it
# via active_plan() to apply the system-prompt addendum and the
# grounding bundle.
_active_plan_var: contextvars.ContextVar[Optional[CotPlan]] = (
    contextvars.ContextVar("_cot_active_plan", default=None)
)


def route(ctx: PlanContext) -> CotPlan:
    """Heuristic router. Returns the plan that best matches the
    request's source / upload / modality signature.

    Dispatch order matters — earlier branches win on ambiguity:

      1. UPLOAD beats everything else (the user just attached fresh
         information; ignoring it would be embarrassing).
         - upload + repo → RepoPlusUpload (cross-reference posture)
         - upload alone  → UploadDeep      (investigative posture)
      2. REPOS rank by count.
         - multi-repo  → MultiRepo
         - single-repo → SingleRepo
      3. VOICE modality with no source → VoiceFirst (conversational
         tone overlay on knowledge-only grounding).
      4. EVERYTHING ELSE → KnowledgeOnly (the pure ask-the-KB case).

    DefaultPlan stays as the defensive last-resort in case future
    PlanContext fields slip past all five branches.
    """
    if ctx.has_upload and ctx.has_selected_repo:
        chosen: CotPlan = _REPO_PLUS_UPLOAD_PLAN
    elif ctx.has_upload:
        chosen = _UPLOAD_DEEP_PLAN
    elif len(ctx.selected_repos) > 1:
        chosen = _MULTI_REPO_PLAN
    elif ctx.has_selected_repo:
        chosen = _SINGLE_REPO_PLAN
    elif ctx.input_modality == "voice":
        chosen = _VOICE_FIRST_PLAN
    elif not ctx.has_upload and not ctx.has_selected_repo:
        chosen = _KNOWLEDGE_ONLY_PLAN
    else:
        chosen = _DEFAULT_PLAN
    log.info(
        "cot_router: picked plan=%s "
        "(sources=%d, upload=%s, upload_chars=%d, modality=%s)",
        chosen.name, len(ctx.selected_repos),
        ctx.has_upload, ctx.upload_size_chars, ctx.input_modality,
    )
    return chosen


def set_active_plan(plan: Optional[CotPlan]) -> None:
    """Install the plan for the current asyncio task. Called once at
    the top of handle_input. Resetting to None at the bottom isn't
    required — the contextvar is task-scoped and dies with the task."""
    _active_plan_var.set(plan)


def active_plan() -> Optional[CotPlan]:
    """Read the plan installed for the current asyncio task. Returns
    None when no plan is active (e.g. internal/background calls that
    didn't come through handle_input). cot_engine treats None as
    'apply no addendum, inject no grounding' so old code paths
    continue to work."""
    return _active_plan_var.get()
