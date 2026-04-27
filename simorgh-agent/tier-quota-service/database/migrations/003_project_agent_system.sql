-- Migration 003: Project Agent System
-- Adds project management, COT tasks, instructions, and email gateway tables.
-- Modern users create projects by name (no TPMS dependency).
-- Legacy users can optionally link TPMS OENUM.

-- =============================================================================
-- PROJECTS TABLE (unified for modern + legacy users)
-- =============================================================================
CREATE TABLE IF NOT EXISTS projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id TEXT NOT NULL,  -- UUID for modern users, EMPUSERNAME for legacy
    name VARCHAR(255) NOT NULL,
    description TEXT,
    -- Optional TPMS link (legacy users only)
    tpms_oenum VARCHAR(50),
    -- Project status
    status VARCHAR(20) DEFAULT 'active'
        CHECK (status IN ('active', 'paused', 'completed', 'archived')),
    -- Agent configuration
    agent_enabled BOOLEAN DEFAULT TRUE,
    agent_model VARCHAR(50) DEFAULT 'gpt-4o',
    -- Git workspace
    git_repo_initialized BOOLEAN DEFAULT FALSE,
    git_repo_path VARCHAR(500),
    -- Metadata
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_id);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_owner_name ON projects(owner_id, name);
CREATE INDEX IF NOT EXISTS idx_projects_tpms ON projects(tpms_oenum) WHERE tpms_oenum IS NOT NULL;

-- =============================================================================
-- PROJECT INSTRUCTIONS (step-by-step workflow per project)
-- =============================================================================
CREATE TABLE IF NOT EXISTS project_instructions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    step_number INT NOT NULL,
    title VARCHAR(255) NOT NULL,
    content TEXT NOT NULL,
    -- Dependencies: list of instruction IDs that must complete first
    dependencies UUID[] DEFAULT '{}',
    -- What tools this step can use
    allowed_tools TEXT[] DEFAULT '{}',
    -- Stage mapping
    stage VARCHAR(30) DEFAULT 'general'
        CHECK (stage IN ('general', 'analysis', 'design', 'implementation', 'review', 'deployment')),
    -- Approval gate
    requires_approval BOOLEAN DEFAULT FALSE,
    -- Status
    is_active BOOLEAN DEFAULT TRUE,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(project_id, step_number)
);

CREATE INDEX IF NOT EXISTS idx_instructions_project ON project_instructions(project_id);

-- =============================================================================
-- PROJECT TASKS (COT-generated TODO items)
-- =============================================================================
CREATE TABLE IF NOT EXISTS project_tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    -- Link to instruction that spawned this task
    instruction_id UUID REFERENCES project_instructions(id) ON DELETE SET NULL,
    -- Parent task (for subtasks)
    parent_task_id UUID REFERENCES project_tasks(id) ON DELETE CASCADE,
    -- COT chain reference
    cot_chain_id UUID,  -- Groups tasks from same COT analysis
    -- Task details
    title VARCHAR(500) NOT NULL,
    description TEXT,
    task_type VARCHAR(30) DEFAULT 'action'
        CHECK (task_type IN ('action', 'query', 'analysis', 'generation', 'review', 'shell_command', 'email')),
    -- Execution
    status VARCHAR(20) DEFAULT 'pending'
        CHECK (status IN ('pending', 'in_progress', 'completed', 'failed', 'cancelled', 'waiting_approval')),
    priority INT DEFAULT 5 CHECK (priority BETWEEN 1 AND 10),
    -- Tool used and result
    tool_used VARCHAR(50),  -- 'llm', 'shell', 'memory_query', 'document_process', 'email', etc.
    tool_input JSONB,
    result TEXT,
    result_metadata JSONB DEFAULT '{}',
    error_message TEXT,
    -- Ordering
    sort_order INT DEFAULT 0,
    -- Timing
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    -- Who/what triggered this task
    triggered_by VARCHAR(50) DEFAULT 'user'
        CHECK (triggered_by IN ('user', 'agent', 'email', 'document', 'schedule', 'webhook'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_project ON project_tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON project_tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_cot_chain ON project_tasks(cot_chain_id);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON project_tasks(parent_task_id);
CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON project_tasks(project_id, status);

-- =============================================================================
-- PROJECT MESSAGES (all input/output channels)
-- =============================================================================
CREATE TABLE IF NOT EXISTS project_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    chat_id VARCHAR(100),
    -- Channel
    channel VARCHAR(20) NOT NULL DEFAULT 'chat'
        CHECK (channel IN ('chat', 'email', 'document', 'webhook', 'system')),
    -- Message
    role VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
    content TEXT NOT NULL,
    -- References
    task_id UUID REFERENCES project_tasks(id) ON DELETE SET NULL,
    -- Email-specific fields
    email_from VARCHAR(255),
    email_subject VARCHAR(500),
    email_message_id VARCHAR(255),
    -- Document-specific fields
    document_id UUID,
    document_filename VARCHAR(500),
    -- Metadata
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_messages_project ON project_messages(project_id);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON project_messages(channel);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON project_messages(chat_id);
CREATE INDEX IF NOT EXISTS idx_messages_project_created ON project_messages(project_id, created_at DESC);

-- =============================================================================
-- PROJECT EMAIL ADDRESSES (inbound email-to-project mapping)
-- =============================================================================
CREATE TABLE IF NOT EXISTS project_email_addresses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    email_address VARCHAR(255) NOT NULL UNIQUE,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_project_emails_address ON project_email_addresses(email_address);

-- =============================================================================
-- PROJECT GIT COMMITS (track agent commits)
-- =============================================================================
CREATE TABLE IF NOT EXISTS project_git_commits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    task_id UUID REFERENCES project_tasks(id) ON DELETE SET NULL,
    commit_hash VARCHAR(40) NOT NULL,
    commit_message TEXT NOT NULL,
    files_changed TEXT[],
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_git_commits_project ON project_git_commits(project_id);

-- =============================================================================
-- PROJECT DOCUMENTS (metadata for uploaded/generated docs)
-- =============================================================================
CREATE TABLE IF NOT EXISTS project_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    filename VARCHAR(500) NOT NULL,
    original_filename VARCHAR(500),
    file_type VARCHAR(50),
    file_size BIGINT,
    -- Processing status
    processing_status VARCHAR(20) DEFAULT 'pending'
        CHECK (processing_status IN ('pending', 'processing', 'completed', 'failed')),
    -- Storage
    storage_path VARCHAR(500),
    -- Vector/graph refs
    qdrant_collection VARCHAR(255),
    qdrant_point_ids TEXT[],
    neo4j_node_ids TEXT[],
    -- Content
    content_summary TEXT,
    chunk_count INT DEFAULT 0,
    entity_count INT DEFAULT 0,
    -- Metadata
    metadata JSONB DEFAULT '{}',
    uploaded_by TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_documents_project ON project_documents(project_id);
CREATE INDEX IF NOT EXISTS idx_documents_status ON project_documents(processing_status);

-- =============================================================================
-- HELPER FUNCTION: Update updated_at timestamp
-- =============================================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply updated_at triggers
DO $$
DECLARE
    t TEXT;
BEGIN
    FOR t IN SELECT unnest(ARRAY[
        'projects',
        'project_instructions',
        'project_tasks',
        'project_documents'
    ])
    LOOP
        EXECUTE format(
            'DROP TRIGGER IF EXISTS update_%s_updated_at ON %s; '
            'CREATE TRIGGER update_%s_updated_at BEFORE UPDATE ON %s '
            'FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();',
            t, t, t, t
        );
    END LOOP;
END $$;
