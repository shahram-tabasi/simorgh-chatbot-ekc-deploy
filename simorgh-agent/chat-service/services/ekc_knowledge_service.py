"""
EKC Knowledge Service
======================
Provides access to the shared ekc-knowledge volume containing searchable
metadata for all documents in the knowledge base. This service is used by
the Project Manager Agent to gather general EKC technical information
when analyzing projects.

The ekc-knowledge volume is mounted at EKC_KNOWLEDGE_PATH (default: /app/ekc-knowledge)
and contains:
  - *.metadata.json   Individual document metadata files
  - _index.json        Consolidated searchable index

Every legacy login user's project workspace should have a symlink/bind
named `ekc-knowledge` pointing to this shared volume, so all projects
share the same knowledge base.
"""

import json
import logging
import os
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

EKC_KNOWLEDGE_PATH = os.environ.get("EKC_KNOWLEDGE_PATH", "/app/ekc-knowledge")


class EKCKnowledgeService:
    """Service for querying the EKC shared knowledge base."""

    def __init__(self, knowledge_path: Optional[str] = None):
        self.knowledge_path = Path(knowledge_path or EKC_KNOWLEDGE_PATH)
        self._index: Optional[Dict[str, Any]] = None
        self._metadata_cache: Dict[str, Dict[str, Any]] = {}

    def is_available(self) -> bool:
        """Check if the knowledge base is mounted and accessible."""
        return self.knowledge_path.exists() and self.knowledge_path.is_dir()

    def _load_index(self) -> Dict[str, Any]:
        """Load or reload the consolidated knowledge index."""
        index_path = self.knowledge_path / "_index.json"
        if not index_path.exists():
            logger.warning("Knowledge index not found at %s", index_path)
            return {"total_documents": 0, "documents": [], "keyword_index": {}, "category_index": {}, "domain_index": {}}

        try:
            with open(index_path, "r", encoding="utf-8") as f:
                self._index = json.load(f)
            logger.info("Loaded knowledge index: %d documents", self._index.get("total_documents", 0))
            return self._index
        except (json.JSONDecodeError, OSError) as e:
            logger.error("Failed to load knowledge index: %s", e)
            return {"total_documents": 0, "documents": [], "keyword_index": {}, "category_index": {}, "domain_index": {}}

    @property
    def index(self) -> Dict[str, Any]:
        if self._index is None:
            self._load_index()
        return self._index

    def reload(self):
        """Force reload the knowledge index."""
        self._index = None
        self._metadata_cache.clear()
        self._load_index()

    def get_document_count(self) -> int:
        """Get total number of indexed documents."""
        return self.index.get("total_documents", 0)

    def get_all_documents(self) -> List[Dict[str, Any]]:
        """Get all document entries from the index."""
        return self.index.get("documents", [])

    def search_by_keyword(self, keyword: str) -> List[str]:
        """Search documents by keyword, returns list of matching filenames."""
        kw_index = self.index.get("keyword_index", {})
        return kw_index.get(keyword.lower(), [])

    def search_by_keywords(self, keywords: List[str]) -> List[Dict[str, Any]]:
        """Search documents matching any of the given keywords."""
        matching_files = set()
        for kw in keywords:
            matching_files.update(self.search_by_keyword(kw))

        # Return full document entries for matches
        docs = self.index.get("documents", [])
        return [d for d in docs if d.get("file_name") in matching_files]

    def search_by_category(self, category: str) -> List[str]:
        """Search documents by category."""
        cat_index = self.index.get("category_index", {})
        return cat_index.get(category.lower(), [])

    def search_by_domain(self, domain: str) -> List[str]:
        """Search documents by domain (electrical, mechanical, etc.)."""
        domain_index = self.index.get("domain_index", {})
        return domain_index.get(domain.lower(), [])

    def get_document_metadata(self, filename: str) -> Optional[Dict[str, Any]]:
        """Get full metadata for a specific document."""
        if filename in self._metadata_cache:
            return self._metadata_cache[filename]

        # Try to find the metadata file
        stem = Path(filename).stem
        metadata_path = self.knowledge_path / f"{stem}.metadata.json"

        if not metadata_path.exists():
            return None

        try:
            with open(metadata_path, "r", encoding="utf-8") as f:
                metadata = json.load(f)
            self._metadata_cache[filename] = metadata
            return metadata
        except (json.JSONDecodeError, OSError) as e:
            logger.error("Failed to load metadata for %s: %s", filename, e)
            return None

    def search_fulltext(self, query: str) -> List[Dict[str, Any]]:
        """Simple full-text search across all document metadata."""
        query_lower = query.lower()
        query_terms = query_lower.split()
        results = []

        for doc in self.index.get("documents", []):
            score = 0
            searchable = " ".join([
                doc.get("title", ""),
                doc.get("summary", ""),
                " ".join(doc.get("keywords", [])),
                " ".join(doc.get("categories", [])),
                doc.get("domain", ""),
                " ".join(doc.get("key_entities", [])),
                " ".join(doc.get("related_standards", [])),
                doc.get("project_relevance", ""),
            ]).lower()

            for term in query_terms:
                if term in searchable:
                    score += 1

            if score > 0:
                results.append({**doc, "_relevance_score": score})

        results.sort(key=lambda x: x["_relevance_score"], reverse=True)
        return results

    def get_knowledge_context_for_agent(self, project_domain: str = "electrical", max_docs: int = 10) -> str:
        """
        Generate a knowledge context string for the Project Manager Agent.
        This provides general EKC technical information relevant to the project.

        Args:
            project_domain: Domain of the project (electrical, mechanical, etc.)
            max_docs: Maximum number of documents to include in context

        Returns:
            Formatted string with relevant knowledge summaries
        """
        if not self.is_available():
            return "[EKC Knowledge Base not available]"

        docs = self.index.get("documents", [])
        if not docs:
            return "[EKC Knowledge Base is empty]"

        # Prioritize documents matching the project domain
        domain_docs = [d for d in docs if d.get("domain", "").lower() == project_domain.lower()]
        other_docs = [d for d in docs if d.get("domain", "").lower() != project_domain.lower()]

        selected = domain_docs[:max_docs]
        remaining = max_docs - len(selected)
        if remaining > 0:
            selected.extend(other_docs[:remaining])

        context_parts = [
            f"## EKC Knowledge Base ({self.get_document_count()} documents indexed)",
            "",
        ]

        for doc in selected:
            context_parts.append(f"### {doc.get('title', doc.get('file_name', 'Unknown'))}")
            context_parts.append(f"- **Type**: {doc.get('document_type', 'unknown')}")
            context_parts.append(f"- **Domain**: {doc.get('domain', 'general')}")
            context_parts.append(f"- **Summary**: {doc.get('summary', 'No summary available')}")
            if doc.get("related_standards"):
                context_parts.append(f"- **Standards**: {', '.join(doc['related_standards'])}")
            if doc.get("key_entities"):
                context_parts.append(f"- **Key items**: {', '.join(doc['key_entities'][:5])}")
            if doc.get("project_relevance"):
                context_parts.append(f"- **Relevance**: {doc['project_relevance']}")
            context_parts.append("")

        return "\n".join(context_parts)

    def get_standards_summary(self) -> str:
        """Get a summary of all standards referenced across the knowledge base."""
        all_standards = set()
        for doc in self.index.get("documents", []):
            all_standards.update(doc.get("related_standards", []))

        if not all_standards:
            return "No standards referenced in knowledge base."

        return "Referenced standards: " + ", ".join(sorted(all_standards))


# Singleton instance
_ekc_knowledge_service: Optional[EKCKnowledgeService] = None


def get_ekc_knowledge_service() -> EKCKnowledgeService:
    """Get singleton instance of EKCKnowledgeService."""
    global _ekc_knowledge_service
    if _ekc_knowledge_service is None:
        _ekc_knowledge_service = EKCKnowledgeService()
    return _ekc_knowledge_service
