#!/usr/bin/env python3
"""
EKC Knowledge Metadata Generator
=================================
Processes documents pushed to the knowledge/ directory and generates
searchable metadata using OpenAI API. The metadata is stored as JSON
files in knowledge/.metadata/ and synced to the ekc-knowledge volume.

Usage:
    python generate_metadata.py [--file <path>] [--all] [--output-dir <dir>]

Environment:
    OPENAI_API_KEY - Required. OpenAI API key for metadata generation.
"""

import argparse
import hashlib
import json
import logging
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

# Supported document extensions
SUPPORTED_EXTENSIONS = {
    ".pdf", ".doc", ".docx", ".txt", ".md", ".rst",
    ".xls", ".xlsx", ".csv", ".pptx", ".ppt",
    ".html", ".htm", ".rtf", ".odt", ".ods",
    ".json", ".yaml", ".yml", ".xml",
    ".dwg", ".dxf",  # CAD files (metadata only)
    ".epl", ".zw1",  # EPLAN files
}

# Max file size to read content from (10MB)
MAX_CONTENT_SIZE = 10 * 1024 * 1024

# Text-readable extensions (we can extract content directly)
TEXT_EXTENSIONS = {".txt", ".md", ".rst", ".csv", ".html", ".htm", ".json", ".yaml", ".yml", ".xml"}


def compute_file_hash(filepath: str) -> str:
    """Compute SHA-256 hash of a file."""
    sha256 = hashlib.sha256()
    with open(filepath, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            sha256.update(chunk)
    return sha256.hexdigest()


def extract_text_content(filepath: str, max_chars: int = 15000) -> str:
    """Extract text content from a file for metadata generation."""
    ext = Path(filepath).suffix.lower()

    if ext not in TEXT_EXTENSIONS:
        # For binary files, just return filename and extension info
        return f"[Binary file: {Path(filepath).name}, type: {ext}]"

    try:
        with open(filepath, "r", encoding="utf-8", errors="replace") as f:
            content = f.read(max_chars)
        return content
    except Exception as e:
        logger.warning("Could not read %s: %s", filepath, e)
        return f"[Could not read file: {Path(filepath).name}]"


def generate_metadata_with_openai(
    filepath: str,
    content: str,
    api_key: str,
    model: str = "gpt-4o-mini",
) -> Dict[str, Any]:
    """Call OpenAI API to generate searchable metadata for a document."""
    import urllib.request
    import urllib.error

    filename = Path(filepath).name
    file_ext = Path(filepath).suffix.lower()
    file_size = os.path.getsize(filepath)

    prompt = f"""Analyze the following document and generate structured metadata for a searchable knowledge base.
The metadata should help engineers and project managers quickly find relevant technical information.

Document filename: {filename}
File type: {file_ext}
File size: {file_size} bytes

Document content (may be truncated):
---
{content[:12000]}
---

Generate a JSON object with these fields:
{{
    "title": "A clear, descriptive title for this document",
    "summary": "A 2-3 sentence summary of the document's content and purpose",
    "keywords": ["list", "of", "searchable", "keywords", "max 15"],
    "categories": ["primary_category", "secondary_category"],
    "document_type": "one of: standard, specification, manual, guide, drawing, report, datasheet, correspondence, template, other",
    "domain": "one of: electrical, mechanical, civil, instrumentation, automation, general, management, safety",
    "language": "detected language (e.g., en, fa, de)",
    "technical_level": "one of: basic, intermediate, advanced, expert",
    "related_standards": ["IEC xxxx", "IEEE xxx"],
    "key_entities": ["names of equipment, systems, or components mentioned"],
    "applicable_voltage_level": "if applicable: ELV, LV, MV, HV, or N/A",
    "project_relevance": "Brief note on how this document might be useful for industrial electrical projects"
}}

Return ONLY the JSON object, no markdown formatting."""

    request_body = json.dumps({
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": "You are a technical document analyst specializing in industrial electrical engineering. Generate accurate, searchable metadata for documents in a knowledge management system.",
            },
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.3,
        "max_tokens": 1500,
    }).encode("utf-8")

    req = urllib.request.Request(
        "https://api.openai.com/v1/chat/completions",
        data=request_body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        method="POST",
    )

    max_retries = 3
    for attempt in range(max_retries):
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                result = json.loads(resp.read().decode("utf-8"))
            content_str = result["choices"][0]["message"]["content"].strip()

            # Strip markdown fences if present
            if content_str.startswith("```"):
                lines = content_str.split("\n")
                content_str = "\n".join(lines[1:])
                if content_str.endswith("```"):
                    content_str = content_str[:-3]
                content_str = content_str.strip()

            metadata = json.loads(content_str)
            return metadata
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < max_retries - 1:
                wait_time = 2 ** (attempt + 1)
                logger.warning("Rate limited, retrying in %ds...", wait_time)
                time.sleep(wait_time)
                continue
            logger.error("OpenAI API error: %s %s", e.code, e.read().decode())
            raise
        except json.JSONDecodeError as e:
            logger.error("Failed to parse OpenAI response as JSON: %s", e)
            # Return a basic metadata structure as fallback
            return {
                "title": filename,
                "summary": f"Document: {filename} ({file_ext})",
                "keywords": [filename.rsplit(".", 1)[0]],
                "categories": ["uncategorized"],
                "document_type": "other",
                "domain": "general",
                "language": "unknown",
                "technical_level": "intermediate",
                "related_standards": [],
                "key_entities": [],
                "applicable_voltage_level": "N/A",
                "project_relevance": "Metadata generation failed - manual review needed",
            }

    raise RuntimeError("Max retries exceeded for OpenAI API call")


def process_document(
    filepath: str,
    output_dir: str,
    api_key: str,
    force: bool = False,
) -> Optional[Dict[str, Any]]:
    """Process a single document and generate metadata."""
    filepath = os.path.abspath(filepath)
    filename = Path(filepath).name
    ext = Path(filepath).suffix.lower()

    if ext not in SUPPORTED_EXTENSIONS:
        logger.info("Skipping unsupported file type: %s", filename)
        return None

    # Compute hash to detect changes
    file_hash = compute_file_hash(filepath)

    # Check if metadata already exists and is up to date
    metadata_filename = Path(filename).stem + ".metadata.json"
    metadata_path = os.path.join(output_dir, metadata_filename)

    if not force and os.path.exists(metadata_path):
        try:
            with open(metadata_path, "r") as f:
                existing = json.load(f)
            if existing.get("file_hash") == file_hash:
                logger.info("Metadata up to date for: %s", filename)
                return existing
        except (json.JSONDecodeError, KeyError):
            pass  # Regenerate if metadata is corrupt

    logger.info("Generating metadata for: %s", filename)

    # Extract text content
    content = extract_text_content(filepath)

    # Generate metadata using OpenAI
    ai_metadata = generate_metadata_with_openai(filepath, content, api_key)

    # Build full metadata record
    stat = os.stat(filepath)
    metadata = {
        "file_name": filename,
        "file_path": filepath,
        "file_extension": ext,
        "file_size_bytes": stat.st_size,
        "file_hash": file_hash,
        "created_at": datetime.fromtimestamp(stat.st_ctime, tz=timezone.utc).isoformat(),
        "modified_at": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
        "metadata_generated_at": datetime.now(tz=timezone.utc).isoformat(),
        "metadata_version": "1.0",
        **ai_metadata,
    }

    # Write metadata file
    os.makedirs(output_dir, exist_ok=True)
    with open(metadata_path, "w", encoding="utf-8") as f:
        json.dump(metadata, f, indent=2, ensure_ascii=False)

    logger.info("Metadata written to: %s", metadata_path)
    return metadata


def build_knowledge_index(metadata_dir: str) -> Dict[str, Any]:
    """Build a consolidated searchable index from all metadata files."""
    index = {
        "version": "1.0",
        "generated_at": datetime.now(tz=timezone.utc).isoformat(),
        "total_documents": 0,
        "documents": [],
        "keyword_index": {},
        "category_index": {},
        "domain_index": {},
    }

    for fname in sorted(os.listdir(metadata_dir)):
        if not fname.endswith(".metadata.json"):
            continue

        fpath = os.path.join(metadata_dir, fname)
        try:
            with open(fpath, "r", encoding="utf-8") as f:
                meta = json.load(f)
        except (json.JSONDecodeError, OSError) as e:
            logger.warning("Skipping corrupt metadata: %s (%s)", fname, e)
            continue

        doc_entry = {
            "file_name": meta.get("file_name", fname),
            "title": meta.get("title", ""),
            "summary": meta.get("summary", ""),
            "keywords": meta.get("keywords", []),
            "categories": meta.get("categories", []),
            "domain": meta.get("domain", "general"),
            "document_type": meta.get("document_type", "other"),
            "language": meta.get("language", "unknown"),
            "technical_level": meta.get("technical_level", "intermediate"),
            "applicable_voltage_level": meta.get("applicable_voltage_level", "N/A"),
            "related_standards": meta.get("related_standards", []),
            "key_entities": meta.get("key_entities", []),
            "project_relevance": meta.get("project_relevance", ""),
            "metadata_file": fname,
        }
        index["documents"].append(doc_entry)
        index["total_documents"] += 1

        # Build keyword index
        for kw in meta.get("keywords", []):
            kw_lower = kw.lower()
            if kw_lower not in index["keyword_index"]:
                index["keyword_index"][kw_lower] = []
            index["keyword_index"][kw_lower].append(meta.get("file_name", fname))

        # Build category index
        for cat in meta.get("categories", []):
            cat_lower = cat.lower()
            if cat_lower not in index["category_index"]:
                index["category_index"][cat_lower] = []
            index["category_index"][cat_lower].append(meta.get("file_name", fname))

        # Build domain index
        domain = meta.get("domain", "general").lower()
        if domain not in index["domain_index"]:
            index["domain_index"][domain] = []
        index["domain_index"][domain].append(meta.get("file_name", fname))

    # Write index
    index_path = os.path.join(metadata_dir, "_index.json")
    with open(index_path, "w", encoding="utf-8") as f:
        json.dump(index, f, indent=2, ensure_ascii=False)

    logger.info("Knowledge index built: %d documents", index["total_documents"])
    return index


def main():
    parser = argparse.ArgumentParser(description="Generate searchable metadata for EKC knowledge documents")
    parser.add_argument("--file", "-f", help="Process a specific file")
    parser.add_argument("--all", "-a", action="store_true", help="Process all documents in knowledge/")
    parser.add_argument("--changed", "-c", nargs="*", help="Process specific changed files (space-separated)")
    parser.add_argument("--output-dir", "-o", default=None, help="Output directory for metadata (default: knowledge/.metadata)")
    parser.add_argument("--knowledge-dir", "-k", default=None, help="Knowledge documents directory (default: knowledge/)")
    parser.add_argument("--force", action="store_true", help="Regenerate even if metadata exists")
    parser.add_argument("--model", default="gpt-4o-mini", help="OpenAI model to use (default: gpt-4o-mini)")
    args = parser.parse_args()

    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        logger.error("OPENAI_API_KEY environment variable is required")
        sys.exit(1)

    # Determine directories
    script_dir = Path(__file__).parent.resolve()
    knowledge_dir = Path(args.knowledge_dir) if args.knowledge_dir else script_dir
    output_dir = Path(args.output_dir) if args.output_dir else knowledge_dir / ".metadata"

    os.makedirs(output_dir, exist_ok=True)

    processed = 0
    errors = 0

    if args.file:
        # Process single file
        fpath = Path(args.file)
        if not fpath.exists():
            logger.error("File not found: %s", fpath)
            sys.exit(1)
        result = process_document(str(fpath), str(output_dir), api_key, force=args.force)
        if result:
            processed += 1

    elif args.changed is not None:
        # Process specific changed files
        for f in args.changed:
            fpath = Path(f)
            if not fpath.exists():
                logger.warning("Skipping missing file: %s", f)
                continue
            if fpath.suffix.lower() not in SUPPORTED_EXTENSIONS:
                logger.info("Skipping unsupported: %s", f)
                continue
            try:
                result = process_document(str(fpath), str(output_dir), api_key, force=args.force)
                if result:
                    processed += 1
            except Exception as e:
                logger.error("Error processing %s: %s", f, e)
                errors += 1

    elif args.all:
        # Process all documents
        for entry in sorted(knowledge_dir.iterdir()):
            if entry.name.startswith(".") or entry.is_dir():
                continue
            if entry.suffix.lower() not in SUPPORTED_EXTENSIONS:
                continue
            if entry.name == "generate_metadata.py":
                continue
            try:
                result = process_document(str(entry), str(output_dir), api_key, force=args.force)
                if result:
                    processed += 1
            except Exception as e:
                logger.error("Error processing %s: %s", entry.name, e)
                errors += 1
    else:
        parser.print_help()
        sys.exit(1)

    # Rebuild the consolidated index
    if processed > 0:
        build_knowledge_index(str(output_dir))

    logger.info("Done. Processed: %d, Errors: %d", processed, errors)

    if errors > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
