"""
Context Window Manager
======================
Token-aware context window management for LLM calls.
Ensures context fits within model token limits with priority-based truncation.

Author: Simorgh Industrial Assistant
"""

import logging
from typing import List, Dict, Any, Optional, Tuple
from dataclasses import dataclass, field
import tiktoken
import re

logger = logging.getLogger(__name__)


@dataclass
class ContextBudget:
    """Token budget allocation for different context components"""
    recent_history: int = 0
    session_summary: int = 0
    semantic_memory: int = 0
    graph_context: int = 0
    system_prompt: int = 0
    current_message: int = 0
    response_buffer: int = 0
    total_used: int = 0
    total_available: int = 0


@dataclass
class ContextResult:
    """Result of context building"""
    messages: List[Dict[str, str]]
    budget: ContextBudget
    truncated: bool = False
    warnings: List[str] = field(default_factory=list)


class ContextWindowManager:
    """
    Manages context within LLM token limits.

    Features:
    - Token counting for accurate budget management
    - Priority-based context inclusion
    - Smart truncation of less important content
    - Support for multiple LLM models
    """

    # Model-specific context limits
    MODEL_LIMITS = {
        "gpt-4": 8192,
        "gpt-4-turbo": 128000,
        "gpt-4o": 128000,
        "gpt-4o-mini": 128000,
        "gpt-3.5-turbo": 16385,
        "claude-3-opus": 200000,
        "claude-3-sonnet": 200000,
        "claude-3-haiku": 200000,
        "local": 8192,  # Conservative default for local models
    }

    # Default budget allocation percentages
    DEFAULT_BUDGET = {
        "system_prompt": 0.15,      # 15% for system prompt
        "graph_context": 0.25,      # 25% for knowledge graph/RAG context
        "semantic_memory": 0.15,    # 15% for semantic memory retrieval
        "session_summary": 0.10,    # 10% for conversation summary
        "recent_history": 0.25,     # 25% for recent messages
        "response_buffer": 0.10,    # 10% reserved for response
    }

    def __init__(
        self,
        model: str = "gpt-4o",
        max_tokens: Optional[int] = None,
        budget_allocation: Optional[Dict[str, float]] = None
    ):
        """
        Initialize context window manager.

        Args:
            model: Model name for token counting and limits
            max_tokens: Override max tokens (otherwise uses model default)
            budget_allocation: Custom budget allocation percentages
        """
        self.model = model
        self.max_tokens = max_tokens or self.MODEL_LIMITS.get(model, 8192)
        self.budget_allocation = budget_allocation or self.DEFAULT_BUDGET

        # Initialize tokenizer
        try:
            # Try to get model-specific tokenizer
            if "gpt" in model.lower():
                self.tokenizer = tiktoken.encoding_for_model(model)
            else:
                # Use cl100k_base for Claude and other models
                self.tokenizer = tiktoken.get_encoding("cl100k_base")
        except Exception as e:
            logger.warning(f"Failed to load tokenizer for {model}, using cl100k_base: {e}")
            self.tokenizer = tiktoken.get_encoding("cl100k_base")

        logger.info(f"ContextWindowManager initialized: model={model}, max_tokens={self.max_tokens}")

    def count_tokens(self, text: str) -> int:
        """Count tokens in a text string"""
        if not text:
            return 0
        try:
            return len(self.tokenizer.encode(text))
        except Exception as e:
            logger.warning(f"Token counting failed, using estimate: {e}")
            # Fallback: rough estimate of 4 chars per token
            return len(text) // 4

    def count_message_tokens(self, messages: List[Dict[str, str]]) -> int:
        """Count tokens in a list of messages"""
        total = 0
        for msg in messages:
            # Add overhead for message structure (role, etc.)
            total += 4  # Approximate overhead per message
            total += self.count_tokens(msg.get("role", ""))
            total += self.count_tokens(msg.get("content", ""))
        return total

    def _calculate_budget(
        self,
        system_prompt_tokens: int,
        current_message_tokens: int
    ) -> ContextBudget:
        """Calculate token budget for each component"""

        # Fixed allocations
        response_buffer = int(self.max_tokens * self.budget_allocation["response_buffer"])

        # Available tokens after fixed allocations
        available = self.max_tokens - system_prompt_tokens - current_message_tokens - response_buffer

        if available <= 0:
            logger.warning(f"Negative available tokens: {available}. System prompt or message too large.")
            available = 1000  # Minimum fallback

        # Distribute remaining budget
        budget = ContextBudget(
            system_prompt=system_prompt_tokens,
            current_message=current_message_tokens,
            response_buffer=response_buffer,
            total_available=self.max_tokens,
            graph_context=int(available * 0.35),       # Prioritize RAG context
            recent_history=int(available * 0.30),      # Then recent history
            semantic_memory=int(available * 0.20),     # Then semantic memory
            session_summary=int(available * 0.15),     # Then summary
        )

        return budget

    def _truncate_text(self, text: str, max_tokens: int) -> Tuple[str, bool]:
        """Truncate text to fit within token limit"""
        if not text:
            return "", False

        current_tokens = self.count_tokens(text)
        if current_tokens <= max_tokens:
            return text, False

        # Binary search for truncation point
        tokens = self.tokenizer.encode(text)
        truncated_tokens = tokens[:max_tokens - 10]  # Leave room for "..."
        truncated_text = self.tokenizer.decode(truncated_tokens)

        # Add ellipsis to indicate truncation
        truncated_text = truncated_text.rstrip() + "..."

        return truncated_text, True

    def _truncate_messages(
        self,
        messages: List[Dict[str, str]],
        max_tokens: int
    ) -> Tuple[List[Dict[str, str]], bool]:
        """
        Truncate message list to fit within token limit.
        Keeps most recent messages (LIFO truncation).
        """
        if not messages:
            return [], False

        current_tokens = self.count_message_tokens(messages)
        if current_tokens <= max_tokens:
            return messages, False

        # Remove oldest messages until we fit
        truncated = list(messages)
        was_truncated = False

        while len(truncated) > 1 and self.count_message_tokens(truncated) > max_tokens:
            truncated.pop(0)  # Remove oldest
            was_truncated = True

        # If still too large, truncate the oldest remaining message
        if self.count_message_tokens(truncated) > max_tokens and truncated:
            oldest = truncated[0]
            content = oldest.get("content", "")
            remaining_tokens = max_tokens - self.count_message_tokens(truncated[1:]) if len(truncated) > 1 else max_tokens
            truncated_content, _ = self._truncate_text(content, remaining_tokens - 10)
            truncated[0] = {**oldest, "content": truncated_content}
            was_truncated = True

        return truncated, was_truncated

    def build_context(
        self,
        system_prompt: str,
        current_message: str,
        chat_history: Optional[List[Dict[str, str]]] = None,
        semantic_memories: Optional[List[Dict[str, Any]]] = None,
        session_summary: Optional[str] = None,
        graph_context: Optional[str] = None,
        project_context: Optional[str] = None
    ) -> ContextResult:
        """
        Build context that fits within token budget.

        Priority order (highest to lowest):
        1. System prompt (always included)
        2. Current message (always included)
        3. Graph/RAG context (project-specific knowledge)
        4. Recent chat history (conversation continuity)
        5. Semantic memories (relevant past conversations)
        6. Session summary (compressed conversation context)

        Args:
            system_prompt: Base system prompt
            current_message: Current user message
            chat_history: Recent chat messages
            semantic_memories: Semantically similar past conversations
            session_summary: Compressed summary of conversation
            graph_context: Knowledge graph/RAG context
            project_context: Project-specific context

        Returns:
            ContextResult with messages and budget info
        """
        warnings = []
        truncated = False

        # Calculate initial tokens
        system_tokens = self.count_tokens(system_prompt)
        message_tokens = self.count_tokens(current_message)

        # Calculate budget
        budget = self._calculate_budget(system_tokens, message_tokens)

        # Build enhanced system prompt
        enhanced_system = system_prompt

        # Add project context if available
        if project_context:
            project_tokens = self.count_tokens(project_context)
            if project_tokens <= budget.graph_context // 4:
                enhanced_system += f"\n\n## Project Context\n{project_context}"
            else:
                truncated_project, _ = self._truncate_text(project_context, budget.graph_context // 4)
                enhanced_system += f"\n\n## Project Context\n{truncated_project}"
                warnings.append("Project context was truncated")
                truncated = True

        # Add graph/RAG context (highest priority for knowledge)
        if graph_context:
            graph_tokens = self.count_tokens(graph_context)
            if graph_tokens <= budget.graph_context:
                enhanced_system += f"\n\n{graph_context}"
                budget.graph_context = graph_tokens
            else:
                truncated_graph, _ = self._truncate_text(graph_context, budget.graph_context)
                enhanced_system += f"\n\n{truncated_graph}"
                warnings.append("Graph context was truncated")
                truncated = True

        # Add session summary if available
        if session_summary:
            summary_tokens = self.count_tokens(session_summary)
            if summary_tokens <= budget.session_summary:
                enhanced_system += f"\n\n## Conversation Summary\n{session_summary}"
                budget.session_summary = summary_tokens
            else:
                truncated_summary, _ = self._truncate_text(session_summary, budget.session_summary)
                enhanced_system += f"\n\n## Conversation Summary\n{truncated_summary}"
                warnings.append("Session summary was truncated")
                truncated = True

        # Add semantic memories
        if semantic_memories:
            memory_text = self._format_semantic_memories(semantic_memories)
            memory_tokens = self.count_tokens(memory_text)
            if memory_tokens <= budget.semantic_memory:
                enhanced_system += f"\n\n{memory_text}"
                budget.semantic_memory = memory_tokens
            else:
                # Reduce number of memories to fit
                reduced_memories = semantic_memories[:3]  # Keep top 3
                reduced_text = self._format_semantic_memories(reduced_memories)
                if self.count_tokens(reduced_text) <= budget.semantic_memory:
                    enhanced_system += f"\n\n{reduced_text}"
                    warnings.append(f"Semantic memories reduced from {len(semantic_memories)} to {len(reduced_memories)}")
                truncated = True

        # Build message list
        messages = [{"role": "system", "content": enhanced_system}]

        # Add chat history
        if chat_history:
            history_messages = [
                {"role": msg.get("role", "user"), "content": msg.get("content", msg.get("text", ""))}
                for msg in chat_history
            ]

            truncated_history, history_truncated = self._truncate_messages(
                history_messages,
                budget.recent_history
            )

            if history_truncated:
                warnings.append(f"Chat history truncated from {len(chat_history)} to {len(truncated_history)} messages")
                truncated = True

            messages.extend(truncated_history)
            budget.recent_history = self.count_message_tokens(truncated_history)

        # Add current message
        messages.append({"role": "user", "content": current_message})

        # Calculate total used
        budget.total_used = self.count_message_tokens(messages)

        # Final validation
        if budget.total_used > self.max_tokens - budget.response_buffer:
            logger.warning(f"Context still exceeds budget: {budget.total_used} > {self.max_tokens - budget.response_buffer}")
            warnings.append("Context may exceed token limit")

        logger.info(
            f"Context built: {budget.total_used}/{self.max_tokens} tokens used "
            f"({budget.total_used * 100 / self.max_tokens:.1f}%), "
            f"truncated={truncated}"
        )

        return ContextResult(
            messages=messages,
            budget=budget,
            truncated=truncated,
            warnings=warnings
        )

    def _format_semantic_memories(self, memories: List[Dict[str, Any]]) -> str:
        """Format semantic memories for inclusion in context"""
        if not memories:
            return ""

        # Check if these are fallback (recent) or semantic matches
        is_fallback = memories[0].get("is_fallback", False)

        if is_fallback:
            header = "## Recent Conversation History\n"
            header += "Here are your most recent conversations for reference:\n\n"
        else:
            header = "## Relevant Past Conversations\n"
            header += "Here are semantically similar past discussions:\n\n"

        lines = [header]

        for idx, mem in enumerate(memories, 1):
            user_msg = mem.get("user_message", "")[:150]
            assistant_msg = mem.get("assistant_response", "")[:200]
            score = mem.get("score", 0)

            if is_fallback:
                lines.append(f"**{idx}. Previous Q&A:**")
            else:
                lines.append(f"**{idx}. Previous Q&A** (Relevance: {score:.0%}):")

            lines.append(f"  - You asked: \"{user_msg}{'...' if len(mem.get('user_message', '')) > 150 else ''}\"")
            lines.append(f"  - I answered: \"{assistant_msg}{'...' if len(mem.get('assistant_response', '')) > 200 else ''}\"\n")

        return "\n".join(lines)


# =============================================================================
# SINGLETON INSTANCE
# =============================================================================

_context_manager: Optional[ContextWindowManager] = None


def get_context_window_manager(
    model: str = None,
    max_tokens: int = None
) -> ContextWindowManager:
    """Get or create context window manager singleton"""
    global _context_manager

    if _context_manager is None:
        import os
        model = model or os.getenv("OPENAI_MODEL", "gpt-4o")
        _context_manager = ContextWindowManager(model=model, max_tokens=max_tokens)

    return _context_manager
