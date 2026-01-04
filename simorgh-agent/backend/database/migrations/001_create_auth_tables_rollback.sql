-- Rollback: 001_create_auth_tables.sql
-- WARNING: This will delete all authentication data!

-- Drop indexes first
DROP INDEX IF EXISTS idx_users_email;
DROP INDEX IF EXISTS idx_users_is_active;
DROP INDEX IF EXISTS idx_oauth_accounts_user;
DROP INDEX IF EXISTS idx_oauth_accounts_provider;
DROP INDEX IF EXISTS idx_email_verification_user;
DROP INDEX IF EXISTS idx_email_verification_token;
DROP INDEX IF EXISTS idx_password_reset_user;
DROP INDEX IF EXISTS idx_password_reset_token;
DROP INDEX IF EXISTS idx_refresh_tokens_user;
DROP INDEX IF EXISTS idx_refresh_tokens_token;
DROP INDEX IF EXISTS idx_user_sessions_user;
DROP INDEX IF EXISTS idx_user_sessions_token;
DROP INDEX IF EXISTS idx_login_attempts_email;
DROP INDEX IF EXISTS idx_login_attempts_ip;

-- Drop tables in reverse order (respecting foreign keys)
DROP TABLE IF EXISTS user_preferences CASCADE;
DROP TABLE IF EXISTS login_attempts CASCADE;
DROP TABLE IF EXISTS user_sessions CASCADE;
DROP TABLE IF EXISTS refresh_tokens CASCADE;
DROP TABLE IF EXISTS password_reset_tokens CASCADE;
DROP TABLE IF EXISTS email_verification_tokens CASCADE;
DROP TABLE IF EXISTS oauth_accounts CASCADE;
DROP TABLE IF EXISTS users CASCADE;

-- Note: This rollback preserves the schema_migrations table
-- to allow for proper migration tracking
