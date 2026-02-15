"""
Internet Connectivity Check Utility

Provides a cached connectivity check that tools can use to detect
when internet is unavailable (e.g., local LLM running offline).
When offline, tools should gracefully fall back and warn the user.
"""

import logging
import socket
import time
from typing import Optional

logger = logging.getLogger(__name__)

# Cache connectivity result to avoid checking on every tool call
_last_check_time: float = 0.0
_last_check_result: bool = True
_CACHE_TTL_SECONDS: float = 30.0  # Re-check every 30 seconds


def check_internet_available(timeout: float = 3.0) -> bool:
    """
    Check if internet is available by attempting DNS resolution + TCP connect.

    Uses a cached result to avoid excessive network calls.
    Returns True if internet is reachable, False otherwise.

    Args:
        timeout: Socket timeout in seconds
    """
    global _last_check_time, _last_check_result

    now = time.time()
    if now - _last_check_time < _CACHE_TTL_SECONDS:
        return _last_check_result

    # Try multiple reliable hosts
    test_hosts = [
        ("dns.google", 443),
        ("8.8.8.8", 53),
        ("1.1.1.1", 53),
    ]

    for host, port in test_hosts:
        try:
            sock = socket.create_connection((host, port), timeout=timeout)
            sock.close()
            _last_check_time = now
            _last_check_result = True
            return True
        except (socket.timeout, OSError):
            continue

    logger.warning("⚠️ Internet connectivity check failed - all hosts unreachable")
    _last_check_time = now
    _last_check_result = False
    return False


def get_offline_warning() -> str:
    """
    Return a standard warning message when internet is unavailable.
    This message is prepended to tool results so the LLM and user
    are aware that the response is based on training data only.
    """
    return (
        "[OFFLINE] Internet is not available. Unable to fetch live data. "
        "The response below is based on the AI model's training knowledge "
        "only and may not reflect the most current information."
    )


def reset_cache():
    """Reset the connectivity cache (useful for testing)."""
    global _last_check_time, _last_check_result
    _last_check_time = 0.0
    _last_check_result = True
