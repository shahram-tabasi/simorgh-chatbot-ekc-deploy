"""
Payment Routes (Phase 5)

Endpoints for:
- Creating payment invoices for tier upgrades
- NOWPayments IPN webhook receiver
- Transaction status checking
- Available tiers and pricing
"""

import logging
from uuid import UUID
from typing import Optional

from fastapi import APIRouter, HTTPException, Depends, Request, Header
from pydantic import BaseModel

from routes.auth_v2 import get_current_user
from services.payment_service import get_payment_service, TIER_PRICES

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v2/payments", tags=["Payments"])


# =============================================================================
# Request/Response Models
# =============================================================================

class CreateInvoiceRequest(BaseModel):
    tier: str  # 'pro' or 'max'
    pay_currency: Optional[str] = None  # Optional: 'btc', 'eth', 'usdt', etc.


class InvoiceResponse(BaseModel):
    transaction_id: str
    invoice_url: str
    invoice_id: str
    price_amount: float
    price_currency: str
    tier: str


class PricingTier(BaseModel):
    name: str
    price_usd: float
    questions_per_day: int
    can_create_projects: bool
    can_use_tools: bool
    duration_days: int


# =============================================================================
# Public Endpoints
# =============================================================================

@router.get("/pricing")
async def get_pricing():
    """Get available tiers and their prices."""
    from services.user_tier_service import get_tier_service

    tier_service = get_tier_service()
    tiers = await tier_service.get_all_tier_quotas() if tier_service else []

    pricing = []
    for tier in tiers:
        name = tier["tier_name"]
        if name in TIER_PRICES:
            pricing.append({
                "name": name,
                "price_usd": TIER_PRICES[name],
                "questions_per_day": tier["max_questions_per_day"],
                "can_create_projects": tier.get("can_create_projects", False),
                "can_use_tools": tier.get("can_use_tools", False),
                "duration_days": tier.get("subscription_duration_days", 30),
                "description": tier.get("description", ""),
            })

    return {"tiers": pricing, "currency": "usd", "payment_method": "crypto"}


# =============================================================================
# Webhook (no auth - verified by signature)
# =============================================================================

@router.post("/webhook")
async def payment_webhook(request: Request):
    """
    NOWPayments IPN webhook handler.

    Receives payment status updates and fulfills orders.
    Verified via HMAC-SHA512 signature.
    """
    payment_service = get_payment_service()
    if not payment_service:
        raise HTTPException(status_code=503, detail="Payment service not available")

    signature = request.headers.get("x-nowpayments-sig", "")
    body = await request.json()

    try:
        result = await payment_service.handle_webhook(body, signature)
        return result
    except ValueError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except Exception as e:
        logger.error(f"Webhook processing error: {e}")
        raise HTTPException(status_code=500, detail="Internal error")


# =============================================================================
# Authenticated Endpoints
# =============================================================================

@router.post("/create-invoice", response_model=InvoiceResponse)
async def create_invoice(
    request: CreateInvoiceRequest,
    current_user: dict = Depends(get_current_user),
):
    """
    Create a payment invoice for a tier upgrade.

    Returns a NOWPayments checkout URL where the user can pay with crypto.
    """
    payment_service = get_payment_service()
    if not payment_service:
        raise HTTPException(status_code=503, detail="Payment service not available")

    if request.tier not in TIER_PRICES:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid tier. Available: {list(TIER_PRICES.keys())}"
        )

    # Check if user already has this tier or higher
    current_role = current_user.get("user_role", "free")
    role_hierarchy = {"free": 0, "pro": 1, "max": 2, "admin": 3}

    if role_hierarchy.get(current_role, 0) >= role_hierarchy.get(request.tier, 0):
        raise HTTPException(
            status_code=400,
            detail=f"You already have {current_role} tier (same or higher)"
        )

    try:
        result = await payment_service.create_invoice(
            user_id=current_user["id"],
            tier_name=request.tier,
            pay_currency=request.pay_currency,
        )
        return InvoiceResponse(**result)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e))


@router.get("/transactions")
async def get_my_transactions(
    current_user: dict = Depends(get_current_user),
):
    """Get current user's payment transaction history."""
    payment_service = get_payment_service()
    if not payment_service:
        raise HTTPException(status_code=503, detail="Payment service not available")

    transactions = await payment_service.get_user_transactions(current_user["id"])
    return {"transactions": transactions}


@router.get("/transactions/{tx_id}")
async def get_transaction_status(
    tx_id: UUID,
    current_user: dict = Depends(get_current_user),
):
    """Get a specific transaction's status."""
    payment_service = get_payment_service()
    if not payment_service:
        raise HTTPException(status_code=503, detail="Payment service not available")

    tx = await payment_service.get_transaction_status(tx_id, current_user["id"])
    if not tx:
        raise HTTPException(status_code=404, detail="Transaction not found")

    return tx
