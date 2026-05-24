"""MultiRepoPlan — multiple repos selected. Cross-repo fusion: run
the same query against every selected repo in parallel, then merge.
Used when the user asks something like 'compare the cable specs across
HCS-DD-EL-SP-003 and HCS-DD-EL-SP-007' — without this plan the
planner would serialise the lookups and run out of task budget."""
from __future__ import annotations

import logging

from .base import CotPlan, PlanContext, PlanGrounding

log = logging.getLogger(__name__)


class MultiRepoPlan(CotPlan):
    name: str = "multi_repo"

    def system_prompt_addendum(self, ctx: PlanContext) -> str:
        repo_list = ", ".join(ctx.selected_repos[:8]) or "(none provided)"
        return (
            "\n============================================================================\n"
            "ACTIVE PLAN: multi_repo\n"
            "============================================================================\n"
            f"The user has multiple repos selected: {repo_list}.\n"
            "Run retrieval steps IN PARALLEL across them — one search_context task per "
            "repo, then ONE llm.synthesize that compares/integrates the findings. Do NOT "
            "serialise the lookups; that wastes the task budget. When citing in the final "
            "answer, prefix every claim with the source repo, e.g.\n"
            "  - 'In HCS-DD-EL-SP-003 the CT ratio is 200/5; in HCS-DD-EL-SP-007 it is "
            "100/5.' \n"
            "The KNOWLEDGE GROUNDING block below carries shared technical context that "
            "applies regardless of which repo — use it to interpret/compare the repo-"
            "specific findings (e.g. 'both ratios comply with IEC 61869-2 …')."
        )

    async def gather_grounding(self, ctx: PlanContext) -> PlanGrounding:
        g = PlanGrounding()
        try:
            from services.knowledge_repo_service import retrieve as kb_retrieve
            hits = await kb_retrieve(ctx.user_input, top_k=5)
        except Exception as e:
            log.warning("multi_repo plan: knowledge retrieve failed: %s", e)
            hits = []
        for h in hits:
            g.add(
                text=h.get("text") or "",
                source=h.get("source_file") or "knowledge_repo",
                section=h.get("section_path"),
                score=h.get("score"),
                origin="knowledge_repo",
            )
        return g
