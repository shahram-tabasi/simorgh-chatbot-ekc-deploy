"""
Conversation Summarizer
=======================
Generates rolling summaries to compress long conversations.
Maintains context while reducing token usage.

Author: Simorgh Industrial Assistant
"""

import logging
from typing import List, Dict, Any, Optional
from datetime import datetime
import json

logger = logging.getLogger(__name__)


class ConversationSummarizer:
    """
    Generates and maintains rolling conversation summaries.

    Features:
    - Incremental summarization (updates existing summary with new messages)
    - Preserves key facts, decisions, and technical details
    - Configurable summary triggers
    - Fallback to truncation if LLM fails
    """

    # Trigger summarization every N unsummarized messages
    SUMMARY_THRESHOLD = 8

    # Maximum summary length in characters
    MAX_SUMMARY_LENGTH = 1500

    # Summary prompt template
    SUMMARY_PROMPT = """You are a conversation summarizer for a technical electrical engineering assistant.

Your task is to create or update a conversation summary that captures the essential context needed for future responses.

CURRENT SUMMARY (if any):
{current_summary}

NEW MESSAGES TO INCORPORATE:
{new_messages}

INSTRUCTIONS:
1. Create a concise summary (max 300 words) that preserves:
   - Key technical specifications mentioned (voltages, currents, equipment models)
   - Important decisions or conclusions reached
   - User preferences or requirements stated
   - Any project-specific context
   - Questions that remain unanswered

2. Structure the summary as:
   - **Topic**: Brief description of what's being discussed
   - **Key Details**: Important technical facts (bullet points)
   - **Context**: User's goals or requirements
   - **Status**: Current state of the conversation

3. Remove:
   - Redundant information
   - Pleasantries and filler
   - Information that's been superseded

Generate the updated summary now:"""

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

    async def maybe_summarize(
        self,
        chat_id: str,
        messages: List[Dict[str, Any]],
        force: bool = False
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
            new_messages=new_messages
        )

        if updated_summary:
            # Store updated summary
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
        new_messages: List[Dict[str, Any]]
    ) -> Optional[str]:
        """
        Generate summary using LLM.

        Args:
            current_summary: Existing summary to update
            new_messages: New messages to incorporate

        Returns:
            Generated summary or None on failure
        """
        if not self.llm:
            logger.warning("LLM service not available for summarization")
            return self._fallback_summary(new_messages)

        try:
            # Format messages for the prompt
            formatted_messages = self._format_messages_for_prompt(new_messages)

            # Build prompt
            prompt = self.SUMMARY_PROMPT.format(
                current_summary=current_summary or "No previous summary.",
                new_messages=formatted_messages
            )

            # Generate summary using LLM
            result = self.llm.generate(
                messages=[
                    {"role": "system", "content": "You are a helpful assistant that creates concise conversation summaries."},
                    {"role": "user", "content": prompt}
                ],
                mode="offline",  # Use local LLM for speed
                temperature=0.3,
                max_tokens=500,
                use_cache=False  # Don't cache summaries
            )

            summary = result.get("response", "").strip()

            if not summary:
                logger.warning("Empty summary returned from LLM")
                return self._fallback_summary(new_messages)

            # Truncate if too long
            if len(summary) > self.MAX_SUMMARY_LENGTH:
                summary = summary[:self.MAX_SUMMARY_LENGTH - 3] + "..."

            logger.info(f"Generated summary: {len(summary)} characters")
            return summary

        except Exception as e:
            logger.error(f"LLM summarization failed: {e}")
            return self._fallback_summary(new_messages)

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
