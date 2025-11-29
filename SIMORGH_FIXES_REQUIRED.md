# Simorgh Industrial Assistant - Required Fixes

## Summary
Completed comprehensive code review and cleanup of the simorgh-agent project. Removed ~7,800 lines of deprecated ArangoDB code. This document outlines remaining issues that need fixes.

---

## ✅ COMPLETED

### 1. Backend Cleanup (DONE)
**Deleted 12 deprecated files + CocoIndex directory:**
- ✅ Removed all ArangoDB-related code (now using Neo4j)
- ✅ Removed old parsers and extractors (replaced by CocoIndex)
- ✅ Removed test files and migration tools
- ✅ Removed duplicate CocoIndex test structure

**Result:** Cleaner codebase, reduced confusion, better maintainability

---

## 🔧 CRITICAL FIXES NEEDED

### 2. Add Streaming Chat Endpoint
**File:** `simorgh-agent/backend/main.py`

**Issue:** LLM service supports streaming but no endpoint uses it

**Fix Required:**
```python
@app.post("/api/chat/stream")
async def send_chat_message_stream(
    message: ChatMessage,
    neo4j: Neo4jService = Depends(get_neo4j),
    redis: RedisService = Depends(get_redis),
    llm: LLMService = Depends(get_llm)
):
    """Stream chat response using Server-Sent Events"""

    async def event_stream():
        try:
            # Get graph context if needed
            context = None
            if message.use_graph_context and message.chat_id:
                chat_meta = await redis.get_chat_metadata(message.chat_id)
                if chat_meta and chat_meta.get("project_number"):
                    # Get relevant context from Neo4j
                    context = neo4j.semantic_search(
                        project_number=chat_meta["project_number"],
                        query=message.content,
                        limit=5
                    )

            # Get chat history
            history = await redis.get_chat_history(message.chat_id, limit=10)

            # Stream response
            async for chunk in llm.generate_stream(
                messages=history + [{"role": "user", "content": message.content}],
                context=context,
                mode=message.llm_mode
            ):
                yield f"data: {json.dumps({'chunk': chunk})}\n\n"

            # Signal completion
            yield f"data: {json.dumps({'done': True})}\n\n"

        except Exception as e:
            logger.error(f"Streaming error: {e}")
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no"
        }
    )
```

### 3. Active CocoIndex Integration
**File:** `simorgh-agent/backend/main.py`

**Issue:** Document processing is passive (just saves files, no integration)

**Fix Required:**
```python
@app.post("/api/projects/{project_number}/documents")
async def upload_and_process_document(
    project_number: str,
    file: UploadFile = File(...),
    llm_mode: Optional[str] = None,
    neo4j: Neo4jService = Depends(get_neo4j),
    llm: LLMService = Depends(get_llm)
):
    """Upload and actively process document through CocoIndex"""

    # Save file
    file_path = Path(UPLOAD_FOLDER) / project_number / file.filename
    file_path.parent.mkdir(parents=True, exist_ok=True)

    with open(file_path, "wb") as f:
        content = await file.read()
        f.write(content)

    # Import and call CocoIndex flow directly
    from cocoindex_flows.industrial_electrical_flow import process_document

    try:
        result = await process_document(
            project_number=project_number,
            file_path=str(file_path),
            llm_service=llm,
            neo4j_service=neo4j,
            llm_mode=llm_mode or "online"
        )

        return {
            "status": "success",
            "filename": file.filename,
            "entities_extracted": result["entity_count"],
            "relationships_created": result["relationship_count"],
            "processing_time": result["duration"]
        }
    except Exception as e:
        logger.error(f"Document processing failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))
```

### 4. Improve Error Messages
**File:** `simorgh-agent/backend/main.py` (line 649-651)

**Issue:** Generic error handling doesn't distinguish failure types

**Fix Required:**
```python
except LLMOfflineError as e:
    raise HTTPException(
        status_code=503,
        detail={
            "error": "offline_unavailable",
            "message": "Local LLM servers are unavailable. Please try online mode or check server status.",
            "servers_tried": ["192.168.1.61", "192.168.1.62"]
        }
    )
except LLMOnlineError as e:
    raise HTTPException(
        status_code=503,
        detail={
            "error": "online_unavailable",
            "message": "OpenAI API is unavailable. Please try offline mode.",
            "api_error": str(e)
        }
    )
except LLMTimeoutError as e:
    raise HTTPException(
        status_code=504,
        detail={
            "error": "timeout",
            "message": "LLM request timed out. The query may be too complex.",
            "mode": message.llm_mode
        }
    )
except Exception as e:
    logger.error(f"Unexpected chat error: {e}")
    raise HTTPException(status_code=500, detail=str(e))
```

---

## ⚠️ MEDIUM PRIORITY FIXES

### 5. Fix SQL Auth Service Naming
**File:** `simorgh-agent/backend/services/sql_auth_service.py`

**Issue:** Uses pymysql but called SQLAuthService (implies SQL Server)

**Options:**
- **Option A:** Rename file to `mysql_auth_service.py` and class to `MySQLAuthService`
- **Option B:** Change to SQL Server driver (`pymssql`) and update connection

**Current (Confusing):**
```python
import pymysql  # MySQL driver
class SQLAuthService:  # Name implies SQL Server
```

**Recommended:**
```python
import pymysql
class MySQLAuthService:  # Clear naming
```

### 6. Add Round-Robin Load Balancing
**File:** `simorgh-agent/backend/services/llm_service.py`

**Issue:** Always tries server 1 first, server 2 only on failure

**Enhancement:**
```python
import random

class LLMService:
    def __init__(self, ...):
        self.local_llm_urls = [
            os.getenv("LOCAL_LLM_URL_1", "http://192.168.1.61/ai"),
            os.getenv("LOCAL_LLM_URL_2", "http://192.168.1.62/ai")
        ]
        self.server_health = {url: True for url in self.local_llm_urls}

    def _select_best_server(self):
        """Select best available server with round-robin"""
        healthy_servers = [
            url for url, health in self.server_health.items()
            if health
        ]

        if not healthy_servers:
            # All down, try anyway
            return random.choice(self.local_llm_urls)

        return random.choice(healthy_servers)

    def _offline_chat(self, messages, context=None):
        """Use selected server with fallback"""
        server_url = self._select_best_server()

        try:
            # Try selected server
            response = self._call_local_llm(server_url, messages, context)
            self.server_health[server_url] = True
            return response
        except Exception as e:
            # Mark as unhealthy and try other server
            self.server_health[server_url] = False

            # Try remaining servers
            for url in self.local_llm_urls:
                if url != server_url:
                    try:
                        response = self._call_local_llm(url, messages, context)
                        self.server_health[url] = True
                        return response
                    except:
                        self.server_health[url] = False

            # All failed
            raise LLMOfflineError("All local LLM servers unavailable")
```

---

## 📝 NGINX CONFIGURATION REVIEW

### Current nginx config is CORRECT for backend usage:

**File:** `simorgh-agent/nginx_configs/conf.d/default.conf`

✅ **Correctly configured:**
1. Backend API at `/api/` → proxies to `backend:8890`
2. Frontend at `/` → proxies to `frontend:80`
3. `/api/r1/` and `/api/r2/` routes to LLM servers (for direct frontend access if needed)
4. Proper SSE streaming support (buffering off, long timeouts)
5. Health check endpoints

**Note:** The backend LLM service correctly calls `http://192.168.1.61/ai` and `http://192.168.1.62/ai` directly (not through simorgh nginx). The `/api/r1/` and `/api/r2/` routes in simorgh nginx are optional and allow frontend to directly access LLM servers if needed (bypassing backend).

---

## 🔍 FRONTEND REVIEW

### Frontend Structure Analysis

**Location:** `simorgh-agent/frontend/`

**Key Files:**
- `package.json` - React application
- `Dockerfile` - Production build with nginx
- `nginx/nginx.conf` - Frontend nginx config
- `chatbot-ui/` subdirectory (possible duplication?)

**Potential Issues:**
1. **Duplicate frontend structure?** - Both `frontend/` and `frontend/chatbot-ui/` exist
2. **API endpoint configuration** - Check if using correct `/api/` prefix
3. **LLM mode selection** - Frontend should send `llm_mode` parameter

**Needs Manual Review:**
- Check `frontend/chatbot-ui/` vs `frontend/` - which is production?
- Verify API calls include `llm_mode` parameter
- Check if streaming endpoint exists in frontend

---

## 🎯 OPTIONAL ENHANCEMENTS

### 7. Integrate Qdrant Vector Search
Currently Qdrant is configured but not used. Semantic search only uses Neo4j property filters.

### 8. Add API Documentation
FastAPI auto-generates `/docs` but needs detailed descriptions and examples.

### 9. Add Metrics and Monitoring
Track LLM response times, error rates, server health.

### 10. Add Rate Limiting per User
Currently rate limiting by IP, could add user-based limits.

---

## 📊 CODE CLEANUP SUMMARY

**Files Deleted:** 12 deprecated backend files + CocoIndex directory
**Lines Removed:** ~7,800 lines of dead code
**Remaining Issues:** 6 critical/medium priority fixes needed

**Next Steps:**
1. Implement streaming chat endpoint
2. Integrate CocoIndex actively
3. Improve error messages
4. Fix SQL auth service naming
5. Add load balancing (optional but recommended)
6. Review and fix frontend issues

---

## 🛠️ IMPLEMENTATION PRIORITY

**Must Fix (Critical):**
1. ✅ Backend cleanup (DONE)
2. Add streaming endpoint
3. Active CocoIndex integration
4. Better error messages

**Should Fix (Medium):**
5. SQL Auth naming
6. Round-robin load balancing

**Nice to Have (Low):**
7. Qdrant integration
8. API documentation
9. Metrics/monitoring
10. Per-user rate limiting

---

Generated: 2025-11-29
Project: Simorgh Industrial Electrical Assistant
Architecture: Neo4j + Redis + CocoIndex + Hybrid LLM (OpenAI/Local)
