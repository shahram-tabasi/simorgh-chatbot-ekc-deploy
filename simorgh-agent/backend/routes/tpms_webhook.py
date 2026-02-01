"""
TPMS Webhook Routes
===================
Endpoints for TPMS real-time sync notifications.

Author: Simorgh Industrial Assistant
"""

import os
import hmac
import hashlib
import logging
from typing import Dict, Any, Optional
from datetime import datetime

from fastapi import APIRouter, HTTPException, Header, Request, Query
from pydantic import BaseModel, Field

from services.background_sync_service import get_background_sync_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v2/tpms", tags=["TPMS Webhook"])

# Webhook secret for HMAC validation (optional)
WEBHOOK_SECRET = os.getenv("TPMS_WEBHOOK_SECRET", "")


# =============================================================================
# MODELS
# =============================================================================

class TPMSWebhookPayload(BaseModel):
    """TPMS webhook payload"""
    event_type: str = Field(..., description="Type of event (project_updated, panel_added, etc.)")
    oenum: str = Field(..., description="Project OENUM")
    timestamp: Optional[str] = Field(None, description="Event timestamp")
    data: Optional[Dict[str, Any]] = Field(default_factory=dict, description="Event data")


class SyncTriggerRequest(BaseModel):
    """Manual sync trigger request"""
    oenum: str = Field(..., description="Project OENUM to sync")


# =============================================================================
# WEBHOOK ENDPOINTS
# =============================================================================

@router.post("/webhook")
async def tpms_webhook(
    payload: TPMSWebhookPayload,
    request: Request,
    x_webhook_signature: Optional[str] = Header(None, alias="X-Webhook-Signature"),
):
    """
    Receive TPMS change notifications.

    This endpoint is called by TPMS when project data changes.
    Triggers background sync for the affected project.

    Supported event types:
    - project_updated: Project main info changed
    - project_identity_updated: Project identity/specs changed
    - panel_added: New panel added
    - panel_updated: Panel info changed
    - panel_deleted: Panel removed
    - feeder_added: New feeder added
    - feeder_updated: Feeder info changed
    - equipment_updated: Equipment info changed
    """
    # Validate webhook signature if secret is configured
    if WEBHOOK_SECRET:
        if not x_webhook_signature:
            logger.warning("Webhook received without signature")
            raise HTTPException(status_code=401, detail="Missing webhook signature")

        # Verify HMAC signature
        body = await request.body()
        expected_signature = hmac.new(
            WEBHOOK_SECRET.encode(),
            body,
            hashlib.sha256
        ).hexdigest()

        if not hmac.compare_digest(x_webhook_signature, expected_signature):
            logger.warning(f"Invalid webhook signature for {payload.oenum}")
            raise HTTPException(status_code=401, detail="Invalid webhook signature")

    logger.info(f"📥 TPMS webhook: {payload.event_type} for {payload.oenum}")

    try:
        sync_service = get_background_sync_service()
        result = await sync_service.handle_tpms_webhook(
            event_type=payload.event_type,
            oenum=payload.oenum,
            data=payload.data
        )

        return {
            "status": "accepted",
            "result": result
        }

    except Exception as e:
        logger.error(f"Webhook processing failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/sync")
async def trigger_sync(request: SyncTriggerRequest):
    """
    Manually trigger sync for a project.

    Use this to force a data refresh from TPMS.
    """
    logger.info(f"Manual sync triggered: {request.oenum}")

    try:
        sync_service = get_background_sync_service()
        result = await sync_service.trigger_sync(request.oenum)

        return {
            "status": "completed" if result["status"] == "success" else "failed",
            "result": result
        }

    except Exception as e:
        logger.error(f"Manual sync failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/sync/status")
async def get_sync_status():
    """
    Get background sync service status.

    Returns info about running sync operations and active projects.
    """
    try:
        sync_service = get_background_sync_service()
        return sync_service.get_status()
    except Exception as e:
        logger.error(f"Failed to get sync status: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/sync/project/{oenum}")
async def get_project_sync_status(oenum: str):
    """
    Get sync status for a specific project.
    """
    try:
        sync_service = get_background_sync_service()

        last_sync = sync_service.get_last_sync_time(oenum)
        is_active = oenum in sync_service._active_projects

        return {
            "oenum": oenum,
            "is_active": is_active,
            "last_sync": last_sync.isoformat() if last_sync else None,
            "will_sync_next_interval": is_active and (
                last_sync is None or
                (datetime.utcnow() - last_sync).total_seconds() > sync_service.sync_interval
            )
        }

    except Exception as e:
        logger.error(f"Failed to get project sync status: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/project/{oenum}/activate")
async def activate_project_sync(oenum: str):
    """
    Mark a project as active for background sync.

    Active projects are automatically synced periodically.
    """
    try:
        sync_service = get_background_sync_service()
        sync_service.mark_project_active(oenum)

        return {
            "status": "activated",
            "oenum": oenum,
            "message": f"Project {oenum} will be synced every {sync_service.sync_interval}s"
        }

    except Exception as e:
        logger.error(f"Failed to activate project: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/project/{oenum}/deactivate")
async def deactivate_project_sync(oenum: str):
    """
    Remove project from active sync list.

    Project will no longer be automatically synced.
    """
    try:
        sync_service = get_background_sync_service()
        sync_service.mark_project_inactive(oenum)

        return {
            "status": "deactivated",
            "oenum": oenum,
            "message": f"Project {oenum} removed from background sync"
        }

    except Exception as e:
        logger.error(f"Failed to deactivate project: {e}")
        raise HTTPException(status_code=500, detail=str(e))
