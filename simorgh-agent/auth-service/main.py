"""
Auth Service
============
Standalone REST microservice for authentication.

The auth_v2 router has its own prefix `/auth/v2`, so we add an outer `/api`
prefix here so the full external URL is `/api/auth/v2/*` — matching the
URL pattern the React frontend already uses (`${API_BASE}/auth/v2/...`,
where API_BASE is `/api`). nginx forwards `/api/auth/v2/...` here
unchanged.

Provides:
  - email/password registration + login (PostgreSQL)
  - Google OAuth 2.0
  - JWT access + refresh tokens
  - email verification + password reset
  - legacy TPMS / SQL Server fallback authentication

Backed by PostgreSQL (via database.postgres_connection) and the
postgres_auth, oauth, email, tpms_auth service modules extracted from
the backend monolith in phase 4.
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

# auth_v2_router has its own prefix `/auth/v2`. We add `/api` so the
# combined path is `/api/auth/v2/*` which is what the frontend already
# hits and what backend's nginx already routes here.
app.include_router(auth_v2_router, prefix="/api")


@app.get("/health")
def health():
    return {"status": "healthy", "service": "auth-service"}
