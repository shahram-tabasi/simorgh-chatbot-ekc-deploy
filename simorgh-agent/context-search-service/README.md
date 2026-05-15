# context-search-service

**Hybrid (BM25 + kNN) search and analytical aggregations across the simorgh
Elasticsearch indices.** This is the search + analytics brain the CoT agent
calls to reason about your data.

Most RAG setups give the agent only documents. This service gives it:

1. **Documents** — project files, GitLab blobs, TPMS rows, technical-knowledge, emails
2. **Structured project metadata** — one ES doc per TPMS project with
   filterable fields (status, voltage_class, customer, year, etc.)
3. **Prior CoT traces** — what the agent reasoned about before, and how
4. **Runtime logs** — what actually happened when services ran
5. **Aggregations and time series** — analytical questions ("how many",
   "trend of", "p95 of") computed by Elasticsearch, not by the LLM

The result: an agent that can answer "Which voltage-class projects had the
worst spec-change rate this quarter, and what did we do about it last time?"
in one CoT cycle — pulling structured counts, retrieving relevant docs, and
recalling past reasoning, all without hitting token limits.

---

## Indices at a glance

| Alias / Pattern | Source | What it holds | Write path |
|---|---|---|---|
| `simorgh-content` | various ingestors | Hybrid BM25 + kNN over project docs, GitLab blobs, TPMS rows, tech-kb, emails | `POST /index/content`, `POST /index/content/bulk` |
| `simorgh-projects` | tpms-fetcher | One doc per TPMS project (oenum is _id). Structured + denormalized text. | `POST /index/project_meta` (auto-called by tpms-fetcher) |
| `simorgh-cot-YYYY.MM` | project-agent-service | One doc per completed CoT trace. Question is embedded. | `POST /index/cot` (auto-called at end of `COTEngine.analyze()`) |
| `simorgh-logs-YYYY.MM.DD` | filebeat + logstash | All structured log events from every service | Pushed by `simorgh_logging` + filebeat (no direct write here) |

All four indices are created automatically on service startup via
`index_setup.ensure_templates()` — no manual provisioning needed.

---

## The MCP surface — what the CoT agent calls

The agent never talks to Elasticsearch directly. It calls these MCP tools
exposed at `http://context-search:8049/mcp`:

| Tool | When to use | Example |
|---|---|---|
| `search_context` | **Before generating**, for narrative facts | "What does our wiring guide say about 6 kV motors?" |
| `search_projects_mcp` | When the user references a project loosely | "the 6 kV project we did for ABC last year" → resolve to oenum |
| `search_past_cot` | **Early in reasoning** — recall past similar problems | "How did I solve a spec-change request before?" |
| `search_logs_mcp` | For runtime evidence (debugging context) | "Did embeddings-service throw any errors during the last call?" |
| `aggregate_field` | **Analytical questions** — group + count/avg/p95 | "How many projects per voltage_class this year?" |
| `time_series_query` | **Trend questions** — date-bucketed series | "Is the spec-change rate rising month over month?" |
| `index_cot_trace` | At the END of reasoning, persist the trace | (also called automatically by `COTEngine.analyze()`) |

### Tool 1 — `search_context(query, project_id?, oenum?, k=8)`

Hybrid BM25 + kNN over `simorgh-content`. Returns up to k hits with
highlighted snippets.

```json
search_context(
  query="6kV motor starter sequence",
  project_id="ABC-123",
  k=6
)
```
Returns:
```json
{
  "hits": [
    {"id":"...", "score":12.4, "source":"gitlab",
     "title":"Motor Control Wiring",
     "snippet":"...6kV starter sequence is initiated when..."},
    ...
  ],
  "took_ms": 18
}
```

### Tool 2 — `search_projects_mcp(query, k=10)`

Same shape but searches `simorgh-projects`. Useful for **disambiguating a
project from a loose user description**:

```
User: "the ABC plant project from 2024 with the 6kV motors"
Agent → search_projects_mcp("ABC plant 6kV motor 2024")
Agent ← {"hits":[{"path":"OE-2024-0457", "title":"ABC-Plant-Phase-3", ...}]}
Agent then calls search_context(oenum="OE-2024-0457", query=...)
```

### Tool 3 — `search_past_cot(query, project_id?, k=5)`

Hybrid search over prior reasoning traces. The agent can copy what worked,
learn from what failed:

```
search_past_cot(query="customer requested voltage change after panel build")

→ {"hits":[{
    "question":  "Customer wants 690V instead of 400V mid-build",
    "reasoning": "...we need to recalculate cross-sections, recheck breakers...",
    "steps":     [...],
    "final_answer": "Updated panel spec, re-issued schematics",
    "success":   true,
    "@timestamp": "2025-09-12T..."
  }]}
```

This is the highest-leverage tool for analytical depth — the agent has
**procedural memory** of how it has solved problems before.

### Tool 4 — `search_logs_mcp(query, k=10)`

BM25 over `simorgh-logs-*`. For runtime evidence:

```
search_logs_mcp(query="auth-service AND error AND MySQL")
→ ten recent log lines with full context
```

### Tool 5 — `aggregate_field(index, group_by, metric, ...)`

Group-by aggregation. **This is what separates ELK from a vector DB.**

```python
# How many projects per voltage_class:
aggregate_field(index="projects", group_by="voltage_class")
→ {"buckets":[
    {"key":"6.6 kV", "value":47, "count":47},
    {"key":"3.3 kV", "value":32, "count":32},
    {"key":"0.4 kV", "value":98, "count":98}
]}

# Average LLM latency per service, last 7 days:
aggregate_field(
    index="logs", group_by="service",
    metric="avg", metric_field="latency_ms",
    time_range="now-7d"
)
→ {"buckets":[
    {"key":"chat-service",       "value":823.4, "count":12047},
    {"key":"embeddings-service", "value":18.2,  "count":89233},
    ...
]}

# p95 of CoT-trace latency by step_type:
aggregate_field(
    index="cot", group_by="steps.tool",
    metric="p95", metric_field="steps.latency_ms"
)
```

Parameters:
- `index`: `"content" | "logs" | "cot" | "projects"`
- `group_by`: field name (`.keyword` auto-appended if needed)
- `metric`: `"count" (default) | "avg" | "sum" | "min" | "max" | "p50" | "p95" | "p99"`
- `metric_field`: required for non-count metrics
- `filter_query`: ES query_string syntax — `level:ERROR AND service:backend`
- `time_range`: `"now-30d"` etc.
- `top_n`: max buckets returned (default 20)

### Tool 6 — `time_series_query(index, interval, ...)`

Date histogram. Trend analysis:

```python
# Daily error count per service, last 30 days:
time_series_query(
    index="logs", interval="1d",
    filter_query="level:ERROR",
    group_by="service",
    time_range="now-30d"
)
→ {"series":[
    {"t":"2026-04-15", "count":12, "by":[{"key":"chat","count":7},...]},
    {"t":"2026-04-16", "count":3,  "by":[...]},
    ...
]}

# p95 LLM latency hourly for the last day:
time_series_query(
    index="logs", interval="1h",
    metric="p95", metric_field="latency_ms",
    filter_query="event:llm_call",
    time_range="now-1d"
)
```

`interval` supports `1m / 5m / 1h / 1d` (fixed) or `1w / 1M / 1y` (calendar).

### Tool 7 — `index_cot_trace(trace_json)`

Manual persist. Already wired automatically; the agent normally doesn't
need to call this explicitly.

---

## How the CoT agent should use these

A canonical high-analytic reasoning pattern:

```
USER: "Customer wants to reduce voltage on the ABC-2024 project from 6.6kV
       to 3.3kV. What's the impact?"

Step 1 — Resolve the project from loose reference:
  search_projects_mcp("ABC 2024 6.6kV") → oenum="OE-2024-0457"

Step 2 — Check if I've handled this kind of problem before:
  search_past_cot("voltage reduction mid-project")
  → past trace: "needed to recompute cross-sections, recheck breakers,
                 update SLD, notify EPLAN team..."

Step 3 — Get the structured project data:
  search_context(oenum="OE-2024-0457", query="voltage class motors")

Step 4 — Quantify scope by querying TPMS metadata via aggregation:
  aggregate_field(index="projects", group_by="motor_type",
                  filter_query="oenum:OE-2024-0457")
  → bucket counts of motor types affected

Step 5 — Compare against similar past projects:
  aggregate_field(index="projects", group_by="voltage_class",
                  filter_query="customer:\"ABC\"")
  → trend of voltage classes for this customer

Step 6 — Reflect + synthesize the answer.
```

Without context-search, that's the LLM scrolling through retrieved docs and
guessing counts. With context-search, every number is grounded.

---

## REST API (called by services, not by the CoT agent)

### Health
```
GET  /health        — basic
GET  /health/deep   — also probes Elasticsearch
```

### Search
```
POST /search/content    {query, project_id?, oenum?, sources?, k, use_knn}
POST /search/projects   {query, project_id?, k, use_knn}
POST /search/cot        {query, project_id?, k, use_knn}
POST /search/logs       {query, k}
```

### Aggregation / time series
```
POST /aggregate     {index, group_by, metric, metric_field, filter_query,
                     time_range, top_n}
POST /time_series   {index, interval, metric, metric_field, filter_query,
                     time_range, group_by, top_n}
```

### Indexing
```
POST /index/content         ContentDoc
POST /index/content/bulk    [ContentDoc, ...]
POST /index/cot             CotTrace
POST /index/project_meta    ProjectMeta
```

See the pydantic models in `app.py` for exact field shapes.

---

## How traces and project metadata are populated automatically

You don't need to call `/index/cot` or `/index/project_meta` manually — two
services do it for you:

| Source | When | What |
|---|---|---|
| `project-agent-service` `COTEngine.analyze()` | At the end of every CoT analysis (success or failure) | One `simorgh-cot-YYYY.MM` doc with `chain_id`, `question`, `reasoning`, all steps, success flag |
| `tpms-fetcher-service` `fetch_project()` | After every TPMS fetch | One `simorgh-projects` doc, oenum-keyed (upsert) |

Both calls go through `shared/simorgh_clients/context_search.py`, which is
**fire-and-forget** — if context-search is offline the caller continues
unaffected. ELK is enrichment, not a hard dependency.

You can disable shipping per-call by setting `CONTEXT_SEARCH_URL=` (empty)
in the source service's env.

---

## Operations

### Quick smoke test after deploy

```bash
# Direct REST
curl -s http://192.168.1.68:8049/health
curl -s http://192.168.1.68:8049/health/deep

# Search
curl -s -X POST http://192.168.1.68:8049/search/content \
     -H 'content-type: application/json' \
     -d '{"query":"motor starter","k":3}' | jq

# Aggregation
curl -s -X POST http://192.168.1.68:8049/aggregate \
     -H 'content-type: application/json' \
     -d '{"index":"projects","group_by":"voltage_class"}' | jq
```

### Force a re-sync of all TPMS projects into simorgh-projects

```bash
# Walk every oenum the chat-service knows about
docker compose exec backend python -c "
import asyncio, httpx
async def main():
    async with httpx.AsyncClient(timeout=30) as c:
        oenums = (await c.get('http://tpms-fetcher:8021/list')).json()
        for oe in oenums['items']:
            await c.post(f'http://tpms-fetcher:8021/fetch/{oe}')
asyncio.run(main())
"
```

### See what's in each index

```bash
docker compose exec elasticsearch curl -s http://localhost:9200/_cat/indices/simorgh-*?v
```

### Kibana dashboards worth building

1. **Errors by service, last 24h** — log threshold rule + Lens line
2. **CoT trace success rate, daily** — `simorgh-cot-*`, metric `count` with
   `bucket_script` for success/total
3. **Top 10 longest-running tools** — `aggregate` on `steps.tool` with
   `p95(latency_ms)`
4. **Projects index — distribution by status / voltage_class / year** —
   stacked bar over `simorgh-projects`

---

## Tuning

| Knob | Default | When to change |
|---|---|---|
| `ELASTICSEARCH_URL` | `http://elasticsearch:9200` | Point at a different cluster |
| `ELASTIC_USER` / `ELASTIC_PASSWORD` | empty | If `xpack.security.enabled=true` |
| `EMBEDDINGS_URL` | `http://embeddings:8037` | Different embedding service |
| `EMBED_DIMS` | 768 | If you swap to a different embedding model — must match `dense_vector.dims` in `index_setup.py` |
| `CONTEXT_SEARCH_URL` (in caller services) | `http://context-search:8049` | Disable shipping by setting to `""` |
| `CONTEXT_SEARCH_TIMEOUT` (in caller services) | 5.0 s | Tighter for jittery networks |

### Embedding-model swap requires reindex

`simorgh-content`, `simorgh-projects`, and `simorgh-cot-*` all carry
`dense_vector` fields sized at indexing time. If you swap to a different
embedding model with different dimensions, you must:

1. Update `EMBED_DIMS` and `index_setup.py` `dense_vector.dims`
2. Delete + re-create indices
3. Re-ingest content (the CoT and project ingestors are idempotent;
   content needs whatever ingestor pipeline you use)

---

## Architecture

```
                   ┌──────────────────────────────────────────────┐
                   │           Elasticsearch (single node)        │
                   │                                              │
                   │  simorgh-content-* ── hybrid docs + embed    │
                   │  simorgh-projects  ── structured TPMS records│
                   │  simorgh-cot-*     ── CoT traces + embed     │
                   │  simorgh-logs-*    ── runtime events         │
                   └──┬─────────────────────────┬─────────────────┘
                      │                         │
       Filebeat ──────┤                         ├──── Logstash
       (every         │                         │     (5044 beats,
        container's   │                         │      5045 direct)
        stdout)       │                         │
                      │                         │
              ┌───────▼────────┐         ┌──────▼────────┐
              │ context-search │         │ shared/simorgh_logging │
              │  REST + MCP    │         │  (structlog → 5045)    │
              │  :8049         │         └────────────────────────┘
              └───┬────────┬───┘
                  │        │
   ┌──────────────▼──┐  ┌──▼────────────────────┐
   │ project-agent   │  │ tpms-fetcher          │
   │  CoT engine     │  │  fetch_project()      │
   │  → index/cot    │  │  → index/project_meta │
   └─────────────────┘  └───────────────────────┘
```

All inter-service calls inside the docker network. The Kibana UI is at
`https://simorghai.electrokavir.com/kibana/` (proxied via host nginx).

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `search_past_cot` always returns empty | `project-agent-service` hasn't run `analyze()` since the index template existed | Trigger one CoT request through chat-service; check `docker compose logs project-agent-service \| grep ship_cot` |
| `aggregate_field` returns `unaggregatable field` | Field is `text`-typed without a `.keyword` subfield | Map the field as `keyword` in `index_setup.py` and reindex |
| Search returns 0 hits but you know docs exist | `simorgh-content` alias didn't bootstrap; check `GET _cat/aliases/simorgh-content` | `ensure_templates()` only runs on service startup — `docker compose restart context-search` |
| Slow CoT trace shipping breaks the agent | Default 5 s timeout should be safe, but if context-search is dead… | Calls are fire-and-forget; check `context_search_unreachable` warning logs |
| Embedding always None → degraded to BM25-only | `embeddings-service` unreachable | `docker compose logs context-search \| grep embed_failed`; then check embeddings-service |
| `time_series_query` returns flat zeros | Wrong `time_field` (most events use `@timestamp`, not `timestamp`) | Use `@timestamp` |
