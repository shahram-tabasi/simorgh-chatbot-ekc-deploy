"""DefaultPlan — the fallback plan, used when no specialized plan
applies. Behaves like "existing CoT flow" + the silent knowledge-repo
layer. Lets us ship Phase 2 without breaking anything: every project
chat goes through this plan, gets the knowledge layer for free, and
the existing planner/dispatcher do exactly what they did before.

Phase 3 layers in the specialized plans (SingleRepo, MultiRepo,
UploadDeep, …) which take over for their specific signatures and
leave the DefaultPlan as the catch-all."""
from __future__ import annotations

import logging

from .base import CotPlan, PlanContext, PlanGrounding

log = logging.getLogger(__name__)


class DefaultPlan(CotPlan):
    name: str = "default"

    def system_prompt_addendum(self, ctx: PlanContext) -> str:
        # Keep the planner's existing freedom; just remind it that
        # technical-knowledge passages may already be in the user
        # message's grounding section so it doesn't re-fetch them.
        return (
            "\n============================================================================\n"
            "ACTIVE PLAN: default\n"
            "============================================================================\n"
            "Some technical-knowledge passages may already be supplied below in the user "
            "message under a 'KNOWLEDGE GROUNDING' header — read them first before deciding "
            "which retrieval rung to climb. If they fully answer the question, you may go "
            "straight to llm.synthesize. Otherwise climb the retrieval ladder as usual."
        )

    async def gather_grounding(self, ctx: PlanContext) -> PlanGrounding:
        """DefaultPlan only contributes the always-on knowledge-repo
        layer. Specialized plans in Phase 3 will add more (selected
        repo passages, upload chunks, etc.)."""
        g = PlanGrounding()
        try:
            from services.knowledge_repo_service import retrieve as kb_retrieve
            hits = await kb_retrieve(ctx.user_input, top_k=5)
        except Exception as e:
            log.warning("default plan: knowledge_repo retrieve failed: %s", e)
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
