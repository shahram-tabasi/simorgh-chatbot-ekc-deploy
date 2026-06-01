"""TechserverPlan — the project's source is the legacy techserver (SMB).

Picked when the project ticked the `techserver` source. The project has
no GitLab repo, so the gitlab tools 404; instead the planner browses the
techserver share by OE number and reads single files on demand. The huge
Drawing/ CAD subtree is excluded server-side.

Flow the addendum steers the planner toward:
  1. techserver_get_tree(oenum)                    ← ALWAYS first
  2. techserver_read_artifact(oenum, path=<exact>) ← for a specific file
  3. llm.synthesize
"""
from __future__ import annotations

import logging

from .base import CotPlan, PlanContext, PlanGrounding

log = logging.getLogger(__name__)


class TechserverPlan(CotPlan):
    name: str = "techserver"

    def system_prompt_addendum(self, ctx: PlanContext) -> str:
        oe = ctx.techserver_oenum or ""
        oe_line = (
            f"The OE number for this project is {oe}. Pass oenum=\"{oe}\" to "
            "both techserver tools.\n"
            if oe else
            "Extract the OE number from the user's message and pass it as "
            "oenum.\n"
        )
        return (
            "\n============================================================================\n"
            "ACTIVE PLAN: techserver\n"
            "============================================================================\n"
            "This project's files live on the legacy techserver (SMB), NOT in a "
            "GitLab repo.\n"
            "  ❌ FORBIDDEN tools (they 404 here — this project has NO repo): "
            "get_project_tree, read_file_mcp, read_artifact_mcp, search_blobs, "
            "search_context, project_analyze.\n"
            "  ✅ USE ONLY these for files: techserver_get_tree, "
            "techserver_search, techserver_fetch_files, "
            "techserver_read_artifact.\n"
            + oe_line +
            "Work in a RETRIEVAL FUNNEL — index once, then search, then read "
            "only the few files that matter (do NOT read many files blindly):\n"
            "  • techserver_get_tree(oenum) → the ENTIRE project tree in one "
            "call (every folder + file, e.g. Document/Client/Spec/…). Use for "
            "structure / \"what's in my project\" / \"is there an X folder\" "
            "questions. Treat it as the authoritative list of what EXISTS.\n"
            "  • techserver_search(oenum, query=\"…\") → ranked candidate PATHS "
            "across the whole project (filename matches first). Use to LOCATE a "
            "document by kind: spec, datasheet, CT/PT calc, BOM, cable list, "
            "SLD, vendor list, schematic.\n"
            "  • techserver_fetch_files(oenum, query=\"…\", top_n=3) → the "
            "RECOMMENDED way to analyse a document: it ranks, fetches ONLY the "
            "top few matching files to the workspace, and returns their "
            "markdown in one step. Prefer this over multiple read calls.\n"
            "  • techserver_read_artifact(oenum, path=<EXACT path>) → read ONE "
            "known file.\n"
            "Typical plans:\n"
            "  structure Qs (\"what's in my project\", \"is there a Client dir\", "
            "\"where are the specs\") → [1] techserver_get_tree(oenum) "
            "[2] llm.synthesize(depends_on=[1]).\n"
            "  analyse/summarise a document (\"summarise the 6.6kv spec\", "
            "\"what does the CT&PT calc say\") → [1] techserver_fetch_files("
            "oenum, query=\"<the document kind + key terms>\", top_n=3) "
            "[2] llm.synthesize(depends_on=[1]).\n"
            "ALWAYS end with a tool_needed=\"llm\", task_type=\"generation\" step "
            "(depends_on the prior steps). NEVER emit get_project_tree (wrong "
            "tool). NEVER request a path under Drawing/ or a CAD/archive file."
        )

    async def gather_grounding(self, ctx: PlanContext) -> PlanGrounding:
        # No pre-fetch grounding: the techserver tree/files are pulled at
        # execution time by the tools the planner schedules. Returning an
        # empty bundle keeps latency low (no speculative SMB listing).
        return PlanGrounding()
