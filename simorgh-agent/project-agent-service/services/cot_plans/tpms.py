"""TpmsPlan — the project's primary source is TPMS (no GitLab repo, no
SMB techserver). The structured project data — panels, feeders, scopes,
customer specs — lives in MySQL behind tpms-fetcher, and the renderable
markdown comes from tpms-context-agent's get_project_context tool.

Picked when the project ticked the `tpms` source at wizard time AND has
no GitLab repo selected AND no techserver source. In that posture TPMS
IS the project: every "overview / scope / panels / feeders / customer
specs / voltage / busbar" question must START with tpms_context_agent,
not with a README / repo search (the planner's default prior leaks the
repo-shaped canonical examples into TPMS-only projects otherwise — we
observed plans like "Search README → Read README → Summarise" and
multi-step "Find OE → Extract OE → Get TPMS context" chains that
chase non-existent files).

The OE number is set at project-create time by the wizard and stored on
the projects row (tpms_oenum); we surface it in the addendum so the
planner never has to "find" it. The defensive scrubber in
project_agent._execute_single_task swaps any leftover <oenum> literals
that survive the LLM's pattern-copying.
"""
from __future__ import annotations

import logging

from .base import CotPlan, PlanContext, PlanGrounding

log = logging.getLogger(__name__)


class TpmsPlan(CotPlan):
    name: str = "tpms"

    def system_prompt_addendum(self, ctx: PlanContext) -> str:
        oe = ctx.tpms_oenum or ""
        oe_line = (
            f"The OE number for this project is \"{oe}\". Pass "
            f"oenum=\"{oe}\" verbatim to tpms_context_agent.get_project_context. "
            "NEVER emit the literal string \"<oenum>\". NEVER emit cross-step "
            "placeholders like \"<output_of_step_N>\". NEVER plan a separate "
            "\"find / extract the OE\" step — the OE is already known.\n"
            if oe else
            "The OE number is not stored on the record. If the user's message "
            "contains a recognisable OE token (e.g. \"04A12065\", \"12065\"), "
            "pass that literal string as oenum. If not, emit a single "
            "llm.synthesize step that asks the user for the OE — do NOT plan "
            "any retrieval gymnastics to \"find\" it.\n"
        )
        return (
            "\n============================================================================\n"
            "ACTIVE PLAN: tpms\n"
            "============================================================================\n"
            "This project's data lives in TPMS (MySQL), NOT in a GitLab repo "
            "and NOT on the techserver SMB share. TPMS holds the structured "
            "engineering records (project identity, panels / switchgear, "
            "feeders, customer specs, scopes).\n"
            "  ❌ FORBIDDEN tools (they 404 here — there is NO repo and NO "
            "techserver share for this project): get_project_tree, "
            "read_artifact_mcp, read_file_mcp, search_blobs, search_context, "
            "regex_search_project, search_technical_knowledge, project_analyze, "
            "techserver_get_tree, techserver_search, techserver_fetch_files, "
            "techserver_read_artifact.\n"
            "  ✅ PRIMARY tool: tpms_context_agent.get_project_context("
            "oenum=\"<the OE below>\", sections=[…]) — renders TPMS rows into "
            "markdown.\n"
            "  ✅ For raw rows / drilldowns: tpms_fetch(oenum=\"…\").\n"
            + oe_line +
            "Sections you can request from get_project_context (pick the "
            "minimum you need — do not dump everything):\n"
            "  • panels          → switchgear identity (voltage, busbar, "
            "dimensions, IP)\n"
            "  • feeders         → per-feeder records (designation, cb_rating, "
            "cable_size, wiring_type)\n"
            "  • customer_specs  → wire colours, plating, project-wide rules\n"
            "  • scopes          → the project's scope tree\n"
            "If unsure, omit sections — the renderer returns project identity "
            "+ panels + feeders, which is what \"brief overview\" asks for.\n"
            "Typical plans:\n"
            "  overview / \"what is this project\" / \"brief overview\" → "
            "[1] tpms_context_agent.get_project_context(oenum, sections=[\"panels\",\"feeders\"]) "
            "[2] llm.synthesize(depends_on=[1]).\n"
            "  \"how many panels / feeders\" → [1] get_project_context with the "
            "matching section [2] llm.synthesize.\n"
            "  \"what cable on feeder X\" / specific record lookup → "
            "[1] get_project_context(oenum, sections=[\"feeders\"]) "
            "[2] llm.synthesize.\n"
            "ALWAYS end with tool_needed=\"llm\", task_type=\"generation\" "
            "depending on the retrieval step(s). NEVER emit a Search/Read/List "
            "step against the repo — there is no repo. NEVER chain a \"find "
            "OE\" → \"extract OE\" → \"call TPMS with extracted OE\" plan — "
            "the OE is provided above; just pass it."
        )

    async def gather_grounding(self, ctx: PlanContext) -> PlanGrounding:
        # No pre-fetch: the planner schedules get_project_context itself,
        # and pre-fetching here would double the latency for the common
        # "structured retrieval is the whole answer" case. If we ever want
        # to inline the project_identity block as grounding (so even a 1-step
        # plan can render an overview) it goes here.
        return PlanGrounding()
