"""VoiceFirstPlan — input came from voice transcription. Lighter
output: conversational tone, shorter sentences, no markdown tables,
no fenced code blocks (the user is listening via TTS or scanning a
short message bubble on mobile).

This plan does NOT change the grounding strategy — it overlays the
appropriate underlying plan's grounding (KnowledgeOnly / SingleRepo
/ etc., depending on source state) and just adjusts the system-
prompt instructions for tone + length.

Phase 3 ships the plan with KnowledgeOnly's grounding as the
baseline; the router will pick this plan when the input modality
is 'voice' AND there is no upload. For voice+upload or voice+repo
the underlying plan still wins (the upload/repo dominates routing);
the planner's response prompt is tone-adjusted via a separate hint
that the router can layer in regardless of plan.
"""
from __future__ import annotations

import logging

from .base import CotPlan, PlanContext, PlanGrounding

log = logging.getLogger(__name__)


class VoiceFirstPlan(CotPlan):
    name: str = "voice_first"

    def system_prompt_addendum(self, ctx: PlanContext) -> str:
        return (
            "\n============================================================================\n"
            "ACTIVE PLAN: voice_first — conversational output\n"
            "============================================================================\n"
            "The user spoke this request via the mic — the assistant's reply will be "
            "either read aloud (TTS) or scanned briefly on mobile. Adjust the response:\n"
            "  - SHORTER than usual. 2-4 sentences for simple questions; a brief bulleted "
            "list (3-5 items max) for explanations.\n"
            "  - NO markdown tables, NO fenced code blocks — voice users can't hear them, "
            "mobile users can't easily scan them. Quote numbers and code inline.\n"
            "  - Plain Persian/English conversational tone, not technical-document "
            "register.\n"
            "  - If a long answer is genuinely required (e.g. 10-step procedure), say so "
            "and offer to send the full text: 'I can send you the full 10-step procedure "
            "in the chat — should I?' Then proceed if the user assents.\n"
            "Grounding sources are the same as a text request — the KNOWLEDGE GROUNDING "
            "block carries the technical-knowledge passages."
        )

    async def gather_grounding(self, ctx: PlanContext) -> PlanGrounding:
        # Same baseline as KnowledgeOnly — voice-only queries
        # typically don't have a project context.
        g = PlanGrounding()
        try:
            from services.knowledge_repo_service import retrieve as kb_retrieve
            hits = await kb_retrieve(ctx.user_input, top_k=8)
        except Exception as e:
            log.warning("voice_first plan: knowledge retrieve failed: %s", e)
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
