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


@app.get("/health")
def health():
    return {"status": "healthy", "service": "tier-quota-service"}
