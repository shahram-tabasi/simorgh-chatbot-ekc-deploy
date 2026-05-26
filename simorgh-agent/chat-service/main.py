"""
Chat Service
============
Standalone microservice that owns the modern chat surface and the project
workspace surface. Both routers ship their own correct prefixes — we
include both without any extra prefix.

Routers
-------
chatbot_v2 (`/api/v2/chat`)
    - create chat, send message, upload doc into chat, stage updates,
      get/history/delete, tools/available, stats
project_session (`/api/v2/project`)
    - select project, sync, missing-data, data summaries, list, tpms/tables

Backed by Redis (sessions, history), PostgreSQL (unified message
persistence), Qdrant (RAG retrieval), and the LLM service for
completions (will be replaced by HTTP to llm-gateway in phase C).
"""
import logging
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from routes.chatbot_v2 import router as chatbot_v2_router
from routes.project_session import router as project_session_router
from routes.project_chat_session import router as project_chat_session_router
from routes.general_chat_hr import router as general_chat_hr_router

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("chat-service")

app = FastAPI(title="Simorgh Chat Service", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ALLOW_ORIGINS", "*").split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Both routers carry their own prefixes (/api/v2/chat, /api/v2/project).
# Don't add a second one.
app.include_router(chatbot_v2_router)
app.include_router(project_session_router)
app.include_router(project_chat_session_router)
# Direct-RAG path for general-chat against the curated HR/Strategy KB.
# Bypasses chatbot_core / planner / MCP entirely for sub-second
# streaming via gpt-oss-20b on 192.168.1.61.
app.include_router(general_chat_hr_router)


@app.on_event("startup")
async def _bootstrap_services() -> None:
    """Open the Postgres pool and wire singleton services that
    routes look up via get_*_service(). Mirrors admin-service's
    bootstrap pattern.

    Why this exists, May 2026 — operator's "quota still not work"
    bug-day: the daily-quota counter for general-chat AND
    project-chat lives behind `services.user_tier_service.UserTierService`,
    a module-level singleton initialised by `init_tier_service(db)`.
    chat-service never called that initialiser, so
    `get_tier_service()` returned None and EVERY call to
    `increment_usage` was a silent no-op. The `if tier_service:`
    guard masked the failure as "successful skip" with no log
    line. Net effect: questions_used stayed at 0 in the daily-usage
    table indefinitely, the QuotaIndicator's optimistic decrement
    got reverted by every fetchQuota, the ring "immediately reset".

    Wiring the service at startup is what flips it from no-op to
    real INSERT/UPDATE against `user_daily_usage`.
    """
    from database import PostgresConnection
    from services.user_tier_service import init_tier_service

    db = PostgresConnection()
    try:
        await db.init_async_pool()
    except Exception as e:
        logger.error("chat-service: postgres pool init failed: %s", e)
        return

    try:
        init_tier_service(db)
        logger.info("chat-service: tier_service initialised")
    except Exception as e:
        logger.error("chat-service: init_tier_service failed: %s", e)


@app.get("/health")
def health():
    return {"status": "healthy", "service": "chat-service"}
