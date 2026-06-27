"""
soft_source_markup.py — locate an extracted value inside its source PDF and
render the page with the extracted region marked.

The Design Suite proposals UI lets the user click "show source" on any
proposal. The whole-doc extractor bakes a verbatim `evidence_span` into the
proposal's `source_note` ("from spec 'X.pdf' · § Site Conditions ·
\"design ambient: 50 °C\""). We take that quote, find it in the PDF's text
layer with PyMuPDF (`page.search_for`), render the matching page to a PNG,
and return both the image and the bounding rectangles (in image-pixel
coordinates) so the frontend can overlay a rectangle around the exact area
the value came from.

Scope (Phase 1): text-layer PDFs. Scanned / image-only pages (SLD drawings)
have no searchable text — we still render the page so the user sees the
source, just without a box (`matched=False`). Pixel-coordinate boxes for
raster pages would need the vision model and are deferred.
"""
from __future__ import annotations

import base64
import hashlib
import logging
import re
from collections import OrderedDict
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

# Render zoom — 2.0 ≈ 144 DPI, a good balance between crisp text and payload
# size for an in-browser viewer.
_ZOOM = 2.0
# Don't scan a 200-page drawing set end-to-end looking for a phrase.
_MAX_PAGES = 80

# Rendered-page cache. The page IMAGE is identical no matter which value the
# user inspects (only the overlay rectangles differ, and those are cheap), so
# caching the PNG makes the 2nd+ "show source" on the same page instant. Keyed
# by (pdf-hash, page-index, zoom); small LRU so a few open documents stay hot.
_PAGE_CACHE: "OrderedDict[Tuple[str, int, float], Tuple[bytes, int, int]]" = OrderedDict()
_PAGE_CACHE_MAX = 64


# ---------------------------------------------------------------------------
# source_note parsing — mirror of the frontend parseSourceNote() so the
# backend can resolve the document + evidence without the UI passing them.
# ---------------------------------------------------------------------------
def parse_source_note(note: Optional[str]) -> Dict[str, Optional[str]]:
    raw = (note or "").strip()
    out: Dict[str, Optional[str]] = {"filename": None, "section": None,
                                     "evidence": None, "page": None, "raw": raw}
    if not raw:
        return out
    m = re.search(r"from\s+\w+\s+['\"]([^'\"]+)['\"]", raw, re.IGNORECASE)
    if m:
        out["filename"] = m.group(1)
    m = re.search(r"§\s*([^·\n]+?)(?:\s*·|$)", raw)
    if m:
        out["section"] = m.group(1).strip()
    # Page hint — the extractor stamps "· p.17" / "page 17" on the note. This
    # is what lets the viewer jump to the right page even when the scrambled
    # (RTL/LTR-mixed) text layer defeats a verbatim search.
    m = re.search(r"(?:·\s*)?p(?:age|\.|\b)\s*([0-9]{1,4})", raw, re.IGNORECASE)
    if m:
        out["page"] = m.group(1)
    # Evidence — last quoted run (the extractor appends it at the end).
    quotes = re.findall(r"[“\"](.+?)[”\"]", raw)
    if quotes:
        out["evidence"] = quotes[-1].strip()
    return out


# ---------------------------------------------------------------------------
# Search-string candidates — search_for needs a contiguous, single-line-ish
# string. A long multi-line evidence span rarely matches verbatim, so we try
# the value, then progressively shorter prefixes of the evidence, then a few
# distinctive tokens. First hit wins.
# ---------------------------------------------------------------------------
def _candidates(evidence: Optional[str], value: Any) -> List[str]:
    cands: List[str] = []

    # Never search the PDF for an abstention/null-like — that's what made the
    # viewer highlight the word "specified" all over the page.
    try:
        from services.soft_value_filter import is_meaningful_value
    except Exception:  # pragma: no cover
        def is_meaningful_value(_v):  # type: ignore
            return True

    def add(s: Optional[str]) -> None:
        if not s:
            return
        s = re.sub(r"\s+", " ", str(s)).strip()
        if not is_meaningful_value(s):
            return
        if 2 <= len(s) <= 90 and s not in cands:
            cands.append(s)

    val = "" if value is None else str(value)
    add(val)

    ev = re.sub(r"\s+", " ", (evidence or "")).strip()
    if ev:
        add(ev)
        # Progressive prefixes, trimmed to a word boundary.
        for n in (70, 50, 35, 24):
            if len(ev) > n:
                cut = ev[:n].rsplit(" ", 1)[0]
                add(cut)

    # Distinctive tokens from the value: doc-codes, numbers-with-units.
    for tok in re.findall(r"[A-Za-z0-9][A-Za-z0-9.\-/]{3,}", val):
        add(tok)

    return cands


def _render_page(doc, pno: int, rects, zoom: float, matched: bool,
                 evidence: Optional[str],
                 doc_hash: Optional[str] = None) -> Dict[str, Any]:
    import fitz  # PyMuPDF — available (also used by services/sld_processor)
    png: Optional[bytes] = None
    w = h = 0
    ck = (doc_hash, pno, zoom) if doc_hash else None
    if ck is not None and ck in _PAGE_CACHE:
        png, w, h = _PAGE_CACHE[ck]
        _PAGE_CACHE.move_to_end(ck)          # LRU touch
    if png is None:
        page = doc[pno]
        mat = fitz.Matrix(zoom, zoom)
        pix = page.get_pixmap(matrix=mat, alpha=False)
        png, w, h = pix.tobytes("png"), pix.width, pix.height
        if ck is not None:
            _PAGE_CACHE[ck] = (png, w, h)
            while len(_PAGE_CACHE) > _PAGE_CACHE_MAX:
                _PAGE_CACHE.popitem(last=False)
    # search_for returns Rects in PDF points; the pixmap is zoomed, so pixel
    # coordinates are the point coordinates times the zoom factor.
    out_rects: List[List[float]] = []
    for r in (rects or []):
        out_rects.append([round(r.x0 * zoom, 1), round(r.y0 * zoom, 1),
                          round(r.x1 * zoom, 1), round(r.y1 * zoom, 1)])
    return {
        "ok": True,
        "matched": matched,
        "page": pno + 1,                 # 1-based for display
        "page_count": doc.page_count,
        "image_b64": base64.b64encode(png).decode("ascii"),
        "image_w": w,
        "image_h": h,
        "rects": out_rects,
        "evidence": evidence,
    }


def _search_page(page, cands: List[str]):
    """First candidate that hits on this page → its rects (capped)."""
    for cand in cands:
        try:
            hits = page.search_for(cand)
        except Exception:
            hits = []
        if hits:
            return hits[:8]
    return []


def locate_in_pdf(pdf_bytes: bytes, *, evidence: Optional[str],
                  value: Any, page_hint: Any = None,
                  zoom: float = _ZOOM) -> Dict[str, Any]:
    """Open the PDF, find the evidence/value text, and return the rendered
    page + rectangles.

    When `page_hint` (1-based) is given — the extractor stamps the source
    page on every proposal — we jump straight to that page: search ONLY it
    for a box, and render it regardless. This both fixes the "shows the
    cover page" bug and removes the 80-page scan that made the viewer lag.
    Falls back to a whole-document scan only when there is no page hint."""
    try:
        import fitz  # noqa: F401
    except Exception as e:  # noqa: BLE001
        logger.warning("soft_source_markup: PyMuPDF unavailable: %s", e)
        return {"ok": False, "reason": "pdf rendering unavailable"}

    import fitz
    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    except Exception as e:  # noqa: BLE001
        logger.warning("soft_source_markup: open failed: %s", e)
        return {"ok": False, "reason": "could not open source document"}

    if doc.page_count == 0:
        return {"ok": False, "reason": "empty document"}

    doc_hash = hashlib.sha1(pdf_bytes).hexdigest()[:16]
    cands = _candidates(evidence, value)

    # Normalise the page hint to a 0-based index inside the doc.
    hint_idx: Optional[int] = None
    try:
        if page_hint not in (None, ""):
            n = int(str(page_hint).strip())
            if 1 <= n <= doc.page_count:
                hint_idx = n - 1
    except (TypeError, ValueError):
        hint_idx = None

    try:
        # FAST PATH: we know the page. Search just it; render it either way.
        if hint_idx is not None:
            hits = _search_page(doc[hint_idx], cands)
            return _render_page(doc, hint_idx, hits, zoom,
                                matched=bool(hits), evidence=evidence,
                                doc_hash=doc_hash)

        # No hint — scan, but bounded. First page with a textual hit wins.
        pages = min(doc.page_count, _MAX_PAGES)
        for pno in range(pages):
            hits = _search_page(doc[pno], cands)
            if hits:
                return _render_page(doc, pno, hits, zoom,
                                    matched=True, evidence=evidence,
                                    doc_hash=doc_hash)
        # Nothing matched — render the first page so the user still sees the
        # source document (image-only page, or a paraphrased span).
        return _render_page(doc, 0, [], zoom, matched=False, evidence=evidence,
                            doc_hash=doc_hash)
    finally:
        try:
            doc.close()
        except Exception:
            pass
