# Unified LLM Context Service - Integration Guide

## Overview

The `UnifiedLLMContextService` consolidates all context gathering into a single, clean interface.

### Before (Scattered in main.py ~300 lines):
```python
# Multiple context sources manually assembled
graph_rag = GraphRAGService(neo4j.driver)
cocoindex = get_cocoindex_adapter()
doc_overview = DocumentOverviewService(...)

# Manual TPMS context building
tpms_context = cocoindex.get_project_tpms_context(...)
tpms_parts = []
if tpms_context.get("project_info"):
    # 50+ lines of formatting...

# Manual graph specs
graph_result = graph_rag.search_by_natural_query(...)
# 30+ lines of formatting...

# Manual vector search
vector_results = qdrant.search_section_summaries(...)
# 20+ lines of formatting...

# Manual user memory
similar_conversations = qdrant.retrieve_similar_conversations(...)
# 20+ lines of formatting...

# Manual chat history
recent_messages = redis.get_project_chat_history(...)
# 20+ lines of formatting...

# Combine everything
graph_context = "\n\n".join(context_parts)
```

### After (Using UnifiedLLMContextService):
```python
from services.unified_llm_context_service import get_unified_context_service

# Initialize once (singleton)
context_service = get_unified_context_service(
    redis_service=redis,
    neo4j_driver=neo4j.driver,
    qdrant_service=qdrant
)

# Build context in one call
result = await context_service.build_context(
    user_id=user_id,
    query=message.content,
    chat_id=chat_id,
    project_number=project_number,
    chat_type="project"  # or "general"
)

# Get formatted system prompt with all context
system_prompt = context_service.build_system_prompt(
    context_result=result,
    project_number=project_number
)

# Use in LLM call
llm_messages = [
    {"role": "system", "content": system_prompt},
    {"role": "user", "content": message.content}
]
```

---

## Integration Steps

### Step 1: Initialize Service at Startup

In `main.py`, add to the startup section:

```python
from services.unified_llm_context_service import (
    get_unified_context_service,
    ContextConfig
)

@app.on_event("startup")
async def startup():
    # ... existing startup code ...

    # Initialize unified context service
    context_config = ContextConfig(
        max_total_tokens=8000,
        include_user_profile=True,
        include_tpms_data=True,
        vector_search_limit=5,
        chat_history_limit=10
    )

    get_unified_context_service(
        redis_service=get_redis_service(),
        neo4j_driver=get_neo4j_service().driver,
        qdrant_service=get_qdrant_service(),
        config=context_config
    )
```

### Step 2: Update Login to Cache User Profile

In `routes/auth.py` or `routes/auth_v2.py`, after successful login:

```python
@app.post("/api/auth/login")
async def login(request: LoginRequest, redis: RedisService = Depends(get_redis)):
    # ... existing auth logic ...

    # Cache user profile for LLM context
    redis.cache_user_profile_on_login(
        user_id=str(user.id),
        user_data={
            "email": user.email,
            "first_name": user.first_name,
            "last_name": user.last_name,
            "display_name": user.display_name,
            "role": user.role,
            "language": user.language,
            "ai_mode": user.ai_mode,
            "created_at": user.created_at.isoformat() if user.created_at else None
        }
    )

    return LoginResponse(...)
```

### Step 3: Update Chat Endpoint

Replace the scattered context building in `/api/chat`:

```python
@app.post("/api/chat")
async def send_chat_message(
    message: ChatMessage,
    current_user: str = Depends(get_current_user),
    neo4j: Neo4jService = Depends(get_neo4j),
    redis: RedisService = Depends(get_redis),
    llm: LLMService = Depends(get_llm),
):
    # Get chat metadata
    chat_metadata = redis.get(f"chat:{message.chat_id}:metadata", db="chat")
    project_number = chat_metadata.get("project_number")
    chat_type = "project" if project_number else "general"

    # Update user activity
    redis.update_user_activity(current_user, "chat", {"chat_id": message.chat_id})

    # Build context using unified service
    context_service = get_unified_context_service()

    context_result = await context_service.build_context(
        user_id=current_user,
        query=message.content,
        chat_id=message.chat_id,
        project_number=project_number,
        chat_type=chat_type
    )

    # Build system prompt with context
    system_prompt = context_service.build_system_prompt(
        context_result=context_result,
        project_number=project_number
    )

    # Get recent chat history for conversation continuity
    history = redis.get_chat_history(message.chat_id, limit=5)

    # Build LLM messages
    llm_messages = [{"role": "system", "content": system_prompt}]
    for msg in history:
        llm_messages.append({"role": msg["role"], "content": msg["content"]})
    llm_messages.append({"role": "user", "content": message.content})

    # Generate response
    result = llm.generate(messages=llm_messages, temperature=0.7)

    # Log context stats
    logger.info(
        f"Context: {result.sources_used}, "
        f"~{result.total_tokens_estimated} tokens, "
        f"{result.build_time_ms:.1f}ms"
    )

    return {"response": result["response"], "context_used": bool(context_result.sources_used)}
```

### Step 4: Update Streaming Endpoint Similarly

The streaming endpoint (`/api/chat/stream`) follows the same pattern.

---

## Configuration Options

```python
from services.unified_llm_context_service import ContextConfig

config = ContextConfig(
    # Token limits
    max_total_tokens=8000,
    user_profile_tokens=200,
    tpms_project_tokens=2000,
    graph_specs_tokens=1500,
    vector_sections_tokens=2000,

    # Feature toggles (disable what you don't need)
    include_user_profile=True,
    include_tpms_data=True,
    include_graph_specs=True,
    include_graph_subgraph=True,
    include_vector_search=True,
    include_user_memory=True,
    include_chat_history=True,
    include_document_overview=True,

    # Search parameters
    vector_search_limit=5,
    vector_score_threshold=0.3,
    memory_search_limit=5,
    memory_score_threshold=0.65,
    chat_history_limit=10,
    max_panels_to_show=15,
    max_sections_to_show=3,
    bfs_max_depth=2
)
```

---

## Context Priority Order

The service builds context in this priority order:

1. **User Profile** - Personalization (name, preferences, role)
2. **TPMS Project Data** - Panels, feeders, equipment (highest priority for answers)
3. **Graph Specifications** - Extracted spec values from documents
4. **Graph Subgraph** - Related entities via BFS traversal
5. **Vector Sections** - Semantic search in document content
6. **User Memory** - Past relevant conversations
7. **Chat History** - Recent conversation context
8. **Document Overview** - List of uploaded documents

---

## Result Structure

```python
result = await context_service.build_context(...)

# Formatted context for LLM
result.context_text  # str - Ready to insert in system prompt

# Metadata
result.sources_used  # List[str] - Which sources contributed
result.total_tokens_estimated  # int - Approximate token count
result.build_time_ms  # float - Build time in milliseconds

# Individual source data (for debugging)
result.user_profile  # Dict - User profile data
result.tpms_data  # Dict - TPMS project data
result.graph_specs  # Dict - Graph specifications
result.graph_subgraph  # Dict - BFS traversal result
result.vector_results  # List - Vector search results
result.user_memory  # List - Past conversations
result.chat_history  # List - Recent messages
result.document_overview  # Dict - Document list
```

---

## Benefits

1. **Single Source of Truth** - All context logic in one place
2. **Configurable** - Toggle features, adjust limits
3. **Testable** - Easy to unit test each source
4. **Logged** - Clear logging of what's included
5. **Extensible** - Add new sources easily
6. **Consistent** - Same formatting everywhere
7. **User-Aware** - Includes user profile for personalization
