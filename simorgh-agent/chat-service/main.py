"""
Chat Service
============
Standalone REST microservice for chat: send/stream messages, manage sessions,
persist conversation history, build context windows.

Routers:
- chatbot_v2  → /api/v2/chat/*  (main streaming chat endpoint)
- project_session → /api/v2/projects/{id}/sessions/*  (project-scoped sessions)

Backed by Redis (sessions, history), PostgreSQL (unified message persistence),
Qdrant (RAG retrieval), and the new llm-gateway for completions.
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

app.include_router(chatbot_v2_router, prefix="/api/v2/chat", tags=["chat"])
app.include_router(project_session_router, prefix="/api/v2/projects", tags=["sessions"])


@app.get("/health")
def health():
    return {"status": "healthy", "service": "chat-service"}
