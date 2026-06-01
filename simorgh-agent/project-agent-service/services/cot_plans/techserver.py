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
            "The full project tree is cached, so you can navigate AND search it:\n"
            "  • techserver_get_tree(oenum, path=\"\") → ROOT folders "
            "(Document/, Identity/, …).\n"
            "  • techserver_get_tree(oenum, path=\"Document/Client\") → that "
            "folder's contents. Add recursive=true to get a whole subtree.\n"
            "  • techserver_search(oenum, query=\"spec 6.6kv\") → find files "
            "ANYWHERE by name without listing every level. PREFER this when the "
            "user names a kind of document (spec, datasheet, CT/PT calc, BOM, "
            "cable list, SLD).\n"
            "  • techserver_read_artifact(oenum, path=<EXACT path>) → read ONE "
            "file as markdown.\n"
            "Typical plans:\n"
            "  \"what's in my project\"  → [1] techserver_get_tree(path=\"\") "
            "[2] llm.synthesize(depends_on=[1])\n"
            "  \"what's in Document\"    → [1] techserver_get_tree(path=\"Document\") "
            "[2] llm.synthesize(depends_on=[1])\n"
            "  \"summarise the spec\"    → [1] techserver_search(query=\"spec\") "
            "[2] techserver_read_artifact(path=<top hit>) "
            "[3] llm.synthesize(depends_on=[2])\n"
            "ALWAYS end with a tool_needed=\"llm\", task_type=\"generation\" step "
            "(depends_on the prior steps) so the result becomes an answer. When the "
            "user asks about a SUBFOLDER, pass that folder as `path` — do NOT just "
            "list the root. NEVER emit get_project_tree (wrong tool). NEVER request "
            "a path under Drawing/ or a CAD/archive file; it is refused."
        )

    async def gather_grounding(self, ctx: PlanContext) -> PlanGrounding:
        # No pre-fetch grounding: the techserver tree/files are pulled at
        # execution time by the tools the planner schedules. Returning an
        # empty bundle keeps latency low (no speculative SMB listing).
        return PlanGrounding()
