"""
Auth Service
============
Standalone REST microservice for authentication.

Mounts the auth_v2 router at /api/v2/auth, providing:
- Email/password registration + login
- Google OAuth 2.0
- JWT access + refresh tokens
- Email verification + password reset
- Legacy TPMS / SQL Server fallback authentication

Backed by PostgreSQL (via database.postgres_connection) and the
postgres_auth, oauth, email, and tpms_auth service modules extracted from
the backend monolith in Phase 4.
"""
import logging
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from routes.auth_v2 import router as auth_v2_router

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("auth-service")

app = FastAPI(title="Simorgh Auth Service", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ALLOW_ORIGINS", "*").split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_v2_router, prefix="/api/v2/auth", tags=["auth"])


@app.get("/health")
def health():
    return {"status": "healthy", "service": "auth-service"}
