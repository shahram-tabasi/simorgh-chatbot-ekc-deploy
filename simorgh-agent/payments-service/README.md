# payments-service

Standalone microservice for **NOWPayments** (crypto) integration —
invoice creation, IPN webhook receiver, transaction history. Extracted
from `backend/routes/payments.py` in phase 9.

| Property | Value |
|---|---|
| Container | `payments-service` |
| Port (internal) | **8038** |
| Image | built from `simorgh-agent/payments-service/Dockerfile` |
| Compose file | `simorgh-agent/compose/svc-payments.yml` |
| Mounted at nginx | `/api/v2/payments/*` |
| Storage | PostgreSQL (`postgres_auth` — payments tables alongside auth) |

---

## Endpoints

The router has prefix `/api/v2/payments`; this service includes it
without an extra prefix (the phase-9 first pass mistakenly used
`/api/payments`).

| Method | Path | Body / params | Auth | Notes |
|---|---|---|---|---|
| `GET`  | `/api/v2/payments/pricing` | — | none | Public price list per tier |
| `POST` | `/api/v2/payments/create-invoice` | `{tier, currency?, ...}` | bearer | Creates a NOWPayments invoice; returns hosted-page URL |
| `POST` | `/api/v2/payments/webhook` | NOWPayments IPN | HMAC | Verifies `X-Nowpayments-Sig`, marks transaction paid, upgrades tier |
| `GET`  | `/api/v2/payments/transactions` | `?limit=` | bearer | User's own tx history |
| `GET`  | `/api/v2/payments/transactions/{tx_id}` | — | bearer | Single tx |

### Status codes

| Code | When |
|---|---|
| `200` | Success |
| `400` | Bad currency / amount / tier |
| `401` | Missing / invalid JWT |
| `403` | IPN signature mismatch (`/webhook`) |
| `404` | Transaction not found |
| `502` | NOWPayments API error |

---

## How the IPN flow works

```
   user clicks "Buy Premium"
        │
        ▼
   POST /api/v2/payments/create-invoice  → NOWPayments API
        │                                   │
        │                                   ▼
        │                           creates invoice record
        │                                   │
        ▼                                   │
   browser → hosted payment page ◀──────────┘
        │
        │   user pays in BTC/ETH/...
        ▼
   NOWPayments → POST /api/v2/payments/webhook (signed with IPN_SECRET)
        │
        ▼
   service verifies HMAC, updates tx → paid, calls user-tier upgrade
```

The IPN secret (`NOWPAYMENTS_IPN_SECRET`) must match what's set in the
NOWPayments dashboard. Mismatched signature → 403 and the payment is
silently lost — be careful when rotating secrets.

---

## Environment variables

| Var | Required | Notes |
|---|---|---|
| `NOWPAYMENTS_API_KEY` | **yes** | From dashboard |
| `NOWPAYMENTS_IPN_SECRET` | **yes** | HMAC key for webhook |
| `NOWPAYMENTS_SANDBOX` | | `true` to use sandbox API |
| `POSTGRES_AUTH_*` | yes | Stores `payments_transactions` etc. |
| `JWT_SECRET_KEY` | yes | Verify caller JWT |
| `FRONTEND_URL` | | Used in invoice success/cancel redirect URLs |

---

## How `backend/main.py` collaborates with it

### Today (phase B)

backend still includes `payments_router` and runs the same code in-process.
The standalone container also runs it but isn't receiving traffic until
the nginx fix.

### After phase C

backend stops including the router. Container nginx forwards
`/api/v2/payments/*` directly here. Other services that need to check
"is user X paid?" go through `tier-quota-service` (it owns tier state),
not this service.

This service does **one thing**: take money. Tier upgrades it triggers
are persisted in the same DB as auth, so other services see them via
the JWT (`tier` claim) or via `tier-quota-service:/api/v2/quota/me`.

---

## Local dev

```bash
NOWPAYMENTS_API_KEY=test NOWPAYMENTS_IPN_SECRET=test \
NOWPAYMENTS_SANDBOX=true \
docker compose -f simorgh-agent/compose/infra-postgres-auth.yml \
               -f simorgh-agent/compose/svc-payments.yml \
               up --build
```

Test the IPN locally with `curl` and a manually-computed HMAC:

```bash
BODY='{"payment_id":1,"payment_status":"finished",...}'
SIG=$(echo -n "$BODY" | openssl dgst -sha512 -hmac "$NOWPAYMENTS_IPN_SECRET" -hex | cut -d' ' -f2)
curl -X POST http://localhost:8038/api/v2/payments/webhook \
  -H "Content-Type: application/json" \
  -H "x-nowpayments-sig: $SIG" \
  -d "$BODY"
```

---

## Roadmap / known gaps

* **Idempotency** — repeated IPN deliveries should be no-ops; currently
  the webhook handler checks tx state but a unique constraint on
  `(payment_id, status)` would be safer.
* **Refund flow** — none. NOWPayments has refund endpoints; expose them.
* **Multi-currency display** — pricing endpoint returns USD; add
  Tomans/Rials based on `Accept-Language` for the Iranian users.
* **Drop bulk-copied `services/`** — payments only needs `payment_service.py`,
  `user_tier_service.py`, `auth_utils.py`, plus `database/`. Prune.
