"""
Conversation Summarizer
=======================
Two-tier compaction in the Claude-Code style.

Verbatim tail + rolling ``<summary>`` block. When the conversation grows
past the trigger ratio (or a user runs ``/compact``), older turns are
folded into a structured summary that preserves:

  * decisions made,
  * files / artifacts touched (paths),
  * the current task and project stage,
  * open questions,
  * pinned facts (specs, equations, oenums) the model must never forget.

The summary itself is bounded; once it exceeds ``MAX_SUMMARY_LENGTH``
a summary-of-summary pass re-folds it without losing the pinned section.

Author: Simorgh Industrial Assistant
"""

import logging
import os
from typing import List, Dict, Any, Optional
from datetime import datetime
import json

import httpx

logger = logging.getLogger(__name__)


# Wrap stored summaries in tags so the assembled prompt makes it explicit
# this is a compacted view (and an easy regex target for re-summary).
SUMMARY_OPEN_TAG = "<summary>"
SUMMARY_CLOSE_TAG = "</summary>"


class ConversationSummarizer:
    """Two-tier compaction (verbatim tail + structured ``<summary>``).

    Features
    --------
    * Incremental summarization — only new messages folded in each pass.
    * Structured sections (decisions, files, task, stage, open questions,
      pinned facts) so the model gets the same skeleton every time.
    * Optional ``hint`` to steer manual ``/compact`` ("preserve panel-A
      wiring decisions").
    * Re-summary when the summary itself outgrows the limit.
    * Routes through ``llm-gateway`` with ``force_backend=text`` so it
      runs on the fast LLM, not the VLM.
    """

    # Trigger automatic summarization every N unsummarized messages.
    SUMMARY_THRESHOLD = 8

    # Re-summary threshold for the summary itself (characters).
    MAX_SUMMARY_LENGTH = 4000

    SUMMARY_SYSTEM_PROMPT = (
        "You are a context compaction agent for an electrical-engineering "
        "assistant. Compact the conversation into a single structured block "
        "that preserves every fact the next turn needs. Drop pleasantries "
        "and re-stated context. Never lose: numeric specs, equations, "
        "oenums, file paths, decisions, stage transitions."
    )

    SUMMARY_PROMPT = """\
Compact the conversation below into a single block wrapped in <summary>...</summary>.

EXISTING SUMMARY (if any):
{current_summary}

NEW MESSAGES TO FOLD IN:
{new_messages}

{hint_block}

Output ONLY this skeleton (keep section headers verbatim, omit a section
only if truly empty):

<summary>
## Topic
One sentence on what's being worked on.

## Current Task
The user's active task and any sub-step in progress.

## Stage
ANALYSIS | DESIGN | IMPLEMENTATION | REVIEW (omit if not a project chat).

## Decisions
- short bullets, one decision each, with the rationale if non-obvious.

## Files & Artifacts
- absolute paths, MR numbers, commit SHAs, GitLab repo refs.

## Pinned Facts
- specs, equations, oenums, part numbers — verbatim, never paraphrased.

## Open Questions
- bullets the next turn must address.

## Tool Results (recent)
- name + 1-line outcome ("gitlab.search_blobs: 3 hits in panel-A/").
</summary>"""

    def __init__(self, llm_service=None, redis_service=None):
        """
        Initialize summarizer.

        Args:
            llm_service: LLM service for generating summaries (legacy path)
            redis_service: Redis service for storing summaries
        """
        self.llm = llm_service
        self.redis = redis_service
        self._gateway_url = (os.getenv("LLM_GATEWAY_URL") or "").rstrip("/")
        logger.info(
            "ConversationSummarizer initialized (gateway=%s)",
            self._gateway_url or "off",
        )

    def set_services(self, llm_service=None, redis_service=None):
        """Set services after initialization (for dependency injection)"""
        if llm_service:
            self.llm = llm_service
        if redis_service:
            self.redis = redis_service

    def __init__(self, llm_service=None, redis_service=None):
        """
        Initialize summarizer.

        Args:
            llm_service: LLM service for generating summaries
            redis_service: Redis service for storing summaries
        """
        self.llm = llm_service
        self.redis = redis_service
        logger.info("ConversationSummarizer initialized")

    def set_services(self, llm_service=None, redis_service=None):
        """Set services after initialization (for dependency injection)"""
        if llm_service:
            self.llm = llm_service
        if redis_service:
            self.redis = redis_service

    async def get_summary(self, chat_id: str) -> Optional[str]:
        """
        Get existing summary for a chat.

        Args:
            chat_id: Chat identifier

        Returns:
            Summary string or None
        """
        if not self.redis:
            logger.warning("Redis service not available for summary retrieval")
            return None

        try:
            summary_data = self.redis.get(f"chat:{chat_id}:summary", db="chat")
            if summary_data:
                if isinstance(summary_data, dict):
                    return summary_data.get("summary", "")
                return str(summary_data)
            return None
        except Exception as e:
            logger.error(f"Failed to retrieve summary: {e}")
            return None

    async def get_summarized_message_count(self, chat_id: str) -> int:
        """
        Get count of messages that have been summarized.

        Args:
            chat_id: Chat identifier

        Returns:
            Count of summarized messages
        """
        if not self.redis:
            return 0

        try:
            summary_data = self.redis.get(f"chat:{chat_id}:summary", db="chat")
            if summary_data and isinstance(summary_data, dict):
                return summary_data.get("message_count", 0)
            return 0
        except Exception:
            return 0

    async def compact(
        self,
        chat_id: str,
        messages: List[Dict[str, Any]],
        hint: Optional[str] = None,
    ) -> Optional[str]:
        """Manual ``/compact``: force a fresh summary with optional hint."""
        return await self.maybe_summarize(
            chat_id=chat_id, messages=messages, force=True, hint=hint,
        )

    async def maybe_summarize(
        self,
        chat_id: str,
        messages: List[Dict[str, Any]],
        force: bool = False,
        hint: Optional[str] = None,
    ) -> Optional[str]:
        """
        Generate or update conversation summary if needed.

        Triggers summarization when:
        - force=True
        - Number of unsummarized messages >= SUMMARY_THRESHOLD
        - Total messages > 20 and no summary exists

        Args:
            chat_id: Chat identifier
            messages: All messages in the conversation
            force: Force summarization regardless of threshold

        Returns:
            Updated summary or existing summary
        """
        if not messages:
            return None

        # Get current summary state
        current_summary = await self.get_summary(chat_id)
        summarized_count = await self.get_summarized_message_count(chat_id)

        # Calculate unsummarized messages
        unsummarized_count = len(messages) - summarized_count

        # Check if we should summarize
        should_summarize = (
            force or
            unsummarized_count >= self.SUMMARY_THRESHOLD or
            (len(messages) > 20 and not current_summary)
        )

        if not should_summarize:
            logger.debug(f"Skipping summarization: {unsummarized_count} unsummarized messages (threshold: {self.SUMMARY_THRESHOLD})")
            return current_summary

        logger.info(f"Triggering summarization for chat {chat_id}: {unsummarized_count} new messages")

        # Get messages to summarize
        if current_summary and summarized_count > 0:
            # Incremental: only summarize new messages
            new_messages = messages[summarized_count:]
        else:
            # Full: summarize all messages
            new_messages = messages

        # Generate summary
        updated_summary = await self._generate_summary(
            current_summary=current_summary,
            new_messages=new_messages,
            hint=hint,
        )

        if updated_summary:
            # If the summary itself is too long, re-fold it once.
            if len(updated_summary) > self.MAX_SUMMARY_LENGTH:
                logger.info(
                    "Summary grew to %d chars; running re-summary pass",
                    len(updated_summary),
                )
                refolded = await self._generate_summary(
                    current_summary=updated_summary,
                    new_messages=[],
                    hint="Re-fold the existing summary to fit within "
                         f"{self.MAX_SUMMARY_LENGTH} characters without "
                         "dropping Pinned Facts.",
                )
                if refolded:
                    updated_summary = refolded
            await self._store_summary(
                chat_id=chat_id,
                summary=updated_summary,
                message_count=len(messages)
            )
            return updated_summary

        return current_summary

    async def _generate_summary(
        self,
        current_summary: Optional[str],
        new_messages: List[Dict[str, Any]],
        hint: Optional[str] = None,
    ) -> Optional[str]:
        """
        Generate summary using LLM.

        Args:
            current_summary: Existing summary to update
            new_messages: New messages to incorporate

        Returns:
            Generated summary or None on failure
        """
        # Format messages and build the structured prompt once — both
        # the gateway and the legacy llm_service path use the same body.
        formatted_messages = self._format_messages_for_prompt(new_messages)
        hint_block = f"USER HINT (apply when in doubt):\n{hint}" if hint else ""
        prompt = self.SUMMARY_PROMPT.format(
            current_summary=current_summary or "No previous summary.",
            new_messages=formatted_messages or "No new messages.",
            hint_block=hint_block,
        )
        messages = [
            {"role": "system", "content": self.SUMMARY_SYSTEM_PROMPT},
            {"role": "user", "content": prompt},
        ]

        # Prefer the gateway path so this runs on gpt-oss (.61), pinned by
        # force_backend=text. Falls back to legacy llm_service if the
        # gateway is unreachable.
        if self._gateway_url:
            try:
                summary = await self._summarize_via_gateway(messages)
                summary = self._normalize_summary(summary)
                if summary:
                    logger.info("Generated summary via gateway: %d chars", len(summary))
                    return summary
            except Exception as e:
                logger.warning(
                    "Summary via llm-gateway failed (%s); falling back", e,
                )

        if not self.llm:
            logger.warning("LLM service not available for summarization")
            return self._fallback_summary(new_messages)

        try:
            result = self.llm.generate(
                messages=messages,
                mode="offline",
                temperature=0.3,
                max_tokens=800,
                use_cache=False,
            )
            summary = self._normalize_summary(result.get("response", ""))
            if not summary:
                logger.warning("Empty summary returned from legacy LLM path")
                return self._fallback_summary(new_messages)
            logger.info("Generated summary via legacy path: %d chars", len(summary))
            return summary
        except Exception as e:
            logger.error(f"LLM summarization failed: {e}")
            return self._fallback_summary(new_messages)

    async def _summarize_via_gateway(self, messages: List[Dict[str, str]]) -> str:
        """POST to llm-gateway pinned to the text backend (gpt-oss-20b)."""
        timeout = float(os.getenv("LLM_GATEWAY_SUMMARY_TIMEOUT_SEC", "120"))
        payload = {
            "messages": messages,
            "mode": "offline",
            "force_backend": "text",
            "temperature": 0.3,
            "max_tokens": int(os.getenv("SUMMARY_MAX_TOKENS", "800")),
        }
        async with httpx.AsyncClient(timeout=timeout) as client:
            r = await client.post(f"{self._gateway_url}/generate", json=payload)
            r.raise_for_status()
            body = r.json()
        return body.get("response", "") or ""

    def _normalize_summary(self, text: str) -> str:
        """Strip code fences and ensure ``<summary>...</summary>`` framing.

        The model is asked to emit the tags directly; if it forgets, we
        wrap whatever was returned so downstream consumers can rely on
        the framing.
        """
        s = (text or "").strip()
        if not s:
            return ""
        # Strip a markdown fence if the model wrapped the block in one.
        if s.startswith("```"):
            lines = s.split("\n")
            if lines[0].startswith("```"):
                lines = lines[1:]
            if lines and lines[-1].startswith("```"):
                lines = lines[:-1]
            s = "\n".join(lines).strip()
        if SUMMARY_OPEN_TAG not in s:
            s = f"{SUMMARY_OPEN_TAG}\n{s}\n{SUMMARY_CLOSE_TAG}"
        elif SUMMARY_CLOSE_TAG not in s:
            s = f"{s}\n{SUMMARY_CLOSE_TAG}"
        return s

    def _fallback_summary(self, messages: List[Dict[str, Any]]) -> str:
        """
        Generate fallback summary without LLM (simple extraction).

        Args:
            messages: Messages to summarize

        Returns:
            Simple summary string
        """
        if not messages:
            return ""

        try:
            # Extract key information
            topics = []
            for msg in messages[-10:]:  # Last 10 messages
                content = msg.get("content", msg.get("text", ""))[:100]
                role = msg.get("role", "user")
                if role == "user" and content:
                    topics.append(f"- User asked about: {content}")

            if topics:
                return "**Recent Topics:**\n" + "\n".join(topics[:5])

            return "Ongoing technical discussion."

        except Exception as e:
            logger.error(f"Fallback summary failed: {e}")
            return ""

    def _format_messages_for_prompt(self, messages: List[Dict[str, Any]]) -> str:
        """Format messages for inclusion in summary prompt"""
        if not messages:
            return "No new messages."

        lines = []
        for msg in messages[-15:]:  # Limit to last 15 messages for prompt
            role = msg.get("role", "user").capitalize()
            content = msg.get("content", msg.get("text", ""))

            # Truncate very long messages
            if len(content) > 500:
                content = content[:500] + "..."

            lines.append(f"**{role}**: {content}")

        return "\n\n".join(lines)

    async def _store_summary(
        self,
        chat_id: str,
        summary: str,
        message_count: int
    ) -> bool:
        """
        Store summary in Redis.

        Args:
            chat_id: Chat identifier
            summary: Generated summary
            message_count: Number of messages summarized

        Returns:
            True if successful
        """
        if not self.redis:
            logger.warning("Redis service not available for summary storage")
            return False

        try:
            summary_data = {
                "summary": summary,
                "message_count": message_count,
                "updated_at": datetime.utcnow().isoformat()
            }

            self.redis.set(
                f"chat:{chat_id}:summary",
                summary_data,
                db="chat",
                ttl=86400 * 30  # 30 days
            )

            logger.info(f"Summary stored for chat {chat_id}: {message_count} messages summarized")
            return True

        except Exception as e:
            logger.error(f"Failed to store summary: {e}")
            return False

    async def clear_summary(self, chat_id: str) -> bool:
        """
        Clear summary for a chat.

        Args:
            chat_id: Chat identifier

        Returns:
            True if successful
        """
        if not self.redis:
            return False

        try:
            self.redis.delete(f"chat:{chat_id}:summary", db="chat")
            logger.info(f"Summary cleared for chat {chat_id}")
            return True
        except Exception as e:
            logger.error(f"Failed to clear summary: {e}")
            return False


# =============================================================================
# SINGLETON INSTANCE
# =============================================================================

_summarizer: Optional[ConversationSummarizer] = None


def get_conversation_summarizer(
    llm_service=None,
    redis_service=None
) -> ConversationSummarizer:
    """Get or create conversation summarizer singleton"""
    global _summarizer

    if _summarizer is None:
        _summarizer = ConversationSummarizer(
            llm_service=llm_service,
            redis_service=redis_service
        )
    elif llm_service or redis_service:
        _summarizer.set_services(llm_service, redis_service)

    return _summarizer
