"""
Smart content-aware ingester for the curated HR / Strategy corpus
=================================================================

Replaces the generic `index_file()` path with one that knows what the
EKC HR docs and strategy documents actually look like. Based on a
line-by-line review of every file in `Human Capital/`:

  HR Operations Manual/ (8 docs — markdown after the docx→md migration)
    * اضافه کاری                       — Overtime (EKWI-AD-005-01)
    * دستورالعمل_انتصاب_و_ارتقا          — Appointment & Promotion (EKWI-AD-009-00)
    * دستورالعمل_تردد__افراد_کالا_و_..   — Comprehensive Access Control (EKWIAD00900)
    * دستورالعمل_تردد_و_حضور_و_غیاب      — Attendance (EKWI-AD-001-07)
    * دستورالعمل_جذب_و_استخدام          — Recruitment & Hiring (EKWI-AD-004-07)
    * دستورالعمل_قطع_همکاری              — Termination (EKWI-AD-008-00)
    * دستورالعمل_مرخصی                  — Leave (EKWI-AD-006-01) — 12 leaf leave-types
    * وام                              — Loans (RE-AD-008-00)

  Organizational Strategy Values/ (4 docs — markdown)
    * اجزا_مقاصد_آرمانی                — Aspirational Goals (RE-HM-007-00)
    * استراتژی_ها___اهداف_و_برنامه_های   — Strategies, Goals & Programs (EKFR-HM-001-05)
    * سند_استراتژیک                    — Strategic Document (EKCO-1-07), 4 chapters
    * منشور_طرح_ریزی                   — Planning Charter (EKIP-1-04)

Shape of the pipeline:

  1. Extraction
     * `.md` / `.markdown` — read the file verbatim (Persian-aware UTF-8).
       Many of the converted markdown files have the entire document
       collapsed onto a single line because the doc→md converter glued
       paragraphs together. The next pass repairs that.
     * `.docx` / `.docm` (legacy) — python-docx faithful text dump
       (paragraphs + tables) preserving soft line breaks (<w:br/>).
  2. Inline-markdown repair: every #/##/### heading marker that lives
     inside the dumped text gets a newline prepended so the chunker
     can detect it. Same for table-row boundaries (`| ... | |`).
  3. Boilerplate filter — every HR ops file repeats the same 4-cell
     signature table, the same 3 document-control bullets, and the
     same ISO9001/14001/45001 references table. Indexing these would
     dilute search scores; we drop them.
  4. Structural chunker — markdown headings produce one chunk per
     leaf section, full heading_path preserved as section_path. Long
     sections window-split with overlap so retrieval can still
     pinpoint a specific paragraph.
  5. Synthetic "card" chunks — hand-curated denormalised Q&A facts
     for high-frequency queries (vision/mission/values, leave caps,
     overtime ceilings, loan tiers, age limits). One card per fact,
     so a user asking "حداکثر ساعت اضافه کاری" gets the canonical
     answer at top-1 even if the source paragraph has it buried.
  6. Rich payload — doc_id, doc_code, category, topic, heading_path,
     section_path, chunk_type ∈ {section, card, table_row, window}.
     Topic facet feeds the UI's "From: <heading>" badge and lets the
     runtime layer filter by topic when the question is unambiguous.

Run it manually on the deploy host:

  docker exec hr-kb-service python /app/ingest_local.py \\
    --root /app/hr_docs --rebuild

The --rebuild flag drops the Qdrant collection first (clean slate so
removed files don't linger). Omit it for incremental upsert.
"""

from __future__ import annotations

import argparse
import logging
import os
import re
import sys
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

import httpx
try:
    import docx  # python-docx — only needed for the legacy .docx path
except Exception:  # pragma: no cover — markdown corpus doesn't need it
    docx = None  # type: ignore
from qdrant_client import QdrantClient
from qdrant_client.http import models as qmodels

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("hr_kb_ingest")

EMBEDDINGS_URL    = os.getenv("EMBEDDINGS_URL", "http://embeddings-service:8031")
QDRANT_URL        = os.getenv("QDRANT_URL", "http://qdrant:6333")
HR_KB_COLLECTION  = os.getenv("HR_KB_COLLECTION", "hr_general_kb")
# 1200 (down from 1800) so long leaf sections fan out into more
# fine-grained chunks. Multilingual embeddings reward focused content
# — a 1200-char window matches a specific question better than a
# 1800-char window that mixes two topics. The result is more Qdrant
# points (≈ 230 vs ≈ 170 on the current corpus) and noticeably
# tighter retrieval on narrow questions.
CHUNK_CHAR_SIZE   = int(os.getenv("HR_KB_CHUNK_CHARS", "1200"))
CHUNK_CHAR_OVERLAP= int(os.getenv("HR_KB_CHUNK_OVERLAP", "200"))


# ---------------------------------------------------------------------------
# 1. DOCX → faithful text dump
# ---------------------------------------------------------------------------
def _para_text(p) -> str:
    """Paragraph text with soft line breaks preserved as \\n.

    python-docx's `p.text` flattens <w:br/> into nothing, which is
    fatal for these files because the authors used Shift+Enter to
    end "lines" inside a single Word paragraph.
    """
    pieces: List[str] = []
    for el in p._element.iter():
        tag = el.tag.split("}", 1)[1]
        if tag == "t" and el.text:
            pieces.append(el.text)
        elif tag == "br":
            pieces.append("\n")
        elif tag == "tab":
            pieces.append("\t")
    return "".join(pieces)


def _cell_text(cell) -> str:
    """Cell text — join the cell's paragraphs with ' / ' so it stays
    on one logical row, and escape any literal '|' so the synthesised
    markdown row doesn't fall apart."""
    return (" / ".join(p.text for p in cell.paragraphs if p.text.strip())
            .replace("|", "\\|").strip())


def extract_md(fp: Path) -> str:
    """Read a markdown file verbatim. The doc→md converter sometimes
    collapses the whole document into a single line; `repair_markdown`
    re-inserts newlines before heading markers and table-row boundaries
    so the structural chunker can do its job."""
    # Try utf-8 first, fall back to utf-8-sig (BOM) if needed.
    try:
        return fp.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return fp.read_text(encoding="utf-8-sig", errors="replace")


def extract_docx(fp: Path) -> str:
    """Walk body elements in order so paragraph/table interleaving is
    preserved. Returns markdown-flavoured text ready for the repair
    pass."""
    if docx is None:
        raise RuntimeError("python-docx is not installed; cannot read .docx")
    d = docx.Document(str(fp))
    parts: List[str] = []
    body = d.element.body
    table_idx, para_idx = 0, 0
    for child in body.iterchildren():
        tag = child.tag.split("}", 1)[1]
        if tag == "p":
            p = d.paragraphs[para_idx]; para_idx += 1
            style = (p.style.name or "").lower() if p.style else ""
            text = _para_text(p).strip()
            if not text:
                continue
            if "heading 1" in style:
                parts.append(f"# {text}")
            elif "heading 2" in style:
                parts.append(f"## {text}")
            elif "heading 3" in style:
                parts.append(f"### {text}")
            elif "heading" in style:
                parts.append(f"## {text}")
            else:
                parts.append(text)
        elif tag == "tbl":
            t = d.tables[table_idx]; table_idx += 1
            rows_md: List[str] = []
            for r_i, row in enumerate(t.rows):
                cells = [_cell_text(c) for c in row.cells]
                rows_md.append("| " + " | ".join(cells) + " |")
                if r_i == 0:
                    rows_md.append("|" + "|".join(["---"] * len(cells)) + "|")
            parts.append("\n".join(rows_md))
    return "\n\n".join(parts)


# ---------------------------------------------------------------------------
# 2. Inline-markdown repair
# ---------------------------------------------------------------------------
def repair_markdown(s: str) -> str:
    """Insert newlines so the structural chunker can detect markdown
    structure that the authors embedded as plain text inside a single
    Word paragraph. Verified against all 12 source files; goes from
    1-line/1-heading per file (broken) to 11-40 detectable headings
    and proper table-row segmentation."""
    # Heading markers (#/##/###/.../######) need a leading newline.
    s = re.sub(r"\s+(#{1,6}\s)", r"\n\n\1", s)
    # Table row boundary: "...| |..." → "...|\n|..." so each row gets
    # its own line.
    s = re.sub(r"(\|)\s+(\|)", r"\1\n\2", s)
    # Bold-numbered list items: "**1. عنوان**" gets its own line.
    s = re.sub(r"\s+(\*\*\d+\.\s)", r"\n\n\1", s)
    # Numbered list items "1) " / "1. " (after sentence terminator).
    s = re.sub(r"([.؟!:؛])\s+(\d+[.)]\s)", r"\1\n\2", s)
    # Collapse 3+ blank lines to 2.
    s = re.sub(r"\n{3,}", "\n\n", s)
    # Strip leading whitespace on resulting lines.
    s = re.sub(r"\n[ \t]+", "\n", s)
    return s.strip()


# ---------------------------------------------------------------------------
# 3. Boilerplate filter — drop universally-repeated junk
# ---------------------------------------------------------------------------
_BOILERPLATE_PATTERNS = [
    # Signature table headers — appear identically in every HR ops file
    r"\|\s*تهيه کننده\s*\|.*?(تأیيد کننده|تأیید کننده).*?تصويب.*?\|",
    r"\|\s*سرپرست سرمایه انسانی\s*\|.*?سرپرست تضمین کیفیت.*?\|",
    r"\|\s*نام و نام (خانوادگی|خانوداگی):.*?\|",
    # The 3-bullet document-control disclaimer
    r"هر گونه تغيير در مفاد روشها، دستورالعمل ها و فرم هاي مديريت یکپارچه",
    r"اسناد معتبر به صورت نسخه غیر?\s*چاپی در مسیر شبکه",
    r"توزیع مدارک در فهرست مستندات مشخص و به صورت نسخه غیر",
    # ISO references rows
    r"\|\s*\d\s*\|\s*استاندارد ISO\d+",
    # Date stamps "تاريخ: 30/05/1404"
    r"تاريخ\s*:?\s*\d{2}/\d{2}/\d{4}",
]
_BOILERPLATE_RE = re.compile("|".join(_BOILERPLATE_PATTERNS))


def is_boilerplate(text: str) -> bool:
    """True if a chunk is mostly boilerplate (signature/disclaimer/ISO
    references). Drops chunks where the union of matched boilerplate
    regions covers ≥ 35% of the chunk.

    Previously this used `findall` and summed `len(h)`; with capture
    groups in the patterns `findall` returns tuples, so `isinstance(h,
    str)` was False for nearly every hit and the function silently
    returned False. Now we use `finditer` and measure full match
    spans, so the title-page block (which is purely metadata table +
    signature + disclaimer wrapped under the document's H1) is
    correctly identified and dropped.
    """
    if not text or len(text) < 30:
        return True
    spans: List[Tuple[int, int]] = []
    for pat in _BOILERPLATE_PATTERNS:
        for m in re.finditer(pat, text):
            spans.append((m.start(), m.end()))
    if not spans:
        return False
    # Merge overlapping spans so overlapping patterns aren't double-counted.
    spans.sort()
    merged_chars = 0
    cur_s, cur_e = spans[0]
    for s, e in spans[1:]:
        if s <= cur_e:
            cur_e = max(cur_e, e)
        else:
            merged_chars += cur_e - cur_s
            cur_s, cur_e = s, e
    merged_chars += cur_e - cur_s
    return merged_chars > len(text) * 0.35


# ---------------------------------------------------------------------------
# 4. Structural chunker
# ---------------------------------------------------------------------------
_HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$", re.MULTILINE)


# Section headings whose content is universal boilerplate across all HR
# ops files — same "applies to all employees" / "ISO 9001 references" /
# "document identity" wording in every doc. These chunks were hijacking
# top-K retrieval on unrelated queries (a query like "چشم انداز شرکت"
# was returning "دامنه کاربرد" sections because they share the word
# "شرکت"). Drop them at ingest time — citations point at the real
# answer-bearing sections instead.
_NOISE_HEADING_PATTERNS = (
    r"^\d+\.?\s*دامنه\s*کاربرد\b",          # "1. دامنه کاربرد"
    r"^\d+\.?\s*مراجع\s*الزامی\b",          # "3. مراجع الزامی" — ISO list
    r"^شناسنامه\s*سند\b",                   # "شناسنامه سند" — doc metadata
    r"^امضاهای?\s*تصویب\b",                 # "امضاهای تصویب" — signatures
    r"^قوانین\s*توزیع\s*و\s*اعتبار",        # document-control disclaimer
    r"^\d+\.?\s*مستندات\s*(مربوطه|مرتبط)\b", # "7. مستندات مربوطه" — forms list
)
_NOISE_HEADING_RE = re.compile("|".join(_NOISE_HEADING_PATTERNS))


def _is_noise_heading(text: str) -> bool:
    """True if a section heading marks universal boilerplate that
    should not be indexed."""
    if not text:
        return False
    return bool(_NOISE_HEADING_RE.search(text.strip()))


def _split_long(body: str) -> List[str]:
    n = len(body)
    if n <= CHUNK_CHAR_SIZE:
        return [body]
    out: List[str] = []
    i = 0
    while i < n:
        end = min(i + CHUNK_CHAR_SIZE, n)
        if end < n:
            from_ = max(i + int(CHUNK_CHAR_SIZE * 0.75), i + 1)
            for sep in ("\n\n", "\n", ". ", "؟ ", "! ", " "):
                cut = body.rfind(sep, from_, end)
                if cut != -1:
                    end = cut + len(sep)
                    break
        out.append(body[i:end])
        if end >= n:
            break
        i = max(end - CHUNK_CHAR_OVERLAP, i + 1)
    return out


def chunk_sections(markdown: str) -> List[Dict[str, Any]]:
    """Walk the markdown, emit one chunk per leaf section with full
    heading_path. Long sections get window-split with overlap.

    Critical detail for these docx files: the authors typed everything
    into one Word paragraph, so after the markdown-repair pass the
    heading line still carries the section body glued onto it. The
    walker keeps BOTH the trimmed displayable heading AND the full
    original line. When a section's accumulated body is empty (because
    the body was all in the heading line), we synthesize the body from
    the tail of that full heading text instead of discarding the
    section. Without this, jose-vc-stuck-in-paragraph files like
    جذب و استخدام collapsed from 17 sections to 1.
    """
    if not markdown:
        return []
    lines = markdown.split("\n")
    sections: List[Dict[str, Any]] = []
    # Each stack entry tracks (level, displayable, full_text) so we
    # can synthesize body from the heading when needed.
    stack: List[Tuple[int, str, str]] = []
    buf: List[str] = []
    cur_full_heading: str = ""

    def flush():
        body = "\n".join(buf).strip()
        if not stack and not body:
            return
        # If the section body is short/empty but the current leaf
        # heading carried lots of trailing body (e.g.
        # "2. دامنه کاربرد این دستورالعمل کلیه کارکنان…"), use the
        # post-trim tail as the searchable body.
        if (not body or len(body) < 30) and stack:
            full = stack[-1][2]
            trimmed = stack[-1][1]
            tail = full[len(trimmed):].lstrip(" :.،؛-—") if len(full) > len(trimmed) else ""
            if tail:
                body = (tail + ("\n\n" + body if body else "")).strip()
        if body:
            sections.append({
                "heading_path": [disp for _, disp, _ in stack],
                "body": body,
            })
        buf.clear()

    for ln in lines:
        m = _HEADING_RE.match(ln)
        if m:
            flush()
            level = len(m.group(1))
            full = m.group(2).strip()
            display = _trim_heading(full)
            while stack and stack[-1][0] >= level:
                stack.pop()
            stack.append((level, display, full))
            cur_full_heading = full
            continue
        buf.append(ln)
    flush()

    chunks: List[Dict[str, Any]] = []
    for sec in sections:
        body = sec["body"]
        if is_boilerplate(body):
            continue
        # Skip whole sections whose innermost heading is universal
        # boilerplate (scope / refs / doc-id / signatures / forms-
        # list). These are near-identical across files and were
        # poisoning top-K retrieval on unrelated queries.
        leaf_heading = sec["heading_path"][-1] if sec["heading_path"] else ""
        if _is_noise_heading(leaf_heading):
            continue
        windows = _split_long(body)
        for w in windows:
            if is_boilerplate(w):
                continue
            chunks.append({
                "text": w,
                "heading_path": sec["heading_path"],
                "chunk_type": "window" if len(windows) > 1 else "section",
            })
    return chunks


def _trim_heading(s: str, max_chars: int = 120) -> str:
    """Trim a heading line at the first natural boundary so 'heading
    + glued body' looks reasonable in citations. Boundaries (in order
    of preference): markdown table opener, sentence terminator,
    em-dash, hard length cap."""
    for sep in ("|", " — ", "—"):
        i = s.find(sep)
        if 5 < i < max_chars:
            return s[:i].strip()
    # Persian sentence terminators
    for term in ("؟", "!", "."):
        i = s.find(term)
        if 8 < i < max_chars:
            return s[:i + 1].strip()
    if len(s) > max_chars:
        return s[:max_chars].rstrip() + "…"
    return s


# ---------------------------------------------------------------------------
# 5. Per-document metadata & topic tagging
# ---------------------------------------------------------------------------
# Maps filename → (doc_id, doc_title, doc_code, category, topic).
# doc_id is a human-readable slug we can use in citations and logs.
# topic is a finer-grained facet used by the chat layer's filter UI.

# Keys are matched case-insensitively against `path.name`; both the
# current `.md` corpus and the legacy `.docx` corpus are accepted so a
# half-migrated tree still ingests cleanly.
DOC_REGISTRY: Dict[str, Dict[str, str]] = {
    # ---- HR Operations Manual (.md) ----
    "اضافه کاری.md": dict(
        doc_id="overtime", doc_code="EKWI-AD-005-01",
        doc_title="دستورالعمل اضافه کاری",
        category="hr_manner", topic="overtime"),
    "دستورالعمل_انتصاب_و_ارتقا.md": dict(
        doc_id="promotion", doc_code="EKWI-AD-009-00",
        doc_title="دستورالعمل انتصاب و ارتقا",
        category="hr_manner", topic="promotion"),
    "دستورالعمل_تردد__افراد_کالا_و_وسایل_نقلیه.md": dict(
        doc_id="access-control", doc_code="EKWIAD00900",
        doc_title="دستورالعمل جامع تردد افراد، کالا و وسایل نقلیه",
        category="hr_manner", topic="access_control"),
    "دستورالعمل_تردد_و_حضور_و_غیاب.md": dict(
        doc_id="attendance", doc_code="EKWI-AD-001-07",
        doc_title="دستورالعمل تردد، حضور و غیاب",
        category="hr_manner", topic="attendance"),
    "دستورالعمل_جذب_و_استخدام.md": dict(
        doc_id="recruitment", doc_code="EKWI-AD-004-07",
        doc_title="دستورالعمل جذب و استخدام",
        category="hr_manner", topic="recruitment"),
    "دستورالعمل_قطع_همکاری.md": dict(
        doc_id="termination", doc_code="EKWI-AD-008-00",
        doc_title="دستورالعمل قطع همکاری",
        category="hr_manner", topic="termination"),
    "دستورالعمل_مرخصی.md": dict(
        doc_id="leave", doc_code="EKWI-AD-006-01",
        doc_title="دستورالعمل مرخصی",
        category="hr_manner", topic="leave"),
    "وام.md": dict(
        doc_id="loan", doc_code="RE-AD-008-00",
        doc_title="اعطای تسهیلات (وام)",
        category="hr_manner", topic="loan"),
    # ---- Organizational Strategy Values (.md) ----
    "اجزا_مقاصد_آرمانی.md": dict(
        doc_id="aspirational-goals", doc_code="RE-HM-007-00",
        doc_title="اجزاء مقاصد آرمانی",
        category="org_strategy", topic="aspirational_goals"),
    "استراتژی_ها___اهداف_و_برنامه_های_سازمان.md": dict(
        doc_id="strategies-programs", doc_code="EKFR-HM-001-05",
        doc_title="استراتژی‌ها، اهداف و برنامه‌های سازمان",
        category="org_strategy", topic="strategies"),
    "سند_استراتژیک.md": dict(
        doc_id="strategic-document", doc_code="EKCO-1-07",
        doc_title="سند استراتژیک",
        category="org_strategy", topic="strategy"),
    "منشور_طرح_ریزی.md": dict(
        doc_id="planning-charter", doc_code="EKIP-1-04",
        doc_title="منشور طرح‌ریزی سیستم‌های مدیریت یکپارچه",
        category="org_strategy", topic="charter"),
    # ---- Legacy .docx aliases (kept so a half-migrated tree works) ----
    "اضافه_کاری.MD.docx": dict(
        doc_id="overtime", doc_code="EKWI-AD-005-01",
        doc_title="دستورالعمل اضافه کاری",
        category="hr_manner", topic="overtime"),
    "دستورالعمل_انتصاب_و_ارتقا.md.docx": dict(
        doc_id="promotion", doc_code="EKWI-AD-009-00",
        doc_title="دستورالعمل انتصاب و ارتقا",
        category="hr_manner", topic="promotion"),
    "دستورالعمل_تردد__افراد_کالا_و_وسایل_نقلیه.md.docx": dict(
        doc_id="access-control", doc_code="EKWIAD00900",
        doc_title="دستورالعمل جامع تردد افراد، کالا و وسایل نقلیه",
        category="hr_manner", topic="access_control"),
    "دستورالعمل_تردد_و_حضور_و_غیاب.MD.docx": dict(
        doc_id="attendance", doc_code="EKWI-AD-001-07",
        doc_title="دستورالعمل تردد، حضور و غیاب",
        category="hr_manner", topic="attendance"),
    "دستورالعمل_جذب_و_استخدام.md.docx": dict(
        doc_id="recruitment", doc_code="EKWI-AD-004-07",
        doc_title="دستورالعمل جذب و استخدام",
        category="hr_manner", topic="recruitment"),
    "دستورالعمل_قطع_همکاری.md.docx": dict(
        doc_id="termination", doc_code="EKWI-AD-008-00",
        doc_title="دستورالعمل قطع همکاری",
        category="hr_manner", topic="termination"),
    "دستورالعمل_مرخصی.MD.docx": dict(
        doc_id="leave", doc_code="EKWI-AD-006-01",
        doc_title="دستورالعمل مرخصی",
        category="hr_manner", topic="leave"),
    "وام.md.docx": dict(
        doc_id="loan", doc_code="RE-AD-008-00",
        doc_title="اعطای تسهیلات (وام)",
        category="hr_manner", topic="loan"),
    "mdاجزا_مقاصد_آرمانی.docx": dict(
        doc_id="aspirational-goals", doc_code="RE-HM-007-00",
        doc_title="اجزاء مقاصد آرمانی",
        category="org_strategy", topic="aspirational_goals"),
    "استراتژی_ها___اهداف_و_برنامه_های_سازمان.md.docx": dict(
        doc_id="strategies-programs", doc_code="EKFR-HM-001-05",
        doc_title="استراتژی‌ها، اهداف و برنامه‌های سازمان",
        category="org_strategy", topic="strategies"),
    "سند_استراتژیک.md.docx": dict(
        doc_id="strategic-document", doc_code="EKCO-1-07",
        doc_title="سند استراتژیک",
        category="org_strategy", topic="strategy"),
    "منشور_طرح_ریزی.md.docx": dict(
        doc_id="planning-charter", doc_code="EKIP-1-04",
        doc_title="منشور طرح‌ریزی سیستم‌های مدیریت یکپارچه",
        category="org_strategy", topic="charter"),
}


def doc_meta_for(path: Path) -> Optional[Dict[str, str]]:
    """Look up doc-level metadata by filename. Falls back to a generic
    record so files added later still get indexed (just without the
    curated topic tag)."""
    meta = DOC_REGISTRY.get(path.name)
    if meta is not None:
        return meta
    # Unknown file — derive category from the parent directory name.
    parent = path.parent.name.lower()
    if "strateg" in parent or "vision" in parent or "values" in parent:
        category, topic = "org_strategy", "misc"
    elif "hr" in parent or "operations" in parent or "manual" in parent \
            or "manua" in parent:
        category, topic = "hr_manner", "misc"
    else:
        category, topic = "fs_drop", "misc"
    return dict(
        doc_id=path.stem.lower().replace(" ", "-")[:40],
        doc_code="UNKNOWN",
        doc_title=path.stem,
        category=category, topic=topic,
    )


# ---------------------------------------------------------------------------
# 6. Synthetic canonical-fact cards
# ---------------------------------------------------------------------------
# Each card is a hand-curated fact that's frequently asked but lives
# scattered across long sections. Adding cards as separate chunks
# significantly boosts top-1 recall for these queries because the
# card text is short, on-topic, and embedded as its own vector.
#
# Sourced from a line-by-line read of every source file. The
# `source_section` tag points back at the originating section so the
# UI still shows the document path in the citation.

CANONICAL_CARDS: List[Dict[str, Any]] = [
    # ---- Vision / Mission / Values (most-asked strategy queries) ----
    # Every text intentionally repeats alias keywords (شرکت / سازمان /
    # الکتروکویر) up front so embedding matches on the natural way a
    # user phrases the question — "چشم انداز شرکت", "vision of the
    # company", "ماموریت سازمان". Multilingual sentence-transformers
    # reward verbatim term overlap heavily.
    {"doc_id": "strategic-document", "topic": "vision",
     "title": "چشم انداز شرکت / سازمان / الکتروکویر",
     "text": "چشم انداز شرکت الکتروکویر (سازمان): پیشتاز در ارائه راهکارهای جامع نوآورانه با بهره‌مندی از فناوری‌های نوین صنعت برق. چشم‌انداز ۱۴۰۸ شرکت همچنین شامل رهبری بازار داخلی تابلو برق، ورود به بازارهای جدید (الکتروموتور، درایو، اینورتر خورشیدی)، ورود به بورس اوراق بهادار، و استقرار ساختار هولدینگ است. مرجع: سند استراتژیک (EKCO-1-07) فصل چهارم؛ منشور طرح‌ریزی (EKIP-1-04) به امضای مدیرعامل حمید منتظری.",
     "source_section": "فصل چهارم: اسناد مهم سازمان > چشم انداز"},
    {"doc_id": "strategic-document", "topic": "mission",
     "title": "مأموریت / رسالت شرکت / سازمان",
     "text": "مأموریت (رسالت) شرکت الکتروکویر (سازمان): اطمینان و تعالی با ارائه محصولات، خدمات و راهکارهای ارزش‌آفرین در صنعت برق در راستای رضایتمندی ذینفعان و ارتقاء مسئولیت‌های اجتماعی. مرجع: سند استراتژیک (EKCO-1-07) فصل چهارم.",
     "source_section": "فصل چهارم > مأموریت"},
    {"doc_id": "strategic-document", "topic": "values",
     "title": "ارزش‌های بنیادین شرکت / سازمان",
     "text": "ارزش‌های بنیادین شرکت الکتروکویر (سازمان): ۱) اخلاق حرفه‌ای ۲) رضایتمندی شرکای اجتماعی ۳) تعالی فردی و سازمانی ۴) مسئولیت اجتماعی ۵) کار تیمی. مرجع: سند استراتژیک (EKCO-1-07) فصل چهارم؛ منشور طرح‌ریزی (EKIP-1-04).",
     "source_section": "فصل چهارم > ارزش‌ها"},
    {"doc_id": "strategic-document", "topic": "strategies",
     "title": "ده استراتژی شرکت / سازمان",
     "text": "ده استراتژی شرکت الکتروکویر (سازمان): ۱) بهبود کیفیت محصول و خدمات ۲) توسعه منابع انسانی و مدیریت استعدادها ۳) توسعه زنجیره تأمین ۴) تحول‌آفرینی و نوآوری ۵) توسعه برندینگ ۶) بهبود ساختار هزینه‌های سازمان ۷) سرمایه‌گذاری و سودآوری ۸) توسعه زیرساخت ۹) بهره‌وری در مصرف انرژی ۱۰) نظام جامع مدیریت ریسک. مرجع: سند استراتژیک (EKCO-1-07) فصل چهارم.",
     "source_section": "فصل چهارم > استراتژی‌های سازمان"},
    {"doc_id": "planning-charter", "topic": "policy",
     "title": "خط‌مشی هشت‌گانه شرکت / سازمان",
     "text": "خط‌مشی مدیریت یکپارچه شرکت الکتروکویر (سازمان): ۱) بهبود مستمر فرایندها ۲) افزایش رضایتمندی ذینفعان ۳) ایجاد و حفظ شرایط کاری ایمن و بهداشتی ۴) افزایش بهره‌وری کارکنان ۵) بهبود مشاوره و مشارکت کارکنان ۶) توسعه ارتباط برد-برد با تأمین‌کنندگان ۷) ارتقای دانش مشتریان ۸) بهبود سیستم مدیریت دانش. مرجع: منشور طرح‌ریزی (EKIP-1-04) به امضای مدیرعامل حمید منتظری.",
     "source_section": "خط مشی"},
    {"doc_id": "aspirational-goals", "topic": "aspirational_goals_summary",
     "title": "مقاصد آرمانی شرکت / سازمان",
     "text": "مقاصد آرمانی شرکت الکتروکویر (سازمان) از ۱۰ مؤلفه تشکیل شده است (سند RE-HM-007-00): "
              "۱) **نقش در توسعه** — تبدیل شدن به Solution provider، ورود به بازارهای جدید و نوظهور، ورود به بورس، دیجیتال‌سازی نسل ۴، حرکت به سمت هولدینگ. "
              "۲) **محصولات** — طراحی محصولات جدید درایو (فرکانس کانورتر)، الکتروموتور، اینورترهای خورشیدی، محصولات دانش‌بنیان (باسداکت، تابلو کوره، تابلو ژنراتور)، خدمات پس از فروش. "
              "۳) **ذی‌نفعان** — ارتقاء کارکنان از طریق ارتباط با دانشگاه، پیاده‌سازی استاندارد امنیت اطلاعات ISO 27001. "
              "۴) **رشد، رقابت و سودآوری** — رشد سالانه فروش، افزایش حاشیه سود، تمرکز بر مشتریان کلیدی (نفت/گاز/نیرو)، بهبود زنجیره تأمین. "
              "۵) **ویژگی ممتاز** — جوایز ملی، محصولات جانبی و تکمیلی، همکاری با زیمنس. "
              "۶) **تکنولوژی** — اجرای تحول دیجیتال نسل ۴، یکپارچه‌سازی و امنیت اطلاعات بر اساس ISO 27001، توسعه R&D. "
              "۷) **ارزش‌ها** — شفافیت، رضایت مشتری، مسئولیت اجتماعی، کیفیت، انعطاف‌پذیری، ارتقای کارکنان، ارزش‌آفرینی از طریق مشاوره. "
              "۸) **مسئولیت اجتماعی** — تعهد مدیریت به بهینه‌سازی مصرف انرژی و پسماند. "
              "۹) **دیدگاه نسبت به کارکنان** — جانشین‌پروری، ارزیابی عملکرد، مصاحبه خروج، افزایش بهره‌وری نیروی انسانی. "
              "۱۰) **چشم‌انداز** — رهبر بازار داخلی تابلو برق، بازیگر منطقه‌ای، ورود به حوزه‌های نو (الکتروموتور، درایو، اینورتر خورشیدی)، بورس، ساختار هولدینگ.",
     "source_section": "بخش اول: جدول مؤلفه‌های مقصد آرمانی"},
    {"doc_id": "planning-charter", "topic": "vision_1408",
     "title": "چشم‌انداز ۱۴۰۸ شرکت الکتروکویر",
     "text": "چشم‌انداز ۱۴۰۸ شرکت الکتروکویر (سازمان): پیشتاز در ارائه راهکارهای جامع نوآورانه با بهره‌مندی از فناوری‌های نوین صنعت برق، با تأکید بر مدیریت اطمینان و تعالی با ارائه محصولات، خدمات و راهکارهای ارزش‌آفرین در صنعت برق، در راستای رضایتمندی ذی‌نفعان و ارتقاء مسئولیت‌های اجتماعی. مرجع: منشور طرح‌ریزی (EKIP-1-04).",
     "source_section": "چشم‌انداز الکتروکویر ۱۴۰۸"},

    # ---- Leave canonical facts (highest-volume HR queries) ----
    {"doc_id": "leave", "topic": "leave_annual",
     "title": "میزان مرخصی استحقاقی سالانه",
     "text": "مرخصی استحقاقی سالانه: ۳۰ روز در سال با احتساب ۴ جمعه (ماده ۶۴ قانون کار). ماهانه معادل ۲.۵ روز محاسبه می‌شود و برای کارکرد کمتر از یک سال به نسبت محاسبه می‌گردد. تعطیلات رسمی بین مرخصی جزو مرخصی محسوب نمی‌شود. ۱۱ اردیبهشت (روز کارگر) جزو مرخصی استحقاقی.",
     "source_section": "۶-۱- مرخصی استحقاقی > ۶-۱-۱- میزان مرخصی استحقاقی"},
    {"doc_id": "leave", "topic": "leave_banking",
     "title": "ذخیره مرخصی استحقاقی",
     "text": "حداکثر ۹ روز مرخصی استحقاقی در سال قابل ذخیره است (ماده ۶۹ قانون کار، تأیید ماده ۶۶). مابقی استفاده‌نشده سوخت می‌شود. مرخصی ذخیره‌شده در پایان قرارداد قابل تبدیل به پول می‌باشد. تغییر این بند نیاز به مجوز مدیرعامل دارد.",
     "source_section": "۶-۱-۳- ذخیره مرخصی"},
    {"doc_id": "leave", "topic": "leave_hourly",
     "title": "مرخصی ساعتی — سقف و قواعد",
     "text": "سقف مرخصی ساعتی: حداکثر ۴ ساعت در روز (مازاد آن باید روزانه ثبت شود)؛ حداکثر ۵ نوبت در ماه. ۱۰ دقیقه اول روز کاری قابل ثبت مرخصی نیست (کسرکار محسوب می‌شود). افزایش این سقف نیازمند تأیید مدیر مستقیم، معاونت و مدیرعامل است.",
     "source_section": "۶-۱-۵-۲- مرخصی ساعتی"},
    {"doc_id": "leave", "topic": "leave_maternity",
     "title": "مرخصی زایمان",
     "text": "مرخصی زایمان: جمعاً ۹ ماه با حقوق (ماده ۷۶ قانون کار). حداکثر ۲ ماه قبل از زایمان قابل استفاده، حتی‌الامکان ۴۵ روز پس از زایمان استفاده شود. حقوق توسط سازمان تأمین اجتماعی پرداخت می‌شود (معادل دو سوم میانگین دستمزد ۹۰ روز آخر). جزو سابقه بازنشستگی محاسبه می‌شود.",
     "source_section": "۶-۳- مرخصی زایمان"},
    {"doc_id": "leave", "topic": "leave_lactation",
     "title": "مرخصی شیردهی",
     "text": "حق شیر برای مادران تا دو سالگی کودک: کارخانه ۰۱:۱۵ روزانه، دفتر مرکزی تهران ۰۱:۳۰ روزانه. نحوه استفاده شناور، با توافق مدیر واحد و پرسنل. برای فرزندان دو/چندقلو روزانه ۲ ساعت. این زمان جزو ساعات کار محسوب می‌شود و از مرخصی استحقاقی کسر نمی‌شود.",
     "source_section": "۶-۲- مرخصی دوران شیردهی"},
    {"doc_id": "leave", "topic": "leave_marriage_bereavement",
     "title": "مرخصی ازدواج و فوت",
     "text": "طبق ماده ۷۳ قانون کار، ۳ روز مرخصی برای ازدواج دائم و ۳ روز برای فوت همسر/پدر/مادر/فرزندان (اقوام درجه یک). این مرخصی جزو مرخصی استحقاقی محاسبه نمی‌شود.",
     "source_section": "۶-۴- مرخصی استحقاقی ازدواج و فوت"},
    {"doc_id": "leave", "topic": "leave_sick",
     "title": "مرخصی استعلاجی",
     "text": "مرخصی استعلاجی با تأیید پزشک معالج و سازمان تأمین اجتماعی. مدت قانونی مشخص ندارد، تا زمان بهبودی. غرامت دستمزد از طرف تأمین اجتماعی پرداخت می‌شود (در بستری از روز اول، در سایر موارد از روز چهارم). حقوق توسط شرکت پرداخت نمی‌گردد. ثبت در سامانه خدمات غیرحضوری تأمین اجتماعی الزامی است.",
     "source_section": "۶-۶- مرخصی استعلاجی"},
    {"doc_id": "leave", "topic": "leave_unpaid",
     "title": "مرخصی بدون حقوق",
     "text": "مرخصی بدون حقوق: حداکثر یک دوازدهم سنوات خدمت (ماده ۷۲)؛ سقف سالانه ۱ ماه. تا ۷ روز با تأیید سرپرست و کمیته منابع انسانی، بیش از ۷ روز با مدیرعامل. جزو سابقه خدمت محسوب نمی‌شود. شرط: حداقل یک سال سابقه.",
     "source_section": "۶-۷- مرخصی بدون حقوق"},
    {"doc_id": "leave", "topic": "leave_hajj",
     "title": "مرخصی حج",
     "text": "برای حج تمتع واجب یک ماه مرخصی با حقوق (طبق ۳۰ روز سالانه ماده ۶۷). در صورت کسری روز، مازاد به صورت مرخصی بدون حقوق. فقط برای حج تمتع — برای عمره مرخصی بدون حقوق با دلیل سفر طولانی قابل استفاده است.",
     "source_section": "۶-۸- مرخصی حج"},
    {"doc_id": "leave", "topic": "leave_all_types",
     "title": "فهرست کامل انواع مرخصی در شرکت الکتروکویر",
     "text": "انواع مرخصی — انواع مرخصی شرکت الکتروکویر — لیست همه مرخصی‌ها — فهرست مرخصی‌های مجاز — مرخصی چه نوع‌هایی دارد — kinds of leave — leave types. "
             "در شرکت الکتروکویر (سازمان) مجموعاً ۱۲ نوع مرخصی رسمی تعریف شده است (دستورالعمل مرخصی، کد EKWI-AD-006-01): "
             "۱) **مرخصی استحقاقی** — ۳۰ روز سالانه با احتساب ۴ جمعه (ماده ۶۴ قانون کار)؛ ماهانه ۲.۵ روز. شامل دو زیرنوع روزانه و ساعتی. "
             "۲) **مرخصی دوران شیردهی** — حق شیر تا دو سالگی کودک: کارخانه ۰۱:۱۵ روزانه، دفتر تهران ۰۱:۳۰ روزانه، دوقلو ۲ ساعت (ماده ۷۸). "
             "۳) **مرخصی زایمان** — جمعاً ۹ ماه با حقوق از تأمین اجتماعی (ماده ۷۶). "
             "۴) **مرخصی استحقاقی ازدواج و فوت** — ۳ روز ازدواج دائم، ۳ روز فوت اقوام درجه یک (ماده ۷۳)، خارج از سقف استحقاقی. "
             "۵) **مرخصی تشویقی و آموزشی** — با درخواست مدیر واحد و موافقت مدیرعامل، برای کارکنان کوشا یا دارای نوآوری. "
             "۶) **مرخصی استعلاجی** — با تأیید پزشک معالج و سازمان تأمین اجتماعی، حقوق توسط شرکت پرداخت نمی‌شود، مدت قانونی مشخص ندارد، ثبت در سامانه خدمات غیرحضوری تأمین اجتماعی الزامی است (ماده ۵۹ تأمین اجتماعی). "
             "۷) **مرخصی بدون حقوق** — سقف سالانه ۱ ماه (تا یک‌دوازدهم سنوات خدمت، ماده ۷۲)؛ تا ۷ روز با تأیید سرپرست و کمیته منابع انسانی، بیش از ۷ روز با مدیرعامل. شرط: حداقل یک سال سابقه. "
             "۸) **مرخصی حج** — یک ماه مرخصی با حقوق فقط برای حج تمتع واجب (طبق ماده ۶۷)؛ برای حج عمره مرخصی بدون حقوق با دلیل سفر طولانی. "
             "۹) **مرخصی تحصیلی** — نوع مرخصی بدون حقوق، مقطع فوق‌دیپلم ۲ سال، کارشناسی ۴ سال، کارشناسی‌ارشد ۲ سال (قابل تمدید ۲ سال در هر مقطع). با مجوز مدیرعامل، در الکتروکویر تهاتر با اضافه‌کاری الزامی است. "
             "۱۰) **مجوز خروج** — مرخصی کوتاه‌مدت در ساعات موظفی، مدت هر مجوز حداکثر ۱۰ دقیقه، حداکثر دو بار در هفته. "
             "۱۱) **بازخرید مرخصی** — بازخرید مازاد بر اساس جمع کل حقوق در صورت عدم موافقت مدیر؛ مرخصی منفی حداکثر ۳ روز و مازاد آن مرخصی بدون حقوق. در زمان خاتمه همکاری، مرخصی انباشته بازخرید می‌شود. "
             "۱۲) **سایر مرخصی‌ها** — مسابقات ورزشی و موارد خاص با مجوز مدیران ارشد/مدیرعامل. "
             "ثبت همه مرخصی‌ها از طریق سامانه کسرا (kasra.electrokavir.com) با تأیید مدیر مستقیم انجام می‌شود. مرجع کامل: دستورالعمل مرخصی (EKWI-AD-006-01)، فصل ۵ (انواع در قانون کار) و فصل ۶ (روش اجرا، بندهای ۶-۱ تا ۶-۱۲).",
     "source_section": "۵. انواع مرخصی در قانون کار + ۶. روش اجرا (بندهای ۶-۱ تا ۶-۱۲)"},
    {"doc_id": "leave", "topic": "leave_daily_calculation",
     "title": "مرخصی روزانه و معادل ساعتی",
     "text": "مرخصی روزانه: در کارخانه هر ۰۷:۲۰ ساعت کار = یک روز مرخصی استحقاقی؛ در دفتر مرکزی تهران هر ۰۸:۳۰ ساعت کار = یک روز مرخصی. برای نگهبانان بر اساس شیفت کاری محاسبه می‌شود. کارکنان می‌توانند هم از مرخصی استحقاقی همان سال و هم از مرخصی ذخیره‌شده استفاده نمایند. عدم استحقاق هنگام درخواست = غیبت محسوب می‌شود.",
     "source_section": "۶-۱-۵-۱- مرخصی روزانه"},
    {"doc_id": "leave", "topic": "leave_incentive",
     "title": "مرخصی تشویقی و آموزشی",
     "text": "مرخصی تشویقی: در صورت درخواست مدیر واحد و موافقت مدیرعامل، به منظور تشویق کارکنان کوشا و افرادی که با نوآوری خود موجب افزایش بهره‌وری می‌شوند یا پیشنهاد سازنده و قابل اجرایی دارند، مرخصی تشویقی اعطا می‌شود. برای ارتقاء سطح دانش کارکنان، مرخصی آموزشی نیز قابل اعطاء است. کار در ایام تعطیل (مأموریت یا کار در تعطیلات رسمی) حقوق طبق قانون پرداخت می‌شود. تعطیلات توافقی (نوروز و تابستانی) با تأیید مدیرعامل.",
     "source_section": "۶-۵- مرخصی تشویقی"},
    {"doc_id": "leave", "topic": "leave_study",
     "title": "مرخصی تحصیلی",
     "text": "مرخصی تحصیلی از نوع مرخصی بدون حقوق است و برای افرادی که از طرف شرکت ملزم به ادامه تحصیل می‌شوند اعطا می‌گردد. مدت قانونی: فوق دیپلم ۲ سال، کارشناسی ۴ سال، کارشناسی ارشد ۲ سال — قابل تمدید تا ۲ سال دیگر در هر مقطع. شرط الکتروکویر: تهاتر مرخصی تحصیلی با اضافه‌کاری. در صورت نداشتن اضافه‌کار یا مرخصی برای تهاتر، کسرکار محسوب می‌شود. اخذ مجوز مدیرعامل یا نماینده وی الزامی است.",
     "source_section": "۶-۹- مرخصی تحصیلی"},
    {"doc_id": "leave", "topic": "leave_exit_permit",
     "title": "مجوز خروج (مرخصی کوتاه‌مدت)",
     "text": "مجوز خروج: نوعی مرخصی کوتاه‌مدت که پرسنل در مدت موظفی می‌توانند از آن استفاده کنند. مدت زمان هر مجوز خروج حداکثر ۱۰ دقیقه است و حداکثر استفاده از آن دو بار در هفته می‌باشد.",
     "source_section": "۶-۱۰- مرخصی مجوز خروج"},
    {"doc_id": "leave", "topic": "leave_buyback",
     "title": "بازخرید مرخصی و مرخصی منفی",
     "text": "بازخرید مرخصی: ۱) چنانچه درخواست استفاده از مرخصی همکار طی سال به ضرورت مورد موافقت مدیر قرار نگیرد، بازخرید مازاد مرخصی آن سال بر اساس جمع کل حقوق در پایان سال محاسبه و پرداخت می‌شود. ۲) بازخرید مانده مرخصی ذخیره‌شده سال‌های گذشته با تأیید مدیر، مشروط بر نگهداری ۹ روز. ۳) بازخرید مرخصی انباشته در زمان خاتمه همکاری بر اساس جمع کل حقوق. ۴) مرخصی منفی (استفاده بیش از استحقاقی جاری و ذخیره) حداکثر ۳ روز است؛ مازاد آن باید از مرخصی بدون حقوق استفاده شود. در شرایط خاص با تصمیم مدیریت ارشد قابل تغییر است.",
     "source_section": "۶-۱۱- بازخرید مرخصی"},
    {"doc_id": "leave", "topic": "leave_other",
     "title": "سایر مرخصی‌ها",
     "text": "سایر مرخصی‌ها از جمله شرکت در مسابقات ورزشی و موارد مشابه با اخذ مجوز امکان‌پذیر است و نحوه استفاده و کسر از مرخصی در اختیارات مدیران ارشد، مدیرعامل یا نماینده وی می‌باشد.",
     "source_section": "۶-۱۲- سایر مرخصی ها"},
    {"doc_id": "leave", "topic": "leave_registration",
     "title": "ثبت مرخصی در سامانه کسرا",
     "text": "ثبت مرخصی: کاربر باید از طریق سیستم کسرا به آدرس kasra.electrokavir.com نسبت به ثبت مرخصی خود اقدام نماید. تاریخ و مدت استفاده از مرخصی استحقاقی منوط به درخواست همکار و موافقت مدیر مربوطه است. در صورت عدم موافقت مدیر و عدم حضور فرد، آن روز غیبت غیرموجه تلقی شده و مطابق مفاد آیین‌نامه انضباط کار با وی برخورد می‌شود.",
     "source_section": "۶-۱-۲- ثبت مرخصی + ۶-۱-۴- استفاده از مرخصي"},
    {"doc_id": "leave", "topic": "leave_sick_to_annual_conversion",
     "title": "تبدیل مرخصی استحقاقی به استعلاجی",
     "text": "تبدیل مرخصی: کارکنانی که در حال استفاده از مرخصی استحقاقی هستند، در صورت ابتلا به بیماری و مصداق مواد مربوط به مرخصی استعلاجی، حکم مرخصی استحقاقی آنان از تاریخ ابتلا به بیماری به مرخصی استعلاجی تبدیل می‌گردد. جهت ایام مرخصی استعلاجی حقوق از طرف شرکت پرداخت نمی‌گردد و غرامت دستمزد از سوی سازمان تأمین اجتماعی پرداخت می‌شود.",
     "source_section": "۶-۶-۱- تبدیل مرخصی استحقاقی به استعلاجی"},

    # ---- Overtime canonical facts ----
    {"doc_id": "overtime", "topic": "overtime",
     "title": "سقف و نرخ اضافه کاری",
     "text": "سقف اضافه کار: حداکثر ۱۲۰ ساعت در ماه؛ حداکثر ۲:۱۵ ساعت در روز در شرایط عادی و ۸ ساعت در شرایط خاص (با تأیید مدیر). نرخ: ۱.۴ برابر هر ساعت کار عادی (۴۰٪ بالای مزد ثابت). جمعه و تعطیلات رسمی دارای ۴۰٪ مزایای اضافه. ساعات کار قانونی: ۴۴ ساعت در هفته. ثبت در نرم‌افزار کسری.",
     "source_section": "۵. روش اجرا"},
    {"doc_id": "overtime", "topic": "night_shift",
     "title": "تعریف شب کاری و شیفت",
     "text": "شب کاری: ۲۲:۰۰ تا ۰۶:۰۰ بامداد. صبح: ۰۷:۳۰ تا ۱۵:۴۵، عصر: ۱۵:۴۵ تا ۲۱:۰۰. نوبت کاری: گردش بین صبح/عصر/شب. در نوبت کاری ساعات کار ممکن است از ۸ ساعت/روز و ۴۴ ساعت/هفته تجاوز کند، لیکن جمع ۴ هفته متوالی نباید از ۱۷۶ تا ۱۹۲ ساعت تجاوز کند.",
     "source_section": "۴. اصلاحات و تعاریف"},
    {"doc_id": "overtime", "topic": "overtime_summary",
     "title": "جمع‌بندی کامل قواعد اضافه کاری در الکتروکویر",
     "text": "قواعد کامل اضافه کاری شرکت الکتروکویر طبق دستورالعمل EKWI-AD-005-01: "
             "۱) **تعاریف**: اضافه کار = ساعات مازاد بر ۴۴ ساعت در هفته (یا ۱۷۶-۱۹۲ ساعت در ۴ هفته نوبت‌کاری). اضافه کار در ایام تعطیل از لحظه ورود محسوب می‌شود. "
             "۲) **سقف ساعت**: حداکثر ۱۲۰ ساعت در ماه؛ روزانه حداکثر ۲:۱۵ ساعت در شرایط عادی، حداکثر ۸ ساعت در شرایط خاص با تأیید مدیر. "
             "۳) **نرخ (فوق‌العاده)**: ۱.۴ برابر مزد ساعت کار عادی = ۴۰٪ علاوه بر مزد. فرمول: مزد یک ساعت اضافه‌کاری = ۴۰٪ × (مزد ماهانه ÷ ۳۰ ÷ ۷.۳۳). "
             "۴) **روز جمعه و تعطیلات**: ۴۰٪ علاوه بر مزد به همه کارکنان جمعه‌کار تعلق می‌گیرد و این ۴۰٪ مأخذ اضافه‌کاری همان روز محسوب می‌شود. تبصره: فوق‌العاده اضافه‌کاری فقط برای روزهای تعطیل (رسمی و شیفت) لحاظ می‌شود. "
             "۵) **مأخذ محاسبه**: فقط مزد ثابت (نه مزایای متغیر) مأخذ اضافه‌کاری است. "
             "۶) **نوبت‌کاری**: ممکن است ساعات بیش از ۸ ساعت/روز و ۴۴ ساعت/هفته باشد، اما جمع ۴ هفته متوالی نباید از ۱۷۶ تا ۱۹۲ ساعت تجاوز کند. "
             "۷) **مأموریت**: اضافه‌کاری در مأموریت با تأیید مدیر/معاونت واحد یا واحد خدمات مشتری منظور می‌گردد. "
             "۸) **محل**: اضافه‌کاری خارج از محل شرکت نیازمند مجوز مدیر/معاونت واحد است. "
             "۹) **ثبت**: همه اطلاعات اضافه‌کاری در نرم‌افزار کسری ثبت می‌شود. "
             "۱۰) **تعاریف زمانی**: شب‌کاری ۲۲:۰۰ تا ۰۶:۰۰، صبح ۰۷:۳۰ تا ۱۵:۴۵، عصر ۱۵:۴۵ تا ۲۱:۰۰.",
     "source_section": "تمام بخش‌های دستورالعمل اضافه کاری"},

    # ---- Attendance canonical facts ----
    {"doc_id": "attendance", "topic": "attendance",
     "title": "سامانه حضور و غیاب کسرا",
     "text": "نرم‌افزار حضور و غیاب کسرا (kasra.electrokavir.com) سامانه رسمی است. ثبت ورود/خروج از طریق اثر انگشت یا چهره. تعداد ورود/خروج باید زوج باشد. حداکثر ۵ تردد دستی در ماه مجاز است؛ بیش از آن نیاز به تأیید معاونت.",
     "source_section": "۵-۲- درخواست تردد"},
    {"doc_id": "attendance", "topic": "late_arrival",
     "title": "تأخیر و تعجیل در ورود و خروج",
     "text": "تأخیر ورود تا ۵ دقیقه در ماه نادیده گرفته می‌شود. بیش از ۵ دقیقه مشمول مقررات داخلی. ۱۰ دقیقه اول روز کاری قابل ثبت مرخصی نیست (کسرکار). مجموع تأخیر بیش از ۶۰ دقیقه در ماه = تأخیر غیرموجه طبق آیین‌نامه انضباط کار.",
     "source_section": "۵-۳- تأخیر و تعجیل"},
    {"doc_id": "attendance", "topic": "retroactive_window",
     "title": "بازه ثبت تردد گذشته",
     "text": "حداکثر ۷ روز (کاری/غیرکاری) پس از مرخصی، مأموریت یا سایر موارد قانونی برای ثبت در کسرا فرصت دارید. مرخصی روزهای پایانی هر ماه باید تا پایان روز اول ماه بعد ثبت شود. در شرایط خاص با نظر کارشناس سرمایه انسانی قابل تغییر است.",
     "source_section": "۵-۱- بررسی و رفع اشکالات تردد"},
    {"doc_id": "attendance", "topic": "attendance_summary",
     "title": "جمع‌بندی کامل تردد، حضور و غیاب",
     "text": "قواعد حضور و غیاب شرکت الکتروکویر طبق دستورالعمل EKWI-AD-001-07: "
             "۱) **سامانه**: نرم‌افزار کسرا (kasra.electrokavir.com) — سامانه رسمی. ثبت ورود/خروج با اثر انگشت یا چهره. تعداد ورود/خروج باید زوج باشد. "
             "۲) **تردد دستی**: حداکثر ۵ تردد دستی در ماه مجاز. بیش از آن نیاز به تأیید معاونت. "
             "۳) **تأخیر مجاز**: تأخیر ورود تا ۵ دقیقه در ماه نادیده گرفته می‌شود. بیش از آن مشمول مقررات داخلی. مجموع تأخیر بیش از ۶۰ دقیقه در ماه = تأخیر غیرموجه طبق آیین‌نامه انضباط کار. "
             "۴) **۱۰ دقیقه اول**: قابل ثبت مرخصی نیست و کسرکار محسوب می‌شود. "
             "۵) **بازه ثبت گذشته**: حداکثر ۷ روز پس از مرخصی، مأموریت یا موارد قانونی فرصت برای ثبت. مرخصی روزهای پایانی هر ماه باید تا پایان روز اول ماه بعد ثبت شود. "
             "۶) **اصلاح**: درخواست اصلاح تردد به کارشناس سرمایه انسانی ارسال می‌شود. در موارد خاص با نظر کارشناس قابل تغییر است. "
             "۷) **رفع اشکال**: مشکلات سامانه از طریق واحد سرمایه انسانی پیگیری می‌شود. ساعات استاندارد کار: ۰۷:۳۰ تا ۱۵:۴۵ (صبح)، ۱۵:۴۵ تا ۲۱:۰۰ (عصر).",
     "source_section": "تمام بخش‌های دستورالعمل تردد و حضور و غیاب"},

    # ---- Recruitment canonical facts ----
    {"doc_id": "recruitment", "topic": "age_limit",
     "title": "محدودیت سنی استخدام",
     "text": "حداقل ۱۸ و حداکثر ۳۵ سال برای مشاغل غیرکارشناسی؛ حداقل ۲۲ و حداکثر ۴۰ سال برای مشاغل کارشناسی. در مشاغل تخصصی با تأیید مدیرعامل امکان صرف‌نظر از حداکثر سن وجود دارد.",
     "source_section": "۵-۴-۱- مصاحبه عمومی"},
    {"doc_id": "recruitment", "topic": "required_documents",
     "title": "مدارک مورد نیاز استخدام",
     "text": "مدارک استخدام: ۱) طب کار از مرکز سلامت مجاز ۲) گواهی عدم سوء پیشینه (پلیس +۱۰) ۳) آزمایش عدم اعتیاد ۴) افتتاح حساب بانک معرفی‌شده ۵) فرم بیمه تأمین اجتماعی ۶) حساب بانک رفاه ۷) اصل و کپی شناسنامه ۸) اصل و کپی مدرک تحصیلی ۹) اصل و کپی کارت پایان خدمت ۱۰) اصل و کپی کارت ملی ۱۱) ۴ قطعه عکس ۴×۳ ۱۲) ضمانت کار.",
     "source_section": "۵-۵- مدارک مورد نیاز شرکت"},
    {"doc_id": "recruitment", "topic": "contract_types",
     "title": "انواع قرارداد کار",
     "text": "انواع قرارداد در الکتروکویر: ۱) قرارداد دائم (نامحدود، تمام‌وقت) ۲) قرارداد آزمایشی (حداکثر ۳ ماه، در بدو استخدام) ۳) قرارداد کار مدت‌دار (موقت معین، تمام‌وقت) ۴) قرارداد کار ساعتی (مدت زمان مشخص، پرداخت ساعتی) ۵) قرارداد مشاوره (حق‌الزحمه توافقی با تأیید مدیرعامل).",
     "source_section": "۴. اصطلاحات و تعاریف"},
    {"doc_id": "recruitment", "topic": "general_requirements",
     "title": "شرایط عمومی استخدام",
     "text": "شرایط عمومی جذب: ۱) تابعیت ایرانی (افراد خارجی با مجوز اداره اشتغال اتباع بیگانه) ۲) حداقل مدرک تحصیلی پست ۳) محدودیت سنی ۴) سلامت جسمانی و روانی (طب کار) ۵) عدم سوء پیشینه ۶) عدم اعتیاد به مواد مخدر ۷) کارت پایان خدمت یا معافیت (آقایان) ۸) موفقیت در مصاحبه ورودی.",
     "source_section": "۵-۴-۱- مصاحبه عمومی"},

    # ---- Termination canonical facts ----
    {"doc_id": "termination", "topic": "resignation_notice",
     "title": "مدت اعلام استعفا",
     "text": "اعلام تصمیم خروج باید به‌صورت مکتوب و حداقل ۳۰ روز قبل (مطابق قرارداد) به مدیر مستقیم اعلام شود. استعفا صرفاً در صورت مکتوب بودن و تأیید مدیر مافوق معتبر است. غیبت غیرموجه قبل از تاریخ رسمی خروج موجب عدم پرداخت حقوق و مزایای آن دوره می‌شود.",
     "source_section": "۵-۲- اعلام تصمیم خروج"},
    {"doc_id": "termination", "topic": "settlement",
     "title": "تسویه حساب",
     "text": "تسویه حساب پس از تکمیل فرم و ارائه به واحد مالی انجام می‌شود. واحد مالی مطالبات قانونی و حقوق باقی‌مانده را حداقل ۲ ماه پس از تاریخ تسویه پرداخت می‌کند. سنوات: یک ماه از آخرین حقوق و مزایای مستمر به ازای هر سال کارکرد.",
     "source_section": "۵-۵- تسویه حساب نهایی"},
    {"doc_id": "termination", "topic": "exit_interview",
     "title": "مصاحبه خروج",
     "text": "مصاحبه خروج: گفتگوی انفرادی توسط نماینده واحد سرمایه انسانی برای بررسی دلایل ترک شغل و دریافت بازخورد. مستندسازی تجربیات مثبت/منفی و پیشنهادات. اطلاعات برای بهبود سیاست‌ها و شناسایی دلایل ترک خدمت استفاده می‌شود.",
     "source_section": "۵-۴- بررسی تصمیم خروج"},

    # ---- Loan canonical facts ----
    {"doc_id": "loan", "topic": "loan_types",
     "title": "انواع تسهیلات (وام)",
     "text": "سه نوع وام در الکتروکویر: ۱) وام امتیازی (از گردش حساب بانکی شرکت، ۷۰-۷۵٪ امتیاز، ۱۸ ماهه با کارمزد ۴٪) ۲) وام کوتاه مدت شرکت (سال ۱۴۰۴: ۱۲ میلیون تومان، ۶ ماهه، یک‌بار در سال) ۳) وام ضروری (سقف ۵۰ میلیون تومان، تأیید کمیته وام، ۱۸ ماهه ۴٪). تمامی درخواست‌ها از طریق سیستم BPMS.",
     "source_section": "انواع و نحوه تخصیص وام"},
    {"doc_id": "loan", "topic": "loan_tiers",
     "title": "سقف وام امتیازی بر اساس سطح سازمانی",
     "text": "سقف وام امتیازی: مدیر/سرپرست = ۵۰ میلیون تومان؛ کارشناس/مسئول = ۴۰ میلیون تومان؛ کارکنان تولید/فنی/خدمات/کارمند = ۳۰ میلیون تومان. تخصیص بر اساس امتیاز گردش حساب شرکت.",
     "source_section": "۱- وام امتیازی"},
    {"doc_id": "loan", "topic": "loan_emergency_eligibility",
     "title": "موارد وام ضروری",
     "text": "وام ضروری در موارد: ۱) تصادفات و اتفاقات با هزینه ناگهانی ۲) بیماری‌های خاص و پرهزینه خود یا اعضای درجه یک خانواده (خارج از سقف بیمه تکمیلی) ۳) ازدواج پرسنل ۴) ازدواج فرزندان ۵) تولد فرزندان. شرط: حداقل ۶ ماه سابقه، تسویه وام قبلی، تأیید کمیته وام.",
     "source_section": "۳- وام ضروری"},

    # ---- Promotion canonical facts ----
    {"doc_id": "promotion", "topic": "promotion_committee",
     "title": "ترکیب کمیته ارتقا",
     "text": "ترکیب کمیته ارتقا: برای رده مدیران شامل قائم‌مقام، معاون سرمایه انسانی، مافوق واحد مبدا و مقصد است. برای رده سرپرستان: معاون سرمایه انسانی، مافوق واحد مبدا و مقصد. برای معاونین و مدیرانی که مستقیم با مدیرعامل همکاری می‌کنند، حضور مدیرعامل یا نماینده قانونی الزامی است.",
     "source_section": "۵-۱ مراحل پیش از انتصاب"},
    {"doc_id": "promotion", "topic": "deputy_phase",
     "title": "دوره جانشینی پیش از حکم اصلی",
     "text": "برای مدیران و معاونت‌ها، ابتدا حکم جانشین مدیر یا معاون صادر می‌شود. پس از ۳ الی ۶ ماه، در صورت رضایت، حکم اصلی تفویض می‌گردد. احکام سرپرستان توسط معاون سرمایه انسانی و احکام مدیران/معاونت‌ها توسط مدیرعامل امضا می‌شود.",
     "source_section": "۵-۲ انتصاب و صدور حکم"},

    # ---- Recruitment full summary ----
    {"doc_id": "recruitment", "topic": "recruitment_summary",
     "title": "جمع‌بندی کامل فرآیند جذب و استخدام",
     "text": "فرآیند جذب و استخدام — مراحل استخدام — recruitment process — hiring steps. "
             "فرآیند کامل جذب و استخدام در شرکت الکتروکویر طبق دستورالعمل EKWI-AD-004-07: "
             "۱) **مراجعه/ثبت‌نام** — حضوری در واحد سرمایه انسانی، یا تکمیل پرسشنامه استخدامی در electrokavir.com، یا معرفی از سایت‌های کاریابی. "
             "۲) **مصاحبه عمومی** — توسط معاون سرمایه انسانی برای بررسی شرایط احراز: تابعیت ایرانی، حداقل مدرک تحصیلی پست، سن (۱۸-۳۵ سال غیر کارشناسی / ۲۲-۴۰ سال کارشناسی)، سلامت جسمی و روانی، عدم سوء پیشینه، عدم اعتیاد، کارت پایان خدمت (آقایان). "
             "۳) **مصاحبه تخصصی** — توسط واحد متقاضی بر اساس شرایط احراز شغل؛ سپس تأییدیه نهایی در نرم‌افزار BPMS. "
             "۴) **مدارک مورد نیاز** — طب کار، گواهی عدم سوء پیشینه (پلیس +۱۰)، آزمایش عدم اعتیاد، افتتاح حساب بانک معرفی شده، فرم بیمه تأمین اجتماعی، حساب بانک رفاه، اصل و کپی شناسنامه/کارت ملی/مدرک تحصیلی/کارت پایان خدمت، ۴ قطعه عکس ۴×۳، ضمانت کار. "
             "۵) **انواع قرارداد** — دائم (نامحدود تمام‌وقت)، آزمایشی (حداکثر ۳ ماه بدو استخدام)، کار مدت‌دار (موقت معین تمام‌وقت)، کار ساعتی (پرداخت ساعتی)، مشاوره (حق‌الزحمه توافقی با تأیید مدیرعامل). "
             "۶) **تشکیل پرونده پرسنلی** — مدارک بند ۴ تحویل واحد سرمایه انسانی؛ طب کار به HSE ارسال می‌شود. "
             "۷) **تنظیم و امضای قرارداد** — قرارداد در دو نسخه؛ یک نسخه به کارمند، یک نسخه در پرونده پرسنلی. در دوره قرارداد اول، مستخدم مشمول تسهیلات مالی شرکت نمی‌شود. سنوات سال = یک ماه از آخرین حقوق و مزایا به ازای هر سال کارکرد. "
             "۸) **تمدید/عدم تمدید** — توسط مدیر/سرپرست در نرم‌افزار قراردادها؛ اطلاع‌رسانی عدم تمدید: ۱ ماه قبل برای فعال، ۲ ماه قبل برای استعلاجی. "
             "۹) **جابجایی درون‌سازمانی** — فرم درخواست تامین نیرو از داخل سازمان، ارسال به سرمایه انسانی، بررسی شرایط احراز. "
             "۱۰) **بازنشستگی** — طبق قوانین سازمان تأمین اجتماعی.",
     "source_section": "تمام بخش‌های دستورالعمل جذب و استخدام"},

    # ---- Termination full summary ----
    {"doc_id": "termination", "topic": "termination_summary",
     "title": "جمع‌بندی کامل فرآیند قطع همکاری و استعفا",
     "text": "فرآیند قطع همکاری — مراحل استعفا — تسویه حساب — termination process — resignation steps. "
             "مراحل قطع همکاری در شرکت الکتروکویر طبق دستورالعمل EKWI-AD-008-00: "
             "۱) **پیش از ورود رسمی به مسیر استعفا** — پس از اعلام غیررسمی یا نشانه‌های نارضایتی، گفتگو با واحد سرمایه انسانی الزامی است. اگر ماندن ممکن باشد طرح نگهداشت اجرا می‌شود؛ در غیر این صورت فرآیند خروج آغاز می‌شود. "
             "۲) **اعلام تصمیم خروج** — به صورت مکتوب به مدیر مستقیم، **حداقل ۳۰ روز قبل** از زمان خروج (مطابق قرارداد). استعفای شفاهی یا غیبت غیرموجه به‌منزله استعفا نیست. غیبت بین ترک کار و تاریخ رسمی = غیبت غیرموجه (عدم پرداخت حقوق آن دوره، عدم صدور گواهی حسن انجام کار). "
             "۳) **ارزیابی وضعیت کاری و تحویل امور** — مدیر واحد پروژه‌های ناتمام، وظایف جاری و دانش انباشته را به فرد جایگزین یا تیم منتقل می‌کند. تصمیم درباره جایگزینی یا بازطراحی تیمی. "
             "۴) **بررسی توسط واحد سرمایه انسانی + مصاحبه خروج** — گفتگوی انفرادی برای بررسی دلایل ترک شغل، دریافت بازخورد، مستندسازی تجربیات. در این مرحله فرم تسویه در اختیار فرد قرار می‌گیرد. "
             "۵) **تسویه حساب نهایی** — فرم به واحد مالی ارائه می‌شود. واحد مالی مطالبات قانونی و حقوق باقی‌مانده را **حداقل ۲ ماه** پس از تاریخ تسویه پرداخت می‌کند. سنوات = یک ماه از آخرین حقوق و مزایای مستمر به ازای هر سال کارکرد. "
             "۶) **ثبت خروج در سیستم و تحلیل سازمانی** — حذف دسترسی (تلفن، ایمیل، شبکه‌های مجازی)؛ اطلاعات مصاحبه خروج برای بهبود سیاست‌ها استفاده می‌شود. در صورت خروج حرفه‌ای و موافقت مدیران ارشد، قدردانی رسمی ممکن است. "
             "همه گفت‌وگوها با حفظ احترام، رازداری و شفافیت انجام می‌شود. در شرایط خاص (انضباطی/امنیتی) فرآیند سریع و ویژه است.",
     "source_section": "تمام بخش‌های دستورالعمل قطع همکاری (۵-۱ تا ۵-۶)"},

    # ---- Loan full summary ----
    {"doc_id": "loan", "topic": "loan_summary",
     "title": "جمع‌بندی کامل تسهیلات و وام در الکتروکویر",
     "text": "انواع وام — تسهیلات الکتروکویر — loans summary. "
             "شرکت الکتروکویر بر اساس سند RE-AD-008-00 سه نوع وام/تسهیلات اعطا می‌کند: "
             "۱) **وام امتیازی** — منبع: امتیاز گردش حساب شرکت در بانک. سقف بر اساس سطح سازمانی: مدیر/سرپرست ۵۰ میلیون تومان، کارشناس/مسئول ۴۰ میلیون تومان، کارکنان تولید/فنی/خدمات/کارمند ۳۰ میلیون تومان. ۷۰-۷۵٪ از امتیاز شرکت به وام امتیازی تخصیص می‌یابد. بازگشت ۱۸ ماهه با کارمزد ۴٪. رتبه‌بندی: هر روز ثبت ۱ امتیاز، هر ماه سابقه ۱ امتیاز. ثبت در BPMS. "
             "۲) **وام کوتاه‌مدت شرکت** — مبلغ توسط مدیرعامل/مالی/سرمایه‌انسانی در اسفند هر سال تعیین. **سال ۱۴۰۴: ۱۲ میلیون تومان** یک بار در سال. شرط: حداقل ۶ ماه سابقه، تسویه وام قبلی، استعلام مثبت معاونت بابت تمدید قرارداد. بازپرداخت ۶ ماهه با کسر از حقوق. "
             "۳) **وام ضروری** — سقف ۵۰ میلیون تومان. بودجه ۱۰-۲۰٪ امتیازات سالانه. موارد: تصادفات با هزینه ناگهانی، بیماری‌های خاص خود یا اعضای درجه یک خانواده خارج از سقف بیمه تکمیلی، ازدواج پرسنل، ازدواج فرزندان، تولد فرزندان. شرط: حداقل ۶ ماه سابقه، تسویه وام ضروری قبلی، تأیید کمیته وام. کمیته وام آخرین هفته هر ماه با حضور حداقل ۳ نفر از: معاون مالی، معاون سرمایه انسانی، نماینده شورا، نماینده مدیرعامل تشکیل می‌شود. بازپرداخت ۱۸ ماهه با کارمزد ۴٪. "
             "همه وام‌ها از طریق سامانه BPMS ثبت می‌شوند. منبع تأمین: اندوخته شرکت یا امتیاز گردش حساب در بانک مهر. مسئول تخصیص: معاونت مالی؛ نظارت: مدیرعامل یا نماینده وی.",
     "source_section": "انواع و نحوه تخصیص وام (۱، ۲، ۳)"},

    # ---- Promotion full summary ----
    {"doc_id": "promotion", "topic": "promotion_summary",
     "title": "جمع‌بندی کامل فرآیند انتصاب و ارتقا",
     "text": "فرآیند انتصاب و ارتقا — مراحل ارتقا — promotion process. "
             "مراحل انتصاب و ارتقا در شرکت الکتروکویر طبق دستورالعمل EKWI-AD-009-00: "
             "۱) **مراحل پیش از انتصاب** — اعلام نیاز واحد (ایجاد پست، بازنشستگی، استعفا، توسعه). تأیید سرپرستان با معاونت سرمایه انسانی، تأیید مدیران/معاونین با قائم‌مقام و مدیرعامل. تطابق شرایط احراز و شاخص‌های عملکردی فرد با شناسنامه شغل (سابقه، تحصیلات، آموزش، مهارت‌های نرم). "
             "۲) **ترکیب کمیته ارتقا** — برای رده مدیران: قائم‌مقام + معاون سرمایه انسانی + مافوق واحد مبدا و مقصد. برای رده سرپرستان: معاون سرمایه انسانی + مافوق واحد مبدا و مقصد. برای معاونین و مدیران مستقیم با مدیرعامل: حضور مدیرعامل یا نماینده قانونی الزامی. "
             "۳) **جلسه کمیته ارتقا** — نقد و بررسی عملکرد، بازخورد مدیران مافوق و همکاران کلیدی، مصاحبه واحد سرمایه انسانی، معرفی کاندیدای نهایی طی صورتجلسه. "
             "۴) **انتصاب و صدور حکم** — برای مدیران/معاونت‌ها ابتدا حکم **جانشین** صادر می‌شود؛ پس از **۳ الی ۶ ماه** در صورت رضایت، حکم اصلی تفویض می‌گردد. احکام سرپرستان توسط معاون سرمایه انسانی، احکام مدیران/معاونت‌ها توسط مدیرعامل امضا می‌شود. ابلاغ در جلسه رسمی. "
             "۵) **انتقال وظایف** — صورتجلسه تحویل وظایف، پروژه‌های جاری، اموال، اختیارات مالی/اداری توسط مافوق واحدهای مبدا و مقصد. "
             "۶) **اقدامات بعد از انتصاب** — اطلاع‌رسانی به همکاران از طریق ایمیل شرکت توسط واحد اداری. آموزش و توانمندسازی (دوره‌های مهارتی شناسنامه شغل). بازخورد، حمایت و پایش: جلسات منظم با مافوق و سرپرست واحد توسعه انسانی در طی ۱ سال از تاریخ حکم. ثبت و بایگانی احکام و مستندات در پرونده پرسنلی.",
     "source_section": "تمام بخش‌های دستورالعمل انتصاب و ارتقا (۵-۱ تا ۵-۳)"},

    # ---- Access control cards (this doc had ZERO cards before) ----
    {"doc_id": "access-control", "topic": "access_summary",
     "title": "جمع‌بندی کامل دستورالعمل تردد افراد، کالا و وسایل نقلیه",
     "text": "تردد افراد و کالا — قوانین ورود و خروج — حراست — access control summary. "
             "دستورالعمل جامع تردد (EKWIAD00900) موارد زیر را پوشش می‌دهد: "
             "۱) **تردد کارکنان** — صرفاً از درب اصلی، با اثر انگشت یا چهره در دستگاه حضور و غیاب. اضافه‌کاری در ساعات غیراداری تنها برای افرادی که نام آن‌ها **حداقل یک روز قبل** از طریق ایمیل توسط معاون/مدیر/سرپرست به واحد حراست اعلام و در فهرست مجازین ثبت شده باشد. در شرایط اضطراری تماس تلفنی با سرپرست حراست + ایمیل تأییدیه روز کاری بعد. درخواست آژانس برای اضافه‌کاری: تا ساعت ۱۴:۳۰ (واحد QC: ۱۴:۳۰ تلفنی). "
             "۲) **نمایندگان شرکت‌های همکار** — تحویل نقشه بدون نیاز به خودرو و هماهنگی. تحویل قطعه با هماهنگی نگهبان با مسئول مربوطه. خروج قطعه فقط با برگه خروج معتبر و امضای مجاز. ورود در زمان استراحت پرسنل ممنوع مگر با هماهنگی قبلی سرپرست. "
             "۳) **مهمانان و کارآموزان** — ورود با ثبت در فرم (نام، سمت، ساعت ملاقات) و هماهنگی تلفنی نگهبان با مدیر/سرپرست. مهمان زودرس به اتاق انتظار یا فضای نگهبانی هدایت می‌شود. خارج از ساعات اداری: درخواست کتبی به حراست + ثبت + ایمیل تأییدیه روز بعد. کارآموزان: معرفی‌نامه از سرمایه انسانی + ثبت اثر انگشت در دستگاه حضور و غیاب. "
             "۴) **ورود و خروج اقلام از انبار** — کالاها به صورت بسته‌بندی به انبار. صدور برگه خروج از طریق ایمیل + شماره خروج. زمان‌بندی: درخواست صدور برگه ساعت ۱۱ و ۱۴، تحویل کالا به انبار ۱۱:۰۰-۱۱:۳۰ و ۱۴:۰۰-۱۴:۳۰، تحویل بسته‌ها به راننده ۱۲:۰۰ و ۱۵:۰۰. مهلت کالا: ۲۴ ساعت در انبار، ۷۲ ساعت تعیین تکلیف یا ابطال. "
             "۵) **شرایط بسته‌بندی** — تسمه مناسب، حداکثر **۱۵ کیلوگرم در هر بسته**، اقلام سنگین روی پالت، لیبل اطلاعات حمل (رطوبت، شکستنی، جهت). "
             "۶) **خارج از ساعت کاری (عدم حضور انبار)** — درخواست‌کننده برگه خروج را قبل از پایان ساعت اداری تحویل می‌گیرد و با رویت نگهبان بارگیری می‌کند؛ یا با اخذ تأییدیه دکتر درویش/مهندس مورکیان/مهندس رنجبر در موارد عجله‌ای. "
             "۷) **بازدید خودروها** — شرکتی: ثبت ساعت/کیلومتر/تحویل‌گیرنده. شخصی: ممنوع جز با مجوز کتبی مدیریت. حامل بار: مجوز بار + برگه ورود/خروج، بازدید بدنه/کابین/صندوق عقب قبل از خروج. "
             "۸) **ساعات ارسال بسته‌ها** — تیپاکس تا ۱۳:۰۰، باربری تا ۱۲:۰۰، شرکت‌های زیرمجموعه تا ۱۴:۳۰. کالاهای کارفرما فقط ساعات اداری. "
             "۹) **مأموریت و خودرو** — درخواست از طریق ایمیل (تا BPMS) شامل نام راننده، مسیر، هدف. خودروهای پادرا/نیسان: گواهینامه پایه دوم. ماموریت برون شهری مشمول اضطراری نمی‌شود. "
             "۱۰) **HSE** — مواد پرریسک تنها با تأیید واحد HSE بارگیری می‌شوند. "
             "مسئولیت اجرا: نگهبانان و پرسنل حراست. نظارت: سرپرست حراست. گزارش ماهانه به قائم‌مقام مدیرعامل.",
     "source_section": "تمام بخش‌های دستورالعمل تردد (۵-۱ تا ۵-۹)"},
    {"doc_id": "access-control", "topic": "access_off_hours",
     "title": "حضور در ساعات غیراداری و تعطیلات",
     "text": "حضور در ساعات غیراداری و روزهای تعطیل تنها برای افرادی مجاز است که نامشان **حداقل یک روز قبل** از طریق ایمیل رسمی توسط معاون/مدیر/سرپرست به واحد حراست اعلام و در فهرست مجازین ثبت شده باشد. ایمیل باید شامل نام، واحد، تاریخ و ساعت حضور جهت رزرو غذا باشد. در شرایط اضطراری (ارسال ایمیل ممکن نیست) تماس تلفنی با سرپرست حراست یا کشیک حراست — حراست اجازه ورود موقت می‌دهد و معاون/مدیر باید **روز کاری بعد** ایمیل تأییدیه ارسال کند. حضور افراد متفرقه و میهمانان در تعطیلات بدون ایمیل کتبی ممنوع. اخذ آژانس برای اضافه‌کاری تا ساعت ۱۴:۳۰ (واحد کنترل کیفیت: تلفنی ۱۴:۳۰).",
     "source_section": "۵-۱ فرآیند ورود و خروج کارکنان"},
    {"doc_id": "access-control", "topic": "access_warehouse_timing",
     "title": "زمان‌بندی انبار و برگه خروج کالا",
     "text": "زمان‌بندی انبار: درخواست صدور برگه خروج ساعت ۱۱ و ۱۴؛ تحویل کالا به انبار ۱۱:۰۰-۱۱:۳۰ و ۱۴:۰۰-۱۴:۳۰؛ تحویل بسته‌ها از انبار به راننده ساعت ۱۲:۰۰ و ۱۵:۰۰. کالا حداکثر ۲۴ ساعت در انبار می‌ماند؛ اگر تا ۷۲ ساعت تعیین تکلیف نشود، باطل می‌شود و واحد موظف به تحویل از انبار است. شرایط بسته‌بندی: تسمه مناسب، حداکثر ۱۵ کیلوگرم در هر بسته، اقلام سنگین روی پالت، لیبل اطلاعات حمل (رطوبت، شکستنی، جهت). آدرس فرم‌های مورد نیاز: `\\\\mra\\Warehouse Forms`.",
     "source_section": "۵-۴ ورود و خروج اقلام از انبار + ۵-۴-۱ شرایط بسته‌بندی"},
    {"doc_id": "access-control", "topic": "access_visitors",
     "title": "ورود مهمانان، مراجعین و کارآموزان",
     "text": "ورود مهمانان و مراجعین صرفاً با ثبت در فرم مخصوص (نام، سمت، ساعت ملاقات) و هماهنگی تلفنی نگهبان با مدیر/سرپرست واحد مربوطه مجاز است. مهمان زودرس به اتاق انتظار واحد یا فضای نگهبانی هدایت می‌شود. خارج از ساعات اداری: درخواست کتبی به حراست؛ در صورت عدم هماهنگی کتبی، تماس با مدیر + ثبت موضوع + مجوز موقت توسط نگهبان + ایمیل تأییدیه روز بعد. اطلاعات و تجهیزات همراه میهمان در دفتر ثبت می‌شود؛ خروج با کنترل وسایل توسط نگهبان. در صورت مغایرت یا اقدام مشکوک، گزارش فوری به سرپرست حراست. کارآموزان: معرفی‌نامه از واحد سرمایه انسانی + ثبت اثر انگشت در دستگاه حضور و غیاب + استفاده در بدو ورود و خروج. تجهیزات شخصی: کنترل و ثبت شماره سریال در دفتر تجهیزات ورودی؛ تجهیزات ممنوعه تا زمان خروج در محل امن نگهداری می‌شوند.",
     "source_section": "۵-۳ بازدیدها، مراجعین، کارآموزان و مهمانان"},

    # ---- Q&A anchor mini-cards — short, question-shaped, front-loaded ----
    # Each anchor's text starts with the exact question phrasing a user
    # would type, so the embedding model's first-token similarity wins
    # the race against bland section headings. Anchors are short
    # (200-400 chars), point at the canonical detailed card or section,
    # and act as the top-1 hit on common Persian HR queries.
    {"doc_id": "leave", "topic": "anchor_leave_types",
     "title": "انواع مرخصی — لیست کامل",
     "text": "انواع مرخصی در شرکت الکتروکویر؟ چه نوع مرخصی‌هایی موجود است؟ فهرست مرخصی‌ها چیست؟ "
             "شرکت الکتروکویر طبق دستورالعمل EKWI-AD-006-01 مجموعاً **۱۲ نوع مرخصی رسمی** اعطا می‌کند: "
             "(۱) استحقاقی، (۲) شیردهی، (۳) زایمان، (۴) ازدواج و فوت، (۵) تشویقی و آموزشی، (۶) استعلاجی، "
             "(۷) بدون حقوق، (۸) حج، (۹) تحصیلی، (۱۰) مجوز خروج، (۱۱) بازخرید مرخصی، (۱۲) سایر. "
             "جزئیات هر نوع در کارت اختصاصی همان نوع آمده است.",
     "source_section": "فهرست انواع مرخصی"},
    {"doc_id": "leave", "topic": "anchor_leave_days",
     "title": "چند روز مرخصی استحقاقی داریم؟",
     "text": "چند روز مرخصی استحقاقی داریم؟ سقف مرخصی سالانه چقدر است؟ مرخصی سالانه چند روز است؟ "
             "مرخصی استحقاقی سالانه: **۳۰ روز در سال** با احتساب ۴ جمعه (ماده ۶۴ قانون کار). ماهانه ۲.۵ روز. حداکثر ۹ روز قابل ذخیره (ماده ۶۶، ۶۹). ۱۱ اردیبهشت روز کارگر جزو مرخصی استحقاقی.",
     "source_section": "۶-۱-۱- میزان مرخصی استحقاقی"},
    {"doc_id": "leave", "topic": "anchor_maternity_days",
     "title": "مرخصی زایمان چند روز است؟",
     "text": "مرخصی زایمان چند روز است؟ مرخصی زایمان چقدر طول می‌کشد؟ "
             "مرخصی زایمان: **جمعاً ۹ ماه** با حقوق (ماده ۷۶ قانون کار). حداکثر ۲ ماه قبل از زایمان قابل استفاده. حتی‌الامکان ۴۵ روز پس از زایمان. حقوق توسط سازمان تأمین اجتماعی پرداخت می‌شود (دو سوم میانگین دستمزد ۹۰ روز آخر).",
     "source_section": "۶-۳- مرخصی زایمان"},
    {"doc_id": "overtime", "topic": "anchor_overtime_cap",
     "title": "سقف اضافه کاری چقدر است؟",
     "text": "سقف اضافه کاری چقدر است؟ حداکثر ساعت اضافه‌کاری در ماه چقدر است؟ نرخ اضافه‌کاری چقدر است؟ "
             "سقف اضافه‌کاری: **حداکثر ۱۲۰ ساعت در ماه**؛ روزانه حداکثر ۲:۱۵ ساعت در شرایط عادی، حداکثر ۸ ساعت در شرایط خاص با تأیید مدیر. نرخ: **۱.۴ برابر** مزد ساعت کار عادی (۴۰٪ علاوه). فقط مزد ثابت مأخذ محاسبه است.",
     "source_section": "۵. روش اجرا (اضافه کاری)"},
    {"doc_id": "loan", "topic": "anchor_loan_types",
     "title": "انواع وام در الکتروکویر",
     "text": "انواع وام در شرکت الکتروکویر چیست؟ چه وام‌هایی موجود است؟ سقف وام چقدر است؟ "
             "**۳ نوع وام**: (۱) وام امتیازی (۳۰-۵۰ میلیون تومان بر اساس سطح سازمانی، ۱۸ ماهه ۴٪)، (۲) وام کوتاه‌مدت شرکت (سال ۱۴۰۴: ۱۲ میلیون تومان، ۶ ماهه)، (۳) وام ضروری (سقف ۵۰ میلیون تومان، تأیید کمیته وام، ۱۸ ماهه ۴٪). همه از طریق BPMS.",
     "source_section": "انواع و نحوه تخصیص وام"},
    {"doc_id": "recruitment", "topic": "anchor_age_limit",
     "title": "شرایط سنی استخدام چیست؟",
     "text": "شرایط سنی استخدام در الکتروکویر چیست؟ محدودیت سنی استخدام چقدر است؟ "
             "محدودیت سن: **حداقل ۱۸ و حداکثر ۳۵ سال** برای مشاغل غیرکارشناسی؛ **حداقل ۲۲ و حداکثر ۴۰ سال** برای مشاغل کارشناسی. در مشاغل تخصصی با تأیید مدیرعامل امکان صرف‌نظر از حداکثر سن وجود دارد.",
     "source_section": "۵-۴-۱- مصاحبه عمومی"},
    {"doc_id": "recruitment", "topic": "anchor_recruitment_docs",
     "title": "مدارک مورد نیاز استخدام",
     "text": "مدارک مورد نیاز استخدام چیست؟ چه مدارکی برای استخدام لازم است؟ "
             "مدارک: طب کار از مرکز سلامت مجاز، گواهی عدم سوء پیشینه (پلیس +۱۰)، آزمایش عدم اعتیاد، افتتاح حساب بانک معرفی شده، فرم بیمه تأمین اجتماعی، حساب بانک رفاه، اصل و کپی شناسنامه/کارت ملی/مدرک تحصیلی/کارت پایان خدمت، ۴ قطعه عکس ۴×۳، ضمانت کار.",
     "source_section": "۵-۵- مدارک مورد نیاز شرکت"},
    {"doc_id": "termination", "topic": "anchor_resignation_notice",
     "title": "مدت اعلام استعفا چقدر است؟",
     "text": "مدت اعلام استعفا چقدر است؟ چند روز قبل باید استعفا داد؟ "
             "اعلام تصمیم خروج باید به‌صورت مکتوب و **حداقل ۳۰ روز قبل** (مطابق قرارداد) به مدیر مستقیم اعلام شود. استعفای شفاهی یا غیبت غیرموجه به‌منزله استعفا نیست. غیبت بین ترک کار و تاریخ رسمی = غیبت غیرموجه (عدم پرداخت حقوق، عدم صدور گواهی حسن انجام کار).",
     "source_section": "۵-۲- اعلام تصمیم خروج"},
    {"doc_id": "promotion", "topic": "anchor_promotion_phase",
     "title": "دوره جانشینی پیش از ارتقا",
     "text": "دوره جانشینی پیش از حکم اصلی چقدر است؟ مراحل ارتقا چیست؟ "
             "برای مدیران و معاونت‌ها، ابتدا حکم **جانشین** صادر می‌شود. پس از **۳ الی ۶ ماه** در صورت رضایت، حکم اصلی تفویض می‌گردد. احکام سرپرستان توسط معاون سرمایه انسانی، احکام مدیران/معاونت‌ها توسط مدیرعامل امضا می‌شود.",
     "source_section": "۵-۲ انتصاب و صدور حکم"},
    {"doc_id": "attendance", "topic": "anchor_attendance_system",
     "title": "سامانه حضور و غیاب کجا است؟",
     "text": "سامانه حضور و غیاب کجا است؟ کسرا چیست؟ ثبت تردد چگونه انجام می‌شود؟ "
             "نرم‌افزار **کسرا** (kasra.electrokavir.com) سامانه رسمی حضور و غیاب است. ثبت ورود/خروج با اثر انگشت یا چهره. تعداد ورود/خروج باید زوج باشد. حداکثر ۵ تردد دستی در ماه مجاز است.",
     "source_section": "۵-۲- درخواست تردد"},
    {"doc_id": "access-control", "topic": "anchor_off_hours_request",
     "title": "حضور در ساعات غیراداری چگونه است؟",
     "text": "حضور در ساعات غیراداری و تعطیلات چگونه است؟ شرایط اضافه‌کاری برای ورود به شرکت چیست؟ "
             "حضور در ساعات غیراداری تنها برای افرادی مجاز است که نامشان **حداقل یک روز قبل** از طریق ایمیل رسمی توسط معاون/مدیر/سرپرست به واحد حراست اعلام شده و در فهرست مجازین ثبت شده باشد. ایمیل باید شامل نام، واحد، تاریخ و ساعت حضور باشد. در شرایط اضطراری: تماس تلفنی + ایمیل تأییدیه روز بعد.",
     "source_section": "۵-۱ فرآیند ورود و خروج کارکنان"},
    {"doc_id": "strategic-document", "topic": "anchor_vision",
     "title": "چشم انداز شرکت چیست؟",
     "text": "چشم انداز شرکت الکتروکویر چیست؟ vision سازمان چیست؟ "
             "چشم‌انداز شرکت الکتروکویر: **پیشتاز در ارائه راهکارهای جامع نوآورانه با بهره‌مندی از فناوری‌های نوین صنعت برق**. چشم‌انداز ۱۴۰۸: رهبری بازار داخلی تابلو برق، ورود به بازارهای جدید (الکتروموتور، درایو، اینورتر خورشیدی)، ورود به بورس، استقرار ساختار هولدینگ. مرجع: سند استراتژیک EKCO-1-07.",
     "source_section": "فصل چهارم > چشم انداز"},
    {"doc_id": "strategic-document", "topic": "anchor_mission",
     "title": "مأموریت شرکت چیست؟",
     "text": "مأموریت یا رسالت شرکت الکتروکویر چیست؟ mission سازمان چیست؟ "
             "مأموریت شرکت الکتروکویر: **اطمینان و تعالی با ارائه محصولات، خدمات و راهکارهای ارزش‌آفرین در صنعت برق در راستای رضایتمندی ذینفعان و ارتقاء مسئولیت‌های اجتماعی**. مرجع: سند استراتژیک EKCO-1-07 فصل چهارم.",
     "source_section": "فصل چهارم > مأموریت"},
    {"doc_id": "strategic-document", "topic": "anchor_values",
     "title": "ارزش‌های شرکت چیست؟",
     "text": "ارزش‌های بنیادین شرکت الکتروکویر چیست؟ values سازمان چیست؟ "
             "**۵ ارزش بنیادین**: (۱) اخلاق حرفه‌ای، (۲) رضایتمندی شرکای اجتماعی، (۳) تعالی فردی و سازمانی، (۴) مسئولیت اجتماعی، (۵) کار تیمی. مرجع: سند استراتژیک EKCO-1-07 و منشور طرح‌ریزی EKIP-1-04.",
     "source_section": "فصل چهارم > ارزش‌ها"},
    {"doc_id": "strategic-document", "topic": "anchor_strategies",
     "title": "ده استراتژی شرکت",
     "text": "ده استراتژی شرکت الکتروکویر چیست؟ استراتژی‌های سازمان چیست؟ "
             "**۱۰ استراتژی**: (۱) بهبود کیفیت محصول و خدمات، (۲) توسعه منابع انسانی و مدیریت استعدادها، (۳) توسعه زنجیره تأمین، (۴) تحول‌آفرینی و نوآوری، (۵) توسعه برندینگ، (۶) بهبود ساختار هزینه‌ها، (۷) سرمایه‌گذاری و سودآوری، (۸) توسعه زیرساخت، (۹) بهره‌وری در مصرف انرژی، (۱۰) نظام جامع مدیریت ریسک. مرجع: سند استراتژیک EKCO-1-07.",
     "source_section": "فصل چهارم > استراتژی‌های سازمان"},

    # ---- Strategies-programs full summary ----
    {"doc_id": "strategies-programs", "topic": "strategies_all_summary",
     "title": "فهرست ده استراتژی سازمان و اهداف کلیدی",
     "text": "ده استراتژی سازمان — برنامه‌های اجرایی — strategies and programs summary. "
             "شرکت الکتروکویر در سند EKFR-HM-001-05 ده استراتژی کلیدی را با اهداف، سنجه‌ها و برنامه‌های اجرایی تعریف کرده است: "
             "۱) **بهبود کیفیت محصول و خدمات** — کاهش شکایات مشتریان، افزایش رضایتمندی، بهبود فرآیندهای کنترل کیفیت. "
             "۲) **توسعه منابع انسانی و مدیریت استعدادها** — جانشین‌پروری، ارزیابی عملکرد، مصاحبه خروج، افزایش بهره‌وری نیروی انسانی. "
             "۳) **توسعه زنجیره تأمین** — توسعه تأمین‌کنندگان داخلی، بومی‌سازی قطعات وارداتی، بهبود تأمین به‌موقع. "
             "۴) **تحول‌آفرینی و نوآوری** — تحول دیجیتال نسل ۴، توسعه R&D، محصولات جدید (الکتروموتور، درایو، اینورتر خورشیدی، باسداکت، تابلو کوره، تابلو ژنراتور). "
             "۵) **توسعه برندینگ** — جوایز ملی، شهرت در صنعت برق، همکاری با زیمنس. "
             "۶) **بهبود ساختار هزینه‌های سازمان** — کاهش هزینه‌های سربار، نسبت قیمت تمام‌شده به قیمت کل ۷۳٪، بازنگری ساختار پرسنلی و فرآیندهای سازمانی، مدیریت انرژی. "
             "۷) **سرمایه‌گذاری و سودآوری** — رشد سالانه فروش، افزایش حاشیه سود، تمرکز بر مشتریان کلیدی (نفت/گاز/نیرو)، ورود به بورس. "
             "۸) **توسعه زیرساخت** — ماشین‌آلات اروپایی، خطوط تولید زیمنس، توسعه کارخانه یزد. "
             "۹) **بهره‌وری در مصرف انرژی** — VFD، LED صنعتی، سیستم‌های کنترل هوشمند، اتوماسیون و مانیتورینگ انرژی، نگهداری پیشگیرانه. "
             "۱۰) **نظام جامع مدیریت ریسک** — شناسایی، ارزیابی، کنترل ریسک‌های مالی، عملیاتی، استراتژیک. "
             "هر استراتژی دارای هدف، ریسک، فرصت، سنجه، متولی، اهداف کمی، و برنامه‌های اجرایی با مراحل و درصد پیشرفت است. مرجع: سند استراتژیک (EKCO-1-07) فصل چهارم و سند استراتژی‌ها (EKFR-HM-001-05).",
     "source_section": "تمام استراتژی‌ها (۱ تا ۱۰)"},
]


# ---------------------------------------------------------------------------
# 7. Embeddings + Qdrant
# ---------------------------------------------------------------------------
def embed_batch(texts: List[str]) -> List[Optional[List[float]]]:
    if not texts:
        return []
    try:
        r = httpx.post(f"{EMBEDDINGS_URL}/embeddings/batch",
                       json={"texts": texts}, timeout=120.0)
        r.raise_for_status()
        return r.json().get("embeddings", [])
    except Exception as e:
        log.warning("batch embed failed (%s); falling back per-text", e)
    out: List[Optional[List[float]]] = []
    for t in texts:
        try:
            r = httpx.post(f"{EMBEDDINGS_URL}/embeddings",
                           json={"text": t}, timeout=30.0)
            r.raise_for_status()
            out.append(r.json().get("embedding"))
        except Exception:
            out.append(None)
    return out


def ensure_collection(client: QdrantClient, dim: int, rebuild: bool) -> None:
    if rebuild:
        try:
            client.delete_collection(HR_KB_COLLECTION)
            log.info("dropped existing collection %s", HR_KB_COLLECTION)
        except Exception:
            pass
    try:
        existing = client.get_collection(HR_KB_COLLECTION)
        cur = existing.config.params.vectors.size
        if cur != dim:
            log.error("dim mismatch existing=%d new=%d — pass --rebuild to recreate", cur, dim)
            sys.exit(2)
        return
    except Exception:
        pass
    client.create_collection(
        collection_name=HR_KB_COLLECTION,
        vectors_config=qmodels.VectorParams(size=dim, distance=qmodels.Distance.COSINE),
    )
    for field in ("category", "topic", "doc_id", "chunk_type"):
        try:
            client.create_payload_index(
                collection_name=HR_KB_COLLECTION,
                field_name=field,
                field_schema=qmodels.PayloadSchemaType.KEYWORD,
            )
        except Exception as e:
            log.warning("payload index %s failed: %s", field, e)
    log.info("created collection %s dim=%d", HR_KB_COLLECTION, dim)


def chunk_uuid(*parts: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, "::".join(parts)))


# ---------------------------------------------------------------------------
# 8. Pipeline driver
# ---------------------------------------------------------------------------
@dataclass
class IngestStats:
    files: int = 0
    sections: int = 0
    boilerplate_dropped: int = 0
    cards: int = 0
    embedded: int = 0
    upserted: int = 0
    errors: int = 0


def ingest_directory(root: Path, rebuild: bool = False) -> IngestStats:
    stats = IngestStats()
    qdrant = QdrantClient(url=QDRANT_URL, timeout=60.0)

    # Pre-collect ALL chunks first (sections + cards), embed in one
    # batched pass, then a single Qdrant upsert. Cheaper than per-file
    # batching when the total corpus is small.
    pending: List[Dict[str, Any]] = []

    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        suffix = path.suffix.lower()
        if suffix not in (".md", ".markdown", ".docx", ".docm"):
            continue
        if path.name.startswith(".") or path.name.endswith("~"):
            continue
        stats.files += 1
        meta = doc_meta_for(path)
        if not meta:
            stats.errors += 1
            continue
        try:
            if suffix in (".md", ".markdown"):
                raw = extract_md(path)
            else:
                raw = extract_docx(path)
            md = repair_markdown(raw)
            chunks = chunk_sections(md)
        except Exception as e:
            log.warning("extract/chunk failed path=%s err=%s", path.name, e)
            stats.errors += 1
            continue
        # Boilerplate already filtered inside chunk_sections; count
        # what survived for the stats line.
        stats.sections += len(chunks)
        try:
            rel = str(path.relative_to(root))
        except Exception:
            rel = path.name
        for idx, ch in enumerate(chunks):
            section_path = " > ".join(ch["heading_path"]) or "(no heading)"
            pending.append({
                "id": chunk_uuid(meta["doc_id"], "section", str(idx)),
                "text": ch["text"],
                "payload": {
                    **meta,
                    "filename": path.name,
                    "relpath": rel,
                    "chunk_idx": idx,
                    "chunk_type": ch["chunk_type"],
                    "heading_path": ch["heading_path"],
                    "section_path": section_path,
                    "text": ch["text"],
                },
            })

    # Synthetic cards
    for idx, card in enumerate(CANONICAL_CARDS):
        doc_id = card["doc_id"]
        # Look up the host doc's full meta so card payload mirrors
        # section payload shape (filename, category, etc.).
        host = next((m for m in DOC_REGISTRY.values()
                     if m["doc_id"] == doc_id), None)
        if not host:
            continue
        pending.append({
            "id": chunk_uuid(doc_id, "card", str(idx), card["topic"]),
            "text": card["text"],
            "payload": {
                **host,
                "topic": card["topic"],  # override host's default topic
                "filename": next((fn for fn, m in DOC_REGISTRY.items()
                                  if m["doc_id"] == doc_id), ""),
                "chunk_idx": idx,
                "chunk_type": "card",
                "heading_path": [host["doc_title"], card.get("source_section", "")],
                "section_path": card.get("source_section", host["doc_title"]),
                "card_title": card["title"],
                "text": card["text"],
            },
        })
    stats.cards = sum(1 for p in pending if p["payload"]["chunk_type"] == "card")

    if not pending:
        log.warning("no chunks collected; nothing to upsert")
        return stats

    # Batched embed (32 at a time).
    BATCH = 32
    dim: Optional[int] = None
    points: List[qmodels.PointStruct] = []
    for i in range(0, len(pending), BATCH):
        batch = pending[i:i + BATCH]
        vecs = embed_batch([p["text"] for p in batch])
        for p, v in zip(batch, vecs):
            if v is None:
                continue
            stats.embedded += 1
            if dim is None:
                dim = len(v)
                ensure_collection(qdrant, dim, rebuild=rebuild)
            points.append(qmodels.PointStruct(
                id=p["id"], vector=v, payload=p["payload"],
            ))

    if not points:
        log.error("no points embedded; check embeddings-service")
        return stats

    # Single upsert.
    BATCH_UP = 200
    for i in range(0, len(points), BATCH_UP):
        try:
            qdrant.upsert(collection_name=HR_KB_COLLECTION,
                           points=points[i:i + BATCH_UP], wait=True)
            stats.upserted += len(points[i:i + BATCH_UP])
        except Exception as e:
            log.exception("upsert failed at offset=%d: %s", i, e)
            stats.errors += 1

    log.info("ingest done: %s", stats)
    return stats


def main():
    ap = argparse.ArgumentParser(description="Ingest curated HR/Strategy corpus into Qdrant.")
    ap.add_argument("--root", default=os.getenv("HR_DOCS_PATH", "/app/hr_docs"),
                    help="Directory containing 'HR Operations Manual/' and 'Organizational Strategy Values/'")
    ap.add_argument("--rebuild", action="store_true",
                    help="Drop the Qdrant collection first (clean slate).")
    args = ap.parse_args()
    root = Path(args.root)
    if not root.exists():
        log.error("root not found: %s", root)
        sys.exit(1)
    log.info("starting ingest root=%s rebuild=%s collection=%s",
             root, args.rebuild, HR_KB_COLLECTION)
    stats = ingest_directory(root, rebuild=args.rebuild)
    print(
        f"\nFiles processed:      {stats.files}\n"
        f"Section chunks:       {stats.sections}\n"
        f"Canonical cards:      {stats.cards}\n"
        f"Embedded:             {stats.embedded}\n"
        f"Upserted to Qdrant:   {stats.upserted}\n"
        f"Errors:               {stats.errors}\n"
        f"Collection:           {HR_KB_COLLECTION}\n"
    )
    sys.exit(0 if stats.errors == 0 else 1)


if __name__ == "__main__":
    main()
