"""
Admin Service
=============
Standalone REST microservice for admin operations
(user management, stats, system controls).

Mounts the admin router at /api/admin/*.
"""
import logging
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from routes.admin import router as admin_router

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("admin-service")

app = FastAPI(title="Simorgh Admin Service", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ALLOW_ORIGINS", "*").split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# router carries its own prefix /api/v2/admin
app.include_router(admin_router)


@app.get("/health")
def health():
    return {"status": "healthy", "service": "admin-service"}
