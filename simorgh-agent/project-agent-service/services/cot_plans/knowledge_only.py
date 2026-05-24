"""KnowledgeOnlyPlan — user picked NO source AND attached NO upload.
Pure conversation against the technical-knowledge repo. Highest top-K
from knowledge_repo (12) because it's the only grounding source, and
the system prompt skips the retrieval-ladder freedom to keep latency
predictable for this lightweight case."""
from __future__ import annotations

import logging

from .base import CotPlan, PlanContext, PlanGrounding

log = logging.getLogger(__name__)


class KnowledgeOnlyPlan(CotPlan):
    name: str = "knowledge_only"

    def system_prompt_addendum(self, ctx: PlanContext) -> str:
        return (
            "\n============================================================================\n"
            "ACTIVE PLAN: knowledge_only\n"
            "============================================================================\n"
            "The user has NOT selected a project repo and has NOT uploaded any document. "
            "Your ONLY grounding source is the KNOWLEDGE GROUNDING block below — top-K "
            "passages from the company technical-knowledge repository. \n"
            "  - Answer DIRECTLY from those passages with [G1]…[Gn] citations.\n"
            "  - SKIP get_project_tree / search_blobs / search_context — there is no "
            "project to search.\n"
            "  - If the knowledge block does not contain the answer, say so plainly and "
            "suggest which standard / document the user could ask about — DO NOT "
            "fabricate.\n"
            "  - 2 task limit: llm.synthesize + (optional) one knowledge follow-up."
        )

    async def gather_grounding(self, ctx: PlanContext) -> PlanGrounding:
        g = PlanGrounding()
        try:
            from services.knowledge_repo_service import retrieve as kb_retrieve
            hits = await kb_retrieve(ctx.user_input, top_k=12)
        except Exception as e:
            log.warning("knowledge_only plan: retrieve failed: %s", e)
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
