"""
Document Chunking Service
==========================
Intelligently chunks markdown documents section-by-section
for optimal vector storage and semantic search.

Author: Simorgh Industrial Assistant
"""

import re
import logging
from typing import List, Dict, Any, Optional
from dataclasses import dataclass

logger = logging.getLogger(__name__)


@dataclass
class DocumentChunk:
    """Represents a document chunk"""
    text: str
    section_title: str
    chunk_index: int
    heading_level: int
    char_count: int
    metadata: Dict[str, Any]


class DocumentChunker:
    """
    Chunks documents intelligently by sections for vector storage
    """

    def __init__(
        self,
        max_chunk_size: int = 1000,
        min_chunk_size: int = 100,
        overlap_size: int = 50,
        preserve_structure: bool = True
    ):
        """
        Initialize document chunker

        Args:
            max_chunk_size: Maximum characters per chunk
            min_chunk_size: Minimum characters per chunk
            overlap_size: Overlap between chunks (for context preservation)
            preserve_structure: Keep section structure intact
        """
        self.max_chunk_size = max_chunk_size
        self.min_chunk_size = min_chunk_size
        self.overlap_size = overlap_size
        self.preserve_structure = preserve_structure

    def chunk_markdown(
        self,
        markdown_content: str,
        document_id: str,
        filename: str = ""
    ) -> List[Dict[str, Any]]:
        """
        Chunk markdown content by sections

        Args:
            markdown_content: Markdown text content
            document_id: Unique document identifier
            filename: Original filename (for metadata)

        Returns:
            List of chunk dictionaries ready for Qdrant
        """
        logger.info(f"📄 Starting markdown chunking for: {filename}")

        # Split document into sections
        sections = self._split_by_sections(markdown_content)

        logger.info(f"📑 Found {len(sections)} sections in document")

        # Process sections into chunks
        chunks = []
        chunk_index = 0

        for section in sections:
            section_chunks = self._process_section(
                section=section,
                start_index=chunk_index
            )
            chunks.extend(section_chunks)
            chunk_index += len(section_chunks)

        # Format chunks for Qdrant
        formatted_chunks = []
        for chunk in chunks:
            formatted_chunks.append({
                "text": chunk.text,
                "section_title": chunk.section_title,
                "chunk_index": chunk.chunk_index,
                "metadata": {
                    "document_id": document_id,
                    "filename": filename,
                    "heading_level": chunk.heading_level,
                    "char_count": chunk.char_count,
                    **chunk.metadata
                }
            })

        logger.info(f"✅ Created {len(formatted_chunks)} chunks from document")

        return formatted_chunks

    def _split_by_sections(self, markdown_content: str) -> List[Dict[str, Any]]:
        """
        Split markdown content into sections based on headings

        Args:
            markdown_content: Markdown text

        Returns:
            List of section dictionaries
        """
        sections = []

        # Regex pattern for markdown headings (# to ######)
        heading_pattern = r'^(#{1,6})\s+(.+)$'

        lines = markdown_content.split('\n')
        current_section = {
            "heading": "Introduction",
            "heading_level": 0,
            "content": []
        }

        for line in lines:
            # Check if line is a heading
            match = re.match(heading_pattern, line, re.MULTILINE)

            if match:
                # Save previous section if it has content
                if current_section["content"]:
                    current_section["content"] = '\n'.join(current_section["content"])
                    sections.append(current_section)

                # Start new section
                heading_level = len(match.group(1))  # Number of # symbols
                heading_text = match.group(2).strip()

                current_section = {
                    "heading": heading_text,
                    "heading_level": heading_level,
                    "content": []
                }
            else:
                # Add line to current section
                current_section["content"].append(line)

        # Add final section
        if current_section["content"]:
            current_section["content"] = '\n'.join(current_section["content"])
            sections.append(current_section)

        return sections

    def _process_section(
        self,
        section: Dict[str, Any],
        start_index: int
    ) -> List[DocumentChunk]:
        """
        Process a section into chunks

        Args:
            section: Section dictionary with heading and content
            start_index: Starting chunk index

        Returns:
            List of DocumentChunk objects
        """
        heading = section["heading"]
        heading_level = section["heading_level"]
        content = section["content"].strip()

        # If section is small enough, keep as single chunk
        if len(content) <= self.max_chunk_size:
            return [DocumentChunk(
                text=content,
                section_title=heading,
                chunk_index=start_index,
                heading_level=heading_level,
                char_count=len(content),
                metadata={"is_complete_section": True}
            )]

        # Otherwise, split into multiple chunks with overlap
        chunks = []
        chunk_start = 0
        chunk_idx = start_index

        while chunk_start < len(content):
            # Calculate chunk end
            chunk_end = min(chunk_start + self.max_chunk_size, len(content))

            # Try to break at sentence boundary
            if chunk_end < len(content):
                # Look for sentence endings near chunk_end
                sentence_breaks = ['.', '!', '?', '\n\n']
                best_break = chunk_end

                for i in range(chunk_end, max(chunk_end - 200, chunk_start), -1):
                    if content[i] in sentence_breaks:
                        best_break = i + 1
                        break

                chunk_end = best_break

            # Extract chunk text
            chunk_text = content[chunk_start:chunk_end].strip()

            # Skip if chunk is too small (unless it's the last one)
            if len(chunk_text) < self.min_chunk_size and chunk_end < len(content):
                chunk_start = chunk_end
                continue

            # Create chunk
            chunks.append(DocumentChunk(
                text=chunk_text,
                section_title=heading,
                chunk_index=chunk_idx,
                heading_level=heading_level,
                char_count=len(chunk_text),
                metadata={
                    "is_complete_section": False,
                    "part_number": chunk_idx - start_index + 1,
                    "total_parts": "unknown"  # Will be updated after
                }
            ))

            chunk_idx += 1

            # Move to next chunk with overlap
            chunk_start = chunk_end - self.overlap_size if chunk_end < len(content) else chunk_end

        # Update total_parts metadata
        total_parts = len(chunks)
        for chunk in chunks:
            chunk.metadata["total_parts"] = total_parts

        return chunks

    def chunk_by_paragraphs(
        self,
        text: str,
        document_id: str,
        filename: str = ""
    ) -> List[Dict[str, Any]]:
        """
        Alternative chunking strategy: by paragraphs

        Args:
            text: Text content
            document_id: Document identifier
            filename: Original filename

        Returns:
            List of paragraph-based chunks
        """
        paragraphs = text.split('\n\n')
        chunks = []

        for idx, para in enumerate(paragraphs):
            para = para.strip()
            if len(para) < self.min_chunk_size:
                continue

            chunks.append({
                "text": para,
                "section_title": f"Paragraph {idx + 1}",
                "chunk_index": idx,
                "metadata": {
                    "document_id": document_id,
                    "filename": filename,
                    "heading_level": 0,
                    "char_count": len(para),
                    "chunking_strategy": "paragraph"
                }
            })

        logger.info(f"✅ Created {len(chunks)} paragraph-based chunks")
        return chunks

    def chunk_by_tokens(
        self,
        text: str,
        document_id: str,
        filename: str = "",
        max_tokens: int = 512
    ) -> List[Dict[str, Any]]:
        """
        Alternative chunking strategy: by token count (approximate)

        Args:
            text: Text content
            document_id: Document identifier
            filename: Original filename
            max_tokens: Maximum tokens per chunk (approximate)

        Returns:
            List of token-based chunks
        """
        # Rough approximation: 1 token ≈ 4 characters
        max_chars = max_tokens * 4

        chunks = []
        chunk_start = 0
        chunk_idx = 0

        while chunk_start < len(text):
            chunk_end = min(chunk_start + max_chars, len(text))

            # Try to break at whitespace
            if chunk_end < len(text):
                # Look for space near chunk_end
                for i in range(chunk_end, max(chunk_end - 50, chunk_start), -1):
                    if text[i].isspace():
                        chunk_end = i
                        break

            chunk_text = text[chunk_start:chunk_end].strip()

            if len(chunk_text) >= self.min_chunk_size:
                chunks.append({
                    "text": chunk_text,
                    "section_title": f"Chunk {chunk_idx + 1}",
                    "chunk_index": chunk_idx,
                    "metadata": {
                        "document_id": document_id,
                        "filename": filename,
                        "heading_level": 0,
                        "char_count": len(chunk_text),
                        "chunking_strategy": "token_based",
                        "approx_tokens": len(chunk_text) // 4
                    }
                })
                chunk_idx += 1

            chunk_start = chunk_end

        logger.info(f"✅ Created {len(chunks)} token-based chunks")
        return chunks

    def get_chunk_statistics(self, chunks: List[Dict[str, Any]]) -> Dict[str, Any]:
        """
        Get statistics about chunks

        Args:
            chunks: List of chunk dictionaries

        Returns:
            Statistics dictionary
        """
        if not chunks:
            return {
                "total_chunks": 0,
                "avg_chunk_size": 0,
                "min_chunk_size": 0,
                "max_chunk_size": 0,
                "total_chars": 0
            }

        char_counts = [chunk["metadata"]["char_count"] for chunk in chunks]

        return {
            "total_chunks": len(chunks),
            "avg_chunk_size": sum(char_counts) / len(char_counts),
            "min_chunk_size": min(char_counts),
            "max_chunk_size": max(char_counts),
            "total_chars": sum(char_counts),
            "unique_sections": len(set(chunk["section_title"] for chunk in chunks))
        }
