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
        """Knowledge layer + upload investigation. The investigator
        decides inline vs MapReduce based on ctx.upload_size_chars
        vs MAPREDUCE_THRESHOLD_CHARS and returns PlanGrounding-shape
        blocks. We need the upload payload (markdown or raw bytes)
        to actually investigate — `ctx` carries filenames but not
        content; we rely on the upload_id convention (chat_id +
        first filename hash) and on the caller having already
        called upload_investigator.ensure_indexed when the upload
        was attached. If neither is true, gracefully degrades to
        knowledge-only grounding and the planner will read the
        upload via doc-processor at task-execution time."""
        g = PlanGrounding()

        # 1. Always-on knowledge layer.
        try:
            from services.knowledge_repo_service import retrieve as kb_retrieve
            kb_hits = await kb_retrieve(ctx.user_input, top_k=2)
        except Exception as e:
            log.warning("upload_deep plan: knowledge retrieve failed: %s", e)
            kb_hits = []
        for h in kb_hits:
            g.add(
                text=h.get("text") or "",
                source=h.get("source_file") or "knowledge_repo",
                section=h.get("section_path"),
                score=h.get("score"),
                origin="knowledge_repo",
            )

        # 2. Upload investigation — requires the upload to already
        #    be indexed (the upload_attach hook calls ensure_indexed
        #    once at attach time; we just retrieve here). If the
        #    cache miss happens (very first turn after a service
        #    restart), the planner will pick up the upload via
        #    doc-processor on the read step.
        if ctx.upload_filenames and ctx.chat_id:
            try:
                from services.upload_investigator import (
                    investigate, MAPREDUCE_THRESHOLD,
                )
                upload_id = f"{ctx.chat_id}::{ctx.upload_filenames[0]}"
                result = await investigate(
                    upload_id=upload_id,
                    question=ctx.user_input,
                    upload_size_chars=ctx.upload_size_chars,
                    filename=ctx.upload_filenames[0],
                )
                log.info("upload_deep: method=%s chunks=%d leaves=%d upload=%s",
                          result.method, result.chunk_count,
                          result.leaves_kept, upload_id)
                for b in result.blocks:
                    g.add(
                        text=b.get("text") or "",
                        source=b.get("source") or "upload",
                        section=b.get("section"),
                        score=b.get("score"),
                        origin="upload",
                    )
            except Exception as e:
                log.warning("upload_deep: investigate failed: %s", e)

        return g
