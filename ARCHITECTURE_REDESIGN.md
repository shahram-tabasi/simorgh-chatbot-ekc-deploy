# Simorgh Industrial Electrical Assistant - Architecture Redesign

## 📋 Overview

This document describes the comprehensive architecture redesign of the Simorgh Industrial Electrical Assistant, migrating from ArangoDB to Neo4j with enhanced caching, authentication, and hybrid LLM support.

### Key Changes

- ✅ **Neo4j 5.x** replaces ArangoDB for knowledge graph with project isolation
- ✅ **Redis** added for multi-database caching (sessions, chat, LLM, auth)
- ✅ **SQL Server** integration for external user authentication
- ✅ **Hybrid LLM** support (OpenAI online + local LLM servers)
- ✅ **CocoIndex** for advanced document processing and entity extraction
- ✅ **Enhanced Frontend** with LLM mode toggle and metadata display

---

## 🏗️ Architecture

### System Components

```
┌─────────────────────────────────────────────────────────────┐
│                        FRONTEND (Vite React)                │
│  • LLM Mode Toggle (Online/Offline)                        │
│  • Graph Context Indicators                                │
│  • Enhanced Chat with Metadata                             │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│                     NGINX REVERSE PROXY                     │
│  /api/* → Backend FastAPI                                  │
│  /     → Frontend                                           │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│                    BACKEND (FastAPI)                        │
│                                                             │
│  Services:                                                  │
│  ├── Neo4jService (Project-isolated graphs)                │
│  ├── RedisService (Multi-DB caching)                       │
│  ├── SQLAuthService (External auth)                        │
│  └── LLMService (Hybrid OpenAI/Local)                      │
│                                                             │
│  Endpoints:                                                 │
│  ├── /api/auth/* (Authentication)                          │
│  ├── /api/projects/* (Project management)                  │
│  ├── /api/chats/* (Chat sessions)                          │
│  ├── /api/chat/send (Message + RAG)                        │
│  ├── /api/graph/* (Graph queries)                          │
│  └── /api/projects/{id}/documents (Upload & process)       │
└─────┬───────┬─────────┬──────────┬────────────┬────────────┘
      │       │         │          │            │
      ▼       ▼         ▼          ▼            ▼
┌──────────┐ ┌──────┐ ┌──────┐ ┌────────┐ ┌──────────┐
│  Neo4j   │ │Redis │ │Qdrant│ │SQL Svr │ │LLM Svrs  │
│  Graph   │ │Cache │ │Vector│ │  Auth  │ │61│62│OpenAI│
└──────────┘ └──────┘ └──────┘ └────────┘ └──────────┘
```

---

## 🗄️ Database Architecture

### Neo4j - Knowledge Graph

**Project Isolation Pattern:**

Every entity MUST connect to its Project node via `[:BELONGS_TO_PROJECT]` relationship.

```cypher
// Project root
(:Project {
  project_number: "P-2024-001",
  project_name: "Tehran Substation",
  client: "Tehran Power Co."
})

// All entities belong to project
(:Panel {entity_id: "MDB-01"})-[:BELONGS_TO_PROJECT]->(:Project)
(:Transformer {entity_id: "TR-01"})-[:BELONGS_TO_PROJECT]->(:Project)
(:Load {entity_id: "M-01"})-[:BELONGS_TO_PROJECT]->(:Project)

// Relationships within project
(:Transformer)-[:SUPPLIES]->(:Panel)
(:Panel)-[:FEEDS]->(:Circuit)
(:Circuit)-[:POWERS]->(:Load)
```

**Entity Types:**
- Switchgear & Panels (MDB, SMDB, MCC, PCC)
- Protection Devices (Circuit Breakers, Fuses, Relays)
- Transformers
- Cables & Wiring
- Loads (Motors, HVAC, Lighting)
- Measurement Devices (CTs, VTs, Meters)
- Control Systems (PLCs, SCADA)

### Redis - Multi-Database Caching

| DB | Purpose | TTL | Key Pattern |
|----|---------|-----|-------------|
| 0 | User sessions & profiles | Session | `user:profile:{user_id}` |
| 1 | Chat history | 24h | `chat:history:{chat_id}` |
| 2 | LLM response cache | 1h | `llm:response:{hash}` |
| 3 | Authorization cache | 1h | `auth:project:{user}:{project}` |

### SQL Server - External Authentication

Read-only connection for:
- User validation (`Users` table)
- Project access permissions (`UserProjectAccess` table)
- User project list retrieval

**Sample Schema:**
```sql
-- Users table
CREATE TABLE Users (
    user_id INT PRIMARY KEY,
    username VARCHAR(100) UNIQUE,
    full_name VARCHAR(200),
    email VARCHAR(200),
    is_active BIT DEFAULT 1
);

-- Project access
CREATE TABLE UserProjectAccess (
    user_id INT,
    project_id INT,
    role VARCHAR(50),
    is_active BIT DEFAULT 1,
    granted_at DATETIME DEFAULT GETDATE(),
    FOREIGN KEY (user_id) REFERENCES Users(user_id)
);
```

### Qdrant - Vector Search

Maintained for semantic entity search and relationship embeddings.

---

## 🔧 Configuration

### Environment Variables

Copy `.env.example` to `.env` and configure:

```bash
# Neo4j
NEO4J_URI=bolt://neo4j:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=your_secure_password

# Redis
REDIS_URL=redis://redis:6379/0

# SQL Server (External Auth)
SQL_SERVER_HOST=192.168.1.100
SQL_SERVER_PORT=1433
SQL_SERVER_USER=readonly_user
SQL_SERVER_PASSWORD=readonly_password
SQL_SERVER_DATABASE=ProjectManagement

# LLM - OpenAI (Online Mode)
OPENAI_API_KEY=sk-your-api-key
OPENAI_MODEL=gpt-4o

# LLM - Local Servers (Offline Mode)
LOCAL_LLM_URL_1=http://192.168.1.61/ai
LOCAL_LLM_URL_2=http://192.168.1.62/ai

# Default Mode
DEFAULT_LLM_MODE=online  # online|offline|auto

# CocoIndex
COCOINDEX_URL=http://cocoindex:8080
COCOINDEX_DB_PASSWORD=cocoindex_2024
```

---

## 🚀 Deployment

### Prerequisites

- Docker & Docker Compose
- GitHub Container Registry access
- Network access to:
  - Neo4j (ports 7474, 7687)
  - SQL Server (port 1433)
  - Local LLM servers (192.168.1.61, 192.168.1.62)

### Deployment Steps

1. **Clone Repository**
   ```bash
   git clone https://github.com/your-org/simorgh-chatbot-ekc-deploy
   cd simorgh-chatbot-ekc-deploy/simorgh-agent
   ```

2. **Configure Environment**
   ```bash
   cp .env.example .env
   # Edit .env with your configuration
   nano .env
   ```

3. **Build & Deploy**
   ```bash
   docker-compose up -d
   ```

4. **Verify Services**
   ```bash
   # Check all containers
   docker-compose ps

   # Check health
   curl http://localhost/api/health
   ```

5. **Access Applications**
   - **Frontend**: http://192.168.1.68
   - **API Docs**: http://192.168.1.68/api/docs
   - **Neo4j Browser**: http://192.168.1.68:7474

---

## 📊 API Endpoints

### Authentication

```http
POST /api/auth/check-project-access
{
  "username": "john.doe",
  "project_number": "P-2024-001"
}

GET /api/auth/user-projects/{username}
```

### Projects

```http
POST /api/projects
{
  "project_number": "P-2024-001",
  "project_name": "Tehran Substation",
  "client": "Tehran Power Company"
}

GET /api/projects/{project_number}
GET /api/projects/{project_number}/graph
```

### Chats

```http
POST /api/chats
{
  "chat_name": "Design Discussion",
  "user_id": "user123",
  "chat_type": "project",
  "project_number": "P-2024-001"
}

GET /api/chats/{chat_id}
GET /api/projects/{project_number}/chats
```

### Chat with RAG

```http
POST /api/chat/send
{
  "chat_id": "chat-uuid",
  "user_id": "user123",
  "content": "What is the rating of transformer TR-01?",
  "llm_mode": "online",
  "use_graph_context": true
}
```

### Document Processing

```http
POST /api/projects/{project_number}/documents
Content-Type: multipart/form-data

file: specification.pdf
llm_mode: online
```

### Graph Queries

```http
POST /api/graph/query
{
  "project_number": "P-2024-001",
  "query": "Find all 400V panels",
  "entity_type": "Panel",
  "filters": {"rated_voltage": "400V"},
  "limit": 20
}

GET /api/graph/{project_number}/entity/{entity_id}?depth=2

POST /api/graph/{project_number}/power-path
{
  "from_entity_id": "TR-01",
  "to_entity_id": "M-01"
}
```

---

## 🔄 Migration Guide

### From ArangoDB to Neo4j

**1. Export Existing Data from ArangoDB**

```python
# Run this script on the old system
from pyArango.connection import Connection

conn = Connection(
    arangoURL='http://arangodb:8529',
    username='root',
    password='password'
)

db = conn['electrical_knowledge']

# Export entities
entities = []
for collection in db.collections:
    if not collection.startswith('_'):
        for doc in db[collection].fetchAll():
            entities.append({
                'entity_type': collection,
                'entity_id': doc['_key'],
                'properties': doc
            })

# Export edges
relationships = []
for edge_col in db.graphs['electrical_graph'].edgeDefinitions:
    for edge in db[edge_col['collection']].fetchAll():
        relationships.append({
            'from': edge['_from'],
            'to': edge['_to'],
            'type': edge_col['collection'],
            'properties': edge
        })

# Save to JSON
import json
with open('arango_export.json', 'w') as f:
    json.dump({'entities': entities, 'relationships': relationships}, f)
```

**2. Import to Neo4j**

```python
from services.neo4j_service import get_neo4j_service
import json

neo4j = get_neo4j_service()

# Load exported data
with open('arango_export.json') as f:
    data = json.load(f)

# Create project
project_number = "P-2024-001"  # Your project number
neo4j.create_project(
    project_number=project_number,
    project_name="Migrated Project"
)

# Batch import entities
neo4j.batch_create_entities(
    project_number=project_number,
    entities=data['entities']
)

# Batch import relationships
neo4j.batch_create_relationships(
    project_number=project_number,
    relationships=data['relationships']
)

print("✅ Migration complete!")
```

**3. Update Application Code**

All ArangoDB references have been replaced. No manual code changes needed.

---

## 🎯 Features

### 1. Project Isolation

Every project has its own isolated knowledge graph:

```python
# All queries are project-scoped
entities = neo4j.semantic_search(
    project_number="P-2024-001",
    entity_type="Panel"
)
# Returns only entities from P-2024-001
```

### 2. Hybrid LLM Support

Users can toggle between online (OpenAI) and offline (local) modes:

```typescript
// Frontend
const { llmMode, toggleLlmMode } = useChat(...)

// Toggle between online/offline
<button onClick={toggleLlmMode}>
  {llmMode === 'online' ? '🌐 Online' : '💻 Offline'}
</button>
```

Backend automatically handles fallback:

```python
# Auto mode: try online first, fallback to offline
llm_service.generate(messages, mode="auto")
```

### 3. Smart Caching

- **LLM Responses**: Cached for 1 hour (saves API costs)
- **Authorization**: Cached for 1 hour (reduces SQL queries)
- **Chat History**: Cached for 24 hours (fast retrieval)

```python
# Automatic caching
result = llm_service.generate(messages, use_cache=True)
# Cache hit rate tracked in stats
stats = llm_service.get_stats()
# {'cache_hit_rate': 0.65}
```

### 4. Document Processing with CocoIndex

Upload PDFs → Extract entities → Build graph

```python
# Automatic pipeline
POST /api/projects/P-2024-001/documents
# → PDF extraction
# → LLM entity extraction
# → Relationship inference
# → Neo4j export with project isolation
```

### 5. Power Flow Analysis

Find electrical paths between components:

```cypher
// Find path from transformer to motor
MATCH path = shortestPath(
  (tr:Transformer {entity_id: "TR-01"})
  -[:SUPPLIES|FEEDS*1..10]-
  (m:Motor {entity_id: "M-01"})
)
WHERE all(n IN nodes(path) WHERE n.project_number = "P-2024-001")
RETURN path
```

---

## 🔍 Monitoring & Health

### Health Check Endpoint

```bash
curl http://localhost/api/health
```

**Response:**
```json
{
  "status": "healthy",
  "timestamp": "2024-01-15T10:30:00Z",
  "services": {
    "neo4j": {
      "status": "healthy",
      "neo4j_version": "5.15.0",
      "node_count": 1250
    },
    "redis": {
      "status": "healthy",
      "databases": {
        "session_db": "healthy",
        "chat_db": "healthy",
        "cache_db": "healthy",
        "auth_db": "healthy"
      }
    },
    "sql_auth": {
      "status": "healthy",
      "database": "ProjectManagement"
    },
    "llm": {
      "status": "healthy",
      "openai": {"status": "healthy"},
      "local_llm_1": {"status": "healthy"},
      "local_llm_2": {"status": "healthy"}
    }
  }
}
```

### Neo4j Monitoring

Access Neo4j Browser at http://192.168.1.68:7474

**Useful Queries:**

```cypher
// Count nodes per project
MATCH (p:Project)<-[:BELONGS_TO_PROJECT]-(e)
RETURN p.project_number, count(e) as entity_count
ORDER BY entity_count DESC

// Find orphaned entities (NOT isolated!)
MATCH (e)
WHERE NOT (e)-[:BELONGS_TO_PROJECT]->(:Project)
  AND NOT e:Project
RETURN e
LIMIT 10

// Relationship distribution
MATCH ()-[r]->()
RETURN type(r) as relationship_type, count(r) as count
ORDER BY count DESC
```

---

## 🐛 Troubleshooting

### Neo4j Connection Issues

```bash
# Check Neo4j status
docker-compose logs neo4j

# Verify connectivity
docker exec -it neo4j cypher-shell -u neo4j -p your_password

# Test from backend
docker exec -it backend python -c "from services.neo4j_service import get_neo4j_service; print(get_neo4j_service().health_check())"
```

### Redis Connection Issues

```bash
# Check Redis status
docker-compose logs redis

# Test connection
docker exec -it redis redis-cli ping

# Check database usage
docker exec -it redis redis-cli
> SELECT 0
> DBSIZE
> SELECT 1
> DBSIZE
```

### LLM Service Issues

```bash
# Check OpenAI API key
docker exec -it backend python -c "import os; print(os.getenv('OPENAI_API_KEY')[:10])"

# Test local LLM servers
curl http://192.168.1.61/ai/health
curl http://192.168.1.62/ai/health

# Check LLM stats
curl http://localhost/api/health | jq '.services.llm'
```

### SQL Server Authentication Issues

```bash
# Test SQL Server connection
docker exec -it backend python -c "from services.sql_auth_service import get_sql_auth_service; print(get_sql_auth_service().health_check())"

# Verify user access query
# Check SQL Server logs and user permissions
```

---

## 📈 Performance Optimization

### Neo4j Tuning

Edit `docker-compose.yml`:

```yaml
environment:
  - NEO4J_dbms_memory_heap_max__size=4G
  - NEO4J_dbms_memory_pagecache_size=2G
```

### Redis Tuning

```yaml
command: >
  redis-server
  --maxmemory 1gb
  --maxmemory-policy allkeys-lru
```

### Backend Workers

```yaml
backend:
  environment:
    - BACKEND_WORKERS=8  # Adjust based on CPU cores
```

---

## 🔐 Security Considerations

1. **Environment Variables**: Never commit `.env` to version control
2. **Database Passwords**: Use strong, unique passwords
3. **SQL Server**: Use read-only account with minimal permissions
4. **Redis**: Disable external access (internal network only)
5. **Neo4j**: Change default password immediately
6. **API Keys**: Rotate OpenAI API keys regularly

---

## 📚 Additional Resources

- [Neo4j Documentation](https://neo4j.com/docs/)
- [Redis Documentation](https://redis.io/documentation)
- [FastAPI Documentation](https://fastapi.tiangolo.com/)
- [Siemens LV/MV Standards](https://siemens.com)

---

## 🤝 Support

For issues or questions:
- GitHub Issues: https://github.com/your-org/simorgh-chatbot-ekc-deploy/issues
- Internal Wiki: [Your internal documentation]

---

**Version**: 2.0.0
**Last Updated**: 2024-01-15
**Author**: Simorgh Engineering Team
