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
import logging
import re
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

# Render zoom — 2.0 ≈ 144 DPI, a good balance between crisp text and payload
# size for an in-browser viewer.
_ZOOM = 2.0
# Don't scan a 200-page drawing set end-to-end looking for a phrase.
_MAX_PAGES = 80


# ---------------------------------------------------------------------------
# source_note parsing — mirror of the frontend parseSourceNote() so the
# backend can resolve the document + evidence without the UI passing them.
# ---------------------------------------------------------------------------
def parse_source_note(note: Optional[str]) -> Dict[str, Optional[str]]:
    raw = (note or "").strip()
    out: Dict[str, Optional[str]] = {"filename": None, "section": None,
                                     "evidence": None, "raw": raw}
    if not raw:
        return out
    m = re.search(r"from\s+\w+\s+['\"]([^'\"]+)['\"]", raw, re.IGNORECASE)
    if m:
        out["filename"] = m.group(1)
    m = re.search(r"§\s*([^·\n]+?)(?:\s*·|$)", raw)
    if m:
        out["section"] = m.group(1).strip()
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

    def add(s: Optional[str]) -> None:
        if not s:
            return
        s = re.sub(r"\s+", " ", str(s)).strip()
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
                 evidence: Optional[str]) -> Dict[str, Any]:
    import fitz  # PyMuPDF — available (also used by services/sld_processor)
    page = doc[pno]
    mat = fitz.Matrix(zoom, zoom)
    pix = page.get_pixmap(matrix=mat, alpha=False)
    png = pix.tobytes("png")
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
        "image_w": pix.width,
        "image_h": pix.height,
        "rects": out_rects,
        "evidence": evidence,
    }


def locate_in_pdf(pdf_bytes: bytes, *, evidence: Optional[str],
                  value: Any, zoom: float = _ZOOM) -> Dict[str, Any]:
    """Open the PDF, find the evidence/value text, and return the rendered
    page + rectangles. Falls back to rendering page 1 (matched=False) when
    nothing matches (image-only page, or the LLM paraphrased the span)."""
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

    cands = _candidates(evidence, value)
    pages = min(doc.page_count, _MAX_PAGES)
    try:
        for pno in range(pages):
            page = doc[pno]
            for cand in cands:
                try:
                    hits = page.search_for(cand)
                except Exception:
                    hits = []
                if hits:
                    # Cap the number of boxes so a value that appears many
                    # times (e.g. "IEC") doesn't paint the whole page.
                    return _render_page(doc, pno, hits[:8], zoom,
                                        matched=True, evidence=evidence)
        # No textual match — render the first page so the user still sees
        # the source document (Phase 1: no box for image-only pages).
        return _render_page(doc, 0, [], zoom, matched=False, evidence=evidence)
    finally:
        try:
            doc.close()
        except Exception:
            pass
