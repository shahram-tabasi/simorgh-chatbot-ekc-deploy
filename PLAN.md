# Simorgh User Tiers & Feature Differentiation - Implementation Plan

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

| Feature | Modern Users (Email/Google) | Legacy/Organize Users (TPMS) |
|---------|----------------------------|------------------------------|
| LLM Access | Online only (OpenAI) | Online + Offline (local) |
| TPMS Data | Never | Full access |
| Project Chat | Yes (name-only, no TPMS) | Yes (with TPMS data & access check) |
| General Chat | Yes | Yes |
| Quotas | Tier-based limits | Unlimited |
| Tools | Tier-based | Full access |
| Payment | Crypto wallet required for pro/max | No payment needed |

### Modern User Tiers

| Feature | Free | Pro | Max | Admin |
|---------|------|-----|-----|-------|
| Price | $0 | Paid (crypto) | Paid (crypto) | - |
| General Chat | Yes | Yes | Yes | Yes |
| Project Chat | No | Yes (name-only, no TPMS) | Yes (name-only, no TPMS) | Yes |
| Questions/day | 20 | 100 | 500 | Unlimited |
| LLM | Online only | Online only | Online only | Both |
| Account Duration | Unlimited | 30 days | 30 days | Unlimited |
| Electrical Tools | No | No | Yes (ETAP, DIgSILENT) | Yes |
| Admin Panel | No | No | No | Yes |
| Project Memory | N/A | Shared within project | Shared within project | Full |

### Admin Capabilities
- Manage ALL users (modern + legacy)
- View usage statistics
- Promote/demote user tiers
- Monitor system health
- Configure tier quotas

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
  ('admin', 99999, TRUE,  TRUE,  TRUE,  NULL,  'Admin - unlimited access');

-- Payment/transaction log
CREATE TABLE payment_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  tier_name VARCHAR(20) NOT NULL,
  amount DECIMAL(18, 8),        -- crypto amount
  currency VARCHAR(20),          -- BTC, ETH, USDT, etc.
  wallet_address VARCHAR(255),
  tx_hash VARCHAR(255),          -- blockchain transaction hash
  status VARCHAR(20) DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'failed', 'refunded')),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  confirmed_at TIMESTAMP
);

CREATE INDEX idx_usage_user_date ON user_daily_usage(user_id, usage_date);
CREATE INDEX idx_payment_user ON payment_transactions(user_id);
```

**1.2 Backend: Quota Enforcement Middleware**

New file: `backend/middleware/quota_middleware.py`
- Intercept chat message endpoints
- Extract user_id from JWT
- Check user_role and daily usage
- For legacy users: skip quota check (unlimited)
- For modern users: enforce tier limits
- Return 429 with quota info when exceeded

**1.3 Backend: User Tier Service**

New file: `backend/services/user_tier_service.py`
- `get_user_quota(user_id)` → returns tier limits
- `check_quota(user_id)` → returns (allowed, remaining, resets_at)
- `increment_usage(user_id)` → tracks daily usage
- `upgrade_tier(user_id, tier, payment_tx)` → upgrade user
- `check_subscription_expiry()` → cron-like check, downgrade expired subs

### Phase 2: LLM & Feature Gating (Backend Logic)

**2.1 LLM Mode Enforcement**
- Modify `llm_service.py`: Before processing, check user tier
- Modern free/pro/max users → force `online` mode only
- Legacy users & modern admin → allow `online` + `offline`
- Return clear error if user tries offline without permission

**2.2 Project Creation Differentiation**
- Modern pro/max users: Create projects with `name` only (no TPMS lookup)
- Legacy users: Keep existing TPMS-based project creation flow
- New endpoint or flag: `POST /api/v2/project/create` with `type: "standalone" | "tpms"`
- Standalone projects: No TPMS sync, no background data fetch
- TPMS projects: Existing flow with permission check

**2.3 Tool Access Gating**
- Modify tool availability endpoint
- `max` tier + legacy users: Full tool access
- `pro` tier: Basic tools only
- `free` tier: No tools
- Prepare plugin system for ETAP/DIgSILENT tools (future)

### Phase 3: Frontend - Tier-Aware UI

**3.1 User State Enhancement**
- Add `user_role`, `subscription_expires_at`, `daily_quota` to user context
- New hook: `useQuota()` → tracks remaining questions, shows warnings

**3.2 UI Changes**
- **Quota display**: Show "X/20 questions remaining" in header/sidebar
- **Upgrade prompts**: When quota hit, show upgrade dialog
- **Feature locks**: Disable project creation for free users (with upgrade CTA)
- **LLM mode**: Hide offline toggle for modern users (except admin)
- **TPMS elements**: Hide completely for modern users (no project data tab, no TPMS sync)

**3.3 Project Creation for Modern Users**
- Simplified modal: Just project name (no OENUM, no TPMS fields)
- Chats within project share memory (like current behavior)
- No TPMS data sync, no background sync progress

### Phase 4: Admin Panel

**4.1 Backend Admin Routes**
- `GET /admin/users` → list all users (paginated, filterable)
- `PATCH /admin/users/{id}/role` → change user role
- `GET /admin/users/{id}/usage` → usage history
- `GET /admin/stats` → system-wide statistics
- `POST /admin/tier-quotas` → update tier configurations
- Protected by `is_superuser` or `user_role == 'admin'`

**4.2 Frontend Admin Page**
- New route: `/admin`
- User management table (search, filter by tier/type)
- Usage graphs per user
- Tier quota configuration
- System health dashboard

### Phase 5: Crypto Payment Integration

**5.1 Wallet Integration**
- Support for major crypto wallets (MetaMask, etc.)
- Or manual crypto payment with TX verification
- Payment flow:
  1. User selects tier → shown crypto address + amount
  2. User sends payment
  3. Backend verifies TX on blockchain (or admin manually confirms)
  4. Tier activated for 30 days

**5.2 Subscription Management**
- Auto-check expiry daily (cron job or startup check)
- Email/notification before expiry (3 days, 1 day)
- Graceful downgrade to free when expired
- Renewal flow

---

## Implementation Priority & Recommendations

### Recommended Order
1. **Phase 1** (Database + Quotas) - Foundation, ~2-3 sessions
2. **Phase 2** (LLM + Feature Gating) - Core logic, ~2 sessions
3. **Phase 3** (Frontend UI) - User-facing, ~2-3 sessions
4. **Phase 4** (Admin Panel) - Management, ~2-3 sessions
5. **Phase 5** (Payments) - Revenue, ~3-4 sessions

### Key Architectural Decisions Needed

1. **Modern project creation**: Should it create Neo4j graphs? Or just use Redis/PostgreSQL for simpler memory sharing?

2. **Crypto payment**: Which coins to support? Manual verification vs automated (requires blockchain node or API like Alchemy/Infura)?

3. **Admin scope**: Should admin be able to manually add quota/days to users? Or only through the tier system?

4. **Legacy user admin**: Can organize members also be admins? Or is admin a modern-only concept?

5. **Tool system**: ETAP/DIgSILENT integration - is this planned as API calls, file upload+analysis, or embedded tools?

6. **Offline LLM**: Should `max` modern users get offline access too? Currently planned as legacy-only + admin.
