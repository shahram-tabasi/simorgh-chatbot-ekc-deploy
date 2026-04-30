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


@app.get("/health")
def health():
    return {"status": "healthy", "service": "chat-service"}
