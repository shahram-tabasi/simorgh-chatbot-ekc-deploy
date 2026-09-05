"""
Token Budget
============
Token-aware accounting for the LLM context window.

The LLM wrapper used to slice history at a fixed message count
(``max_history=20``), which silently overflows on tool-heavy turns where
each message can be thousands of tokens. This module replaces that with
a real token budget:

    fixed_tokens     = system prompt + RAG chunks + current user message
    response_budget  = RESERVED_FOR_RESPONSE   (env, default 2048)
    history_budget   = MODEL_CONTEXT_LIMIT - fixed_tokens - response_budget
    compaction_at    = MODEL_CONTEXT_LIMIT * COMPACTION_TRIGGER_RATIO

``fit_history`` walks the history newest-to-oldest, keeping verbatim
turns until the budget is exhausted, and reports which older messages
were dropped so the caller can replace them with a ``<summary>`` block.

tiktoken is preferred. If unavailable (no internet at build time, or a
non-OpenAI tokenizer is in use) we fall back to ``len(text) // 4`` —
intentionally generous, since under-estimating the prompt is worse than
over-estimating.
"""
from __future__ import annotations

import logging
import os
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Tokenizer — lazy, optional
# ---------------------------------------------------------------------------
_ENCODING = None
_TIKTOKEN_TRIED = False


def _get_encoding():
    """Lazy-load a tiktoken encoding once. Returns None on failure."""
    global _ENCODING, _TIKTOKEN_TRIED
    if _TIKTOKEN_TRIED:
        return _ENCODING
    _TIKTOKEN_TRIED = True
    try:
        import tiktoken  # type: ignore
        try:
            _ENCODING = tiktoken.get_encoding("cl100k_base")
        except Exception:
            _ENCODING = tiktoken.get_encoding("o200k_base")
    except Exception as e:
        logger.info("tiktoken not available (%s); using char/4 fallback", e)
        _ENCODING = None
    return _ENCODING


def count_tokens(text: str) -> int:
    """Token count for a plain string. tiktoken if present, else char/4."""
    if not text:
        return 0
    enc = _get_encoding()
    if enc is None:
        return max(1, len(text) // 4)
    try:
        return len(enc.encode(text))
    except Exception:
        return max(1, len(text) // 4)


# Per-message overhead in the OpenAI chat format (role + boundary tokens).
# 3 is what OpenAI documents for gpt-3.5/4; close enough for gpt-oss too.
_PER_MESSAGE_OVERHEAD = 3


def count_message_tokens(messages: List[Dict[str, Any]]) -> int:
    """Token count for an OpenAI-shape message list."""
    total = 0
    for m in messages or []:
        total += _PER_MESSAGE_OVERHEAD
        content = m.get("content", "")
        if isinstance(content, str):
            total += count_tokens(content)
        elif isinstance(content, list):
            # Multimodal content parts; only text parts cost LLM tokens.
            for part in content:
                if isinstance(part, dict) and part.get("type") == "text":
                    total += count_tokens(part.get("text", ""))
        role = m.get("role")
        if role:
            total += count_tokens(role)
    # Closing "assistant" priming tokens.
    total += _PER_MESSAGE_OVERHEAD
    return total


# ---------------------------------------------------------------------------
# Config (env-tunable)
# ---------------------------------------------------------------------------
def _int_env(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


def _float_env(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


def model_context_limit() -> int:
    """Max tokens the model can hold. gpt-oss-20b default is 32k."""
    return _int_env("MODEL_CONTEXT_LIMIT", 32768)


def reserved_for_response() -> int:
    """Tokens reserved for the model's output. Larger for project chats."""
    return _int_env("RESERVED_FOR_RESPONSE", 2048)


def compaction_trigger_ratio() -> float:
    """Fraction of the context window that triggers auto-compaction.

    Lower than Claude Code's 95% because tool outputs (gitlab reads,
    TPMS dumps, doc-processor markdown) inflate prompts quickly.
    """
    return _float_env("COMPACTION_TRIGGER_RATIO", 0.75)


# ---------------------------------------------------------------------------
# Two-tier history fit
# ---------------------------------------------------------------------------
def fit_history(
    history: List[Dict[str, Any]],
    fixed_tokens: int,
    pinned_indices: Optional[List[int]] = None,
    context_limit: Optional[int] = None,
    response_reserve: Optional[int] = None,
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], Dict[str, int]]:
    """Slice ``history`` to fit the remaining token budget.

    Strategy: pinned messages (by index) are kept first, then verbatim tail
    newest→oldest until the budget is exhausted. Returned ``kept`` is in
    chronological order; ``dropped`` (older messages) is also chronological
    so callers can summarize them in the right order.

    Args:
        history: chronologically ordered list of OpenAI-shape messages.
        fixed_tokens: tokens already committed to system+RAG+current user.
        pinned_indices: indices into ``history`` that must be kept
            regardless of budget (e.g. stage transitions, pinned facts).
        context_limit / response_reserve: override env defaults.

    Returns:
        (kept_messages, dropped_messages, info)
        ``info`` carries ``budget``, ``used_tokens``, ``history_tokens``,
        ``dropped_count``, ``trigger_compaction`` (bool).
    """
    limit = context_limit if context_limit is not None else model_context_limit()
    reserve = response_reserve if response_reserve is not None else reserved_for_response()
    budget = max(0, limit - fixed_tokens - reserve)

    history = history or []
    n = len(history)
    if n == 0:
        return [], [], {
            "budget": budget, "used_tokens": 0, "history_tokens": 0,
            "dropped_count": 0, "trigger_compaction": False,
        }

    pinned = set(pinned_indices or [])
    pinned_msgs = [history[i] for i in sorted(pinned) if 0 <= i < n]
    pinned_tokens = count_message_tokens(pinned_msgs) if pinned_msgs else 0
    remaining = max(0, budget - pinned_tokens)

    # Fill tail newest-to-oldest with non-pinned messages.
    kept_indices = set(i for i in pinned if 0 <= i < n)
    used = pinned_tokens
    for i in range(n - 1, -1, -1):
        if i in kept_indices:
            continue
        m = history[i]
        cost = count_message_tokens([m])
        if used + cost > budget:
            break
        used += cost
        kept_indices.add(i)

    kept = [history[i] for i in sorted(kept_indices)]
    dropped = [history[i] for i in range(n) if i not in kept_indices]
    history_tokens = count_message_tokens(history)

    total_in_window = fixed_tokens + used + reserve
    trigger = total_in_window > limit * compaction_trigger_ratio() or bool(dropped)

    return kept, dropped, {
        "budget": budget,
        "used_tokens": used,
        "history_tokens": history_tokens,
        "dropped_count": len(dropped),
        "trigger_compaction": trigger,
        "context_limit": limit,
        "fixed_tokens": fixed_tokens,
        "response_reserve": reserve,
    }
