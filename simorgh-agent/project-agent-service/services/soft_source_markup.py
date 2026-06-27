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
import os
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
# Token-level localisation. `search_for` needs the value as ONE contiguous
# string, which fails on this corpus because the PDF text layer is RTL/LTR
# reading-order-scrambled ("6.6 kV" extracts as "6.kV 6"). But PyMuPDF still
# reports the CORRECT bounding box for every individual word. So instead of
# searching for a phrase we match the value's distinctive tokens (whole
# numbers + non-unit words) to the page's words and highlight the LINES those
# tokens sit on. This is the PAWLS / token-bbox grounding approach and is
# robust to scramble. (See services/soft_grounding for the token logic.)
# ---------------------------------------------------------------------------
_PG_NUM_RE = re.compile(r"[0-9]+(?:\.[0-9]+)?")
_PG_WORD_RE = re.compile(r"[a-z؀-ۿ]{2,}")


def _value_targets(value: Any, evidence: Optional[str]):
    """Distinctive (numbers, words) the value is made of — units/filler
    excluded — used to find the value's words on a page."""
    from services.soft_grounding import _significant_tokens
    t = _significant_tokens(value)
    nums, words = set(t["nums"]), set(t["words"])
    if evidence:
        te = _significant_tokens(evidence)
        nums |= set(te["nums"])
        words |= set(te["words"])
    return nums, words


def _locate_on_page(page, nums: set, words: set, *, max_lines: int = 6):
    """Return highlight Rects (whole-line boxes) for the lines that carry the
    value's tokens. A line holding one of the value's NUMBERS is a strong
    anchor; lines with ≥2 distinctive word matches also qualify. Empty when
    the value's tokens aren't on this page (image-only page / wrong page)."""
    import fitz
    from services.soft_grounding import _fold
    if not nums and not words:
        return []
    try:
        page_words = page.get_text("words")  # (x0,y0,x1,y1,word,block,line,n)
    except Exception:
        return []
    line_box: Dict[Any, Any] = {}
    line_hits: Dict[Any, Dict[str, int]] = {}
    line_nums: Dict[Any, set] = {}
    for w in page_words:
        try:
            x0, y0, x1, y1, txt, bno, lno = w[0], w[1], w[2], w[3], w[4], w[5], w[6]
        except Exception:
            continue
        key = (bno, lno)
        r = fitz.Rect(x0, y0, x1, y1)
        line_box[key] = (line_box[key] | r) if key in line_box else r
        wn = _fold(txt)
        wnums = set(_PG_NUM_RE.findall(wn))
        line_nums.setdefault(key, set()).update(wnums)
        nm = bool(nums & wnums)
        wm = bool(words & set(_PG_WORD_RE.findall(wn)))
        if nm or wm:
            d = line_hits.setdefault(key, {"num": 0, "word": 0})
            d["num"] += int(nm)
            d["word"] += int(wm)
    # Decimal rescue: the scrambled text layer splits "7.2" into "7.kV 2", so
    # the whole number never appears — but BOTH its parts land on the same
    # line. Treat a line carrying all parts of a decimal target as a strong
    # number anchor.
    decimals = [n for n in nums if "." in n]
    if decimals:
        for key, lnums in line_nums.items():
            for dec in decimals:
                parts = [p for p in dec.split(".") if p]
                if len(parts) >= 2 and all(p in lnums for p in parts):
                    d = line_hits.setdefault(key, {"num": 0, "word": 0})
                    d["num"] += 2
    if not line_hits:
        return []

    def score(k):
        d = line_hits[k]
        return d["num"] * 3 + d["word"]

    anchors = [k for k, d in line_hits.items() if d["num"] > 0]
    if not anchors:
        anchors = [k for k, d in line_hits.items() if d["word"] >= 2]
    if not anchors:
        anchors = sorted(line_hits, key=score, reverse=True)[:1]
    anchors = sorted(anchors, key=score, reverse=True)[:max_lines]
    return [line_box[k] for k in anchors if k in line_box]


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


def _search_page(page, nums: set, words: set):
    """Token-level locate on a page → whole-line Rects (or verbatim hits as a
    bonus). Empty when none of the value's tokens are on the page."""
    rects = _locate_on_page(page, nums, words)
    return rects


def rects_for_text_on_page(pdf_bytes: bytes, page_1based: int, text: str,
                           *, zoom: float = _ZOOM,
                           max_lines: int = 2) -> List[List[float]]:
    """STAGE 2 of the two-stage locator. Given the line text the VLM read at
    the value's location, find that exact text's bounding box on the page via
    PyMuPDF word matching and return PIXEL rects (scaled by `zoom`).

    The VLM supplies WHICH line (reliable visually); PyMuPDF supplies the
    EXACT box (word bboxes are correct even on this RTL/LTR-scrambled text
    layer). Returns [] when the text can't be located (caller falls back)."""
    if not text or not str(text).strip():
        return []
    try:
        import fitz
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    except Exception:
        return []
    try:
        pno = max(0, min(doc.page_count - 1, int(page_1based) - 1))
        nums, words = _value_targets(text, None)
        rects = _locate_on_page(doc[pno], nums, words, max_lines=max_lines)
        out: List[List[float]] = []
        for r in rects:
            out.append([round(r.x0 * zoom, 1), round(r.y0 * zoom, 1),
                        round(r.x1 * zoom, 1), round(r.y1 * zoom, 1)])
        return out
    except Exception as e:  # noqa: BLE001
        logger.debug("rects_for_text_on_page failed: %s", e)
        return []
    finally:
        try:
            doc.close()
        except Exception:
            pass


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
    nums, words = _value_targets(value, evidence)

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
        # FAST PATH: we know the page. Locate on just it; render it either way.
        if hint_idx is not None:
            hits = _search_page(doc[hint_idx], nums, words)
            return _render_page(doc, hint_idx, hits, zoom,
                                matched=bool(hits), evidence=evidence,
                                doc_hash=doc_hash)

        # No hint — scan, but bounded. First page with a token hit wins.
        pages = min(doc.page_count, _MAX_PAGES)
        for pno in range(pages):
            hits = _search_page(doc[pno], nums, words)
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


# ---------------------------------------------------------------------------
# LLM fallback — for DESCRIPTIVE parameters (interlocks, materials, control
# features) that carry no distinctive number/code, token matching finds
# nothing. Here we ask the offline model which LINE on the cited page best
# states the parameter, and box that line. Best-effort + tightly timed so the
# viewer never hangs; gated by SOFT_SOURCE_LLM_FALLBACK (default on).
# ---------------------------------------------------------------------------
_LLM_GATEWAY_URL = os.getenv("LLM_GATEWAY_URL", "http://llm-gateway:8030")


async def llm_locate_rects(pdf_bytes: bytes, page_1based: int, field: str,
                           value: Any, *, zoom: float = _ZOOM,
                           timeout: float = 12.0) -> List[List[float]]:
    """Return pixel rects for the single page line the LLM judges to best
    state (field=value). [] on any failure or when disabled."""
    if os.getenv("SOFT_SOURCE_LLM_FALLBACK", "1").lower() not in (
            "1", "true", "yes", "on"):
        return []
    try:
        import fitz
        import httpx
    except Exception:
        return []
    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    except Exception:
        return []
    try:
        pno = max(0, min(doc.page_count - 1, int(page_1based) - 1))
        page = doc[pno]
        d = page.get_text("dict")
        lines: List[Any] = []           # (rect, text)
        for b in d.get("blocks", []):
            for ln in b.get("lines", []):
                txt = "".join(s.get("text", "") for s in ln.get("spans", []))
                if txt.strip():
                    lines.append((ln["bbox"], txt.strip()))
        if not lines:
            return []
        numbered = "\n".join(f"{i}: {t[:140]}" for i, (_b, t) in enumerate(lines))
        system = (
            "You locate where a parameter is stated on one page of an "
            "engineering document whose text may be slightly garbled. Reply "
            "with ONLY the integer index of the single line that best states "
            "the parameter, or -1 if no line does. No words, only the number."
        )
        user = (
            f"PARAMETER: {field}\nVALUE: {value}\n\nLINES:\n{numbered}\n\n"
            "Return ONLY the best line index.\n/no_think"
        )
        payload = {
            "messages": [{"role": "system", "content": system},
                         {"role": "user", "content": user}],
            "mode": "offline", "temperature": 0.0, "max_tokens": 16,
            "force_backend": "text", "extra": {"reasoning_effort": "low"},
        }
        async with httpx.AsyncClient(timeout=timeout) as c:
            r = await c.post(f"{_LLM_GATEWAY_URL}/generate", json=payload)
            if r.status_code >= 400:
                return []
            body = r.json()
        text = (body.get("response") or body.get("text") or "")
        text = re.sub(r"<think>.*?</think>", "", text,
                      flags=re.DOTALL | re.IGNORECASE)
        m = re.search(r"-?\d+", text)
        if not m:
            return []
        idx = int(m.group(0))
        if idx < 0 or idx >= len(lines):
            return []
        x0, y0, x1, y1 = lines[idx][0]
        logger.info("soft_source_markup: LLM located %r on page %d line %d",
                    field, page_1based, idx)
        return [[round(x0 * zoom, 1), round(y0 * zoom, 1),
                 round(x1 * zoom, 1), round(y1 * zoom, 1)]]
    except Exception as e:  # noqa: BLE001
        logger.debug("soft_source_markup: LLM locate failed: %s", e)
        return []
    finally:
        try:
            doc.close()
        except Exception:
            pass
