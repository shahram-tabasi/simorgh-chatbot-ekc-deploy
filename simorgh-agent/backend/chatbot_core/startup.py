"""
Startup Configuration
=====================
Integrates chatbot_core with FastAPI application startup.

Add this to your main.py startup events.

Example:
    from chatbot_core.startup import initialize_chatbot_on_startup, shutdown_chatbot

    @app.on_event("startup")
    async def startup():
        await initialize_chatbot_on_startup(
            redis_service=redis_service,
            qdrant_service=qdrant_service,
            neo4j_service=neo4j_service,
            llm_service=llm_service,
        )

    @app.on_event("shutdown")
    async def shutdown():
        await shutdown_chatbot()

Author: Simorgh Industrial Assistant
"""

import logging
from typing import Optional

from .integration import (
    get_chatbot_core,
    initialize_chatbot_core,
    ChatbotCore,
)
from .monitoring import get_monitor
from .registry import get_extension_registry, HookPoint

logger = logging.getLogger(__name__)


async def initialize_chatbot_on_startup(
    redis_service=None,
    qdrant_service=None,
    neo4j_service=None,
    llm_service=None,
    doc_processor_client=None,
    register_health_checks: bool = True,
) -> ChatbotCore:
    """
    Initialize chatbot core during FastAPI startup.

    This function should be called in your FastAPI startup event handler.

    Args:
        redis_service: Existing Redis service from main.py
        qdrant_service: Existing Qdrant service from main.py
        neo4j_service: Existing Neo4j service from main.py
        llm_service: Existing LLM service from main.py
        doc_processor_client: Existing doc processor client
        register_health_checks: Whether to register health checks

    Returns:
        Initialized ChatbotCore instance

    Example:
        @app.on_event("startup")
        async def startup():
            # Your existing initialization...
            redis_service = RedisService()
            llm_service = LLMService()

            # Initialize chatbot core
            await initialize_chatbot_on_startup(
                redis_service=redis_service,
                qdrant_service=qdrant_service,
                neo4j_service=neo4j_service,
                llm_service=llm_service,
            )
    """
    monitor = get_monitor()
    monitor.info("startup", "Initializing chatbot core...")

    try:
        # Initialize core
        core = await initialize_chatbot_core(
            redis_service=redis_service,
            qdrant_service=qdrant_service,
            neo4j_service=neo4j_service,
            llm_service=llm_service,
            doc_processor_client=doc_processor_client,
        )

        # Register health checks
        if register_health_checks:
            _register_health_checks(core)

        # Initialize plugins
        registry = get_extension_registry()
        await registry.initialize_plugins({"core": core})

        # Trigger startup hook
        await registry.trigger_hook(HookPoint.SESSION_CREATED, {"event": "startup"})

        monitor.info("startup", "Chatbot core initialized successfully")
        return core

    except Exception as e:
        monitor.critical("startup", f"Failed to initialize chatbot core: {e}")
        raise


def _register_health_checks(core: ChatbotCore):
    """Register component health checks with monitor"""
    monitor = core.monitor

    # Redis health check
    def check_redis():
        if core._redis_service:
            try:
                core._redis_service.ping()
                return {"status": "healthy", "type": "redis"}
            except Exception as e:
                return {"status": "unhealthy", "type": "redis", "error": str(e)}
        return {"status": "not_configured", "type": "redis"}

    monitor.register_health_check("redis", check_redis)

    # Qdrant health check
    def check_qdrant():
        if core._qdrant_service:
            try:
                collections = core._qdrant_service.client.get_collections()
                return {
                    "status": "healthy",
                    "type": "qdrant",
                    "collections": len(collections.collections),
                }
            except Exception as e:
                return {"status": "unhealthy", "type": "qdrant", "error": str(e)}
        return {"status": "not_configured", "type": "qdrant"}

    monitor.register_health_check("qdrant", check_qdrant)

    # Neo4j health check
    def check_neo4j():
        if core._neo4j_service:
            try:
                core._neo4j_service.driver.verify_connectivity()
                return {"status": "healthy", "type": "neo4j"}
            except Exception as e:
                return {"status": "unhealthy", "type": "neo4j", "error": str(e)}
        return {"status": "not_configured", "type": "neo4j"}

    monitor.register_health_check("neo4j", check_neo4j)

    # LLM health check
    def check_llm():
        if core._llm_service:
            try:
                result = core._llm_service.health_check()
                return {
                    "status": "healthy" if result.get("status") == "ok" else "degraded",
                    "type": "llm",
                    "mode": result.get("current_mode"),
                }
            except Exception as e:
                return {"status": "unhealthy", "type": "llm", "error": str(e)}
        return {"status": "not_configured", "type": "llm"}

    monitor.register_health_check("llm", check_llm)

    logger.info("Registered health checks for chatbot core components")


async def shutdown_chatbot():
    """
    Cleanup chatbot core during FastAPI shutdown.

    Call this in your shutdown event handler.
    """
    monitor = get_monitor()
    monitor.info("shutdown", "Shutting down chatbot core...")

    try:
        core = get_chatbot_core()

        # Clear inactive sessions
        if core.sessions:
            core.sessions.clear_inactive_sessions(max_age_hours=0)

        # Trigger shutdown hook
        registry = get_extension_registry()
        await registry.trigger_hook(HookPoint.SESSION_DESTROYED, {"event": "shutdown"})

        # Export logs before shutdown
        if core.monitor:
            logs = core.monitor.export_logs()
            logger.debug(f"Exported {len(logs)} log entries")

        monitor.info("shutdown", "Chatbot core shutdown complete")

    except Exception as e:
        logger.error(f"Error during chatbot shutdown: {e}")


def include_chatbot_routes(app):
    """
    Include chatbot v2 routes in FastAPI app.

    Args:
        app: FastAPI application instance

    Example:
        from chatbot_core.startup import include_chatbot_routes
        include_chatbot_routes(app)
    """
    from routes.chatbot_v2 import router as chatbot_v2_router
    app.include_router(chatbot_v2_router)
    logger.info("Included chatbot v2 routes")


# =============================================================================
# MAIN.PY INTEGRATION EXAMPLE
# =============================================================================

INTEGRATION_EXAMPLE = """
# =============================================================================
# Example: Integrating chatbot_core with your existing main.py
# =============================================================================

# Add these imports at the top of main.py:
from chatbot_core.startup import (
    initialize_chatbot_on_startup,
    shutdown_chatbot,
    include_chatbot_routes,
)

# Add chatbot routes (after creating FastAPI app):
include_chatbot_routes(app)

# Modify your startup event:
@app.on_event("startup")
async def startup():
    # ... your existing startup code ...

    # After initializing your services (redis_service, llm_service, etc.):
    await initialize_chatbot_on_startup(
        redis_service=redis_service,
        qdrant_service=qdrant_service,
        neo4j_service=neo4j_service,
        llm_service=llm_service,
        doc_processor_client=doc_processor_client,
    )

# Add shutdown event:
@app.on_event("shutdown")
async def shutdown():
    await shutdown_chatbot()

# =============================================================================
# That's it! Your chatbot is now enhanced with:
# - General-Session chats (isolated memory)
# - Project-Session chats (shared project memory)
# - Unified memory management (Redis -> CocoIndex -> DBs)
# - Context-aware LLM prompts
# - Stage-based external tool restrictions
# - Document ingestion pipeline
# - Monitoring and metrics
# - Modular extension system
# =============================================================================
"""

if __name__ == "__main__":
    print(INTEGRATION_EXAMPLE)
