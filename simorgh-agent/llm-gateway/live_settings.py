"""
Live-settings client. Pulls the resolved (global + service-scoped) snapshot
from admin-service every REFRESH_SEC seconds and caches it in-process.

Other simorgh services can copy this file as-is; the only per-service
config is `SCOPE` (set via env LIVE_SETTINGS_SCOPE) so the same module
serves any caller.

Falls back to os.environ when admin-service is unreachable, so the gateway
boots cleanly even if the control panel is down.
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Dict, Optional

import httpx

logger = logging.getLogger("live-settings")

ADMIN_URL  = os.getenv("ADMIN_SERVICE_URL", "http://admin-service:8039").rstrip("/")
SCOPE      = os.getenv("LIVE_SETTINGS_SCOPE", "")  # e.g. "llm-gateway"
TOKEN      = os.getenv("SETTINGS_INTERNAL_TOKEN", "").strip()
REFRESH_SEC = float(os.getenv("LIVE_SETTINGS_REFRESH_SEC", "30"))
TIMEOUT_SEC = float(os.getenv("LIVE_SETTINGS_TIMEOUT_SEC", "5"))

_cache: Dict[str, str] = {}
_last_refresh: float = 0.0
_lock = asyncio.Lock()


async def _fetch() -> Dict[str, str]:
    headers = {"X-Internal-Token": TOKEN} if TOKEN else {}
    url = f"{ADMIN_URL}/api/v2/admin/internal/settings/scope/{SCOPE or 'global'}"
    async with httpx.AsyncClient(timeout=TIMEOUT_SEC) as c:
        r = await c.get(url, headers=headers)
    r.raise_for_status()
    return r.json()


async def refresh(force: bool = False) -> None:
    """Pull a fresh snapshot if the cache is older than REFRESH_SEC."""
    global _cache, _last_refresh
    now = time.monotonic()
    if not force and now - _last_refresh < REFRESH_SEC:
        return
    async with _lock:
        if not force and now - _last_refresh < REFRESH_SEC:
            return
        try:
            new_cache = await _fetch()
            _cache = new_cache
            _last_refresh = now
            logger.debug("live-settings refreshed (%d keys, scope=%r)",
                         len(_cache), SCOPE)
        except Exception as exc:
            logger.warning("live-settings refresh failed (using stale or env): %s", exc)
            _last_refresh = now  # don't hammer admin-service if it's down


async def get(key: str, default: Optional[str] = None) -> Optional[str]:
    """Get a setting; refreshes the cache lazily on first call per window."""
    await refresh()
    val = _cache.get(key)
    if val is not None and val != "":
        return val
    return os.getenv(key, default)


def get_sync(key: str, default: Optional[str] = None) -> Optional[str]:
    """Cache-only read (no network). Use after at least one `await refresh()`."""
    val = _cache.get(key)
    if val is not None and val != "":
        return val
    return os.getenv(key, default)


async def start_refresher() -> None:
    """Background task — refresh on a fixed cadence."""
    await refresh(force=True)
    while True:
        await asyncio.sleep(REFRESH_SEC)
        try:
            await refresh(force=True)
        except Exception as exc:
            logger.warning("live-settings background refresh failed: %s", exc)
