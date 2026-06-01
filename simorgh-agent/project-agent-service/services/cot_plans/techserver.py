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
            "techserver_search, techserver_read_artifact.\n"
            + oe_line +
            "techserver_get_tree(oenum) returns the ENTIRE project tree in one "
            "call — every folder and file (e.g. Document/Client/Spec/…, "
            "Document/Client/Other/CT & PT CALCULATION/…). You do NOT navigate "
            "folder by folder and you do NOT need a `path`; the whole structure "
            "comes back at once. Treat that tree as the complete, authoritative "
            "list of what exists — if a folder/file is in it, it EXISTS; only say "
            "something is absent if it is genuinely not in the returned tree.\n"
            "Tools:\n"
            "  • techserver_get_tree(oenum) → the full project tree (cached).\n"
            "  • techserver_search(oenum, query=\"spec\") → just the matching "
            "paths (use when the user names a document kind: spec, datasheet, "
            "CT/PT calc, BOM, cable list, SLD, vendor list).\n"
            "  • techserver_read_artifact(oenum, path=<EXACT path from the tree>) "
            "→ read ONE file as markdown.\n"
            "Typical plans:\n"
            "  \"what's in my project\" / \"is there a Client dir\" / \"where are "
            "the specs\" → [1] techserver_get_tree(oenum) "
            "[2] llm.synthesize(depends_on=[1]).\n"
            "  \"summarise the 6.6kv spec\" → [1] techserver_search(query=\"spec "
            "6.6kv\") [2] techserver_read_artifact(path=<top hit>) "
            "[3] llm.synthesize(depends_on=[2]).\n"
            "ALWAYS end with a tool_needed=\"llm\", task_type=\"generation\" step "
            "(depends_on the prior steps). NEVER emit get_project_tree (wrong "
            "tool). NEVER request a path under Drawing/ or a CAD/archive file."
        )

    async def gather_grounding(self, ctx: PlanContext) -> PlanGrounding:
        # No pre-fetch grounding: the techserver tree/files are pulled at
        # execution time by the tools the planner schedules. Returning an
        # empty bundle keeps latency low (no speculative SMB listing).
        return PlanGrounding()
