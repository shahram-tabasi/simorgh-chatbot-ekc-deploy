-- =============================================================================
-- 009_soft_spec_proposals.sql
--
-- Permission-gated writes to the Design Suite spec. Every value an
-- extractor produces lands here as a PROPOSAL, not a fact. The CoT
-- presents proposals to the user for approval; only approved values are
-- written to soft_spec_state (the spec the bridge posts to simorgh-soft).
--
-- Why: background extractors that auto-write the spec violate principle
-- of least authority — an irrelevant uploaded document silently mutates
-- a structured store the user can't see. HITL gate inverts the contract:
-- extractors propose, the CoT reasons, the user approves, only then does
-- the spec change. Each spec field carries provenance pointing back to
-- the proposal + the user's approval, so we can answer "where did this
-- value come from" and "who authorized it" for any project.
-- =============================================================================
CREATE TABLE IF NOT EXISTS soft_spec_proposal (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    source_kind     VARCHAR(32)  NOT NULL,        -- tpms|uploads|chat|techserver|gitlab|user
    source_note     TEXT,                          -- "regex from spec 'X.pdf'"
    doc_id          UUID,                          -- project_documents.id when source=uploads
    field           VARCHAR(128) NOT NULL,         -- e.g. 'projectName', 'techSettings.general'
    value           JSONB        NOT NULL,
    confidence      REAL         NOT NULL DEFAULT 0.5,
    -- Review state: NULL=pending, true=approved (value written to spec),
    -- false=rejected (kept for audit; never written).
    approved        BOOLEAN,
    approved_value  JSONB,                         -- the value finally accepted (may differ if user edited)
    approved_at     TIMESTAMP WITH TIME ZONE,
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ssp_prop_project
    ON soft_spec_proposal (project_id);
CREATE INDEX IF NOT EXISTS idx_ssp_prop_pending
    ON soft_spec_proposal (project_id, field)
    WHERE approved IS NULL;
