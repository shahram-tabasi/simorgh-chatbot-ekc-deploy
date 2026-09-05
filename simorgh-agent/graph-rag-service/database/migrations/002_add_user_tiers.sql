-- Migration 002: Add user tiers, daily usage tracking, and payment transactions
-- This migration adds tier-based access control for modern (email/Google) users.
-- Legacy (TPMS) users are unaffected - they have unlimited access.

-- Add tier fields to existing users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS user_role VARCHAR(20) DEFAULT 'free';
ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS wallet_address VARCHAR(255);

-- Add CHECK constraint for user_role (only if not already present)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'users_user_role_check'
    ) THEN
        ALTER TABLE users ADD CONSTRAINT users_user_role_check
            CHECK (user_role IN ('free', 'pro', 'max', 'admin'));
    END IF;
END $$;

-- Daily usage tracking
CREATE TABLE IF NOT EXISTS user_daily_usage (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    usage_date DATE NOT NULL DEFAULT CURRENT_DATE,
    questions_used INT DEFAULT 0,
    tokens_used INT DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, usage_date)
);

-- Tier quota configuration (admin-editable)
CREATE TABLE IF NOT EXISTS tier_quotas (
    tier_name VARCHAR(20) PRIMARY KEY,
    max_questions_per_day INT NOT NULL,
    can_create_projects BOOLEAN DEFAULT FALSE,
    can_use_offline_llm BOOLEAN DEFAULT FALSE,
    can_use_tools BOOLEAN DEFAULT FALSE,
    subscription_duration_days INT,  -- NULL = unlimited duration
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Payment/transaction log (for automated crypto verification)
CREATE TABLE IF NOT EXISTS payment_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tier_name VARCHAR(20) NOT NULL,
    amount DECIMAL(18, 8),
    currency VARCHAR(20),
    payment_provider VARCHAR(50),
    provider_payment_id VARCHAR(255),
    wallet_address VARCHAR(255),
    tx_hash VARCHAR(255),
    status VARCHAR(20) DEFAULT 'pending'
        CHECK (status IN ('pending', 'confirming', 'confirmed', 'failed', 'refunded', 'expired')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    confirmed_at TIMESTAMP WITH TIME ZONE,
    expires_at TIMESTAMP WITH TIME ZONE
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_usage_user_date ON user_daily_usage(user_id, usage_date);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(user_role);
CREATE INDEX IF NOT EXISTS idx_users_subscription_expires ON users(subscription_expires_at) WHERE subscription_expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payment_user ON payment_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_payment_status ON payment_transactions(status);
CREATE INDEX IF NOT EXISTS idx_payment_provider_id ON payment_transactions(provider_payment_id);

-- Insert default tier quotas (idempotent via ON CONFLICT)
INSERT INTO tier_quotas (tier_name, max_questions_per_day, can_create_projects, can_use_offline_llm, can_use_tools, subscription_duration_days, description)
VALUES
    ('free',  20,    FALSE, FALSE, FALSE, NULL, 'Free tier - general chat only, 20 questions/day'),
    ('pro',   100,   TRUE,  FALSE, FALSE, 30,   'Pro tier - general + project chat, 100 questions/day'),
    ('max',   500,   TRUE,  FALSE, TRUE,  30,   'Max tier - all features + tools, 500 questions/day'),
    ('admin', 99999, TRUE,  FALSE, TRUE,  NULL, 'Admin - unlimited online access, manage all users')
ON CONFLICT (tier_name) DO NOTHING;
