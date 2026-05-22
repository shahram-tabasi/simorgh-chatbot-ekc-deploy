"""Unit tests for chatbot_core.token_budget."""

import os
import sys
from pathlib import Path

# Make `chatbot_core` importable when pytest is run from the repo root.
HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))

from chatbot_core import token_budget as tb  # noqa: E402


def test_count_tokens_zero_for_empty():
    assert tb.count_tokens("") == 0
    assert tb.count_tokens(None) == 0  # type: ignore[arg-type]


def test_count_tokens_grows_with_text():
    assert tb.count_tokens("hi") < tb.count_tokens("hello world " * 50)


def test_count_message_tokens_includes_role_and_overhead():
    msgs = [{"role": "user", "content": "hi"}]
    n = tb.count_message_tokens(msgs)
    # per-message overhead (3) + role token + content token + trailing 3
    assert n >= 4


def test_count_message_tokens_handles_multimodal_text_parts():
    msgs = [{
        "role": "user",
        "content": [
            {"type": "text", "text": "look at this"},
            {"type": "image_url", "image_url": {"url": "..."}},
        ],
    }]
    n = tb.count_message_tokens(msgs)
    # image_url has no token cost in this accounting; only the text part does.
    text_only = tb.count_message_tokens([{"role": "user", "content": "look at this"}])
    assert n == text_only


def test_fit_history_keeps_everything_when_budget_is_large(monkeypatch):
    monkeypatch.setenv("MODEL_CONTEXT_LIMIT", "32768")
    monkeypatch.setenv("RESERVED_FOR_RESPONSE", "1024")
    hist = [{"role": "user", "content": f"msg {i}"} for i in range(10)]
    kept, dropped, info = tb.fit_history(hist, fixed_tokens=200)
    assert kept == hist
    assert dropped == []
    assert info["dropped_count"] == 0


def _hist(n: int, size: int = 200):
    """Build n distinct user messages so identity tests work."""
    return [
        {"role": "user", "content": f"#{i}:" + ("x" * (size - 4))}
        for i in range(n)
    ]


def test_fit_history_drops_oldest_when_budget_tight(monkeypatch):
    monkeypatch.setenv("MODEL_CONTEXT_LIMIT", "200")
    monkeypatch.setenv("RESERVED_FOR_RESPONSE", "20")
    hist = _hist(8)
    kept, dropped, info = tb.fit_history(hist, fixed_tokens=20)
    assert len(dropped) > 0
    assert info["dropped_count"] == len(dropped)
    # Every dropped index is earlier than every kept index.
    kept_indices = [hist.index(m) for m in kept]
    dropped_indices = [hist.index(m) for m in dropped]
    if kept_indices and dropped_indices:
        assert max(dropped_indices) < min(kept_indices)


def test_fit_history_pinned_indices_always_kept(monkeypatch):
    monkeypatch.setenv("MODEL_CONTEXT_LIMIT", "300")
    monkeypatch.setenv("RESERVED_FOR_RESPONSE", "20")
    hist = _hist(8)
    # Pin index 0 — which would otherwise be the first to drop.
    kept, dropped, _ = tb.fit_history(hist, fixed_tokens=20, pinned_indices=[0])
    assert hist[0] in kept
    assert hist[0] not in dropped


def test_fit_history_signals_compaction_when_history_dropped(monkeypatch):
    monkeypatch.setenv("MODEL_CONTEXT_LIMIT", "200")
    monkeypatch.setenv("RESERVED_FOR_RESPONSE", "20")
    hist = _hist(8)
    _, dropped, info = tb.fit_history(hist, fixed_tokens=20)
    assert dropped, "test setup must force drops"
    assert info["trigger_compaction"] is True


def test_fit_history_empty_history():
    kept, dropped, info = tb.fit_history([], fixed_tokens=100)
    assert kept == [] and dropped == []
    assert info["dropped_count"] == 0
    assert info["trigger_compaction"] is False


def test_env_overrides_are_picked_up(monkeypatch):
    monkeypatch.setenv("MODEL_CONTEXT_LIMIT", "9999")
    monkeypatch.setenv("RESERVED_FOR_RESPONSE", "111")
    monkeypatch.setenv("COMPACTION_TRIGGER_RATIO", "0.5")
    assert tb.model_context_limit() == 9999
    assert tb.reserved_for_response() == 111
    assert tb.compaction_trigger_ratio() == 0.5
