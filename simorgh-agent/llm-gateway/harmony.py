"""
harmony.py — gpt-oss Harmony response-format parser for the gateway.

Background
==========
OpenAI's gpt-oss family (gpt-oss-20b, gpt-oss-120b) was post-trained on
the Harmony response format. Even when served via vLLM's OpenAI-shaped
`/v1/chat/completions`, the assistant's output is structured across three
named channels emitted with sentinel tokens:

  <|channel|>analysis<|message|>...the model's raw chain of thought...
  <|channel|>commentary<|message|>...preambles + tool calls...
  <|channel|>final<|message|>...the user-facing answer...

OpenAI documents the `analysis` channel as **unaligned** — it is the
model's private reasoning and must NEVER be returned to end users or
written to durable logs (cookbook: "How to handle the raw CoT in
gpt-oss"). When vLLM is served with `--reasoning-parser openai_gptoss`
the gateway gets:

  message.content           → final channel only
  message.reasoning_content → analysis channel (drop this!)
  message.tool_calls        → parsed tool calls

When that flag is NOT set, the raw Harmony tokens leak into
`message.content` and downstream parsers see garbled output. This
module makes the gateway resilient to both serving modes:

  * `is_harmony_output(text)` — true if Harmony sentinel tokens appear.
  * `parse_harmony(text)` — returns {final, analysis, commentary,
    tool_calls}. Uses the official `openai-harmony` library when
    importable; otherwise falls back to a deterministic regex parser
    over the documented sentinel tokens.
  * `sanitize_chat_message(msg)` — given a chat-completions
    `message` dict, returns a sanitized copy with the `analysis`
    channel dropped, `content` collapsed to the `final` channel, and
    tool_calls extracted from `commentary` when missing.
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

# Best-effort import of the official Harmony library. If unavailable
# (offline air-gapped host where pip install couldn't run), the regex
# parser below is sufficient for the channel-extraction and tool-call
# cases the gateway needs.
try:  # pragma: no cover — import-only sanity, behaviour-tested below.
    from openai_harmony import (
        load_harmony_encoding,
        HarmonyEncodingName,
        Role,
    )
    _ENC = load_harmony_encoding(HarmonyEncodingName.HARMONY_GPT_OSS)
    _HARMONY_LIB_AVAILABLE = True
except Exception as e:  # noqa: BLE001 — fallback covers all import failures.
    logger.info(
        "harmony: openai-harmony library not importable (%s) — using "
        "regex fallback parser",
        e,
    )
    _ENC = None
    _HARMONY_LIB_AVAILABLE = False


# Sentinel tokens per the published Harmony spec.
_CHANNEL_RE = re.compile(
    r"<\|channel\|>(?P<channel>analysis|commentary|final)"
    r"(?:\s+to=(?P<recipient>[^\s<|]+))?"
    r"(?:\s*<\|constrain\|>(?P<constrain>[a-zA-Z0-9_-]+))?"
    r"<\|message\|>(?P<body>.*?)"
    r"(?=<\|(?:channel|end|call|return|start)\|>|\Z)",
    re.DOTALL,
)


def is_harmony_output(text: str) -> bool:
    """Quick check: does this output contain Harmony sentinel tokens?
    A vLLM served with `--reasoning-parser openai_gptoss` has already
    stripped these into separate fields, so `content` is clean — only
    raw-mode outputs hit this path."""
    if not text:
        return False
    return "<|channel|>" in text or "<|start|>" in text


def parse_harmony(text: str) -> Dict[str, Any]:
    """Return a structured view of a raw Harmony assistant output.

    Output shape (every field always present):
        {
          "final":      str,                # joined final-channel content
          "analysis":   str,                # joined analysis-channel content
          "commentary": str,                # joined commentary-channel content
          "tool_calls": [                   # tool calls emitted in commentary
            {"id": "...", "type": "function",
             "function": {"name": "...", "arguments": "..."}},
            ...
          ],
        }
    """
    out: Dict[str, Any] = {
        "final": "", "analysis": "", "commentary": "", "tool_calls": [],
    }
    if not text:
        return out

    # ---- Library path ---------------------------------------------------
    # The openai-harmony library parses a token stream; when we only have
    # the rendered text (vLLM returns a string), we still want library
    # behaviour. Fall through to the regex parser if anything trips.
    if _HARMONY_LIB_AVAILABLE:
        try:
            # The library has parse_messages_from_completion_tokens which
            # expects token IDs. For text-only inputs we re-encode then
            # re-parse — round-trip is loss-less for valid Harmony text.
            tokens = _ENC.encode(text, allowed_special="all")
            msgs = _ENC.parse_messages_from_completion_tokens(
                tokens, role=Role.ASSISTANT,
            )
            for m in msgs:
                ch = (m.channel or "").lower()
                # m.content is a list of content parts. Join the textual
                # ones; tool-call parts come back as the `recipient` +
                # arguments structure on the message itself.
                body_parts = []
                for c in (m.content or []):
                    txt = getattr(c, "text", None) or str(c)
                    body_parts.append(txt)
                body = "".join(body_parts)
                if ch == "final":
                    out["final"] += body
                elif ch == "analysis":
                    out["analysis"] += body
                elif ch == "commentary":
                    out["commentary"] += body
                    # The library may surface tool calls as recipient on
                    # the message. Best-effort extract.
                    recipient = getattr(m, "recipient", None)
                    if recipient and recipient.startswith("functions."):
                        out["tool_calls"].append(_call_record(
                            name=recipient.split(".", 1)[1],
                            arguments_str=body,
                        ))
            if out["final"] or out["analysis"] or out["commentary"]:
                return out
        except Exception as e:  # noqa: BLE001
            logger.debug("harmony lib parse fell through to regex: %s", e)

    # ---- Regex fallback -------------------------------------------------
    for m in _CHANNEL_RE.finditer(text):
        channel = m.group("channel")
        body = m.group("body") or ""
        recipient = m.group("recipient")
        if channel == "final":
            out["final"] += body
        elif channel == "analysis":
            out["analysis"] += body
        elif channel == "commentary":
            out["commentary"] += body
            if recipient and recipient.startswith("functions."):
                name = recipient.split(".", 1)[1]
                # Body may be a JSON string (forced via <|constrain|>json)
                # or freeform text. Try JSON, fall back to raw.
                out["tool_calls"].append(_call_record(
                    name=name, arguments_str=body.strip(),
                ))

    # Strip trailing sentinel tokens that may have leaked through.
    for k in ("final", "analysis", "commentary"):
        out[k] = _strip_sentinels(out[k])
    return out


def _call_record(*, name: str, arguments_str: str) -> Dict[str, Any]:
    """Format a tool call to match OpenAI's chat-completions
    `tool_calls[]` shape so downstream code (react_engine) can treat
    Harmony-emitted calls and vLLM-parsed calls identically."""
    # If args look like JSON, normalize to a JSON string; if not, wrap.
    args = arguments_str.strip()
    try:
        parsed = json.loads(args)
        args_out = json.dumps(parsed, ensure_ascii=False)
    except Exception:  # noqa: BLE001
        args_out = json.dumps({"_raw": args}, ensure_ascii=False)
    return {
        "id": f"harmony_{abs(hash((name, args_out))) & 0xFFFFFFFF:08x}",
        "type": "function",
        "function": {"name": name, "arguments": args_out},
    }


_SENTINEL_RE = re.compile(
    r"<\|(?:start|end|return|call|message|channel|constrain)\|>"
)


def _strip_sentinels(s: str) -> str:
    """Remove any stray Harmony tokens that survived parsing."""
    return _SENTINEL_RE.sub("", s).strip()


# ---------------------------------------------------------------------------
# Public helper used by main.py
# ---------------------------------------------------------------------------
def sanitize_chat_message(
    msg: Dict[str, Any],
    *,
    drop_analysis: bool = True,
) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """Sanitize a chat-completions `message` dict for safe downstream
    use. Returns (cleaned_message, debug_info).

    Behaviours, in order:
      1. ALWAYS drop `reasoning_content` (vLLM's openai_gptoss parser
         puts the analysis channel there — never expose to users / logs).
      2. If `content` still contains raw Harmony sentinels (vLLM was NOT
         served with `--reasoning-parser openai_gptoss`), parse them and
         replace `content` with the `final` channel only.
      3. If the parsed Harmony commentary held tool calls but the
         OpenAI-shape `tool_calls` field is empty, populate it.
      4. `debug_info` carries the dropped analysis text (caller decides
         whether to emit it at DEBUG level; never at INFO+).
    """
    cleaned = dict(msg)
    debug: Dict[str, Any] = {}

    if drop_analysis and "reasoning_content" in cleaned:
        debug["reasoning_content"] = cleaned.pop("reasoning_content")

    content = cleaned.get("content") or ""
    tool_calls = cleaned.get("tool_calls") or []

    if is_harmony_output(content):
        parsed = parse_harmony(content)
        cleaned["content"] = parsed["final"]
        if parsed["analysis"]:
            debug.setdefault("analysis", "")
            debug["analysis"] += parsed["analysis"]
        if parsed["commentary"]:
            debug["commentary"] = parsed["commentary"]
        if not tool_calls and parsed["tool_calls"]:
            cleaned["tool_calls"] = parsed["tool_calls"]

    return cleaned, debug
