"""
Payments Service
================
Standalone REST microservice for NOWPayments crypto payments + IPN webhooks.

Mounts the payments router at /api/payments/*.
"""
import logging
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from routes.payments import router as payments_router

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("payments-service")

app = FastAPI(title="Simorgh Payments Service", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ALLOW_ORIGINS", "*").split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# router carries its own prefix /api/v2/payments
app.include_router(payments_router)


@app.get("/health")
def health():
    return {"status": "healthy", "service": "payments-service"}
