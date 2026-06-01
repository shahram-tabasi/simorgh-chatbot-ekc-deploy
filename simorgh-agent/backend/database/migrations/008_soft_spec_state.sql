-- =============================================================================
-- 008_soft_spec_state.sql
--
-- Background slot-collector for the Simorgh Design Suite bridge.
-- ---------------------------------------------------------------------------
-- Per-project state for the project-spec that the chatbot continuously
-- accumulates from TPMS / chat / uploads / techserver / SLD / gitlab.
-- Updated by a fire-and-forget collector after every relevant event
-- (chat turn, document upload, source toggle). Read by:
--   - the chat UI's "Design Suite: NN% ready" chip
--   - the ReAct tool read_soft_spec
--   - the submit endpoint that POSTs to simorgh-soft
--
-- sources_signature is a stable hash of the source set & their content
-- markers; the collector short-circuits when it hasn't changed, so the
-- post-hook is cheap to fire after every turn.
-- =============================================================================
CREATE TABLE IF NOT EXISTS soft_spec_state (
    project_id           UUID PRIMARY KEY
                              REFERENCES projects(id) ON DELETE CASCADE,
    spec                 JSONB NOT NULL DEFAULT '{}'::jsonb,
    prov                 JSONB NOT NULL DEFAULT '[]'::jsonb,
    gaps                 JSONB NOT NULL DEFAULT '[]'::jsonb,
    conflicts            JSONB NOT NULL DEFAULT '[]'::jsonb,
    completeness         INTEGER NOT NULL DEFAULT 0,   -- 0..100
    sources_signature    TEXT,
    last_collected_at    TIMESTAMP WITH TIME ZONE,
    last_submitted_at    TIMESTAMP WITH TIME ZONE,
    soft_project_id      VARCHAR(64),                  -- mongo _id once submitted
    updated_at           TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------------
-- Pending ask_user requests emitted by the ReAct loop. The loop creates a
-- row, emits an SSE event {pending_id, questions}; the chat UI renders an
-- inline form; user submits → row's answers column is filled; the agent
-- (the next turn or a resume call) reads the answers and merges them into
-- the spec via the same reconciler pipeline.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS soft_spec_pending_ask (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id   UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    chat_id      VARCHAR(128),
    questions    JSONB NOT NULL,    -- [{field, header, question, options?[]}]
    answers      JSONB,             -- {field: value, ...} when user submits
    answered_at  TIMESTAMP WITH TIME ZONE,
    created_at   TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ssp_ask_project_open
    ON soft_spec_pending_ask (project_id)
    WHERE answered_at IS NULL;
