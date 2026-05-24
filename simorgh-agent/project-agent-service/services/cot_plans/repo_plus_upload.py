"""RepoPlusUploadPlan — user has BOTH a repo selected AND an upload.
The default semantics: cross-reference the upload against the repo.
E.g. user uploads a datasheet and asks 'does our spec match this',
or uploads a customer request and asks 'show me where in our repo
this is already addressed'."""
from __future__ import annotations

import logging

from .base import CotPlan, PlanContext, PlanGrounding

log = logging.getLogger(__name__)


class RepoPlusUploadPlan(CotPlan):
    name: str = "repo_plus_upload"

    def system_prompt_addendum(self, ctx: PlanContext) -> str:
        names = ", ".join(ctx.upload_filenames[:3]) or "(filename pending)"
        repos = ", ".join(ctx.selected_repos[:3]) or "(repo selected)"
        return (
            "\n============================================================================\n"
            "ACTIVE PLAN: repo_plus_upload — cross-reference\n"
            "============================================================================\n"
            f"The user has both repo(s) selected ({repos}) AND uploaded: {names}.\n\n"
            "Default semantics: CROSS-REFERENCE the upload against the repo.\n"
            "  1. READ the upload FIRST (it's the new information the user is bringing in).\n"
            "  2. Identify the topics/sections in the upload that the user's question is "
            "about.\n"
            "  3. For each, search the selected repo (search_context / search_blobs) for "
            "matching content.\n"
            "  4. Synthesize a side-by-side comparison: what the upload says vs. what the "
            "repo currently has. Highlight CONFLICTS, GAPS, and AGREEMENTS distinctly.\n\n"
            "Output structure rule: when the question is comparative, use a "
            "'Upload says X | Repo says Y | Status: agree/conflict/gap' format. The user "
            "is almost always trying to decide whether to update the repo based on the "
            "upload — make that decision easy to read.\n"
            "The KNOWLEDGE GROUNDING block carries technical-standard context that "
            "applies to BOTH sources — quote it when a comparison hinges on a standard."
        )

    async def gather_grounding(self, ctx: PlanContext) -> PlanGrounding:
        g = PlanGrounding()
        try:
            from services.knowledge_repo_service import retrieve as kb_retrieve
            hits = await kb_retrieve(ctx.user_input, top_k=4)
        except Exception as e:
            log.warning("repo_plus_upload plan: knowledge retrieve failed: %s", e)
            hits = []
        for h in hits:
            g.add(
                text=h.get("text") or "",
                source=h.get("source_file") or "knowledge_repo",
                section=h.get("section_path"),
                score=h.get("score"),
                origin="knowledge_repo",
            )
        # Phase 4 upload chunks will be appended here once the
        # upload_investigator pipeline lands.
        return g
