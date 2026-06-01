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
            "The uploaded document's content has been retrieved and is in the "
            "KNOWLEDGE GROUNDING block below (origin: upload). SYNTHESISE YOUR "
            "ANSWER FROM THOSE PASSAGES. Do NOT call gitlab/repo tools "
            "(get_project_tree, read_artifact_mcp, search_context) — there is "
            "no repo.\n"
            "Tools for documents (project scope is injected automatically — "
            "never supply oenum/session/user_id):\n"
            "  • documents_rag.read_document(filename=\"<exact name the user "
            "attached>\") — full text of ONE file. For a two-file "
            "comparison, call it ONCE PER FILE using each filename from the "
            "user's message (e.g. filename=\"موجودی انبار.xlsx\"). Pass "
            "FILENAME, never a document_id you haven't seen — guessed ids "
            "return nothing.\n"
            "  • documents_rag.list_project_documents — if you are unsure "
            "which files exist; returns their exact filenames.\n"
            "  • documents_rag.search_project_documents(query=...) — to find "
            "specific passages across documents.\n"
            "If the grounding block is empty AND list_project_documents "
            "returns nothing, say you could not find the document — do NOT "
            "invent its contents.\n"
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

        # 2. Persistent project-document store — the authoritative source
        #    for uploads. The planner LLM is unreliable about calling the
        #    right retrieval tool (it keeps falling back to gitlab/search
        #    tools that 404 on a repo-less project), so we PRE-LOAD the
        #    documents' content here as grounding. The synthesizer then has
        #    the files regardless of what tools the plan picks.
        #
        #    Strategy: enumerate the project's documents and inject each
        #    one's full (capped) text. For "compare/aggregate across files"
        #    questions this is exactly what's needed — both files present in
        #    the prompt. Falls back to semantic_search only if enumeration
        #    yields nothing. Total budget is bounded so we never blow the
        #    context window.
        scope = (ctx.tpms_oenum or ctx.project_id or "").strip()
        if scope:
            try:
                from services.project_memory_service import (
                    get_project_memory_service,
                )
                qdrant = getattr(get_project_memory_service(), "qdrant", None)
                if qdrant is not None:
                    docs = []
                    try:
                        docs = qdrant.list_documents(user_id="system", project_oenum=scope)
                    except Exception as e:
                        log.warning("upload_deep: list_documents failed: %s", e)

                    TOTAL_BUDGET = 24000
                    used = 0
                    if docs:
                        # Spread the budget across however many docs exist so
                        # a two-file comparison gets both, not just the first.
                        per_doc = max(2000, TOTAL_BUDGET // max(1, len(docs)))
                        for d in docs:
                            fname = d.get("filename") or ""
                            if not fname or used >= TOTAL_BUDGET:
                                continue
                            try:
                                doc = qdrant.get_document_text(
                                    user_id="system", project_oenum=scope,
                                    filename=fname, max_chars=per_doc,
                                )
                            except Exception as e:
                                log.warning("upload_deep: read %s failed: %s", fname, e)
                                continue
                            txt = doc.get("text") or ""
                            if txt:
                                g.add(text=txt, source=fname, origin="upload",
                                      section=fname)
                                used += len(txt)
                        log.info("upload_deep: preloaded %d docs (%d chars) scope=%s",
                                 len(docs), used, scope)
                    else:
                        # No enumerable docs — fall back to query-driven search.
                        hits = qdrant.semantic_search(
                            user_id="system", query=ctx.user_input, limit=8,
                            score_threshold=0.0, project_oenum=scope,
                        )
                        for h in hits:
                            g.add(text=h.get("text") or "",
                                  source=(h.get("metadata") or {}).get("filename")
                                         or h.get("section_title") or "upload",
                                  section=h.get("section_title"),
                                  score=h.get("score"), origin="upload")
                        log.info("upload_deep: fallback search hits=%d scope=%s",
                                 len(hits), scope)
            except Exception as e:
                log.warning("upload_deep: persistent-store grounding failed: %s", e)

        # 3. Ephemeral upload investigation (legacy subsystem). Requires the
        #    upload to already be indexed into upload_<hash> by the attach
        #    hook. Kept for back-compat / large-file MapReduce; for project
        #    chats step 2 above is the authoritative source.
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
