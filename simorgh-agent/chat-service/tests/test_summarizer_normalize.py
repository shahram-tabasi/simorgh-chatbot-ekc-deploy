"""Tests for the summary-framing helper in ConversationSummarizer."""

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))

from services.conversation_summarizer import (  # noqa: E402
    ConversationSummarizer,
    SUMMARY_OPEN_TAG,
    SUMMARY_CLOSE_TAG,
)


def _s():
    return ConversationSummarizer(llm_service=None, redis_service=None)


def test_normalize_empty_returns_empty():
    assert _s()._normalize_summary("") == ""
    assert _s()._normalize_summary("   ") == ""


def test_normalize_strips_markdown_fence():
    raw = "```\n## Topic\nfoo\n```"
    out = _s()._normalize_summary(raw)
    assert "```" not in out
    assert SUMMARY_OPEN_TAG in out and SUMMARY_CLOSE_TAG in out
    assert "## Topic" in out


def test_normalize_wraps_when_tags_missing():
    out = _s()._normalize_summary("## Topic\nplain text")
    assert out.startswith(SUMMARY_OPEN_TAG)
    assert out.endswith(SUMMARY_CLOSE_TAG)


def test_normalize_leaves_already_tagged_intact():
    raw = f"{SUMMARY_OPEN_TAG}\n## Topic\nx\n{SUMMARY_CLOSE_TAG}"
    out = _s()._normalize_summary(raw)
    # Same content, possibly stripped — must still have both tags exactly once.
    assert out.count(SUMMARY_OPEN_TAG) == 1
    assert out.count(SUMMARY_CLOSE_TAG) == 1


def test_normalize_closes_when_only_open_tag_present():
    raw = f"{SUMMARY_OPEN_TAG}\n## Topic\nstuff"
    out = _s()._normalize_summary(raw)
    assert SUMMARY_CLOSE_TAG in out
