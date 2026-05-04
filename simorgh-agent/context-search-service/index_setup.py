"""
Idempotent index templates + ILM policy for the simorgh-* indices. Called
once at service startup; safe to call repeatedly.
"""
from __future__ import annotations

from elasticsearch import Elasticsearch


# Common mapping for the four log-class indices. Vector field present on
# `simorgh-content-*` only (logs/audit don't carry embeddings).
LOG_TEMPLATE = {
    "index_patterns": ["simorgh-logs-*", "simorgh-cot-*",
                       "simorgh-audit-*", "simorgh-mail-*"],
    "priority": 100,
    "template": {
        "settings": {
            "number_of_shards": 1,
            "number_of_replicas": 0,
            "index.refresh_interval": "5s",
        },
        "mappings": {
            "dynamic": "true",
            "properties": {
                "@timestamp":  {"type": "date"},
                "service":     {"type": "keyword"},
                "level":       {"type": "keyword"},
                "event":       {"type": "keyword"},
                "request_id":  {"type": "keyword"},
                "user_id":     {"type": "keyword"},
                "project_id":  {"type": "keyword"},
                "oenum":       {"type": "keyword"},
                "cot_step_id": {"type": "keyword"},
                "tool":        {"type": "keyword"},
                "latency_ms":  {"type": "integer"},
                "message":     {"type": "text"},
                "error":       {"type": "text"},
            },
        },
    },
}


# Content index — project documents, GitLab blobs, TPMS rows, technical-knowledge.
# Carries both BM25 (text) and dense_vector for hybrid search.
CONTENT_TEMPLATE = {
    "index_patterns": ["simorgh-content-*"],
    "priority": 110,
    "template": {
        "settings": {
            "number_of_shards": 1,
            "number_of_replicas": 0,
            "index.refresh_interval": "10s",
        },
        "mappings": {
            "properties": {
                "@timestamp":  {"type": "date"},
                "source":      {"type": "keyword"},   # gitlab|tpms|project|tech-kb|email
                "project_id":  {"type": "keyword"},
                "oenum":       {"type": "keyword"},
                "repo":        {"type": "keyword"},
                "ref":         {"type": "keyword"},
                "path":        {"type": "keyword"},
                "title":       {"type": "text"},
                "body":        {"type": "text"},
                "tags":        {"type": "keyword"},
                "embedding":   {
                    "type": "dense_vector",
                    "dims": 768,
                    "index": True,
                    "similarity": "cosine",
                },
            },
        },
    },
}


def ensure_templates(es: Elasticsearch) -> None:
    es.indices.put_index_template(name="simorgh-logs", body=LOG_TEMPLATE)
    es.indices.put_index_template(name="simorgh-content", body=CONTENT_TEMPLATE)
    # Bootstrap a write index so the BM25 search has something to query.
    if not es.indices.exists(index="simorgh-content-000001"):
        es.indices.create(index="simorgh-content-000001",
                          body={"aliases": {"simorgh-content": {"is_write_index": True}}})
