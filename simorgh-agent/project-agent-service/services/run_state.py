"""
run_state.py — externalised mid-run state for the ReAct loop.

Implements the orchestrator-worker shared-memory pattern from Anthropic's
multi-agent research post: instead of echoing raw tool outputs into the
LLM transcript every turn (which blows the context window and forces
the model to re-read the same tool result on every subsequent turn),
each tool's FULL output is stashed in Redis under a stable reference;
the transcript gets a CONDENSED envelope:

    {"output_preview": "...", "ref": "<chain_id>:<call_id>",
     "full_chars": N}

Later turns (and the final synthesis) can resolve the ref via the
``read_run_state`` local tool when they actually need the raw bytes.

Reference: https://www.anthropic.com/engineering/multi-agent-research-system
(orchestrator-worker; Anthropic reported ~38% input-token reduction with
the related programmatic-tool-calling pattern).

Implementation notes
--------------------
- Keys: ``runstate:<chain_id>:<call_id>`` (Redis db = chat / agent, TTL
  ``RUN_STATE_TTL_SEC`` default 86400 = 24h).
- Stored value is the full UTF-8 string (no JSON wrap — saves a layer
  of escaping and keeps the value cheap to render to the model).
- ``RUN_STATE_THRESHOLD_CHARS`` (default 2500) decides when to externalise
  vs inline. Below threshold, the tool message body remains the raw
  output verbatim — model needs no extra hop for short results.
- The module owns NO global Redis client; it takes the agent's
  ``memory_service`` so test stubs work transparently.
"""
from __future__ import annotations

import json
import logging
import os
from typing import Any, Dict, Optional, Tuple

logger = logging.getLogger(__name__)


THRESHOLD_CHARS = int(os.getenv("RUN_STATE_THRESHOLD_CHARS", "2500"))
TTL_SEC         = int(os.getenv("RUN_STATE_TTL_SEC", "86400"))
PREVIEW_HEAD    = int(os.getenv("RUN_STATE_PREVIEW_HEAD", "800"))
PREVIEW_TAIL    = int(os.getenv("RUN_STATE_PREVIEW_TAIL", "400"))


def _key(chain_id: str, call_id: str) -> str:
    return f"runstate:{chain_id}:{call_id}"


def make_ref(chain_id: str, call_id: str) -> str:
    """Stable string the model can echo back into read_run_state."""
    return f"{chain_id}:{call_id}"


def parse_ref(ref: str) -> Tuple[str, str]:
    """Inverse of make_ref. Returns (chain_id, call_id) or ("", "")."""
    if not isinstance(ref, str) or ":" not in ref:
        return "", ""
    chain_id, _, call_id = ref.partition(":")
    return chain_id, call_id


def _build_preview(output: str) -> str:
    """Head + tail with a marker — preserves the IDs / paths /
    standards a planner usually puts in the first few lines AND the
    final exit-status / footer the result usually closes with."""
    if len(output) <= PREVIEW_HEAD + PREVIEW_TAIL + 50:
        return output
    head = output[:PREVIEW_HEAD].rstrip()
    tail = output[-PREVIEW_TAIL:].lstrip()
    return (f"{head}\n\n[…{len(output) - PREVIEW_HEAD - PREVIEW_TAIL} chars "
            f"externalised — call read_run_state(ref) for the full output…]"
            f"\n\n{tail}")


async def stash_output(
    memory_service: Any,
    *,
    project_id: str,
    chain_id: str,
    call_id: str,
    output: str,
) -> Optional[Dict[str, Any]]:
    """Persist a tool output to Redis under (chain_id, call_id). Returns
    the envelope dict the caller should put in the transcript when the
    output exceeded the inlining threshold; returns None when the
    output is short enough to inline verbatim (caller keeps using the
    raw output).
    """
    if not isinstance(output, str) or len(output) <= THRESHOLD_CHARS:
        return None
    if memory_service is None:
        return None
    key = _key(chain_id, call_id)
    try:
        await memory_service.store_working_memory(
            project_id, key, output, ttl=TTL_SEC)
    except TypeError:
        # Older memory service signature without ttl kwarg — best-effort
        # fallback. TTL is enforced loosely by Redis maxmemory policy.
        try:
            await memory_service.store_working_memory(
                project_id, key, output)
        except Exception as e:
            logger.warning("run_state stash failed: %s", e)
            return None
    except Exception as e:
        logger.warning("run_state stash failed: %s", e)
        return None
    return {
        "output_preview": _build_preview(output),
        "ref":            make_ref(chain_id, call_id),
        "full_chars":     len(output),
        "note": ("Full output externalised. Call read_run_state(ref) "
                 "ONLY if you need the bulk — preview above usually "
                 "contains the IDs / paths / standards you need."),
    }


async def fetch_output(
    memory_service: Any,
    *,
    project_id: str,
    chain_id: str,
    call_id: str,
) -> Optional[str]:
    """Retrieve a previously-stashed output. Returns None when missing
    or on error (caller should fall back to the preview in the
    transcript). The key is implicitly scoped by project_id since
    memory_service partitions by it."""
    if memory_service is None:
        return None
    key = _key(chain_id, call_id)
    try:
        val = await memory_service.get_working_memory(project_id, key)
    except Exception as e:
        logger.warning("run_state fetch failed: %s", e)
        return None
    if val is None:
        return None
    if isinstance(val, (bytes, bytearray)):
        try:
            return val.decode("utf-8", errors="replace")
        except Exception:
            return None
    return str(val)


def envelope_to_transcript_str(envelope: Dict[str, Any]) -> str:
    """Render the externalised envelope for the tool-message body.
    Compact JSON so the model can pattern-match the shape; the
    output_preview is plain text inside it so the model still sees
    the readable head+tail."""
    return json.dumps(envelope, ensure_ascii=False, default=str)
