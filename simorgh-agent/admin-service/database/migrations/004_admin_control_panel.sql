-- =============================================================================
-- Admin control-panel schema
-- Version: 004
-- =============================================================================
-- Adds the runtime-editable config surface that admin-service exposes:
--   * system_settings      — every .env-style key, optionally encrypted
--   * feature_flags        — global toggles + minimum role per feature
--   * user_feature_overrides — per-user grants/denies
--   * password_reset_tokens — admin-issued one-time reset links
--   * admin_audit_log      — every PATCH/POST goes here, who + before/after
--
-- Design notes:
--   * `system_settings.is_secret` — when true, `value` is encrypted with the
--     MASTER_ENCRYPTION_KEY; the API returns the value masked unless the
--     admin explicitly asks for plaintext via ?reveal=1.
--   * `system_settings.requires_restart` — UI shows a red badge so admins
--     know which keys won't take effect until containers reboot. Live
--     settings clients should ignore this column; it's purely advisory.
--   * `system_settings.scope` — empty string means "global", otherwise the
--     setting only applies to a specific service (e.g. "llm-gateway"). A
--     service's live-settings client filters on (scope = '' OR scope = its name).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- system_settings
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS system_settings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    key VARCHAR(255) NOT NULL,
    scope VARCHAR(64) NOT NULL DEFAULT '',
    value TEXT,                   -- plaintext or Fernet-encrypted (see is_secret)
    value_type VARCHAR(16) NOT NULL DEFAULT 'string', -- string|int|float|bool|json
    category VARCHAR(64) NOT NULL DEFAULT 'general',
    description TEXT,
    is_secret BOOLEAN NOT NULL DEFAULT FALSE,
    requires_restart BOOLEAN NOT NULL DEFAULT FALSE,
    is_readonly BOOLEAN NOT NULL DEFAULT FALSE, -- e.g. shown in UI but not editable
    updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(key, scope)
);

CREATE INDEX IF NOT EXISTS idx_system_settings_scope ON system_settings(scope);
CREATE INDEX IF NOT EXISTS idx_system_settings_category ON system_settings(category);

-- -----------------------------------------------------------------------------
-- feature_flags — global on/off + minimum role per feature
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS feature_flags (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(128) UNIQUE NOT NULL,        -- e.g. "general_chat", "voice", "siemens_api"
    description TEXT,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    min_role VARCHAR(32) NOT NULL DEFAULT 'free',  -- free|pro|max|admin
    category VARCHAR(64) NOT NULL DEFAULT 'general',
    updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_feature_flags_category ON feature_flags(category);

-- -----------------------------------------------------------------------------
-- user_feature_overrides — per-user grants/denies that beat the global flag
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_feature_overrides (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    feature_name VARCHAR(128) NOT NULL,
    -- TRUE = force on (whitelist), FALSE = force off (blacklist), regardless of global
    enabled BOOLEAN NOT NULL,
    note TEXT,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, feature_name)
);

CREATE INDEX IF NOT EXISTS idx_user_feature_overrides_user ON user_feature_overrides(user_id);

-- -----------------------------------------------------------------------------
-- password_reset_tokens — admin-initiated forced reset
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(255) NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    used_at TIMESTAMP WITH TIME ZONE,
    issued_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user ON password_reset_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_expires ON password_reset_tokens(expires_at);

-- -----------------------------------------------------------------------------
-- admin_audit_log — every admin write goes here
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_audit_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
    actor_email VARCHAR(255),       -- denormalised for "user deleted" cases
    action VARCHAR(64) NOT NULL,    -- e.g. "user.role_change", "setting.update"
    target_type VARCHAR(64),        -- e.g. "user", "setting", "feature_flag"
    target_id VARCHAR(128),         -- string for portability
    before_state JSONB,
    after_state JSONB,
    metadata JSONB,
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_log_actor ON admin_audit_log(actor_id);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_action ON admin_audit_log(action);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_target ON admin_audit_log(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_created ON admin_audit_log(created_at DESC);

-- -----------------------------------------------------------------------------
-- Seed feature flags — every gateable surface in the simorgh stack
-- -----------------------------------------------------------------------------
INSERT INTO feature_flags (name, description, enabled, min_role, category) VALUES
    ('general_chat',      'Generic Q&A chat (no project context)',                       TRUE,  'free', 'chat'),
    ('project_chat',      'Project-scoped chat with workspace + tools',                  TRUE,  'pro',  'chat'),
    ('voice_chat',        'Voice (STT/TTS) input & output',                              TRUE,  'pro',  'chat'),
    ('document_upload',   'User-driven file upload to project workspace',                TRUE,  'pro',  'project'),
    ('email_polling',     'Inbound email session pickup via simorghai@…',                TRUE,  'pro',  'project'),
    ('graph_rag',         'Graph-RAG service for entity-aware retrieval',                TRUE,  'pro',  'rag'),
    ('vector_rag',        'Qdrant vector RAG over project + tech docs',                  TRUE,  'free', 'rag'),
    ('hr_kb',             'HR knowledge-base lookups',                                   TRUE,  'free', 'knowledge'),
    ('org_data',          'Organisation directory lookups',                              TRUE,  'free', 'knowledge'),
    ('tech_kb',           'Technical knowledge-base lookups',                            TRUE,  'free', 'knowledge'),
    ('eplan_sql',         'EPLAN n²/SQL queries from chat',                              TRUE,  'pro',  'integrations'),
    ('techserver',        'Techserver SMB browse / fetch',                               TRUE,  'pro',  'integrations'),
    ('siemens_api',       'Siemens product info hub tool',                               FALSE, 'pro',  'integrations'),
    ('web_search_tool',   'External DuckDuckGo / web search tool',                       FALSE, 'pro',  'tools'),
    ('python_repl',       'Python REPL tool (sandboxed)',                                FALSE, 'admin','tools'),
    ('payments',          'Stripe / payment flows',                                      TRUE,  'free', 'billing'),
    ('admin_panel',       'This control panel itself',                                   TRUE,  'admin','platform'),
    ('online_llm',        'OpenAI / online LLM mode availability',                       TRUE,  'free', 'llm'),
    ('offline_llm',       'Local LLM (.61) availability',                                TRUE,  'free', 'llm'),
    ('offline_vlm',       'Local VLM (.62) availability',                                TRUE,  'free', 'llm')
ON CONFLICT (name) DO NOTHING;

-- -----------------------------------------------------------------------------
-- Seed system_settings — every .env-style key the stack consumes
--   value=NULL means "use the env default at the consumer".
--   value=''   means "explicitly empty — override env even if env is set".
-- -----------------------------------------------------------------------------
INSERT INTO system_settings (key, scope, value, value_type, category, description, is_secret, requires_restart, is_readonly) VALUES
    -- LLM gateway / AI APIs
    ('DEFAULT_LLM_MODE',      'llm-gateway', 'auto',                      'string', 'ai',     'online | offline | auto. Picked when a request omits `mode`.',        FALSE, FALSE, FALSE),
    ('OPENAI_API_KEY',        'llm-gateway', NULL,                        'string', 'ai',     'OpenAI API key for online mode.',                                    TRUE,  FALSE, FALSE),
    ('OPENAI_BASE_URL',       'llm-gateway', 'https://api.openai.com/v1', 'string', 'ai',     'OpenAI-compatible base URL (override for proxies).',                 FALSE, FALSE, FALSE),
    ('OPENAI_MODEL',          'llm-gateway', 'gpt-4o',                    'string', 'ai',     'Default chat model in online mode.',                                 FALSE, FALSE, FALSE),
    ('OPENAI_EMBED_MODEL',    'llm-gateway', 'text-embedding-3-large',    'string', 'ai',     'Default embedding model in online mode.',                            FALSE, FALSE, FALSE),
    ('LOCAL_LLM_URL_TEXT',    'llm-gateway', 'http://192.168.1.61/v1',    'string', 'ai',     'Text LLM (.61) base URL.',                                           FALSE, FALSE, FALSE),
    ('LOCAL_LLM_MODEL_TEXT',  'llm-gateway', 'gpt-oss-20b',               'string', 'ai',     'Text LLM served-model-name on .61.',                                 FALSE, FALSE, FALSE),
    ('LOCAL_LLM_URL_VLM',     'llm-gateway', 'http://192.168.1.62/v1',    'string', 'ai',     'VLM (.62) base URL.',                                                FALSE, FALSE, FALSE),
    ('LOCAL_LLM_MODEL_VLM',   'llm-gateway', 'qwen2.5-vl-7b',             'string', 'ai',     'VLM served-model-name on .62.',                                      FALSE, FALSE, FALSE),
    ('LOCAL_LLM_API_KEY',     'llm-gateway', NULL,                        'string', 'ai',     'Bearer token mirrored from vllm --api-key (if set on the GPU box).', TRUE,  FALSE, FALSE),
    ('LLM_GATEWAY_TIMEOUT_SEC','llm-gateway','1800',                      'int',    'ai',     'Hard upstream timeout (s). Generation can run minutes for 20B.',     FALSE, FALSE, FALSE),

    -- Auth / JWT
    ('JWT_SECRET_KEY',        '',            NULL,                        'string', 'auth',   'JWT signing key (rotate carefully — invalidates all sessions).',     TRUE,  TRUE,  FALSE),
    ('JWT_ACCESS_TTL_MIN',    '',            '60',                        'int',    'auth',   'Access-token lifetime (min).',                                       FALSE, FALSE, FALSE),
    ('JWT_REFRESH_TTL_DAY',   '',            '30',                        'int',    'auth',   'Refresh-token lifetime (days).',                                     FALSE, FALSE, FALSE),
    ('COOKIE_DOMAIN',         '',            NULL,                        'string', 'auth',   'Cookie domain for browser sessions.',                                FALSE, TRUE,  FALSE),
    ('OAUTH_GOOGLE_CLIENT_ID','auth-service',NULL,                        'string', 'auth',   'Google OAuth client ID.',                                            FALSE, TRUE,  FALSE),
    ('OAUTH_GOOGLE_SECRET',   'auth-service',NULL,                        'string', 'auth',   'Google OAuth client secret.',                                        TRUE,  TRUE,  FALSE),
    ('OAUTH_GITHUB_CLIENT_ID','auth-service',NULL,                        'string', 'auth',   'GitHub OAuth client ID.',                                            FALSE, TRUE,  FALSE),
    ('OAUTH_GITHUB_SECRET',   'auth-service',NULL,                        'string', 'auth',   'GitHub OAuth client secret.',                                        TRUE,  TRUE,  FALSE),

    -- Email gateway
    ('SIMORGHAI_IMAP_HOST',   'project-mail-service','imap.gmail.com',    'string', 'email',  'Inbound IMAP host for simorghai@electrokavir.com.',                  FALSE, TRUE,  FALSE),
    ('SIMORGHAI_IMAP_PORT',   'project-mail-service','993',               'int',    'email',  'Inbound IMAP port.',                                                 FALSE, TRUE,  FALSE),
    ('SIMORGHAI_IMAP_USER',   'project-mail-service',NULL,                'string', 'email',  'IMAP username.',                                                     FALSE, TRUE,  FALSE),
    ('SIMORGHAI_IMAP_PASS',   'project-mail-service',NULL,                'string', 'email',  'IMAP app-password.',                                                 TRUE,  TRUE,  FALSE),
    ('SIMORGHAI_SMTP_HOST',   'project-mail-service','smtp.gmail.com',    'string', 'email',  'Outbound SMTP host.',                                                FALSE, TRUE,  FALSE),
    ('SIMORGHAI_SMTP_PORT',   'project-mail-service','465',               'int',    'email',  'Outbound SMTP port.',                                                FALSE, TRUE,  FALSE),
    ('IMAP_POLL_INTERVAL_SEC','project-mail-service','30',                'int',    'email',  'IMAP poll cadence (s).',                                             FALSE, FALSE, FALSE),

    -- Storage / infra (READ-ONLY in UI; restart-required if changed)
    ('POSTGRES_AUTH_HOST',    '',            'postgres_auth',             'string', 'infra',  'Auth Postgres hostname (compose service name).',                     FALSE, TRUE,  TRUE),
    ('POSTGRES_AUTH_PORT',    '',            '5432',                      'int',    'infra',  'Auth Postgres port.',                                                FALSE, TRUE,  TRUE),
    ('POSTGRES_AUTH_DATABASE','',            'simorgh_auth',              'string', 'infra',  'Auth DB name.',                                                      FALSE, TRUE,  TRUE),
    ('POSTGRES_AUTH_USER',    '',            'simorgh',                   'string', 'infra',  'Auth DB user.',                                                      FALSE, TRUE,  TRUE),
    ('POSTGRES_AUTH_PASSWORD','',            NULL,                        'string', 'infra',  'Auth DB password.',                                                  TRUE,  TRUE,  TRUE),
    ('REDIS_URL',             '',            'redis://redis:6379/0',      'string', 'infra',  'Redis URL for caches + sessions.',                                   FALSE, TRUE,  TRUE),
    ('QDRANT_URL',            '',            'http://qdrant:6333',        'string', 'infra',  'Qdrant vector store.',                                               FALSE, TRUE,  TRUE),
    ('NEO4J_URI',             '',            'bolt://neo4j:7687',         'string', 'infra',  'Neo4j graph store.',                                                 FALSE, TRUE,  TRUE),
    ('NEO4J_USER',            '',            'neo4j',                     'string', 'infra',  'Neo4j username.',                                                    FALSE, TRUE,  TRUE),
    ('NEO4J_PASSWORD',        '',            NULL,                        'string', 'infra',  'Neo4j password.',                                                    TRUE,  TRUE,  TRUE),
    ('MONGO_URL',             '',            'mongodb://mongo:27017',     'string', 'infra',  'Mongo URL.',                                                         FALSE, TRUE,  TRUE),

    -- External gateways (host:port for downstream services)
    ('TPMS_MYSQL_HOST',       'eplan-sql-service','192.168.1.148',        'string', 'integrations','TPMS MySQL host.',                                              FALSE, TRUE,  FALSE),
    ('TPMS_MYSQL_USER',       'eplan-sql-service',NULL,                   'string', 'integrations','TPMS MySQL user.',                                              FALSE, TRUE,  FALSE),
    ('TPMS_MYSQL_PASSWORD',   'eplan-sql-service',NULL,                   'string', 'integrations','TPMS MySQL password.',                                          TRUE,  TRUE,  FALSE),
    ('EPLAN_MSSQL_HOST',      'eplan-sql-service','192.168.1.39',         'string', 'integrations','EPLAN n² MSSQL host.',                                          FALSE, TRUE,  FALSE),
    ('EPLAN_MSSQL_USER',      'eplan-sql-service',NULL,                   'string', 'integrations','EPLAN MSSQL user.',                                             FALSE, TRUE,  FALSE),
    ('EPLAN_MSSQL_PASSWORD',  'eplan-sql-service',NULL,                   'string', 'integrations','EPLAN MSSQL password.',                                         TRUE,  TRUE,  FALSE),
    ('TECHSERVER_SMB_HOST',   'techserver-service','192.168.1.3',         'string', 'integrations','Techserver SMB host.',                                          FALSE, TRUE,  FALSE),
    ('TECHSERVER_SMB_USER',   'techserver-service',NULL,                  'string', 'integrations','Techserver SMB user.',                                          FALSE, TRUE,  FALSE),
    ('TECHSERVER_SMB_PASSWORD','techserver-service',NULL,                 'string', 'integrations','Techserver SMB password.',                                      TRUE,  TRUE,  FALSE),
    ('SIEMENS_API_KEY',       '',            NULL,                        'string', 'integrations','Siemens product info hub key.',                                 TRUE,  FALSE, FALSE),

    -- Payments
    ('STRIPE_PUBLIC_KEY',     'payments-service',NULL,                    'string', 'billing','Stripe publishable key.',                                            FALSE, TRUE,  FALSE),
    ('STRIPE_SECRET_KEY',     'payments-service',NULL,                    'string', 'billing','Stripe secret key.',                                                 TRUE,  TRUE,  FALSE),
    ('STRIPE_WEBHOOK_SECRET', 'payments-service',NULL,                    'string', 'billing','Stripe webhook signing secret.',                                     TRUE,  TRUE,  FALSE),

    -- Logging / behaviour
    ('LOG_LEVEL',             '',            'INFO',                      'string', 'platform','DEBUG | INFO | WARNING | ERROR.',                                   FALSE, FALSE, FALSE),
    ('CORS_ALLOW_ORIGINS',    '',            '*',                         'string', 'platform','Comma-separated origin list.',                                      FALSE, TRUE,  FALSE)
ON CONFLICT (key, scope) DO NOTHING;

-- =============================================================================
-- DOWN (manual; commented out for safety):
--   DROP TABLE IF EXISTS admin_audit_log;
--   DROP TABLE IF EXISTS password_reset_tokens;
--   DROP TABLE IF EXISTS user_feature_overrides;
--   DROP TABLE IF EXISTS feature_flags;
--   DROP TABLE IF EXISTS system_settings;
-- =============================================================================
