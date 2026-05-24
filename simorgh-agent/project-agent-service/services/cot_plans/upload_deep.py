"""UploadDeepPlan — user uploaded a document, possibly LARGE. Phase 3
ships the system-prompt + small/medium upload handling (inline reading,
chunked summary). Phase 4 layers in the MapReduce machinery for files
above the >200K-char threshold (operator-defined).

Routing:
  has_upload=True AND no selected_repo AND size <= 200K  → this plan,
                                                            inline path
  has_upload=True AND no selected_repo AND size  > 200K  → this plan,
                                                            MapReduce
                                                            path (Phase 4)
  has_upload AND has_selected_repo                       → RepoPlusUploadPlan

Big-doc heuristic threshold: KNOWLEDGE_UPLOAD_MAPREDUCE_THRESHOLD env
(default 200_000 chars). Below it, the doc gets a single-pass summary
+ targeted answer. Above it, Phase 4's MapReduce hierarchical pipeline
runs (chunk → leaf-summarize with the question in mind → cot-merge
with citations preserved → final synth).
"""
from __future__ import annotations

import logging
import os

from .base import CotPlan, PlanContext, PlanGrounding

log = logging.getLogger(__name__)

MAPREDUCE_THRESHOLD_CHARS = int(
    os.getenv("KNOWLEDGE_UPLOAD_MAPREDUCE_THRESHOLD", "200000")
)


class UploadDeepPlan(CotPlan):
    name: str = "upload_deep"

    def system_prompt_addendum(self, ctx: PlanContext) -> str:
        big = ctx.upload_size_chars > MAPREDUCE_THRESHOLD_CHARS
        size_note = (
            f"The upload is LARGE ({ctx.upload_size_chars:,} chars > "
            f"{MAPREDUCE_THRESHOLD_CHARS:,}). A hierarchical MapReduce summary "
            "has been pre-computed by the upload_investigator pipeline — its "
            "section summaries are in the KNOWLEDGE GROUNDING block. Treat "
            "those summaries as authoritative excerpts from the upload; you "
            "may cite them as [G1]…[Gn].\n"
        ) if big else (
            f"The upload is small enough to read inline ({ctx.upload_size_chars:,} "
            "chars). Use the document-read tool to fetch its contents in full, "
            "then synthesize from there.\n"
        )
        names = ", ".join(ctx.upload_filenames[:3]) or "(filename pending)"
        return (
            "\n============================================================================\n"
            "ACTIVE PLAN: upload_deep — investigative\n"
            "============================================================================\n"
            f"The user uploaded: {names}\n"
            "There is NO project repo selected — the UPLOAD is the primary source.\n\n"
            f"{size_note}"
            "Investigative posture:\n"
            "  - Read CAREFULLY. Do not skim; the user expects you to ground every claim "
            "in a specific passage you can cite.\n"
            "  - When the user's question targets a specific section (e.g. 'what does the "
            "spec say about earthing'), locate that section first, quote the relevant "
            "lines verbatim in your answer, then explain.\n"
            "  - When the question is broad ('summarise this doc'), produce a STRUCTURED "
            "summary: scope → key facts → numbers/limits → exceptions → open questions.\n"
            "  - For any number, date, name, or formula: cite the exact passage. NEVER "
            "interpolate.\n"
            "The KNOWLEDGE GROUNDING block also carries technical-standard context that "
            "may help interpret the upload (cite as [G…] not as part of the upload)."
        )

    async def gather_grounding(self, ctx: PlanContext) -> PlanGrounding:
        """Phase 3: knowledge layer + (Phase 4) upload chunks via
        upload_investigator. For now, just the knowledge layer +
        a structural note about the upload until Phase 4 lands."""
        g = PlanGrounding()
        # Phase 4 hook — when upload_investigator is wired, populate
        # `g` here with leaf-summaries / map-reduced sections of the
        # uploaded document targeted at ctx.user_input.
        try:
            from services.knowledge_repo_service import retrieve as kb_retrieve
            hits = await kb_retrieve(ctx.user_input, top_k=5)
        except Exception as e:
            log.warning("upload_deep plan: knowledge retrieve failed: %s", e)
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
