"""
Tier & Quota Service
====================
Standalone REST microservice for user tiers, quotas, rate limiting.

Mounts the quota router at /api/quota/*.
"""
import logging
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from routes.quota import router as quota_router

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("tier-quota-service")

app = FastAPI(title="Simorgh Tier/Quota Service", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ALLOW_ORIGINS", "*").split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# router carries its own prefix /api/v2/quota
app.include_router(quota_router)


@app.on_event("startup")
async def _bootstrap_services() -> None:
    """Wire the tier_service singleton. Without this,
    `get_tier_service()` returns None and the GET /me route
    falls through to `return QuotaStatusResponse()` — the
    pydantic defaults — which means questions_used_today=0
    and questions_limit=20 regardless of what the
    user_daily_usage table actually contains.

    May 2026 operator report: "quota immediately resets".
    chat-service was correctly INCREMENTING the daily-usage row
    (logs showed `quota incremented … new daily count=2`) but
    the frontend kept seeing 0/20 because tier-quota-service —
    a separate process serving the GET — never wired the
    singleton and returned defaults.
    """
    from database.postgres_connection import PostgresConnection
    from services.user_tier_service import init_tier_service

    db = PostgresConnection()
    try:
        await db.init_async_pool()
    except Exception as e:
        logger.error("tier-quota-service: postgres pool init failed: %s", e)
        return

    try:
        init_tier_service(db)
        logger.info("tier-quota-service: tier_service initialised")
    except Exception as e:
        logger.error("tier-quota-service: init_tier_service failed: %s", e)


@app.get("/health")
def health():
    return {"status": "healthy", "service": "tier-quota-service"}
