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
            "GitLab repo. There is NO repo to search — do NOT call get_project_tree, "
            "read_artifact_mcp, search_blobs or search_context; they will 404.\n"
            + oe_line +
            "For ANY question about this project's files:\n"
            "  1. techserver_get_tree(oenum)                       ← ALWAYS first; "
            "lists the project tree (Drawing/ CAD excluded), no download.\n"
            "  2. techserver_read_artifact(oenum, path=<EXACT path from the tree>) "
            "← to read a specific file (returns markdown; images via VLM).\n"
            "  3. llm.synthesize (depends_on the reads).\n"
            "For a plain \"what's in my project\" question, ONE techserver_get_tree "
            "step + a synthesis is enough — the tree IS the answer. NEVER request a "
            "path under Drawing/ or a CAD/archive file; it is refused."
        )

    async def gather_grounding(self, ctx: PlanContext) -> PlanGrounding:
        # No pre-fetch grounding: the techserver tree/files are pulled at
        # execution time by the tools the planner schedules. Returning an
        # empty bundle keeps latency low (no speculative SMB listing).
        return PlanGrounding()
