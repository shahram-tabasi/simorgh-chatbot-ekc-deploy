# Simorgh User Tiers & Feature Differentiation - Implementation Plan

## Design Decisions (Confirmed)

1. **Neo4j** → Organize (legacy) members ONLY. Modern users use PostgreSQL + Redis for project memory.
2. **Crypto payment** → Automated via blockchain API (NOWPayments or similar).
3. **Admin** → Modern auth only, created with a specific admin secret/password.
4. **Offline LLM** → Organize members ONLY. All modern tiers (free/pro/max) use online LLM only.

---

## Current State Analysis

### What Exists Today
- **Dual auth**: Modern (PostgreSQL, email/Google OAuth) + Legacy (TPMS/MySQL)
- **Chat types**: General (isolated) + Project (shared memory, TPMS-linked)
- **LLM modes**: Online (OpenAI) + Offline (local servers at 192.168.1.61/.62)
- **Rate limiting**: IP-based only (no per-user quotas)
- **No subscription/tier system** - all users have same access
- **No usage tracking** per user
- **No payment integration**

### Key Architecture Points
- PostgreSQL `users` table has NO role/tier/quota fields
- `user_preferences` has `ai_mode` (online/local/auto) but no enforcement
- TPMS project creation requires TPMS permission check (legacy only)
- Project chats use TPMS data for context; general chats don't
- Middleware rate limits are IP-based, not user-based

---

## Proposed Architecture

### Two User Worlds

| Feature | Modern Users (Email/Google) | Organize Users (TPMS Legacy) |
|---------|----------------------------|------------------------------|
| LLM Access | Online only (OpenAI) | Online + Offline (local) |
| TPMS Data | Never | Full access |
| Neo4j Graph | Never | Full access |
| Project Chat | Name-only (PostgreSQL + Redis) | TPMS-linked (Neo4j + full sync) |
| General Chat | Yes | Yes |
| Quotas | Tier-based limits | Unlimited |
| Tools | Tier-based | Full access |
| Payment | Crypto required for pro/max | No payment needed |

### Modern User Tiers

| Feature | Free | Pro | Max | Admin |
|---------|------|-----|-----|-------|
| Price | $0 | Paid (crypto) | Paid (crypto) | - |
| General Chat | Yes | Yes | Yes | Yes |
| Project Chat | No | Yes (name-only) | Yes (name-only) | Yes |
| Questions/day | 20 | 100 | 500 | Unlimited |
| LLM | Online only | Online only | Online only | Online only |
| Account Duration | Unlimited | 30 days | 30 days | Unlimited |
| Electrical Tools | No | No | Yes (future) | Yes |
| Admin Panel | No | No | No | Yes (modern + legacy) |
| Storage | PostgreSQL + Redis | PostgreSQL + Redis | PostgreSQL + Redis | PostgreSQL + Redis |

### Admin User
- Modern auth only (email/Google login)
- Created via special admin secret (env var `ADMIN_SETUP_SECRET`)
- Manages ALL users (modern tiers + organize/legacy members)
- Has unlimited online LLM access (no offline - that's organize-only)
- Can promote/demote users, view usage, configure quotas

### Organize (Legacy) Users
- Login via TPMS credentials (unchanged)
- Unlimited access to everything: online + offline LLM, all tools
- Projects use full TPMS flow: permission check → data sync → Neo4j graph
- No tier system, no quotas, no payment needed

---

## Implementation Phases

### Phase 1: Database Schema & User Tiers (Backend Foundation)

**1.1 New Migration: `002_add_user_tiers.sql`**
```sql
-- Add tier fields to users table
ALTER TABLE users ADD COLUMN user_role VARCHAR(20) DEFAULT 'free'
  CHECK (user_role IN ('free', 'pro', 'max', 'admin'));
ALTER TABLE users ADD COLUMN subscription_expires_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE users ADD COLUMN wallet_address VARCHAR(255);

-- Daily usage tracking
CREATE TABLE user_daily_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  usage_date DATE NOT NULL DEFAULT CURRENT_DATE,
  questions_used INT DEFAULT 0,
  tokens_used INT DEFAULT 0,
  UNIQUE(user_id, usage_date)
);

-- Tier quota configuration (admin-editable)
CREATE TABLE tier_quotas (
  tier_name VARCHAR(20) PRIMARY KEY,
  max_questions_per_day INT NOT NULL,
  can_create_projects BOOLEAN DEFAULT FALSE,
  can_use_offline_llm BOOLEAN DEFAULT FALSE,
  can_use_tools BOOLEAN DEFAULT FALSE,
  subscription_duration_days INT,  -- NULL = unlimited
  description TEXT
);

-- Default tier configs
INSERT INTO tier_quotas VALUES
  ('free',  20,    FALSE, FALSE, FALSE, NULL,  'Free tier - general chat only'),
  ('pro',   100,   TRUE,  FALSE, FALSE, 30,    'Pro tier - projects + more questions'),
  ('max',   500,   TRUE,  FALSE, TRUE,  30,    'Max tier - all features + tools'),
  ('admin', 99999, TRUE,  FALSE, TRUE,  NULL,  'Admin - unlimited online access');

-- Payment/transaction log (automated crypto verification)
CREATE TABLE payment_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  tier_name VARCHAR(20) NOT NULL,
  amount DECIMAL(18, 8),
  currency VARCHAR(20),          -- BTC, ETH, USDT, etc.
  payment_provider VARCHAR(50),  -- nowpayments, coingate, etc.
  provider_payment_id VARCHAR(255),
  wallet_address VARCHAR(255),
  tx_hash VARCHAR(255),
  status VARCHAR(20) DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirming', 'confirmed', 'failed', 'refunded', 'expired')),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  confirmed_at TIMESTAMP,
  expires_at TIMESTAMP           -- payment window expiry
);

CREATE INDEX idx_usage_user_date ON user_daily_usage(user_id, usage_date);
CREATE INDEX idx_payment_user ON payment_transactions(user_id);
CREATE INDEX idx_payment_status ON payment_transactions(status);
CREATE INDEX idx_payment_provider_id ON payment_transactions(provider_payment_id);
```

**1.2 Backend: Quota Enforcement Middleware**

New file: `backend/middleware/quota_middleware.py`
- Intercept chat message endpoints (`/api/v2/chat/*/message`)
- Extract user_id from JWT
- Determine user type: legacy (TPMS) → skip all checks (unlimited)
- Modern users: check `user_role` against `tier_quotas`
- Check daily usage count against tier limit
- Check subscription expiry for pro/max
- Return 429 with `{remaining: 0, resets_at: "...", upgrade_url: "..."}` when exceeded
- Add response headers: `X-Quota-Remaining`, `X-Quota-Limit`, `X-Quota-Reset`

**1.3 Backend: User Tier Service**

New file: `backend/services/user_tier_service.py`
- `get_user_quota(user_id)` → returns tier limits from `tier_quotas`
- `check_quota(user_id)` → returns `(allowed, remaining, resets_at)`
- `increment_usage(user_id)` → UPSERT into `user_daily_usage`
- `upgrade_tier(user_id, tier, payment_tx)` → upgrade user, set expiry
- `check_subscription_expiry()` → downgrade expired pro/max → free
- `create_admin(email, admin_secret)` → create admin with env-based secret

**1.4 Auto-Migration at Startup**
- Extend `postgres_connection.py` to also run `002_add_user_tiers.sql` if columns missing
- Check for `user_role` column existence, run migration if absent

### Phase 2: LLM & Feature Gating (Backend Logic)

**2.1 LLM Mode Enforcement**
- Modify `llm_service.py`: Add user context parameter
- Modern users (all tiers including admin) → force `online` mode
- Legacy/organize users → allow `online` + `offline`
- Return 403 with clear message if modern user requests offline

**2.2 Project Creation Differentiation**
- New endpoint: `POST /api/v2/project/create` for modern users
  - Accepts: `project_name` only
  - Creates: PostgreSQL record + Redis memory namespace
  - No TPMS lookup, no Neo4j, no background sync
  - Requires: `pro`, `max`, or `admin` role
- Existing endpoint: `POST /api/v2/project/select` unchanged for legacy
  - Full TPMS permission check + data sync + Neo4j graph
- Chat within modern project: shared Redis memory, PostgreSQL history
- Chat within legacy project: full context (TPMS + Neo4j + Qdrant)

**2.3 Feature Access Guards**
- New dependency: `require_role(*roles)` → FastAPI Depends
- Apply to endpoints:
  - Project creation: `require_role('pro', 'max', 'admin')` for modern
  - Tool endpoints: `require_role('max', 'admin')` for modern (+ all legacy)
  - Admin endpoints: `require_role('admin')`
- Return 403 with `{required_tier: "pro", current_tier: "free", upgrade_url: "..."}`

### Phase 3: Frontend - Tier-Aware UI

**3.1 User State Enhancement**
- Add to `AuthContext`: `user_role`, `subscription_expires_at`, `quota`
- New API call on login: `GET /api/v2/quota/me` → returns usage + limits
- New hook: `useQuota()` → `{remaining, limit, resetsAt, tier, canCreateProjects, canUseTools}`

**3.2 UI Changes**
- **Quota badge** in sidebar/header: "12/20 questions today"
- **Upgrade prompts**: When quota exhausted → modal with tier comparison + crypto payment
- **Feature locks**:
  - Free users: Project creation button shows lock icon + "Upgrade to Pro"
  - Free/Pro users: Tools section shows lock icon + "Upgrade to Max"
- **LLM mode**: Hide offline toggle completely for modern users
- **TPMS elements**: Hide for modern users (project data tab, TPMS sync status, OENUM field)

**3.3 Project Creation for Modern Users**
- Simplified modal: Project name + optional description
- No OENUM field, no TPMS project selector
- Project sidebar shows chats within project (shared memory indicator)

**3.4 Subscription Status UI**
- Profile page: Show current tier, expiry date, usage stats
- Expiring soon warning: Banner when < 3 days remaining
- Expired state: Show "Subscription expired" with renewal CTA

### Phase 4: Admin Panel

**4.1 Admin Setup**
- Env var: `ADMIN_SETUP_SECRET` (set in GitHub Secrets)
- Endpoint: `POST /api/v2/admin/setup` with `{email, password, admin_secret}`
- Creates admin user or promotes existing user to admin
- One-time setup, or can be used to add more admins

**4.2 Backend Admin Routes** (`backend/routes/admin.py`)
- `GET /admin/users` → paginated list (both modern + legacy)
- `GET /admin/users/{id}` → user detail with usage history
- `PATCH /admin/users/{id}/role` → change tier (free/pro/max/admin)
- `GET /admin/stats` → system dashboard data
- `GET /admin/tier-quotas` → current tier configs
- `PUT /admin/tier-quotas/{tier}` → update quota values
- `GET /admin/payments` → transaction history
- All protected by admin role check

**4.3 Frontend Admin Page**
- Route: `/admin` (hidden from non-admin users)
- **Users tab**: Table with search, filter by tier/type (modern/legacy)
  - Inline actions: change tier, view usage, toggle active
- **Statistics tab**: Charts for daily active users, questions asked, tier distribution
- **Quotas tab**: Edit tier limits (max questions, features toggles)
- **Payments tab**: Transaction log with status filters
- **System tab**: Health checks, service status

### Phase 5: Crypto Payment Integration

**5.1 Payment Provider: NOWPayments (or similar)**
- API-based crypto payment gateway
- Supports: BTC, ETH, USDT, USDC, and 100+ coins
- Free tier available, low fees
- Webhook for payment confirmation
- No blockchain node needed

**5.2 Payment Flow**
1. User clicks "Upgrade to Pro/Max"
2. Frontend shows tier comparison + price
3. User selects cryptocurrency
4. Backend calls NOWPayments API → creates payment invoice
5. User shown: wallet address + amount + QR code + expiry timer
6. User sends crypto payment
7. NOWPayments webhook → `POST /api/v2/payment/webhook`
8. Backend verifies webhook signature
9. Updates `payment_transactions` status → `confirmed`
10. Upgrades user tier, sets `subscription_expires_at = NOW + 30 days`

**5.3 Backend Payment Routes** (`backend/routes/payment.py`)
- `POST /api/v2/payment/create` → create payment for tier upgrade
- `GET /api/v2/payment/status/{id}` → check payment status
- `POST /api/v2/payment/webhook` → NOWPayments callback
- `GET /api/v2/payment/history` → user's payment history

**5.4 Subscription Lifecycle**
- Background task: Check expired subscriptions every hour
- 3 days before expiry: Send notification (if email works)
- On expiry: Downgrade to free, clear pro/max features
- Renewal: Same payment flow, extends from current expiry date

---

## File Structure (New Files)

```
backend/
├── database/migrations/
│   └── 002_add_user_tiers.sql          # New schema
├── middleware/
│   └── quota_middleware.py              # Per-user quota enforcement
├── services/
│   └── user_tier_service.py            # Tier logic, usage tracking
│   └── payment_service.py              # NOWPayments integration
├── routes/
│   └── admin.py                        # Admin panel API
│   └── payment.py                      # Payment endpoints
│   └── quota.py                        # Quota info endpoints
├── models/
│   └── tier_models.py                  # Pydantic models for tiers/payments

frontend/src/
├── components/
│   └── admin/                          # Admin panel components
│   └── payment/                        # Payment/upgrade components
│   └── quota/                          # Quota display components
├── hooks/
│   └── useQuota.ts                     # Quota tracking hook
├── pages/
│   └── AdminPage.tsx                   # Admin dashboard
│   └── UpgradePage.tsx                 # Tier upgrade + payment
```

---

## Implementation Order

1. **Phase 1** - Database + Quotas (foundation for everything)
2. **Phase 2** - LLM + Feature Gating (core differentiation)
3. **Phase 3** - Frontend Tier UI (user-facing experience)
4. **Phase 4** - Admin Panel (management capability)
5. **Phase 5** - Crypto Payment (monetization)
