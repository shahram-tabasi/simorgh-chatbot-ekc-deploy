"""SingleRepoPlan — user is in a project chat with exactly one repo.
Deterministic exploration order (tree → read → search → synth) so the
planner can't accidentally skip the KNOWN-FILE flow the way it did
in the operator's screenshot."""
from __future__ import annotations

import logging

from .base import CotPlan, PlanContext, PlanGrounding

log = logging.getLogger(__name__)


class SingleRepoPlan(CotPlan):
    name: str = "single_repo"

    def system_prompt_addendum(self, ctx: PlanContext) -> str:
        return (
            "\n============================================================================\n"
            "ACTIVE PLAN: single_repo\n"
            "============================================================================\n"
            "EXPLORATION ORDER IS NOT OPTIONAL — follow this sequence whenever the user "
            "names a file, a topic, or refers to 'the spec / the doc / the README' or "
            "anything implying repo content:\n"
            "  1. get_project_tree(project, recursive=True)              ← ALWAYS first\n"
            "  2. If a filename or partial filename appeared in the user's request, "
            "FUZZY-MATCH it against the tree and pass the EXACT matched path to step 3. "
            "Do NOT pass the user's verbatim string — it will miss extensions, prefixes, "
            "and Persian/Arabic look-alike letters (ك vs ک, ي vs ی).\n"
            "  3. read_artifact_mcp(project, path=<matched path>)        ← for KNOWN files\n"
            "     OR search_context(query, project_id=<this>)            ← for TOPIC queries\n"
            "     OR search_blobs(query, project) for literal phrases.\n"
            "  4. llm.synthesize.\n"
            "If read_artifact_mcp returns empty / 404, do NOT give up — the dispatcher "
            "fuzzy-retries automatically, but if it still fails, report which path was "
            "tried and what the tree actually contains.\n"
            "The KNOWLEDGE GROUNDING block below may already supply technical-standard "
            "context that complements the repo content — quote both when relevant."
        )

    async def gather_grounding(self, ctx: PlanContext) -> PlanGrounding:
        # SingleRepo plan leans on the existing planner+tools for the
        # repo-specific retrieval (search_context is BM25+kNN over the
        # already-indexed project), so the upfront grounding is just
        # the knowledge layer. Smaller top-K than KnowledgeOnly
        # because the repo will contribute its own grounding via the
        # planner's search tasks.
        g = PlanGrounding()
        try:
            from services.knowledge_repo_service import retrieve as kb_retrieve
            hits = await kb_retrieve(ctx.user_input, top_k=2)
        except Exception as e:
            log.warning("single_repo plan: knowledge retrieve failed: %s", e)
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
