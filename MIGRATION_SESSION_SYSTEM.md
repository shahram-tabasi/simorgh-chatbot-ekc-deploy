# Session System Migration Guide

## Overview

This document describes the migration from UUID-based chat sessions to a robust, user-isolated session system with Redis persistence and TPMS permission integration.

**Migration Date**: December 2025
**Version**: 2.0.0
**Branch**: `claude/chat-session-redis-01QHAGTYeAA3F8Kmz7hAAGoC`

---

## What Changed

### 1. Session ID Format

**Before**:
- Chat IDs: Random UUID (e.g., `a1b2c3d4-e5f6-7890-abcd-ef1234567890`)
- No semantic meaning
- Not human-readable

**After**:
- **General sessions**: `G-yyyyMM-nnnnnn` (e.g., `G-202512-000123`)
- **Project sessions**: `P-ProjectID-nnnnnn` (e.g., `P-12345-000456`)
- Deterministic, sortable, human-friendly
- Counter-based with monthly reset for general sessions

### 2. Session Creation Flow

#### General Sessions (Non-Project Chats)

**Before**:
1. User clicks "New Chat"
2. Modal asks for chat title
3. User enters title
4. Session created with title

**After**:
1. User clicks "New Chat"
2. Session created **immediately** with temporary title "New conversation"
3. User sends first message
4. Backend auto-generates semantic title from first message using LLM
5. Title updates automatically in UI

**Benefits**:
- Faster session creation (no modal delay)
- Better titles from actual conversation content
- Consistent UX

#### Project Sessions

**Before**:
1. User creates session with project number
2. Limited validation

**After**:
1. User clicks "New Project Chat"
2. Modal asks for **Project ID** and **Page Name**
3. Backend validates:
   - Project exists in `View_Project_Main` table
   - User has permission in `draft_permission` table
4. Auto-fills **Project Name** from database
5. Session created with validated data

**Benefits**:
- Robust permission checking
- No invalid project sessions
- Clear error messages
- Auto-filled project metadata

### 3. Backend Architecture

#### New Services Added

1. **`session_id_service.py`** - Session ID generation with Redis atomic counters
2. **Extended `tpms_auth_service.py`** - Project lookup and permission validation

#### Key Redis Schema Changes

**Counters** (Redis DB 0 - Session DB):
```
session:counter:general:202512          -> 123
session:counter:project:12345           -> 456
```

**Session Metadata** (Redis DB 1 - Chat DB):
```json
{
  "chat_id": "G-202512-000123",
  "chat_name": "Troubleshooting Motor Issues",
  "user_id": "john.doe",
  "chat_type": "general",
  "project_number": null,
  "project_name": null,
  "page_name": null,
  "created_at": "2025-12-03T10:30:00",
  "message_count": 5,
  "status": "active"
}
```

For project sessions:
```json
{
  "chat_id": "P-12345-000001",
  "chat_name": "Panel Configuration",
  "user_id": "jane.smith",
  "chat_type": "project",
  "project_number": "12345",
  "project_name": "Industrial Plant XYZ",
  "page_name": "Panel Configuration",
  "created_at": "2025-12-03T11:00:00",
  "message_count": 3,
  "status": "active"
}
```

#### API Changes

**Endpoint**: `POST /api/chats`

**Request Body Changes**:
```json
{
  "chat_name": "Title",
  "user_id": "user123",
  "chat_type": "general|project",
  "project_number": "12345",       // NEW: Required for project sessions
  "page_name": "Panel Analysis"    // NEW: Required for project sessions
}
```

**Response Changes**:
```json
{
  "status": "success",
  "chat": {
    "chat_id": "P-12345-000001",   // NEW FORMAT
    "project_name": "Industrial Plant XYZ",  // NEW: Auto-filled
    // ... other fields
  },
  "message": "Project session created for Industrial Plant XYZ"
}
```

### 4. TPMS Database Integration

**New Tables Queried**:

1. **`View_Project_Main`** - Project lookup
   ```sql
   SELECT IDProjectMain, Project_Name
   FROM View_Project_Main
   WHERE IDProjectMain = %s
   ```

2. **`draft_permission`** - Permission checking
   ```sql
   SELECT 1
   FROM draft_permission
   WHERE project_ID = %s AND user = %s
   ```

**Error Handling**:
- `404`: Project not found in `View_Project_Main`
- `403`: User lacks permission in `draft_permission`
- `500`: Database error

### 5. Frontend Changes

**Files Modified**:
- `frontend/src/App.tsx`
- `frontend/src/hooks/useProjects.ts`
- `frontend/src/components/CreateProjectChatModal.tsx` (NEW)

**UX Changes**:
- ✅ General chats: No modal, immediate creation
- ✅ Project chats: New modal with Project ID validation
- ✅ Auto-title generation from first message
- ✅ Real-time permission checking

---

## Migration Steps

### Prerequisites

1. **Docker & Docker Compose**: Ensure running
2. **Redis**: Service must be healthy
3. **TPMS MySQL Database**: Accessible with read permissions
4. **Environment Variables**: Configured (see below)

### Step 1: Update Environment Variables

Add to `.env` or `docker-compose.yml`:

```bash
# TPMS MySQL (if not already configured)
MYSQL_HOST=192.168.1.148
MYSQL_PORT=3306
MYSQL_USER=your_user
MYSQL_PASSWORD=your_password
MYSQL_DATABASE=TPMS

# Redis (verify existing config)
REDIS_URL=redis://redis:6379/0
REDIS_CHAT_DB=1
REDIS_CACHE_DB=2

# JWT (verify existing config)
JWT_SECRET_KEY=your-secret-key-change-in-production
```

### Step 2: Pull Latest Code

```bash
git fetch origin
git checkout claude/chat-session-redis-01QHAGTYeAA3F8Kmz7hAAGoC
git pull origin claude/chat-session-redis-01QHAGTYeAA3F8Kmz7hAAGoC
```

### Step 3: Run Tests

```bash
cd simorgh-agent/backend
pytest tests/test_session_id_service.py -v
```

**Expected Output**:
```
tests/test_session_id_service.py::TestSessionIDService::test_generate_general_session_id_format PASSED
tests/test_session_id_service.py::TestSessionIDService::test_generate_project_session_id_format PASSED
... [all tests pass]
```

### Step 4: Start Services

```bash
cd simorgh-agent
docker-compose up -d --build
```

**Verify Services**:
```bash
docker-compose ps
docker-compose logs backend | grep "Session ID service initialized"
```

### Step 5: Verify Health

```bash
curl http://localhost/api/health | jq .
```

**Expected Response**:
```json
{
  "status": "healthy",
  "services": {
    "neo4j": {"status": "healthy"},
    "redis": {"status": "healthy"},
    "sql_auth": {"status": "healthy"},
    "llm": {"status": "healthy"}
  }
}
```

### Step 6: Test Session Creation

#### Test General Session

```bash
TOKEN="your-jwt-token"
curl -X POST http://localhost/api/chats \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "chat_name": "Test General",
    "user_id": "john.doe",
    "chat_type": "general"
  }'
```

**Expected Response**:
```json
{
  "status": "success",
  "chat": {
    "chat_id": "G-202512-000001",
    "chat_name": "New conversation",
    // ...
  }
}
```

#### Test Project Session

```bash
curl -X POST http://localhost/api/chats \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "chat_name": "Panel Analysis",
    "user_id": "jane.smith",
    "chat_type": "project",
    "project_number": "12345",
    "page_name": "Panel Analysis"
  }'
```

**Expected Responses**:

✅ **Success** (user has permission):
```json
{
  "status": "success",
  "chat": {
    "chat_id": "P-12345-000001",
    "project_name": "Industrial Plant XYZ",
    // ...
  }
}
```

❌ **Project Not Found** (404):
```json
{
  "detail": "Project ID 99999 not found in database"
}
```

❌ **Access Denied** (403):
```json
{
  "detail": "Access denied for project 12345"
}
```

---

## Backward Compatibility

### Existing Sessions

**UUID-based sessions remain functional**:
- Old session IDs (UUIDs) continue to work
- Session history loads correctly
- No data migration required

**Mixed Environment**:
- New sessions use new format
- Old sessions use UUID
- Both coexist seamlessly

### API Compatibility

**Breaking Changes**: None for existing clients

**Optional Fields**:
- `page_name` is **optional** for general sessions
- `page_name` is **required** for project sessions
- Old requests without `page_name` will fail for project sessions

---

## Rollback Plan

If issues arise, rollback to previous version:

```bash
# 1. Stop services
docker-compose down

# 2. Checkout previous branch
git checkout <previous-branch>

# 3. Rebuild and restart
docker-compose up -d --build

# 4. Verify health
curl http://localhost/api/health
```

**Data Impact**:
- Redis counters are forward-compatible
- New session IDs will not be recognized by old code
- Old session IDs continue to work

---

## Monitoring & Troubleshooting

### Check Redis Counters

```bash
docker exec -it redis redis-cli

# Check general counter
GET session:counter:general:202512

# Check project counter
GET session:counter:project:12345

# List all counter keys
KEYS session:counter:*
```

### Check Session Metadata

```bash
docker exec -it redis redis-cli

# Switch to chat DB
SELECT 1

# Get session metadata
GET chat:G-202512-000123:metadata
```

### Backend Logs

```bash
# Watch session creation logs
docker-compose logs -f backend | grep "session created"

# Check TPMS connection
docker-compose logs backend | grep "TPMS"
```

### Common Issues

#### 1. **TPMS Connection Fails**

**Symptoms**:
- `403` errors for all project sessions
- Logs show "TPMS MySQL connection error"

**Solution**:
```bash
# Check TPMS credentials
docker-compose exec backend env | grep MYSQL

# Test MySQL connection
docker-compose exec backend python -c "
from services.tpms_auth_service import get_tpms_auth_service
svc = get_tpms_auth_service()
print(svc.health_check())
"
```

#### 2. **Redis Counter Not Incrementing**

**Symptoms**:
- Duplicate session IDs
- Sessions overwrite each other

**Solution**:
```bash
# Check Redis health
docker exec redis redis-cli PING

# Check Redis persistence
docker exec redis redis-cli CONFIG GET appendonly

# If broken, recreate counters
docker exec redis redis-cli DEL "session:counter:general:202512"
```

#### 3. **Auto-Title Generation Fails**

**Symptoms**:
- General chats keep "New conversation" title
- Logs show LLM errors

**Solution**:
```bash
# Check LLM diagnostics
curl http://localhost/api/llm/diagnostics | jq .

# Verify OpenAI API key
docker-compose exec backend env | grep OPENAI_API_KEY

# Test title generation manually
curl -X POST http://localhost/api/chats/G-202512-000123/generate-title \
  -H "Authorization: Bearer $TOKEN" \
  -F "first_message=How do I configure panel X?"
```

---

## Performance Considerations

### Redis Memory Usage

**Counters**: Negligible (~100 bytes each)
- Monthly general counters: ~12 per year
- Project counters: 1 per project

**Sessions**: ~1-5 KB per session
- Depends on title length and metadata
- Recommend setting TTL or archiving old sessions

### Query Performance

**TPMS Queries**:
- Project lookup: ~10-50ms (indexed on `IDProjectMain`)
- Permission check: ~10-30ms (indexed on `project_ID, user`)
- **Cached in Redis** (1 hour TTL) for repeated checks

**Redis Operations**:
- Counter increment: <1ms (atomic)
- Session metadata read: <1ms

---

## Security Considerations

1. **User Isolation**:
   - All endpoints verify JWT token
   - Sessions linked to `user_id`
   - Cross-user access blocked

2. **Permission Checking**:
   - Every project session creation checks TPMS
   - Cached results expire after 1 hour
   - Failed permission checks return `403`

3. **SQL Injection Prevention**:
   - All queries use parameterized statements
   - TPMS connection is read-only

4. **Redis Security**:
   - No external access (internal Docker network)
   - Persistence enabled (AOF + RDB)
   - Counters cannot overflow (64-bit integers)

---

## Future Enhancements

1. **Session Archival**:
   - Move old sessions (>30 days) to PostgreSQL
   - Keep Redis lean

2. **Advanced Title Generation**:
   - Multi-message context analysis
   - User preference learning

3. **Collaboration**:
   - Add `allowed_users` field
   - Share sessions between team members

4. **Analytics**:
   - Track session usage per user
   - Monitor counter growth rates

---

## Support & Contacts

**Issues**: https://github.com/shahram-tabasi/simorgh-chatbot-ekc-deploy/issues
**Documentation**: See `ARCHITECTURE_REDESIGN.md` for full system architecture
**Author**: Simorgh Industrial Assistant Team

---

## Appendix: Session ID Format Specification

### General Sessions

**Format**: `G-yyyyMM-nnnnnn`

| Part | Description | Example |
|------|-------------|---------|
| `G` | Category prefix (General) | `G` |
| `yyyyMM` | Year-month (UTC) | `202512` |
| `nnnnnn` | 6-digit zero-padded counter | `000123` |

**Counter Behavior**:
- Resets monthly (new counter key per month)
- Atomic increment (Redis INCR)
- No collisions

### Project Sessions

**Format**: `P-ProjectID-nnnnnn`

| Part | Description | Example |
|------|-------------|---------|
| `P` | Category prefix (Project) | `P` |
| `ProjectID` | TPMS Project ID | `12345` |
| `nnnnnn` | 6-digit zero-padded counter | `000001` |

**Counter Behavior**:
- Per-project counter (never resets)
- Independent across projects
- Atomic increment

### Message IDs

**Format**: `S-{sessionId}-M-nnn`

**Example**: `S-G-202512-000123-M-001`

---

**End of Migration Guide**
