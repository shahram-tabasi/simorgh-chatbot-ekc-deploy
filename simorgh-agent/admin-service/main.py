"""
Admin Service — Simorgh control panel
=====================================
Mounts:
  /api/v2/admin/*        REST surface (users, tiers, settings, features, audit, system)
  /api/v2/admin/ui/      Single-page admin UI (vanilla JS + Tailwind CDN)
  /api/v2/admin/internal/settings/scope/{scope}   service-to-service settings pull
"""
import logging
import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from routes.admin import router as admin_router
from routes.settings import router as settings_router
from routes.features import router as features_router
from routes.audit import router as audit_router
from routes.users_extended import router as users_extended_router
from routes.system_control import router as system_router
from database.postgres_connection import PostgresConnection
from services.user_tier_service import init_tier_service

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("admin-service")

app = FastAPI(title="Simorgh Admin Service", version="2.0.0")


@app.on_event("startup")
async def _bootstrap_services() -> None:
    """Open the Postgres pool and wire the singleton services that the
    routes look up via get_*_service(). Without this every admin route
    returns 503 "Tier service not initialized"."""
    db = PostgresConnection()
    await db.init_async_pool()
    init_tier_service(db)
    # Payment service is optional — only wire if importable + the helper
    # exists. Some deployments ship without it.
    try:
        from services.payment_service import init_payment_service  # type: ignore
        init_payment_service(db)
    except Exception as e:  # pragma: no cover
        logger.info("payment service not wired: %s", e)
    logger.info("admin-service bootstrap complete")

app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ALLOW_ORIGINS", "*").split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# All routers carry their own /api/v2/admin prefix.
app.include_router(admin_router)
app.include_router(settings_router)
app.include_router(features_router)
app.include_router(audit_router)
app.include_router(users_extended_router)
app.include_router(system_router)


# ---------------------------------------------------------------------------
# Static SPA at /api/v2/admin/ui/
# ---------------------------------------------------------------------------
_STATIC_DIR = Path(__file__).parent / "static" / "admin"
if _STATIC_DIR.is_dir():
    app.mount(
        "/api/v2/admin/ui",
        StaticFiles(directory=str(_STATIC_DIR), html=True),
        name="admin-ui",
    )
else:
    logger.warning("Admin static UI not found at %s — UI tab will 404.", _STATIC_DIR)


@app.get("/health")
def health():
    return {"status": "healthy", "service": "admin-service"}
