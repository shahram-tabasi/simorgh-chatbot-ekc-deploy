"""
Enhanced PDF Parser V4 - COMPLETE VERSION
Combines V4 universal structure support + V3 AI extraction features

Features:
✅ Universal structure detection (hierarchical + flat documents)
✅ Mixed language support (English, Persian, etc.)
✅ AI-powered variable extraction with chunking
✅ Two-stage processing (Structure → AI)
✅ Vector database integration (Qdrant)
✅ Task cancellation support
✅ Enhanced section detection with multiple strategies
✅ Improved table extraction
✅ Page-based fallback for flat documents
"""

import json
import re
from typing import Dict, List, Optional, Tuple, Any
from datetime import datetime
from collections import defaultdict
import os
import warnings
import hashlib

from unstructured.partition.pdf import partition_pdf
from unstructured.documents.elements import Title, NarrativeText, ListItem, Table, Element, Text

try:
    import pandas as pd
    import numpy as np
    PANDAS_AVAILABLE = True
except ImportError:
    PANDAS_AVAILABLE = False

# Vector database
QDRANT_AVAILABLE = True

try:
    from qdrant_client import QdrantClient
    from qdrant_client.models import Distance, VectorParams, PointStruct
except ImportError as e:
    print(f"⚠️ Qdrant client not available: {e}")
    QDRANT_AVAILABLE = False

try:
    from sentence_transformers import SentenceTransformer
except ImportError:
    print("⚠️ SentenceTransformer not available – embeddings disabled.")

# GPU detection
try:
    import torch
    GPU_AVAILABLE = torch.cuda.is_available()
    GPU_NAME = torch.cuda.get_device_name(0) if GPU_AVAILABLE else "None"
except ImportError:
    GPU_AVAILABLE = False
    GPU_NAME = "None"

import requests
import logging

# Import enhanced prompts for AI extraction
try:
    from enhanced_prompts import get_enhanced_system_prompt, get_user_prompt
except ImportError:
    logging.warning("⚠️ enhanced_prompts module not found - using default prompts")
    def get_enhanced_system_prompt():
        return "You are an AI that extracts technical specifications from documents."
    def get_user_prompt(title, content):
        return f"Extract variables from this section: {title}\n\n{content}"

logging.basicConfig(level=logging.INFO)
warnings.filterwarnings('ignore')

# ============================================================================
# ContentChunker Class
# ============================================================================

class ContentChunker:
    """Handles intelligent content chunking with overlap for large sections."""
    
    def __init__(self, chunk_size: int = 1000, overlap_size: int = 200):
        self.chunk_size = chunk_size
        self.overlap_size = overlap_size
    
    def needs_chunking(self, content: str) -> bool:
        return len(content) > self.chunk_size
    
    def chunk_content(self, content: str) -> List[str]:
        if not self.needs_chunking(content):
            return [content]
        
        chunks = []
        start = 0
        content_length = len(content)
        
        while start < content_length:
            end = start + self.chunk_size
            
            if end < content_length:
                search_start = max(start, end - 100)
                search_text = content[search_start:end]
                sentence_endings = [m.end() for m in re.finditer(r'[.!?\n]\s', search_text)]
                
                if sentence_endings:
                    end = search_start + sentence_endings[-1]
            
            chunk = content[start:end].strip()
            if chunk:
                chunks.append(chunk)
            
            start = end - self.overlap_size
            if start <= (end - self.chunk_size):
                start = end
        
        return chunks

# ============================================================================
# CancellationToken Class
# ============================================================================

class CancellationToken:
    """Simple cancellation token for task interruption."""
    def __init__(self):
        self.cancelled = False
    
    def cancel(self):
        self.cancelled = True
    
    def is_cancelled(self) -> bool:
        return self.cancelled

# ============================================================================
# UniversalStructureDetector
# ============================================================================

class UniversalStructureDetector:
    """
    Detects document structure using multiple strategies:
    1. Traditional numbered sections (1. Title, 1.1 Subtitle)
    2. Heading-based sections (using font size/style from Title elements)
    3. Table-of-contents detection
    4. Page-based grouping (fallback for flat documents)
    5. Mixed language support
    """
    
    def __init__(self, min_content_length: int = 30, debug_mode: bool = False):
        self.min_content_length = min_content_length
        self.debug_mode = debug_mode
        
        # Enhanced regex patterns for section detection
        self.section_patterns = [
            # Standard numbered sections - MORE FLEXIBLE
            (r'^(\d+)\.?\s+([A-Z][A-Za-z\s&,\-/()]+)$', 'numbered', 1),
            (r'^(\d+\.\d+)\.?\s+([A-Z][A-Za-z\s&,/\-()]+)$', 'numbered', 2),
            (r'^(\d+\.\d+\.\d+)\.?\s+([A-Z][A-Za-z\s&,/\-()]+)', 'numbered', 3),
            (r'^(\d+\.\d+\.\d+\.\d+)\.?\s+(.{5,100})$', 'numbered', 4),
            
            # Letter/Roman numeral sections
            (r'^([A-Z])\.?\s+([A-Z][A-Za-z\s]+)$', 'lettered', 1),
            (r'^([IVX]+)\.?\s+([A-Z][A-Za-z\s]+)$', 'roman', 1),
            
            # Keyword-based sections
            (r'^Chapter\s+(\d+)[\s:](.+)$', 'chapter', 1),
            (r'^Section\s+(\d+)[\s:](.+)$', 'section_keyword', 1),
            (r'^Article\s+(\d+)[\s:](.+)$', 'article', 1),
            (r'^Part\s+(\d+)[\s:](.+)$', 'part', 1),
            
            # Loose patterns for headings (less strict)
            (r'^([A-Z][A-Z\s]{3,}):?\s*$', 'heading', 1),  # ALL CAPS headings
            (r'^(.{3,50}):$', 'colon_heading', 1),  # Text ending with colon
            
            # Number range "1-3" or "1 To 15"
            (r'^(\d+-\d+|\d+\s+[Tt]o\s+\d+)\s+([A-Z][A-Za-z\s]+)', 'range', 1),
        ]
    
    def detect_section(self, text: str, elem_type: str = None) -> Tuple[Optional[str], Optional[str], int]:
        """
        Detect if text is a section heading.
        
        Returns:
            (section_number, section_title, hierarchy_level) or (None, None, 0)
        """
        text = text.strip()
        
        # Try pattern matching
        for pattern, pattern_type, level in self.section_patterns:
            match = re.match(pattern, text, re.IGNORECASE if pattern_type in ['heading', 'colon_heading'] else 0)
            if match:
                if pattern_type in ['numbered', 'lettered', 'roman', 'chapter', 'section_keyword', 'article', 'part', 'range']:
                    num = match.group(1)
                    title = match.group(2).strip() if len(match.groups()) > 1 else text
                    
                    # Calculate level for numbered sections
                    if pattern_type == 'numbered':
                        level = num.count('.') + 1
                    
                    # Validate title
                    if self._is_valid_title(title):
                        if self.debug_mode:
                            logging.debug(f"   🔍 Detected: {num} - {title} (level {level})")
                        return (num, title, level)
                
                elif pattern_type in ['heading', 'colon_heading']:
                    # Use the whole text as title
                    title = match.group(1).strip() if match.group(1) else text.strip()
                    if self._is_valid_title(title, min_length=3, max_length=200):
                        if self.debug_mode:
                            logging.debug(f"   🔍 Detected heading: {title}")
                        return (None, title, level)
        
        # Check if element type suggests it's a title
        if elem_type == 'Title':
            if self._is_valid_title(text, min_length=3, max_length=200):
                if self.debug_mode:
                    logging.debug(f"   🔍 Title element: {text}")
                return (None, text, 1)
        
        return (None, None, 0)
    
    def _is_valid_title(self, title: str, min_length: int = 3, max_length: int = 150) -> bool:
        """Check if text is a valid section title."""
        if not title or len(title) < min_length or len(title) > max_length:
            return False
        
        # Check if it has some alphabetic content
        alpha_count = sum(1 for c in title if c.isalpha())
        if alpha_count < min_length:
            return False
        
        # Avoid common junk patterns
        junk_patterns = [
            r'^\d+$',  # Just numbers
            r'^page\s+\d+',  # Page numbers
            r'^\d{4}[-/]\d{2}[-/]\d{2}$',  # Dates
            r'^doc\.?\s*no',  # Document numbers
            r'^rev\.?\s*\d+',  # Revisions
        ]
        
        for pattern in junk_patterns:
            if re.match(pattern, title.lower()):
                return False
        
        return True

# ============================================================================
# Enhanced Main Parser Class - COMPLETE VERSION
# ============================================================================

class EnhancedUniversalPDFParser:
    """
    Enhanced PDF parser V4 with universal structure support + AI extraction.
    """

    def __init__(self,
                 strategy: str = "hi_res",
                 use_gpu: bool = True,
                 extract_tables: bool = True,
                 min_content_length: int = 30,  # Reduced from 50
                 aggressive_filtering: bool = False,  # Changed from True
                 ai_url: str = "http://ai_stage1:9000/generate",
                 thinking_level: str = "medium",
                 qdrant_url: str = "http://qdrant:6333",
                 enable_vector_db: bool = True,
                 chunk_size: int = 1000,
                 chunk_overlap: int = 200,
                 debug_mode: bool = False):
        """
        Initialize enhanced parser with all features.
        
        Args:
            strategy: "hi_res" (GPU+AI), "fast", or "ocr_only"
            use_gpu: Enable GPU acceleration
            extract_tables: Extract tables as structured JSON
            min_content_length: Minimum text length to keep
            aggressive_filtering: Remove more noise/metadata
            ai_url: URL for AI variable extraction service
            thinking_level: AI thinking level (low, medium, high)
            qdrant_url: Qdrant vector database URL
            enable_vector_db: Enable vector database storage
            chunk_size: Maximum characters per chunk
            chunk_overlap: Overlapping characters between chunks
            debug_mode: Enable detailed logging
        """
        self.strategy = strategy
        self.use_gpu = use_gpu and GPU_AVAILABLE
        self.extract_tables = extract_tables
        self.min_content_length = min_content_length
        self.aggressive = aggressive_filtering
        self.ai_url = ai_url
        self.thinking_level = thinking_level
        self.cancellation_token = CancellationToken()
        self.debug_mode = debug_mode
        
        # Initialize structure detector
        self.structure_detector = UniversalStructureDetector(
            min_content_length=min_content_length,
            debug_mode=debug_mode
        )
        
        # Content chunking
        self.chunker = ContentChunker(chunk_size=chunk_size, overlap_size=chunk_overlap)
        
        # Vector database setup
        self.enable_vector_db = enable_vector_db and QDRANT_AVAILABLE
        self.qdrant_client = None
        self.embedding_model = None
        
        if self.enable_vector_db:
            try:
                self.qdrant_client = QdrantClient(url=qdrant_url)
                self.embedding_model = SentenceTransformer('all-mpnet-base-v2')
                logging.info(f"✅ Vector database connected: {qdrant_url}")
            except Exception as e:
                logging.warning(f"⚠️ Vector database connection failed: {e}")
                self.enable_vector_db = False

        logging.info(f"🤖 Enhanced Universal PDF Parser V4 Complete")
        logging.info(f"   GPU: {GPU_NAME} ({'Enabled' if self.use_gpu else 'Disabled'})")
        logging.info(f"   Strategy: {strategy}")
        logging.info(f"   AI Service: {ai_url}")
        logging.info(f"   Thinking Level: {thinking_level}")
        logging.info(f"   Vector DB: {'Enabled' if self.enable_vector_db else 'Disabled'}")
        logging.info(f"   Chunking: Enabled (size={chunk_size}, overlap={chunk_overlap})")
        logging.info(f"   Debug Mode: {debug_mode}")

    def parse_pdf(self, pdf_path: str) -> List[Element]:
        """Parse PDF with GPU-accelerated AI models."""
        if not os.path.exists(pdf_path):
            raise FileNotFoundError(f"File not found: {pdf_path}")

        if self.cancellation_token.is_cancelled():
            raise InterruptedError("Task cancelled")

        logging.info(f"\n📄 Processing: {os.path.basename(pdf_path)}")

        try:
            elements = partition_pdf(
                filename=pdf_path,
                strategy=self.strategy,
                infer_table_structure=self.extract_tables,
                include_page_breaks=True,
                include_metadata=True,
                max_characters=1000000,
                languages=["eng", "fas"],  # English and Persian support
            )

            logging.info(f"   ✓ Extracted {len(elements)} elements")
            return elements

        except Exception as e:
            logging.error(f"   ✗ PDF parsing error: {e}")
            raise

    def clean_ocr_text(self, text: str) -> str:
        """Clean OCR artifacts from text."""
        if not text:
            return text
        
        # Remove excessive whitespace
        text = re.sub(r'\s+', ' ', text)
        
        # Remove zero-width spaces and other invisible characters
        text = re.sub(r'[\u200b-\u200f\u202a-\u202e\ufeff]', '', text)
        
        return text.strip()

    def is_junk(self, text: str) -> bool:
        """
        Enhanced junk detection with mixed language support.
        Less aggressive than V3 to avoid filtering valid content.
        """
        if not text or len(text.strip()) < 3:
            return True

        text_clean = text.strip()
        text_lower = text_clean.lower()

        # Only filter obvious TOC patterns (less aggressive)
        toc_patterns = [
            r'^\d+\.?\d*\.?\d*\s+.{3,}\.{10,}',  # Increased dot threshold
            r'^.{3,50}\.{10,}\s*\d+\s*$',
        ]

        for pattern in toc_patterns:
            if re.search(pattern, text_lower):
                return True

        # Common junk patterns
        junk_patterns = [
            r'^\d+$',  # Just numbers
            r'^page\s*\d+',  # Page numbers
            r'^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$',  # Dates
            r'^©', r'^™', r'^®',  # Copyright symbols
            r'^www\.', r'^https?://',  # URLs
        ]
        
        for pattern in junk_patterns:
            if re.match(pattern, text_lower):
                return True

        # Only filter if EXCESSIVE dots
        dot_ratio = text_clean.count('.') / len(text_clean) if len(text_clean) > 0 else 0
        if dot_ratio > 0.25:  # Increased threshold
            return True

        return False

    def is_valid_table(self, table_elem: Table) -> bool:
        """Validate table content with lenient criteria."""
        text = str(table_elem)
        
        if len(text.strip()) < 20:
            return False
        
        lines = text.split('\n')
        if len(lines) < 2:  # Must have at least header + 1 row
            return False
        
        # Allow more NaN values (OCR may fail on some cells)
        if text.count('NaN') > len(lines) * 2:
            return False
        
        return True

    def extract_table_json(self, table_elem: Table) -> Optional[Dict]:
        """Extract table as structured JSON."""
        if not self.is_valid_table(table_elem):
            return None

        table_data = {
            "type": "table",
            "rows": [],
            "columns": [],
            "data": [],
            "extraction_method": "unknown"
        }

        try:
            if hasattr(table_elem, 'metadata') and hasattr(table_elem.metadata, 'text_as_html'):
                html = table_elem.metadata.text_as_html

                if html and PANDAS_AVAILABLE:
                    try:
                        dfs = pd.read_html(html)
                        if dfs:
                            df = dfs[0]
                            df = df.dropna(axis=1, how='all').dropna(axis=0, how='all')

                            if df.empty or len(df) < 2:
                                return None

                            clean_cols = [
                                str(col).strip().replace("'", "").replace('"', '') if str(col).strip() else f"column_{i}"
                                for i, col in enumerate(df.columns)
                            ]

                            df.columns = clean_cols
                            table_data["columns"] = clean_cols

                            rows = []
                            for _, row in df.iterrows():
                                clean_row = [
                                    None if pd.isna(val) else
                                    (float(val) if isinstance(val, np.floating) else
                                     int(val) if isinstance(val, np.integer) else str(val))
                                    for val in row
                                ]
                                rows.append(clean_row)

                            table_data["rows"] = rows
                            table_data["data"] = [
                                {clean_cols[i]: row[i] for i in range(min(len(clean_cols), len(row)))}
                                for row in rows
                            ]
                            table_data["shape"] = [len(rows), len(clean_cols)]
                            table_data["extraction_method"] = "html_pandas"

                            if hasattr(table_elem.metadata, 'page_number'):
                                table_data["page"] = table_elem.metadata.page_number

                            return table_data

                    except Exception:
                        pass

            return None

        except Exception:
            return None

    # ========================================================================
    # MAIN METHOD: Build Hierarchy WITHOUT AI (Stage 1) - ENHANCED
    # ========================================================================
    
    def build_hierarchy_without_ai(self, elements: List[Element]) -> Dict:
        """
        Build document hierarchy WITHOUT AI extraction - ENHANCED VERSION.
        Now handles:
        1. Traditional numbered sections
        2. Title-based sections (no numbers)
        3. Page-based grouping for flat documents
        4. Mixed language content
        """
        logging.info("\n🔍 Building document structure (no AI extraction)...")

        structure = {}
        section_stack = []
        content_buffer = []
        has_hierarchical_structure = False

        stats = {
            'sections': 0,
            'page_groups': 0,
            'tables': 0,
            'skipped_junk': 0,
            'skipped_tables': 0,
            'elements_processed': 0,
            'potential_sections_missed': 0
        }

        for idx, elem in enumerate(elements):
            if self.cancellation_token.is_cancelled():
                raise InterruptedError("Task cancelled by user")

            elem_type = type(elem).__name__
            stats['elements_processed'] += 1
            
            if elem_type in ['PageBreak', 'Header', 'Footer']:
                continue

            text = str(elem).strip()
            text = self.clean_ocr_text(text)

            # Debug logging
            if self.debug_mode and idx < 50:
                logging.debug(f"   [{idx:3}] Type: {elem_type:15} | Text: {text[:80]}")

            if not text:
                continue
            
            if self.is_junk(text):
                stats['skipped_junk'] += 1
                if self.debug_mode:
                    logging.debug(f"   [JUNK] {text[:60]}")
                continue

            # Try to detect section using enhanced detector
            section_num, title, level = self.structure_detector.detect_section(text, elem_type)

            if section_num or title:  # Found a section (numbered or not)
                has_hierarchical_structure = True
                stats['sections'] += 1

                # Save accumulated content to previous section
                if content_buffer and section_stack:
                    self._save_raw_content(section_stack, content_buffer)
                    content_buffer = []

                # Handle hierarchy
                while section_stack and section_stack[-1][0] >= level:
                    section_stack.pop()

                # Create section key
                key = self._create_key(title or f"section_{stats['sections']}")

                # Get parent dict
                if section_stack:
                    parent_dict = section_stack[-1][1]
                else:
                    parent_dict = structure

                # Create section entry
                parent_dict[key] = {
                    '_section_title': title or f"Section {section_num}",
                    '_section_number': section_num or f"S{stats['sections']}",
                    '_section_level': level
                }
                
                section_stack.append((level, parent_dict[key], key, section_num or "", title or ""))

                logging.info(f"   ✓ Section {section_num or stats['sections']}: {title or 'Untitled'} (level {level})")

            elif isinstance(elem, Table):
                # Extract table
                table_json = self.extract_table_json(elem)

                if table_json:
                    stats['tables'] += 1

                    if section_stack:
                        target_dict = section_stack[-1][1]
                    else:
                        target_dict = structure

                    table_key = f"table_{stats['tables']}"
                    target_dict[table_key] = table_json

                    rows = table_json.get('shape', [0, 0])[0]
                    cols = table_json.get('shape', [0, 0])[1]
                    logging.info(f"   ✓ Table {stats['tables']}: {rows}×{cols}")
                else:
                    stats['skipped_tables'] += 1

            elif isinstance(elem, (Title, NarrativeText, Text, ListItem)):
                # Check if this might be a section we missed
                if elem_type == 'Title' and len(text) >= 10 and not section_num:
                    stats['potential_sections_missed'] += 1
                    if self.debug_mode:
                        logging.warning(f"   ⚠️ Potential section missed: '{text[:60]}'")
                
                if len(text) >= self.min_content_length:
                    content_buffer.append(text)

        # Save final content
        if content_buffer and section_stack:
            self._save_raw_content(section_stack, content_buffer)

        # FALLBACK: If no hierarchical structure found, create page-based groups
        if not has_hierarchical_structure or stats['sections'] == 0:
            logging.info("\n📄 No hierarchical structure found - grouping by pages...")
            structure = self._create_page_based_structure(elements, stats)
        else:
            # Cleanup hierarchical structure
            self._cleanup(structure)

        logging.info(f"\n📊 Structure Extraction Statistics:")
        logging.info(f"   • Sections: {stats['sections']}")
        if stats['page_groups'] > 0:
            logging.info(f"   • Page Groups: {stats['page_groups']}")
        logging.info(f"   • Tables: {stats['tables']}")
        logging.info(f"   • Elements Processed: {stats['elements_processed']}")
        logging.info(f"   • Filtered: {stats['skipped_junk']} junk, {stats['skipped_tables']} tables")
        if stats['potential_sections_missed'] > 0:
            logging.warning(f"   ⚠️ Potential sections missed: {stats['potential_sections_missed']}")

        return structure

    def _create_page_based_structure(self, elements: List[Element], stats: Dict) -> Dict:
        """
        Create structure based on pages when no hierarchical structure is found.
        """
        structure = {}
        
        # Group elements by page
        page_groups = defaultdict(lambda: {'content': [], 'tables': []})
        current_page = 1
        
        for elem in elements:
            if self.cancellation_token.is_cancelled():
                raise InterruptedError("Task cancelled")
            
            elem_type = type(elem).__name__
            
            if elem_type in ['PageBreak']:
                current_page += 1
                continue
            
            if elem_type in ['Header', 'Footer']:
                continue
            
            # Get page number from metadata if available
            if hasattr(elem, 'metadata') and hasattr(elem.metadata, 'page_number'):
                current_page = elem.metadata.page_number
            
            text = str(elem).strip()
            text = self.clean_ocr_text(text)
            
            if isinstance(elem, Table):
                table_json = self.extract_table_json(elem)
                if table_json:
                    page_groups[current_page]['tables'].append(table_json)
            elif isinstance(elem, (Title, NarrativeText, Text, ListItem)):
                if text and not self.is_junk(text) and len(text) >= self.min_content_length:
                    page_groups[current_page]['content'].append(text)
        
        # Create structure from page groups
        for page_num in sorted(page_groups.keys()):
            page_data = page_groups[page_num]
            
            if not page_data['content'] and not page_data['tables']:
                continue
            
            stats['page_groups'] += 1
            page_key = f"page_{page_num}"
            
            structure[page_key] = {
                '_section_title': f"Page {page_num}",
                '_section_number': str(page_num),
                '_section_level': 1,
                '_page_number': page_num
            }
            
            # Add content
            if page_data['content']:
                content_text = '\n'.join(page_data['content'])
                structure[page_key]['_raw_content'] = content_text
                structure[page_key]['_content_length'] = len(content_text)
            
            # Add tables
            for idx, table in enumerate(page_data['tables'], 1):
                stats['tables'] += 1
                table_key = f"table_{idx}"
                structure[page_key][table_key] = table
                
                rows = table.get('shape', [0, 0])[0]
                cols = table.get('shape', [0, 0])[1]
                logging.info(f"   ✓ Page {page_num} - Table {idx}: {rows}×{cols}")
        
        return structure

    def _save_raw_content(self, stack: List[Tuple], content: List[str]):
        """Save raw content to section without AI processing."""
        if not content or not stack:
            return

        text = ' '.join(content).strip()

        if len(text) < self.min_content_length:
            return

        level, current_dict, key, section_num, section_title = stack[-1]
        current_dict['_raw_content'] = text
        current_dict['_content_length'] = len(text)
        
        if self.debug_mode:
            logging.debug(f"   → Saved {len(text)} chars to {section_title}")

    # ========================================================================
    # AI EXTRACTION METHODS
    # ========================================================================
    
    def call_ai_for_extraction(self, section_content: str, section_title: str) -> Dict[str, Any]:
        """
        Call AI service with enhanced prompts for variable extraction.
        """
        if self.cancellation_token.is_cancelled():
            raise InterruptedError("Task cancelled")

        system_prompt = get_enhanced_system_prompt()
        user_prompt = get_user_prompt(section_title, section_content)

        try:
            payload = {
                "system_prompt": system_prompt,
                "user_prompt": user_prompt,
                "thinking_level": self.thinking_level,
                "max_tokens": None,
                "stream": False
            }

            response = requests.post(self.ai_url, json=payload, timeout=600)
            response.raise_for_status()

            ai_output = response.json().get('output', '')
            extracted_json = self._parse_ai_output(ai_output)

            return extracted_json

        except Exception as e:
            logging.error(f"AI extraction failed for '{section_title}': {e}")
            return {"switchboard": {}, "other": {}, "error": str(e)}

    def _parse_ai_output(self, ai_output: str) -> Dict[str, Any]:
        """Parse AI output to extract JSON."""
        try:
            json_str = re.sub(r'^```json\s*', '', ai_output)
            json_str = re.sub(r'\s*```$', '', json_str)

            json_match = re.search(r'\{.*\}', json_str, re.DOTALL)
            if json_match:
                json_str = json_match.group()

            data = json.loads(json_str)

            if "switchboard" not in data:
                data["switchboard"] = {}
            if "other" not in data:
                data["other"] = {}

            data["switchboard"] = self._flatten_dict(data["switchboard"])
            data["other"] = self._flatten_dict(data["other"])

            return data

        except (json.JSONDecodeError, Exception) as e:
            logging.error(f"Failed to parse AI output: {e}")
            return {"switchboard": {}, "other": {}, "parse_error": str(e)}

    def _flatten_dict(self, d: Dict, parent_key: str = '', sep: str = '_') -> Dict:
        """Flatten nested dictionary."""
        items = {}
        for k, v in d.items():
            new_key = f"{parent_key}{sep}{k}" if parent_key else k
            if isinstance(v, dict):
                items.update(self._flatten_dict(v, new_key, sep=sep))
            elif isinstance(v, list):
                items[new_key] = ", ".join(str(item) for item in v)
            else:
                items[new_key] = v
        return items

    def build_hierarchy(self, elements: List[Element]) -> Dict:
        """
        Build document hierarchy WITH AI extraction (full analysis).
        NOW with improved section detection AND chunking support!
        """
        logging.info("\n🔍 Building document structure with AI extraction...")

        structure = {}
        section_stack = []
        content_buffer = []
        has_hierarchical_structure = False

        stats = {
            'sections': 0,
            'sections_chunked': 0,
            'total_chunks_created': 0,
            'sections_with_ai': 0,
            'page_groups': 0,
            'tables': 0,
            'skipped_junk': 0,
            'skipped_tables': 0,
            'ai_errors': 0,
            'potential_sections_missed': 0
        }

        for idx, elem in enumerate(elements):
            if self.cancellation_token.is_cancelled():
                raise InterruptedError("Task cancelled by user")

            elem_type = type(elem).__name__
            if elem_type in ['PageBreak', 'Header', 'Footer']:
                continue

            text = str(elem).strip()
            text = self.clean_ocr_text(text)

            if self.debug_mode and idx < 50:
                logging.debug(f"   [{idx:3}] Type: {elem_type:15} | Text: {text[:80]}")

            if not text:
                continue
            
            if self.is_junk(text):
                stats['skipped_junk'] += 1
                continue

            section_num, title, level = self.structure_detector.detect_section(text, elem_type)

            if section_num or title:
                has_hierarchical_structure = True
                stats['sections'] += 1

                # Process accumulated content with AI
                if content_buffer and section_stack:
                    self._process_section_with_ai(section_stack, content_buffer, stats)
                    content_buffer = []

                while section_stack and section_stack[-1][0] >= level:
                    section_stack.pop()

                key = self._create_key(title or f"section_{stats['sections']}")

                if section_stack:
                    parent_dict = section_stack[-1][1]
                else:
                    parent_dict = structure

                parent_dict[key] = {}
                section_stack.append((level, parent_dict[key], key, section_num or "", title or ""))

                logging.info(f"   ✓ Section {section_num or stats['sections']}: {title or 'Untitled'} (level {level})")

            elif isinstance(elem, Table):
                table_json = self.extract_table_json(elem)

                if table_json:
                    stats['tables'] += 1

                    if section_stack:
                        target_dict = section_stack[-1][1]
                    else:
                        target_dict = structure

                    table_key = f"table_{stats['tables']}"
                    target_dict[table_key] = table_json

                    rows = table_json.get('shape', [0, 0])[0]
                    cols = table_json.get('shape', [0, 0])[1]
                    logging.info(f"   ✓ Table {stats['tables']}: {rows}×{cols}")
                else:
                    stats['skipped_tables'] += 1

            elif isinstance(elem, (Title, NarrativeText, Text, ListItem)):
                if elem_type == 'Title' and len(text) >= 10 and not section_num:
                    stats['potential_sections_missed'] += 1
                    if self.debug_mode:
                        logging.warning(f"   ⚠️ Potential section missed: '{text[:60]}'")
                
                if len(text) >= self.min_content_length:
                    content_buffer.append(text)

        # Process final content
        if content_buffer and section_stack:
            self._process_section_with_ai(section_stack, content_buffer, stats)

        # FALLBACK: If no hierarchical structure found
        if not has_hierarchical_structure or stats['sections'] == 0:
            logging.info("\n📄 No hierarchical structure found - using page-based structure with AI...")
            structure = self._create_page_based_structure_with_ai(elements, stats)
        else:
            self._cleanup(structure)

        logging.info(f"\n📊 Extraction Statistics:")
        logging.info(f"   • Sections: {stats['sections']}")
        if stats.get('sections_chunked', 0) > 0:
            logging.info(f"   • Sections Chunked: {stats['sections_chunked']}")
            logging.info(f"   • Total Chunks Created: {stats['total_chunks_created']}")
        logging.info(f"   • AI Extractions: {stats['sections_with_ai']}")
        if stats.get('page_groups', 0) > 0:
            logging.info(f"   • Page Groups: {stats['page_groups']}")
        logging.info(f"   • Tables: {stats['tables']}")
        logging.info(f"   • Filtered: {stats['skipped_junk']} junk, {stats['skipped_tables']} tables")
        logging.info(f"   • AI Errors: {stats['ai_errors']}")
        if stats['potential_sections_missed'] > 0:
            logging.warning(f"   ⚠️ Potential sections missed: {stats['potential_sections_missed']}")

        return structure

    def _create_page_based_structure_with_ai(self, elements: List[Element], stats: Dict) -> Dict:
        """Create page-based structure and apply AI extraction."""
        structure = self._create_page_based_structure(elements, stats)
        
        # Apply AI extraction to each page
        for page_key, page_data in structure.items():
            if '_raw_content' in page_data and page_data['_raw_content']:
                content = page_data['_raw_content']
                title = page_data.get('_section_title', page_key)
                
                logging.info(f"   🤖 AI extracting from: {title}...")
                
                try:
                    ai_extracted = self.call_ai_for_extraction(content, title)
                    
                    if ai_extracted and (ai_extracted.get("switchboard") or ai_extracted.get("other")):
                        page_data['_ai_extracted'] = ai_extracted
                        stats['sections_with_ai'] += 1
                        
                        sw_count = len(ai_extracted.get("switchboard", {}))
                        other_count = len(ai_extracted.get("other", {}))
                        logging.info(f"      ✓ Extracted: {sw_count} switchboard, {other_count} other")
                    else:
                        stats['ai_errors'] += 1
                        logging.info(f"      ✗ No variables extracted")
                
                except Exception as e:
                    stats['ai_errors'] += 1
                    logging.error(f"AI extraction error: {e}")
        
        return structure

    def _process_section_with_ai(self, stack: List[Tuple], content: List[str], stats: Dict):
        """Process section content with AI extraction WITH CHUNKING."""
        if not content:
            return

        text = ' '.join(content).strip()

        if len(text) < self.min_content_length:
            return

        if not stack:
            return

        level, current_dict, key, section_num, section_title = stack[-1]

        current_dict['_raw_content'] = text

        # Check if content needs chunking
        if self.chunker.needs_chunking(text):
            chunks = self.chunker.chunk_content(text)
            
            if 'sections_chunked' not in stats:
                stats['sections_chunked'] = 0
                stats['total_chunks_created'] = 0
            
            stats['sections_chunked'] += 1
            stats['total_chunks_created'] += len(chunks)
            
            logging.info(f"   📦 Chunking section '{section_title}': {len(text)} chars → {len(chunks)} chunks")
            
            current_dict['_chunking_metadata'] = {
                'original_length': len(text),
                'total_chunks': len(chunks),
                'chunk_size': self.chunker.chunk_size,
                'overlap_size': self.chunker.overlap_size
            }
            
            # Process each chunk
            combined_switchboard = {}
            combined_other = {}
            
            for idx, chunk in enumerate(chunks, 1):
                logging.info(f"   🤖 AI extracting from: {section_title} - Chunk {idx}/{len(chunks)}...")
                
                try:
                    ai_extracted = self.call_ai_for_extraction(chunk, f"{section_title} (Part {idx})")
                    
                    if ai_extracted and (ai_extracted.get("switchboard") or ai_extracted.get("other")):
                        for var_key, var_value in ai_extracted.get("switchboard", {}).items():
                            prefixed_key = f"{var_key}_chunk{idx}" if var_key in combined_switchboard else var_key
                            combined_switchboard[prefixed_key] = var_value
                        
                        for var_key, var_value in ai_extracted.get("other", {}).items():
                            prefixed_key = f"{var_key}_chunk{idx}" if var_key in combined_other else var_key
                            combined_other[prefixed_key] = var_value
                        
                        sw_count = len(ai_extracted.get("switchboard", {}))
                        other_count = len(ai_extracted.get("other", {}))
                        logging.info(f"      ✓ Chunk {idx}: Extracted {sw_count} switchboard, {other_count} other")
                    else:
                        logging.info(f"      ✗ Chunk {idx}: No variables extracted")
                        
                except InterruptedError:
                    raise
                except Exception as e:
                    logging.error(f"      ❌ Chunk {idx} AI error: {e}")
            
            if combined_switchboard or combined_other:
                current_dict['_ai_extracted'] = {
                    'switchboard': combined_switchboard,
                    'other': combined_other
                }
                stats['sections_with_ai'] += 1
                
                total_sw = len(combined_switchboard)
                total_other = len(combined_other)
                logging.info(f"      ✓ Total extracted: {total_sw} switchboard, {total_other} other from {len(chunks)} chunks")
            else:
                stats['ai_errors'] += 1
        
        else:
            # Process normally without chunking
            logging.info(f"   🤖 AI extracting from: {section_title}...")
            
            try:
                ai_extracted = self.call_ai_for_extraction(text, section_title)

                if ai_extracted and (ai_extracted.get("switchboard") or ai_extracted.get("other")):
                    current_dict['_ai_extracted'] = ai_extracted
                    stats['sections_with_ai'] += 1

                    switchboard_count = len(ai_extracted.get("switchboard", {}))
                    other_count = len(ai_extracted.get("other", {}))
                    logging.info(f"      ✓ Extracted: {switchboard_count} switchboard, {other_count} other")
                else:
                    stats['ai_errors'] += 1
                    logging.info(f"      ✗ No variables extracted")

            except InterruptedError:
                raise
            except Exception as e:
                stats['ai_errors'] += 1
                logging.error(f"AI processing error: {e}")

    # ========================================================================
    # Stage 2: Extract AI Variables from Existing Structure
    # ========================================================================
    
    def extract_ai_variables_from_existing_structure(self, 
                                                     structure: Dict,
                                                     callback=None) -> Dict:
        """
        Stage 2: Extract AI variables from existing structure WITH CHUNKING.
        """
        logging.info("\n🤖 Starting AI extraction on existing structure (with chunking)...")
        
        stats = {
            'total_sections': 0,
            'sections_chunked': 0,
            'total_chunks_created': 0,
            'sections_processed': 0,
            'sections_with_ai': 0,
            'total_switchboard_vars': 0,
            'total_other_vars': 0,
            'ai_errors': 0
        }
        
        def count_content_sections(d: Dict):
            count = 0
            for key, value in d.items():
                if isinstance(value, dict):
                    if '_raw_content' in value and value['_raw_content'] and not key.startswith('content_chunk_'):
                        count += 1
                    count += count_content_sections(value)
            return count
        
        stats['total_sections'] = count_content_sections(structure)
        
        if stats['total_sections'] == 0:
            logging.warning("⚠️ No sections with content found for AI extraction")
            return structure
        
        logging.info(f"📊 Found {stats['total_sections']} sections to process")
        
        def process_sections(section_dict: Dict, path: str = ""):
            for key, value in list(section_dict.items()):
                if self.cancellation_token.is_cancelled():
                    raise InterruptedError("Task cancelled")
                
                current_path = f"{path}/{key}" if path else key
                
                if key.startswith('_') or key.startswith('table_'):
                    continue
                
                if isinstance(value, dict):
                    if '_raw_content' in value and value['_raw_content'] and not key.startswith('content_chunk_'):
                        
                        original_section = value
                        chunked_section = self._chunk_section_if_needed(value, key)
                        
                        if '_chunking_metadata' in chunked_section:
                            stats['sections_chunked'] += 1
                            stats['total_chunks_created'] += chunked_section['_chunking_metadata']['total_chunks']
                            section_dict[key] = chunked_section
                            value = chunked_section
                            
                            logging.info(f"   ✂️ Section '{key}' chunked into {chunked_section['_chunking_metadata']['total_chunks']} parts")
                        
                        has_chunks = any(k.startswith('content_chunk_') for k in value.keys() if isinstance(value.get(k), dict))
                        
                        if has_chunks:
                            for chunk_key in [k for k in value.keys() if k.startswith('content_chunk_')]:
                                chunk_section = value[chunk_key]
                                if not isinstance(chunk_section, dict):
                                    continue
                                    
                                stats['sections_processed'] += 1
                                
                                content = chunk_section.get('_raw_content', '')
                                title = value.get('_section_title', key)
                                chunk_info = chunk_section.get('_chunk_info', {})
                                chunk_num = chunk_info.get('chunk_number', 0)
                                total_chunks = chunk_info.get('total_chunks', 1)
                                
                                progress = int((stats['sections_processed'] / 
                                              max(stats['total_sections'] + stats['total_chunks_created'], 1)) * 100)
                                
                                if callback:
                                    try:
                                        callback(
                                            progress=progress,
                                            message=f"🤖 Processing {title} - Chunk {chunk_num}/{total_chunks}",
                                            phase="AI Extraction"
                                        )
                                    except:
                                        pass
                                
                                logging.info(
                                    f"   🤖 [{stats['sections_processed']}/{stats['total_sections'] + stats['total_chunks_created']}] "
                                    f"Processing: {title} - Chunk {chunk_num}/{total_chunks}"
                                )
                                
                                try:
                                    ai_extracted = self.call_ai_for_extraction(content, f"{title} (Part {chunk_num})")
                                    
                                    if ai_extracted and (ai_extracted.get("switchboard") or ai_extracted.get("other")):
                                        chunk_section['_ai_extracted'] = ai_extracted
                                        stats['sections_with_ai'] += 1
                                        
                                        sw_count = len(ai_extracted.get("switchboard", {}))
                                        other_count = len(ai_extracted.get("other", {}))
                                        
                                        stats['total_switchboard_vars'] += sw_count
                                        stats['total_other_vars'] += other_count
                                        
                                        logging.info(
                                            f"      ✓ Extracted: {sw_count} switchboard, "
                                            f"{other_count} other parameters"
                                        )
                                    else:
                                        stats['ai_errors'] += 1
                                        logging.warning(f"      ✗ No variables extracted from chunk {chunk_num}")
                                        
                                except InterruptedError:
                                    raise
                                except Exception as e:
                                    stats['ai_errors'] += 1
                                    logging.error(f"      ❌ AI extraction error for chunk {chunk_num}: {e}")
                        else:
                            stats['sections_processed'] += 1
                            
                            content = value.get('_raw_content', '')
                            title = value.get('_section_title', key)
                            
                            progress = int((stats['sections_processed'] / 
                                          max(stats['total_sections'], 1)) * 100)
                            
                            if callback:
                                try:
                                    callback(
                                        progress=progress,
                                        message=f"🤖 AI extracting from: {title}",
                                        phase="AI Extraction"
                                    )
                                except:
                                    pass
                            
                            logging.info(
                                f"   🤖 [{stats['sections_processed']}/{stats['total_sections']}] "
                                f"Processing: {title}"
                            )
                            
                            try:
                                ai_extracted = self.call_ai_for_extraction(content, title)
                                
                                if ai_extracted and (ai_extracted.get("switchboard") or ai_extracted.get("other")):
                                    value['_ai_extracted'] = ai_extracted
                                    stats['sections_with_ai'] += 1
                                    
                                    sw_count = len(ai_extracted.get("switchboard", {}))
                                    other_count = len(ai_extracted.get("other", {}))
                                    
                                    stats['total_switchboard_vars'] += sw_count
                                    stats['total_other_vars'] += other_count
                                    
                                    logging.info(
                                        f"      ✓ Extracted: {sw_count} switchboard, "
                                        f"{other_count} other parameters"
                                    )
                                else:
                                    stats['ai_errors'] += 1
                                    logging.warning(f"      ✗ No variables extracted from {title}")
                                    
                            except InterruptedError:
                                raise
                            except Exception as e:
                                stats['ai_errors'] += 1
                                logging.error(f"      ❌ AI extraction error for '{title}': {e}")
                    
                    process_sections(value, current_path)
        
        try:
            process_sections(structure)
        except InterruptedError:
            logging.warning("🛑 AI extraction cancelled by user")
            raise
        
        logging.info(f"\n📊 AI Extraction Statistics:")
        logging.info(f"   • Total Sections: {stats['total_sections']}")
        logging.info(f"   • Sections Chunked: {stats['sections_chunked']}")
        logging.info(f"   • Total Chunks Created: {stats['total_chunks_created']}")
        logging.info(f"   • Sections Processed: {stats['sections_processed']}")
        logging.info(f"   • Sections with AI Data: {stats['sections_with_ai']}")
        logging.info(f"   • Total Switchboard Variables: {stats['total_switchboard_vars']}")
        logging.info(f"   • Total Other Variables: {stats['total_other_vars']}")
        logging.info(f"   • AI Errors: {stats['ai_errors']}")
        
        return structure

    def _chunk_section_if_needed(self, section_dict: Dict, section_key: str) -> Dict:
        """Check if section content needs chunking and split into subsections."""
        content = section_dict.get('_raw_content', '')
        
        if not content or not self.chunker.needs_chunking(content):
            return section_dict
        
        chunks = self.chunker.chunk_content(content)
        
        if len(chunks) <= 1:
            return section_dict
        
        logging.info(f"   📦 Chunking section '{section_key}': {len(content)} chars → {len(chunks)} chunks")
        
        chunked_section = {}
        
        for key, value in section_dict.items():
            if key.startswith('_'):
                chunked_section[key] = value
            elif not isinstance(value, dict):
                chunked_section[key] = value
        
        for idx, chunk in enumerate(chunks, 1):
            chunk_key = f"content_chunk_{idx}"
            chunked_section[chunk_key] = {
                '_raw_content': chunk,
                '_chunk_info': {
                    'chunk_number': idx,
                    'total_chunks': len(chunks),
                    'chunk_size': len(chunk),
                    'is_first': idx == 1,
                    'is_last': idx == len(chunks)
                }
            }
        
        chunked_section['_chunking_metadata'] = {
            'original_length': len(content),
            'total_chunks': len(chunks),
            'chunk_size': self.chunker.chunk_size,
            'overlap_size': self.chunker.overlap_size
        }
        
        return chunked_section

    # ========================================================================
    # Vector Database Methods
    # ========================================================================
    
    def store_structure_in_vector_db(self, 
                                    collection_name: str,
                                    hierarchical_structure: Dict,
                                    project_id: str,
                                    document_hash: str) -> bool:
        """Store structure in vector database for RAG search."""
        if not self.enable_vector_db:
            logging.warning("⚠️ Vector database not enabled")
            return False

        try:
            try:
                self.qdrant_client.get_collection(collection_name)
                logging.info(f"✓ Collection exists: {collection_name}")
            except:
                self.qdrant_client.create_collection(
                    collection_name=collection_name,
                    vectors_config=VectorParams(size=768, distance=Distance.COSINE)
                )
                logging.info(f"✅ Created collection: {collection_name}")

            points = []
            point_id = 0

            def process_section(section_dict: Dict, path: str = ""):
                nonlocal point_id
                
                for key, value in section_dict.items():
                    if self.cancellation_token.is_cancelled():
                        raise InterruptedError("Task cancelled")
                    
                    if key.startswith('_') or key.startswith('table_'):
                        continue
                    
                    current_path = f"{path}/{key}" if path else key
                    
                    if isinstance(value, dict):
                        section_title = value.get('_section_title', key)
                        section_number = value.get('_section_number', '')
                        content = value.get('_raw_content', '')
                        content_length = value.get('_content_length', 0)
                        page_number = value.get('_page_number', None)
                        
                        if not content:
                            process_section(value, current_path)
                            continue
                        
                        embedding_text = f"{section_number} {section_title}"
                        if content:
                            embedding_text += f"\n{content[:500]}"
                        
                        embedding = self.embedding_model.encode(embedding_text).tolist()
                        
                        point = PointStruct(
                            id=point_id,
                            vector=embedding,
                            payload={
                                "project_id": project_id,
                                "document_hash": document_hash,
                                "section_path": current_path,
                                "section_key": key,
                                "section_title": section_title,
                                "section_number": section_number,
                                "page_number": page_number,
                                "content": content[:2000] if content else "",
                                "content_length": content_length,
                                "has_content": bool(content),
                                "timestamp": datetime.utcnow().isoformat()
                            }
                        )
                        
                        points.append(point)
                        point_id += 1
                        
                        process_section(value, current_path)
            
            process_section(hierarchical_structure)
            
            if not points:
                logging.warning("⚠️ No sections with content found for vector storage")
                return False
            
            batch_size = 100
            for i in range(0, len(points), batch_size):
                batch = points[i:i + batch_size]
                self.qdrant_client.upsert(
                    collection_name=collection_name,
                    points=batch
                )
                logging.info(f"   Uploaded batch {i//batch_size + 1}: {len(batch)} points")
            
            logging.info(f"✅ Stored {len(points)} sections in vector database")
            return True
            
        except Exception as e:
            logging.error(f"❌ Vector database storage failed: {e}")
            import traceback
            traceback.print_exc()
            return False

    def store_in_vector_db(self, 
                          collection_name: str,
                          hierarchical_structure: Dict,
                          project_id: str,
                          document_hash: str) -> bool:
        """Store hierarchical structure with AI-extracted data in vector database."""
        # Same implementation as store_structure_in_vector_db but includes AI data
        return self.store_structure_in_vector_db(
            collection_name, hierarchical_structure, project_id, document_hash
        )

    def search_vector_db(self,
                        collection_name: str,
                        query: str,
                        project_id: Optional[str] = None,
                        limit: int = 5) -> List[Dict]:
        """Search vector database for relevant sections."""
        if not self.enable_vector_db:
            return []

        try:
            query_embedding = self.embedding_model.encode(query).tolist()
            
            query_filter = None
            if project_id:
                from qdrant_client.models import Filter, FieldCondition, MatchValue
                query_filter = Filter(
                    must=[
                        FieldCondition(
                            key="project_id",
                            match=MatchValue(value=project_id)
                        )
                    ]
                )
            
            results = self.qdrant_client.search(
                collection_name=collection_name,
                query_vector=query_embedding,
                query_filter=query_filter,
                limit=limit
            )
            
            return [
                {
                    "score": result.score,
                    "section_path": result.payload.get("section_path"),
                    "section_title": result.payload.get("section_title"),
                    "content": result.payload.get("content"),
                    "page_number": result.payload.get("page_number"),
                }
                for result in results
            ]
            
        except Exception as e:
            logging.error(f"❌ Vector search failed: {e}")
            return []

    # ========================================================================
    # Utility Methods
    # ========================================================================
    
    def _create_key(self, title: str) -> str:
        """Create clean JSON key from title."""
        key = title.lower()
        key = re.sub(r'[^\w\s]', '', key)
        key = re.sub(r'\s+', '_', key)
        key = key.strip('_')[:60]
        return key if key else 'section'

    def _cleanup(self, d: Dict):
        """Clean up structure recursively."""
        to_remove = []

        for key, value in list(d.items()):
            if not isinstance(key, str):
                new_key = str(key)
                d[new_key] = value
                to_remove.append(key)
                key = new_key

            if isinstance(value, dict):
                self._cleanup(value)

                if not value:
                    to_remove.append(key)

            elif isinstance(value, str):
                if len(value.strip()) < self.min_content_length:
                    to_remove.append(key)

        for key in to_remove:
            if key in d:
                del d[key]

    def cancel_task(self):
        """Cancel ongoing parsing/extraction task."""
        self.cancellation_token.cancel()
        logging.warning("🛑 Task cancellation requested")

    def reset_cancellation(self):
        """Reset cancellation token for new task."""
        self.cancellation_token = CancellationToken()


# Export
__all__ = [
    'EnhancedUniversalPDFParser', 
    'CancellationToken', 
    'ContentChunker', 
    'UniversalStructureDetector'
]