"""
Payment Service - NOWPayments Integration

Handles crypto payment creation, webhook verification, and status tracking.
Uses the NOWPayments invoice-based flow:
  1. Create invoice → get hosted payment URL
  2. Redirect user to NOWPayments checkout
  3. Receive IPN webhook on status change
  4. Verify signature, update transaction, upgrade user on completion
"""

import os
import json
import hmac
import hashlib
import logging
from uuid import UUID, uuid4
from datetime import datetime, timezone, timedelta
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

# Configuration from environment
NOWPAYMENTS_API_KEY = os.getenv("NOWPAYMENTS_API_KEY", "")
NOWPAYMENTS_IPN_SECRET = os.getenv("NOWPAYMENTS_IPN_SECRET", "")
NOWPAYMENTS_SANDBOX = os.getenv("NOWPAYMENTS_SANDBOX", "false").lower() == "true"
FRONTEND_URL = os.getenv("FRONTEND_URL", "https://simorghai.electrokavir.com/chatbot")

NOWPAYMENTS_BASE = (
    "https://api-sandbox.nowpayments.io/v1"
    if NOWPAYMENTS_SANDBOX
    else "https://api.nowpayments.io/v1"
)

# Tier pricing in USD
TIER_PRICES = {
    "pro": 9.99,
    "max": 29.99,
}


class PaymentService:
    """Service for managing crypto payments via NOWPayments."""

    def __init__(self, db):
        self.db = db

    async def create_invoice(
        self,
        user_id: UUID,
        tier_name: str,
        pay_currency: Optional[str] = None,
    ) -> dict:
        """
        Create a NOWPayments invoice for a tier upgrade.

        Returns the invoice URL for the user to complete payment.
        """
        if tier_name not in TIER_PRICES:
            raise ValueError(f"Invalid tier for purchase: {tier_name}")

        if not NOWPAYMENTS_API_KEY:
            raise RuntimeError("NOWPAYMENTS_API_KEY not configured")

        price = TIER_PRICES[tier_name]
        order_id = str(uuid4())

        # Create transaction record first
        tx_query = """
            INSERT INTO payment_transactions
                (user_id, tier_name, amount, currency, payment_provider, status)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING id
        """
        tx_result = await self.db.execute_one_async(
            tx_query, user_id, tier_name, price, "usd",
            "nowpayments", "pending"
        )
        tx_id = str(tx_result["id"])

        # Build callback URL
        ipn_url = f"{FRONTEND_URL.rstrip('/').replace('/chatbot', '')}/api/v2/payments/webhook"

        # Create NOWPayments invoice
        payload = {
            "price_amount": price,
            "price_currency": "usd",
            "order_id": tx_id,
            "order_description": f"Simorgh AI - {tier_name.capitalize()} Tier (30 days)",
            "ipn_callback_url": ipn_url,
            "success_url": f"{FRONTEND_URL}/upgrade?status=success&tx={tx_id}",
            "cancel_url": f"{FRONTEND_URL}/upgrade?status=cancelled&tx={tx_id}",
        }

        if pay_currency:
            payload["pay_currency"] = pay_currency

        async with httpx.AsyncClient(timeout=30) as client:
            try:
                response = await client.post(
                    f"{NOWPAYMENTS_BASE}/invoice",
                    json=payload,
                    headers={
                        "x-api-key": NOWPAYMENTS_API_KEY,
                        "Content-Type": "application/json",
                    },
                )
            except httpx.ConnectError as e:
                logger.error(f"Cannot connect to NOWPayments API: {e}")
                await self.db.execute_async(
                    "UPDATE payment_transactions SET status = 'failed' WHERE id = $1",
                    UUID(tx_id)
                )
                raise RuntimeError(
                    "Cannot reach payment provider. This may be a network issue. "
                    "Please try again later or contact support."
                )
            except httpx.TimeoutException as e:
                logger.error(f"NOWPayments API timeout: {e}")
                await self.db.execute_async(
                    "UPDATE payment_transactions SET status = 'failed' WHERE id = $1",
                    UUID(tx_id)
                )
                raise RuntimeError("Payment provider timed out. Please try again.")

        if response.status_code != 200:
            logger.error(f"NOWPayments invoice creation failed: {response.text}")
            # Mark transaction as failed
            await self.db.execute_async(
                "UPDATE payment_transactions SET status = 'failed' WHERE id = $1",
                UUID(tx_id)
            )
            raise RuntimeError(f"Payment provider error: {response.status_code}")

        invoice_data = response.json()
        provider_id = str(invoice_data.get("id", ""))

        # Update transaction with provider payment ID
        await self.db.execute_async(
            "UPDATE payment_transactions SET provider_payment_id = $1 WHERE id = $2",
            provider_id, UUID(tx_id)
        )

        logger.info(
            f"Invoice created for user {user_id}: tx={tx_id}, "
            f"provider_id={provider_id}, tier={tier_name}"
        )

        return {
            "transaction_id": tx_id,
            "invoice_url": invoice_data.get("invoice_url"),
            "invoice_id": provider_id,
            "price_amount": price,
            "price_currency": "usd",
            "tier": tier_name,
        }

    async def handle_webhook(self, body: dict, signature: str) -> dict:
        """
        Handle NOWPayments IPN webhook callback.

        Verifies signature, updates transaction status, and upgrades user
        when payment is confirmed.
        """
        # Verify signature
        if not self._verify_signature(body, signature):
            logger.warning("Invalid IPN signature received")
            raise ValueError("Invalid signature")

        payment_status = body.get("payment_status", "")
        order_id = body.get("order_id", "")
        actually_paid = body.get("actually_paid", 0)
        pay_currency = body.get("pay_currency", "")

        logger.info(
            f"IPN received: order={order_id}, status={payment_status}, "
            f"paid={actually_paid} {pay_currency}"
        )

        if not order_id:
            return {"status": "ignored", "reason": "no_order_id"}

        # Look up transaction
        tx = await self.db.execute_one_async(
            "SELECT * FROM payment_transactions WHERE id = $1",
            UUID(order_id)
        )

        if not tx:
            logger.warning(f"Transaction not found for order_id: {order_id}")
            return {"status": "ignored", "reason": "transaction_not_found"}

        # Map NOWPayments status to our status
        status_map = {
            "waiting": "pending",
            "confirming": "confirming",
            "confirmed": "confirmed",
            "sending": "confirmed",
            "finished": "confirmed",
            "partially_paid": "pending",
            "failed": "failed",
            "refunded": "refunded",
            "expired": "expired",
        }

        new_status = status_map.get(payment_status, tx["status"])

        # Update transaction
        update_query = """
            UPDATE payment_transactions
            SET status = $1,
                tx_hash = COALESCE($2, tx_hash),
                confirmed_at = CASE WHEN $1 = 'confirmed' THEN NOW() ELSE confirmed_at END,
                updated_at = NOW()
            WHERE id = $3
        """
        await self.db.execute_async(
            update_query,
            new_status,
            body.get("payin_hash"),
            UUID(order_id),
        )

        # If payment is finished/confirmed → upgrade user
        if payment_status in ("finished", "confirmed") and tx["status"] != "confirmed":
            await self._fulfill_payment(tx)
            return {"status": "fulfilled", "tier": tx["tier_name"]}

        return {"status": "updated", "payment_status": new_status}

    async def _fulfill_payment(self, tx: dict):
        """Upgrade user's tier after successful payment."""
        from services.user_tier_service import get_tier_service

        tier_service = get_tier_service()
        if not tier_service:
            logger.error("Tier service not available for fulfillment")
            return

        user_id = tx["user_id"]
        tier_name = tx["tier_name"]

        result = await tier_service.upgrade_user(user_id, tier_name)

        if result:
            logger.info(
                f"Payment fulfilled: user {user_id} upgraded to {tier_name}"
            )
        else:
            logger.error(
                f"Failed to fulfill payment: user {user_id}, tier {tier_name}"
            )

    async def get_transaction_status(self, tx_id: UUID, user_id: UUID) -> Optional[dict]:
        """Get transaction status for a user."""
        tx = await self.db.execute_one_async(
            "SELECT id, tier_name, amount, currency, status, created_at, confirmed_at "
            "FROM payment_transactions WHERE id = $1 AND user_id = $2",
            tx_id, user_id
        )
        return dict(tx) if tx else None

    async def get_user_transactions(self, user_id: UUID, limit: int = 10) -> list:
        """Get recent payment transactions for a user."""
        rows = await self.db.execute_async(
            "SELECT id, tier_name, amount, currency, status, created_at, confirmed_at "
            "FROM payment_transactions WHERE user_id = $1 "
            "ORDER BY created_at DESC LIMIT $2",
            user_id, limit
        )
        return [dict(r) for r in rows]

    def _verify_signature(self, body: dict, signature: str) -> bool:
        """Verify NOWPayments IPN webhook signature."""
        if not NOWPAYMENTS_IPN_SECRET:
            logger.warning("IPN secret not configured, skipping verification")
            return True  # Allow in dev mode

        sorted_body = json.dumps(body, separators=(",", ":"), sort_keys=True)
        computed = hmac.new(
            NOWPAYMENTS_IPN_SECRET.encode("utf-8"),
            sorted_body.encode("utf-8"),
            hashlib.sha512,
        ).hexdigest()

        return hmac.compare_digest(computed, signature)


# Singleton
_payment_service: Optional[PaymentService] = None


def init_payment_service(db) -> PaymentService:
    global _payment_service
    _payment_service = PaymentService(db)
    return _payment_service


def get_payment_service() -> Optional[PaymentService]:
    return _payment_service
