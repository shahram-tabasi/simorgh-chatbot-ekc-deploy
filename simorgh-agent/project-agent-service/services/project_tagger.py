"""
project_tagger.py — Docker-image-tag-style project name generator.

When the chatbot submits a confirmed spec to simorgh-soft, the
projectName field of the created Design Suite project is set to a
deterministic, sortable, traceable tag combining:

  <chatbot-project-slug> : <user-slug> - <YYYYMMDD-HHMM>

The format mirrors how Docker tags identify image builds — the chatbot
project plays the role of the "image", the user + timestamp play the
role of the "tag". Re-running the create flow for the same chatbot
project yields a new tag (date differs) so multiple Design Suite
projects from the same chatbot project never collide.

Example:
  chatbot_project = "Mobarakeh Steel HSM-2"
  user            = "simorgh.ekc.ai@gmail.com"
  datetime        = 2026-06-03T17:15Z
  →  projectName  = "mobarakeh-steel-hsm-2:simorgh-ekc-ai-20260603-1715"

Originally-extracted name (e.g. the LLM-derived "Mobarakeh Steel
Company Hot Strip Mill #2 6.6kV Switchgear") is preserved verbatim in
projectDescription so the simorgh-soft UI still surfaces the human-
readable name; the tagged projectName is for cataloguing.

Disable via env (SOFT_PROJECT_TAGGING=0) to fall back to the old
behaviour (projectName = the LLM-extracted name verbatim).
"""
from __future__ import annotations

import logging
import os
import re
from datetime import datetime, timezone
from typing import Optional

logger = logging.getLogger(__name__)

TAGGING_ENABLED = os.getenv("SOFT_PROJECT_TAGGING", "1").lower() in (
    "1", "true", "yes", "on",
)


def _slug(s: str, *, max_len: int = 32) -> str:
    """Docker-tag-safe slug.

    Docker tags accept ``[A-Za-z0-9_.-]{1,128}``. We lowercase, replace
    runs of non-tag characters with a single ``-``, and trim leading/
    trailing separators. Capped at ``max_len`` so the final tag stays
    readable. Empty input → ``unknown``.
    """
    if s is None:
        return "unknown"
    # Lower-case, strip Persian/Arabic diacritics, normalise whitespace.
    out = str(s).strip().casefold()
    # Drop URL-style local-parts: "user@example.com" → "user"
    out = out.split("@", 1)[0]
    # Replace any run of non-[a-z0-9._-] with a single hyphen.
    out = re.sub(r"[^a-z0-9._-]+", "-", out)
    # Collapse consecutive hyphens / dots, trim ends.
    out = re.sub(r"-+", "-", out).strip("-._")
    if not out:
        return "unknown"
    if len(out) > max_len:
        out = out[:max_len].rstrip("-._")
    return out or "unknown"


def format_tag(
    *,
    chatbot_project: Optional[str],
    user: Optional[str],
    dt: Optional[datetime] = None,
) -> str:
    """Build the docker-style tag from its components. UTC throughout
    so tags from different timezones sort consistently."""
    when = (dt or datetime.now(timezone.utc)).astimezone(timezone.utc)
    proj  = _slug(chatbot_project or "", max_len=40)
    usr   = _slug(user or "", max_len=24)
    stamp = when.strftime("%Y%m%d-%H%M")
    return f"{proj}:{usr}-{stamp}"


def apply_tag_to_spec(
    spec_dict: dict,
    *,
    chatbot_project: Optional[str],
    user: Optional[str],
    dt: Optional[datetime] = None,
) -> dict:
    """Return a MUTATED copy of `spec_dict` where:

      - `projectName` is LEFT AS-IS (the human-readable name the user
        typed or the LLM extracted). Users were confused when their
        typed name ("test-shahram") disappeared and a docker tag
        showed instead — and the old name got concatenated into
        projectDescription as "[name]desc" with no separator.
      - The docker-style catalog tag goes into `projectId` (PID),
        which is otherwise empty, so traceability
        (<chatbot-project>:<user>-<YYYYMMDD-HHMM>) is preserved
        WITHOUT clobbering the human name or polluting the
        description.
      - `projectDescription` is NOT modified.

    Idempotent: re-tagging refreshes the projectId timestamp; never
    touches a projectName the user owns.
    """
    if not TAGGING_ENABLED:
        return spec_dict
    if not isinstance(spec_dict, dict):
        return spec_dict
    out = dict(spec_dict)

    tag = format_tag(chatbot_project=chatbot_project, user=user, dt=dt)

    # Only fill projectId if it's empty or already a generated tag
    # (so we don't overwrite a real PID the user/extractor supplied).
    existing_pid = (out.get("projectId") or "").strip()
    pid_is_tag = bool(
        re.fullmatch(r"[a-z0-9._-]+:[a-z0-9._-]+-\d{8}-\d{4}", existing_pid)
    )
    if not existing_pid or pid_is_tag:
        out["projectId"] = tag

    logger.info(
        "project_tagger: catalog tag='%s' -> projectId "
        "(projectName left as '%s', user='%s', chatbot_project='%s')",
        tag, out.get("projectName"), user, chatbot_project,
    )
    return out
