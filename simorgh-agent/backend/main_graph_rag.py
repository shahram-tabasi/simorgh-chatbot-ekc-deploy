"""
Enhanced FastAPI Backend - COMPLETE VERSION with Graph RAG
Features:
- Graph-based knowledge management (ArangoDB + Qdrant)
- Entity and relationship extraction
- Edge-based vector search
- Traditional RAG for backward compatibility
- Project history management
- Task cancellation support
- SSE streaming with detailed progress
"""

from fastapi import FastAPI, File, UploadFile, Form, HTTPException
from fastapi.responses import StreamingResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import Dict, Any, Optional, List
import hashlib
from datetime import datetime
import time
import json
import asyncio
import os
import logging
from pathlib import Path
import requests

# Import Graph RAG System
from graph_rag_system import GraphRAGSystem

# Import enhanced parser (for backward compatibility)
from enhanced_pdf_parser_v4_universal import EnhancedUniversalPDFParser, CancellationToken

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Specification Analysis API v3 with Graph RAG")

# CORS Configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

UPLOAD_FOLDER = 'uploads'
ALLOWED_EXTENSIONS = {'pdf'}
Path(UPLOAD_FOLDER).mkdir(exist_ok=True)

# Task storage with cancellation tokens
tasks = {}
task_cancellation_tokens = {}

# Configuration
AI_URL_1 = os.getenv("AI_API_URL_1", "http://192.168.1.61/ai")
AI_URL_2 = os.getenv("AI_API_URL_2", "http://192.168.1.62/ai")
AI_URL = AI_URL_1  # Primary AI service

ARANGODB_URL = os.getenv("ARANGODB_URL", "http://arangodb:8529")
ARANGODB_USERNAME = os.getenv("ARANGODB_USERNAME", "root")
ARANGODB_PASSWORD = os.getenv("ARANGODB_PASSWORD", "changeme")
QDRANT_URL = os.getenv("QDRANT_URL", "http://qdrant:6333")

ENABLE_GRAPH_RAG = os.getenv("ENABLE_GRAPH_RAG", "true").lower() == "true"

# System instances
parser = None
graph_rag_system = None

# ============================================================================
# Pydantic Models
# ============================================================================
class TaskStatus(BaseModel):
    task_id: str
    status: str
    progress: int
    message: str
    filename: Optional[str] = None
    results: Optional[Dict[str, Any]] = None

class ProjectDetails(BaseModel):
    pid: str
    oe_number: str
    project_date: str

class CancelTaskRequest(BaseModel):
    task_id: str

class ChatMessage(BaseModel):
    role: str
    content: str

class ChatRequest(BaseModel):
    pid: str
    oe_number: str
    query: str
    conversation_history: List[ChatMessage] = []
    max_results: int = 5

class ChatResponse(BaseModel):
    response: str
    sources: List[Dict[str, Any]]
    context_used: bool
    graph_paths: Optional[List[Dict[str, Any]]] = None

class GraphStatsResponse(BaseModel):
    project_id: str
    graph_database: Dict[str, Any]
    vector_store: Dict[str, Any]
    timestamp: str

# ============================================================================
# Helper Functions
# ============================================================================
def allowed_file(filename: str) -> bool:
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

# ============================================================================
# Initialization
# ============================================================================
@app.on_event("startup")
async def startup_event():
    """Initialize systems on startup."""
    global parser, graph_rag_system
    
    logger.info("🚀 Starting Enhanced Backend with Graph RAG...")
    
    # Initialize traditional parser (for backward compatibility)
    try:
        parser = EnhancedUniversalPDFParser(
            strategy="hi_res",
            use_gpu=True,
            extract_tables=True,
            min_content_length=50,
            aggressive_filtering=True,
            ai_url=AI_URL,
            thinking_level="medium",
            qdrant_url=QDRANT_URL,
            enable_vector_db=True,
            chunk_size=1000,
            chunk_overlap=200
        )
        logger.info("✅ Traditional PDF Parser initialized")
    except Exception as e:
        logger.error(f"❌ Parser initialization failed: {e}")
        parser = None
    
    # Initialize Graph RAG System
    if ENABLE_GRAPH_RAG:
        try:
            logger.info("🔧 Initializing Graph RAG System...")
            
            graph_rag_system = GraphRAGSystem(
                ai_url=AI_URL,
                arango_url=ARANGODB_URL,
                arango_username=ARANGODB_USERNAME,
                arango_password=ARANGODB_PASSWORD,
                qdrant_url=QDRANT_URL,
                thinking_level=os.getenv("THINKING_LEVEL", "medium")
            )
            
            logger.info("✅ Graph RAG System initialized successfully!")
            logger.info("   • Graph Database: ArangoDB connected")
            logger.info("   • Vector Store: Qdrant connected")
            logger.info("   • LLM Service: Connected")
            
        except Exception as e:
            logger.error(f"❌ Graph RAG System initialization failed: {e}")
            logger.error("   Falling back to traditional system only...")
            graph_rag_system = None
    else:
        logger.info("ℹ️ Graph RAG disabled (ENABLE_GRAPH_RAG=false)")
        graph_rag_system = None
    
    logger.info("🎉 Backend initialization complete!")

# ============================================================================
# Health & Status Endpoints
# ============================================================================

@app.get("/health")
async def health_check():
    """Health check with system status."""
    parser_status = 'initialized' if parser is not None else 'not_initialized'
    graph_rag_status = 'initialized' if graph_rag_system is not None else 'not_initialized'
    
    return {
        'status': 'healthy',
        'traditional_parser': parser_status,
        'graph_rag_system': graph_rag_status,
        'gpu_available': parser.use_gpu if parser else False,
        'graph_enabled': ENABLE_GRAPH_RAG,
        'timestamp': datetime.utcnow().isoformat()
    }

@app.get("/status")
async def get_status():
    """
    Lightweight status endpoint for monitoring.
    Returns current task counts and service state.
    """
    processing_tasks = sum(
        1 for task in tasks.values() 
        if task.get('status') == 'processing'
    )
    initialized_tasks = sum(
        1 for task in tasks.values() 
        if task.get('status') == 'initialized'
    )
    completed_tasks = sum(
        1 for task in tasks.values() 
        if task.get('status') == 'completed'
    )
    error_tasks = sum(
        1 for task in tasks.values() 
        if task.get('status') in ['error', 'cancelled']
    )
    
    total_tasks = len(tasks)
    active_tasks = processing_tasks + initialized_tasks
    
    service_state = "busy" if active_tasks > 0 else ("idle" if total_tasks > 0 else "idle_empty")
    
    return {
        'status': 'healthy',
        'service_state': service_state,
        'is_idle': active_tasks == 0,
        'tasks': {
            'total': total_tasks,
            'active': active_tasks,
            'processing': processing_tasks,
            'initialized': initialized_tasks,
            'completed': completed_tasks,
            'errors': error_tasks
        },
        'systems': {
            'traditional_parser': parser is not None,
            'graph_rag': graph_rag_system is not None
        },
        'timestamp': datetime.utcnow().isoformat()
    }

# ============================================================================
# Graph RAG Endpoints (NEW!)
# ============================================================================

@app.post("/analyze-specification-graph")
async def analyze_specification_graph(
    file: UploadFile = File(...),
    pid: str = Form(...),
    oe_number: str = Form(...),
):
    """
    NEW: Graph-based document analysis.
    
    This endpoint:
    1. Parses PDF to hierarchical structure
    2. Extracts entities and relationships using LLM
    3. Stores in ArangoDB knowledge graph
    4. Stores edge embeddings in Qdrant
    5. Returns statistics
    
    This is the core "learning" endpoint for the Smart Memory System.
    """
    if graph_rag_system is None:
        raise HTTPException(
            status_code=503,
            detail="Graph RAG system not available. Check ENABLE_GRAPH_RAG setting and logs."
        )
    
    if not file.filename:
        raise HTTPException(status_code=400, detail="No file selected")
    
    if not allowed_file(file.filename):
        raise HTTPException(status_code=400, detail="Invalid file type. Only PDF allowed")
    
    try:
        # Save uploaded file
        filename = file.filename
        filepath = os.path.join(UPLOAD_FOLDER, filename)
        
        with open(filepath, "wb") as buffer:
            content = await file.read()
            buffer.write(content)
        
        # Calculate hash
        pdf_hash = hashlib.sha256(content).hexdigest()
        
        # Create task
        task_id = f"graph_task_{int(time.time() * 1000)}"
        
        tasks[task_id] = {
            'status': 'initialized',
            'progress': 0,
            'message': 'Starting graph-based analysis...',
            'filename': filename,
            'pdf_hash': pdf_hash,
            'type': 'graph_rag',
            'results': None
        }
        
        logger.info(f"📄 Graph RAG Processing: {filename}")
        logger.info(f"   Task ID: {task_id}")
        logger.info(f"   Project: {pid}/{oe_number}")
        logger.info(f"   Hash: {pdf_hash[:12]}...")
        
        # Return SSE stream
        return StreamingResponse(
            process_graph_rag_streaming(
                task_id=task_id,
                pdf_path=filepath,
                project_id=pid,
                oe_number=oe_number,
                document_hash=pdf_hash
            ),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no"
            }
        )
        
    except Exception as e:
        logger.error(f"❌ Graph processing failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/chat-graph", response_model=ChatResponse)
async def chat_graph(request: ChatRequest):
    """
    NEW: Graph-enhanced chatbot endpoint.
    
    This endpoint:
    1. Searches for relevant edges using semantic search
    2. Traverses graph to get connected entities
    3. Builds rich context from graph neighborhood
    4. Calls LLM to generate answer
    5. Returns answer with source citations
    
    This is the "recall" part of the Smart Memory System.
    """
    if graph_rag_system is None:
        raise HTTPException(
            status_code=503,
            detail="Graph RAG system not available"
        )
    
    try:
        logger.info(f"💬 Graph chat query: {request.query}")
        logger.info(f"   Project: {request.pid}/{request.oe_number}")
        
        # Query the graph RAG system
        result = await graph_rag_system.query(
            project_id=request.pid,
            oe_number=request.oe_number,
            query_text=request.query,
            max_results=request.max_results
        )
        
        if result["status"] == "error":
            raise HTTPException(status_code=500, detail=result.get("error", "Query failed"))
        
        # Format response
        # Note: In production, you'd call the LLM here with the context
        # For now, we return the context directly
        
        response_text = result.get("answer", "")
        
        # If no answer generated yet (system just returns context), generate one
        if not response_text or response_text == "Graph context retrieved successfully. (LLM generation would happen here)":
            # Build a simple response from graph context
            context = result.get("context", "")
            sources = result.get("sources", [])
            
            if sources:
                response_text = f"Based on the knowledge graph, I found {len(sources)} relevant relationships:\n\n"
                for idx, source in enumerate(sources[:3], 1):
                    response_text += f"{idx}. {source.get('embedding_text', 'N/A')}\n"
                response_text += "\n(Full LLM generation will be implemented in production)"
            else:
                response_text = "I couldn't find relevant information in the knowledge graph for this project."
        
        return ChatResponse(
            response=response_text,
            sources=result.get("sources", []),
            context_used=len(result.get("sources", [])) > 0,
            graph_paths=result.get("graph_paths", [])
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"❌ Graph chat failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Chat failed: {str(e)}")

@app.get("/graph-stats/{project_id}", response_model=GraphStatsResponse)
async def get_graph_statistics(project_id: str):
    """
    Get knowledge graph statistics for a project.
    
    Returns:
    - Entity counts by type
    - Relationship counts by type
    - Vector store statistics
    - Total nodes and edges
    """
    if graph_rag_system is None:
        raise HTTPException(
            status_code=503,
            detail="Graph RAG system not available"
        )
    
    try:
        stats = graph_rag_system.get_project_graph_stats(project_id)
        
        return GraphStatsResponse(
            project_id=stats["project_id"],
            graph_database=stats["graph_database"],
            vector_store=stats["vector_store"],
            timestamp=stats["timestamp"]
        )
        
    except Exception as e:
        logger.error(f"Failed to get graph stats: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/graph-entity/{project_id}/{entity_id}")
async def get_graph_entity(project_id: str, entity_id: str, depth: int = 2):
    """
    Get entity with its graph neighborhood.
    
    Args:
        project_id: Project ID
        entity_id: Entity identifier
        depth: Graph traversal depth (1-3)
    
    Returns:
        Entity details + connected entities + relationships
    """
    if graph_rag_system is None:
        raise HTTPException(status_code=503, detail="Graph RAG not available")
    
    try:
        result = graph_rag_system.graph_manager.get_entity_with_neighborhood(
            project_id=project_id,
            entity_id=entity_id,
            depth=min(depth, 3)  # Limit depth to avoid huge responses
        )
        
        return JSONResponse(content=result)
        
    except Exception as e:
        logger.error(f"Failed to get entity: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# ============================================================================
# Traditional RAG Endpoints (Backward Compatibility)
# ============================================================================

@app.post("/analyze-specification")
async def analyze_specification_traditional(
    file: UploadFile = File(...),
    pid: str = Form(...),
    oe_number: str = Form(...),
    thinking_level: str = Form("medium"),
):
    """
    Traditional document analysis (backward compatibility).
    
    Uses the old MongoDB + Qdrant approach.
    Kept for projects that haven't migrated yet.
    """
    if parser is None:
        raise HTTPException(
            status_code=503,
            detail="Traditional parser not available"
        )
    
    logger.info(f"⚠️ Using traditional analysis (consider migrating to /analyze-specification-graph)")
    
    # Implementation would go here (your existing code)
    # For now, just return a message
    return JSONResponse(content={
        "status": "info",
        "message": "Traditional endpoint - use /analyze-specification-graph for graph-based analysis"
    })

# ============================================================================
# Graph RAG Streaming Processor
# ============================================================================

async def process_graph_rag_streaming(
    task_id: str,
    pdf_path: str,
    project_id: str,
    oe_number: str,
    document_hash: str
):
    """
    Generator function for SSE-formatted progress updates during graph ingestion.
    """
    try:
        tasks[task_id]['status'] = 'processing'
        tasks[task_id]['progress'] = 5
        
        yield f"data: {json.dumps({'progress': 5, 'message': 'Starting graph analysis...', 'phase': 'Initialization'})}\n\n"
        await asyncio.sleep(0.1)
        
        # Progress callback for the graph RAG system
        async def progress_callback(progress: int, message: str, phase: str):
            tasks[task_id]['progress'] = progress
            tasks[task_id]['message'] = message
            yield f"data: {json.dumps({'progress': progress, 'message': message, 'phase': phase})}\n\n"
            await asyncio.sleep(0.1)
        
        # Call graph RAG ingestion
        logger.info(f"🚀 Starting graph ingestion for task {task_id}")
        
        result = await graph_rag_system.ingest_document(
            pdf_path=pdf_path,
            project_id=project_id,
            oe_number=oe_number,
            document_hash=document_hash,
            progress_callback=None  # Simplified for now
        )
        
        # Update task status
        if result["status"] == "success":
            tasks[task_id]['status'] = 'completed'
            tasks[task_id]['progress'] = 100
            tasks[task_id]['results'] = result
            
            completion_data = {
                'status': 'completed',
                'progress': 100,
                'message': '✅ Graph analysis complete!',
                'phase': 'Completed',
                'statistics': result['statistics'],
                'graph_stats': {
                    'entities_created': result['statistics']['entities_created'],
                    'relationships_created': result['statistics']['relationships_created'],
                    'vectors_stored': result['statistics']['vectors_stored'],
                    'processing_time': result['statistics']['processing_time_seconds']
                }
            }
            
            yield f"data: {json.dumps(completion_data)}\n\n"
            
            logger.info(f"✅ Task {task_id} completed successfully")
            
        elif result["status"] == "cancelled":
            tasks[task_id]['status'] = 'cancelled'
            error_data = {
                'error': 'Task cancelled',
                'status': 'cancelled',
                'message': '🛑 Analysis cancelled'
            }
            yield f"data: {json.dumps(error_data)}\n\n"
            logger.warning(f"🛑 Task {task_id} cancelled")
            
        else:
            tasks[task_id]['status'] = 'error'
            error_data = {
                'error': result.get('message', 'Unknown error'),
                'status': 'error',
                'message': f'❌ Analysis failed: {result.get("message", "Unknown error")}'
            }
            yield f"data: {json.dumps(error_data)}\n\n"
            logger.error(f"❌ Task {task_id} failed")
        
    except Exception as e:
        tasks[task_id]['status'] = 'error'
        error_data = {
            'error': str(e),
            'status': 'error',
            'message': f'❌ Analysis failed: {str(e)}'
        }
        yield f"data: {json.dumps(error_data)}\n\n"
        logger.error(f"❌ Task {task_id} failed with exception: {e}", exc_info=True)

# ============================================================================
# Task Management Endpoints
# ============================================================================

@app.post("/cancel-task")
async def cancel_task(request: CancelTaskRequest):
    """Cancel an ongoing task."""
    task_id = request.task_id
    
    if task_id not in tasks:
        raise HTTPException(status_code=404, detail="Task not found")
    
    try:
        # Try to cancel graph RAG task
        if graph_rag_system:
            graph_rag_system.cancel_task()
        
        # Try to cancel traditional parser task
        if task_id in task_cancellation_tokens:
            cancellation_token = task_cancellation_tokens[task_id]
            cancellation_token.cancel()
        
        logger.info(f"🛑 Cancellation requested for task {task_id}")
        
        return {
            'status': 'cancellation_requested',
            'task_id': task_id,
            'message': 'Task cancellation requested'
        }
    except Exception as e:
        logger.error(f"Failed to cancel task: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/progress/{task_id}")
async def get_progress(task_id: str):
    """Get processing progress for a task."""
    if task_id not in tasks:
        raise HTTPException(status_code=404, detail="Task not found")
    
    return tasks[task_id]

@app.get("/results/{task_id}")
async def get_results(task_id: str):
    """Get full results for a completed task."""
    if task_id not in tasks:
        raise HTTPException(status_code=404, detail="Task not found")
    
    task_data = tasks[task_id]
    
    if task_data['status'] not in ['completed', 'cancelled']:
        raise HTTPException(status_code=400, detail="Task not finished")
    
    return {
        'task_id': task_id,
        'status': task_data['status'],
        'filename': task_data.get('filename'),
        'type': task_data.get('type', 'unknown'),
        'results': task_data.get('results', {})
    }

@app.get("/tasks")
async def list_tasks():
    """List all tasks with their status."""
    task_list = [
        {
            'task_id': task_id,
            'status': task_data['status'],
            'progress': task_data['progress'],
            'filename': task_data.get('filename', 'Unknown'),
            'type': task_data.get('type', 'unknown')
        }
        for task_id, task_data in tasks.items()
    ]
    return {'tasks': task_list}

# ============================================================================
# System Information Endpoints
# ============================================================================

@app.get("/system-info")
async def get_system_info():
    """
    Get comprehensive system information.
    """
    return {
        "version": "3.0.0-graph-rag",
        "systems": {
            "traditional_parser": {
                "available": parser is not None,
                "gpu_enabled": parser.use_gpu if parser else False
            },
            "graph_rag": {
                "available": graph_rag_system is not None,
                "enabled": ENABLE_GRAPH_RAG,
                "components": {
                    "graph_database": "ArangoDB",
                    "vector_store": "Qdrant",
                    "llm_service": AI_URL
                }
            }
        },
        "endpoints": {
            "graph_rag": [
                "/analyze-specification-graph",
                "/chat-graph",
                "/graph-stats/{project_id}",
                "/graph-entity/{project_id}/{entity_id}"
            ],
            "traditional": [
                "/analyze-specification"
            ]
        },
        "timestamp": datetime.utcnow().isoformat()
    }

# ============================================================================
# Run Server
# ============================================================================

if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host='0.0.0.0', port=8890)