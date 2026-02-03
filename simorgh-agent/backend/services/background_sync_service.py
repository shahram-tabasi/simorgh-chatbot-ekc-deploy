"""
Background Sync Service
=======================
Real-time synchronization service for TPMS data.

Features:
- Periodic background sync for active projects
- Webhook endpoint support for TPMS notifications
- Delta sync (only changed data)
- Project-level sync tracking

Author: Simorgh Industrial Assistant
"""

import asyncio
import logging
from typing import Optional, Dict, Any, List, Set
from datetime import datetime, timedelta
import os

from services.project_sync_service import ProjectSyncService, get_project_sync_service
from services.redis_service import RedisService, get_redis_service

logger = logging.getLogger(__name__)


class BackgroundSyncService:
    """
    Manages background synchronization of TPMS data.

    Flow:
    1. Track active projects (recently accessed)
    2. Periodically check for updates
    3. Sync changed data to PostgreSQL and Neo4j
    4. Invalidate caches after sync
    """

    def __init__(
        self,
        sync_service: ProjectSyncService = None,
        redis_service: RedisService = None,
        sync_interval_seconds: int = 300,  # 5 minutes default
        max_concurrent_syncs: int = 3,
    ):
        """
        Initialize background sync service.

        Args:
            sync_service: ProjectSyncService for data sync
            redis_service: RedisService for tracking and caching
            sync_interval_seconds: Interval between sync checks
            max_concurrent_syncs: Max concurrent sync operations
        """
        self.sync_service = sync_service
        self.redis = redis_service
        self.sync_interval = sync_interval_seconds
        self.max_concurrent = max_concurrent_syncs

        # Tracking
        self._active_projects: Set[str] = set()
        self._last_sync: Dict[str, datetime] = {}
        self._running = False
        self._task: Optional[asyncio.Task] = None

        # Neo4j service reference (set later)
        self._neo4j = None

        logger.info(
            f"BackgroundSyncService initialized "
            f"(interval: {sync_interval_seconds}s, max_concurrent: {max_concurrent_syncs})"
        )

    def set_neo4j_service(self, neo4j_service):
        """Set Neo4j service for sync operations."""
        self._neo4j = neo4j_service
        if self.sync_service:
            self.sync_service.set_neo4j_service(neo4j_service)

    def set_redis_service(self, redis_service: RedisService):
        """Set Redis service."""
        self.redis = redis_service
        if self.sync_service:
            self.sync_service.set_redis_service(redis_service)

    # ==========================================================================
    # PROJECT TRACKING
    # ==========================================================================

    def mark_project_active(self, oenum: str):
        """
        Mark a project as active (recently accessed).

        Active projects are candidates for background sync.

        Args:
            oenum: Project OENUM
        """
        self._active_projects.add(oenum)

        # Store in Redis for persistence across restarts
        if self.redis:
            try:
                # Track active projects with 24-hour TTL
                self.redis.set(
                    f"sync:active_project:{oenum}",
                    {"marked_at": datetime.utcnow().isoformat()},
                    ttl=86400,  # 24 hours
                    db="project"
                )
            except Exception as e:
                logger.warning(f"Failed to persist active project: {e}")

        logger.debug(f"Project marked active: {oenum}")

    def mark_project_inactive(self, oenum: str):
        """Remove project from active list."""
        self._active_projects.discard(oenum)

        if self.redis:
            try:
                self.redis.delete(f"sync:active_project:{oenum}", db="project")
            except Exception:
                pass

    def get_active_projects(self) -> List[str]:
        """Get list of active projects."""
        # Load from Redis for persistence
        if self.redis:
            try:
                pattern = "sync:active_project:*"
                for key in self.redis.project_client.scan_iter(match=pattern):
                    oenum = key.split(":")[-1]
                    self._active_projects.add(oenum)
            except Exception as e:
                logger.warning(f"Failed to load active projects from Redis: {e}")

        return list(self._active_projects)

    def get_last_sync_time(self, oenum: str) -> Optional[datetime]:
        """Get last sync time for a project."""
        # Check memory cache
        if oenum in self._last_sync:
            return self._last_sync[oenum]

        # Check Redis
        if self.redis:
            try:
                data = self.redis.get(f"sync:last_sync:{oenum}", db="project")
                if data and "synced_at" in data:
                    return datetime.fromisoformat(data["synced_at"])
            except Exception:
                pass

        return None

    def _update_last_sync(self, oenum: str, sync_time: datetime = None):
        """Update last sync time for a project."""
        sync_time = sync_time or datetime.utcnow()
        self._last_sync[oenum] = sync_time

        if self.redis:
            try:
                self.redis.set(
                    f"sync:last_sync:{oenum}",
                    {"synced_at": sync_time.isoformat()},
                    ttl=86400 * 7,  # 7 days
                    db="project"
                )
            except Exception as e:
                logger.warning(f"Failed to persist sync time: {e}")

    # ==========================================================================
    # BACKGROUND TASK
    # ==========================================================================

    async def start(self):
        """Start background sync task."""
        if self._running:
            logger.warning("Background sync already running")
            return

        self._running = True
        self._task = asyncio.create_task(self._run_sync_loop())
        logger.info("🔄 Background sync service started")

    async def stop(self):
        """Stop background sync task."""
        self._running = False

        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

        logger.info("⏹️ Background sync service stopped")

    async def _run_sync_loop(self):
        """Main sync loop."""
        while self._running:
            try:
                await self._sync_active_projects()
            except Exception as e:
                logger.error(f"Sync loop error: {e}", exc_info=True)

            # Wait for next interval
            await asyncio.sleep(self.sync_interval)

    async def _sync_active_projects(self):
        """Sync all active projects that need updates."""
        active = self.get_active_projects()

        if not active:
            logger.debug("No active projects to sync")
            return

        # Filter to projects needing sync
        projects_to_sync = []
        for oenum in active:
            last_sync = self.get_last_sync_time(oenum)
            if not last_sync or (datetime.utcnow() - last_sync) > timedelta(seconds=self.sync_interval):
                projects_to_sync.append(oenum)

        if not projects_to_sync:
            logger.debug("All active projects are up to date")
            return

        logger.info(f"🔄 Background sync: {len(projects_to_sync)} projects to sync")

        # Sync with concurrency limit
        semaphore = asyncio.Semaphore(self.max_concurrent)

        async def sync_with_semaphore(oenum: str):
            async with semaphore:
                await self._sync_single_project(oenum)

        tasks = [sync_with_semaphore(oenum) for oenum in projects_to_sync]
        await asyncio.gather(*tasks, return_exceptions=True)

    async def _sync_single_project(self, oenum: str):
        """Sync a single project."""
        try:
            logger.debug(f"Background sync starting: {oenum}")

            # Ensure sync service has Neo4j
            if self._neo4j and self.sync_service:
                self.sync_service.set_neo4j_service(self._neo4j)

            # Get or create sync service
            sync_service = self.sync_service or get_project_sync_service()

            # Run sync
            result = await sync_service.sync_project(oenum)

            if result["status"] == "success":
                self._update_last_sync(oenum)
                logger.info(f"✅ Background sync completed: {oenum}")
            else:
                logger.warning(f"⚠️ Background sync issues: {oenum} - {result.get('errors', [])}")

        except Exception as e:
            logger.error(f"Background sync failed: {oenum} - {e}")

    # ==========================================================================
    # WEBHOOK SUPPORT
    # ==========================================================================

    async def handle_tpms_webhook(
        self,
        event_type: str,
        oenum: str,
        data: Dict[str, Any] = None
    ) -> Dict[str, Any]:
        """
        Handle TPMS webhook notification.

        This is called when TPMS sends a change notification.

        Args:
            event_type: Type of event (project_updated, panel_added, etc.)
            oenum: Project OENUM
            data: Event data

        Returns:
            Response dict
        """
        logger.info(f"📥 TPMS webhook received: {event_type} for {oenum}")

        result = {
            "received_at": datetime.utcnow().isoformat(),
            "event_type": event_type,
            "oenum": oenum,
            "action": "pending"
        }

        try:
            # Mark project as active and trigger immediate sync
            self.mark_project_active(oenum)

            # Queue immediate sync based on event type
            if event_type in ["project_updated", "panel_added", "panel_updated",
                             "feeder_added", "feeder_updated", "equipment_updated"]:
                # Trigger immediate sync
                asyncio.create_task(self._sync_single_project(oenum))
                result["action"] = "sync_triggered"
                logger.info(f"🔄 Immediate sync triggered for {oenum}")

            elif event_type == "project_deleted":
                # Handle project deletion
                self.mark_project_inactive(oenum)
                result["action"] = "project_deactivated"

            else:
                result["action"] = "event_logged"
                logger.debug(f"Unhandled event type: {event_type}")

        except Exception as e:
            logger.error(f"Webhook handling failed: {e}")
            result["error"] = str(e)
            result["action"] = "failed"

        return result

    # ==========================================================================
    # MANUAL SYNC TRIGGER
    # ==========================================================================

    async def trigger_sync(self, oenum: str) -> Dict[str, Any]:
        """
        Manually trigger sync for a project.

        Used when user explicitly requests data refresh.

        Args:
            oenum: Project OENUM

        Returns:
            Sync result
        """
        logger.info(f"Manual sync triggered: {oenum}")

        self.mark_project_active(oenum)

        # Ensure sync service has Neo4j
        if self._neo4j and self.sync_service:
            self.sync_service.set_neo4j_service(self._neo4j)

        sync_service = self.sync_service or get_project_sync_service()
        result = await sync_service.sync_project(oenum)

        if result["status"] == "success":
            self._update_last_sync(oenum)

        return result

    # ==========================================================================
    # STATUS
    # ==========================================================================

    def get_status(self) -> Dict[str, Any]:
        """Get sync service status."""
        return {
            "running": self._running,
            "sync_interval_seconds": self.sync_interval,
            "max_concurrent_syncs": self.max_concurrent,
            "active_projects": len(self._active_projects),
            "projects": list(self._active_projects),
            "last_syncs": {
                k: v.isoformat() for k, v in self._last_sync.items()
            }
        }


# =============================================================================
# SINGLETON INSTANCE
# =============================================================================

_background_sync: Optional[BackgroundSyncService] = None


def get_background_sync_service(
    sync_interval: int = None,
    neo4j_service=None,
    redis_service=None
) -> BackgroundSyncService:
    """
    Get or create BackgroundSyncService singleton.

    Args:
        sync_interval: Override default sync interval (from env or 300s)
        neo4j_service: Neo4j service for sync
        redis_service: Redis service for tracking
    """
    global _background_sync

    if _background_sync is None:
        interval = sync_interval or int(os.getenv("TPMS_SYNC_INTERVAL", "300"))
        max_concurrent = int(os.getenv("TPMS_SYNC_MAX_CONCURRENT", "3"))

        _background_sync = BackgroundSyncService(
            sync_interval_seconds=interval,
            max_concurrent_syncs=max_concurrent,
        )

    # Update services if provided
    if neo4j_service:
        _background_sync.set_neo4j_service(neo4j_service)
    if redis_service:
        _background_sync.set_redis_service(redis_service)

    return _background_sync


async def start_background_sync(
    neo4j_service=None,
    redis_service=None
):
    """Start background sync service."""
    service = get_background_sync_service(
        neo4j_service=neo4j_service,
        redis_service=redis_service
    )
    await service.start()


async def stop_background_sync():
    """Stop background sync service."""
    global _background_sync
    if _background_sync:
        await _background_sync.stop()
