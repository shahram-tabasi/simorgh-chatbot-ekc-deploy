"""
vlm_verifier.py — Qwen 2.5-VL-powered page-image verification.

What this is for
================
Docling delivers byte-exact text + Markdown tables from PDFs with a
clean text layer. But some content can only be read off the page raster:
single-line diagrams, P&IDs, charts, photographs of equipment, and
heavily-merged cells where layout-aware OCR still mangles row/column
assignment. The VLM-as-verifier pattern (best practice per the 2026
Qwen-VL writeups) is:

  1. Docling produces the primary extraction.
  2. For high-stakes fields (e.g. fault current rating, IP class, rated
     voltage), the ReAct agent calls `verify_value(document_id, page,
     field, value)` which routes the rendered page image + a structured
     ask to Qwen 2.5-VL on 192.168.1.62 via llm-gateway.
  3. The VLM returns {confirmed, evidence_text, confidence, note}. The
     agent records that as additional provenance on the proposal so the
     human reviewer sees "TPMS says 2500 A, Docling found 2500 A, VLM
     confirmed at p. 4 → high-confidence approve" or "TPMS says 1600 A,
     spec PDF says 2500 A → conflict, flag for review".

Functions
---------
* render_pdf_page(document_id, page, dpi)  → PNG bytes (cached in Redis)
* verify_value(document_id, page, field, value, language=None)
    → {confirmed, evidence_text, confidence, note}
* describe_page(document_id, page, language=None)
    → markdown description of the page (for "explain this drawing"
      flows; cheaper than verify when the agent just needs context).

All entry points are best-effort: any failure (PDF not stashed, render
exception, VLM gateway down) returns a structured error dict, never
raises. The agent loop continues with the legacy extraction.

Caveats
-------
* Persian numerals (۰-۹) and bidi reordering: Qwen 2.5-VL handles them
  unevenly. The verifier normalises Persian digits in evidence_text
  before returning. If you see consistent VLM failures on Persian-only
  documents, surface that as a `note` and fall back to text-only
  verification.
* The page raster is held in Redis for 1 hour after first render. PDFs
  themselves remain stashed for 24 h per redis_service.set_uploaded_pdf.
"""
from __future__ import annotations

import base64
import json
import logging
import os
import re
from io import BytesIO
from typing import Any, Dict, Optional

import httpx

logger = logging.getLogger(__name__)

LLM_GATEWAY_URL = os.getenv("LLM_GATEWAY_URL", "http://llm-gateway:8030").rstrip("/")
VLM_TIMEOUT_SEC = float(os.getenv("VLM_VERIFIER_TIMEOUT_SEC", "120"))
VLM_MAX_TOKENS = int(os.getenv("VLM_VERIFIER_MAX_TOKENS", "1200"))
PAGE_RENDER_DPI = int(os.getenv("VLM_VERIFIER_DPI", "180"))
PAGE_RENDER_TTL_SEC = int(os.getenv("VLM_VERIFIER_PAGE_TTL_SEC", "3600"))

# Persian → Latin digit translation. Qwen2.5-VL community reports
# inconsistent handling of `۰۱۲۳۴۵۶۷۸۹`; normalise before returning so
# downstream comparison logic doesn't see two encodings of "1234".
_PERSIAN_DIGITS = str.maketrans("۰۱۲۳۴۵۶۷۸۹", "0123456789")


def _redis():
    """Late binding so this module can be imported before main.py
    bootstraps the redis service."""
    from services.redis_service import get_redis_service
    return get_redis_service()


# ---------------------------------------------------------------------------
# Page rendering
# ---------------------------------------------------------------------------
def render_pdf_page(document_id: str, page: int,
                    dpi: int = PAGE_RENDER_DPI) -> Optional[bytes]:
    """Return PNG bytes for the requested page (1-based) of the stashed
    PDF. Caches rendered pages in Redis for 1 h to avoid re-running
    pdf2image on every verify call."""
    if page < 1:
        return None
    r = _redis()
    cache_key = f"vlm_page:{document_id}:{page}:{dpi}"
    try:
        cached = r.cache_client.get(cache_key)
        if cached:
            return base64.b64decode(cached)
    except Exception:  # noqa: BLE001
        pass

    pdf_record = r.get_uploaded_pdf(document_id)
    if not pdf_record or not pdf_record.get("b64"):
        logger.warning("vlm_verifier: no stashed PDF for document_id=%s",
                       document_id)
        return None
    try:
        pdf_bytes = base64.b64decode(pdf_record["b64"])
    except Exception as e:  # noqa: BLE001
        logger.warning("vlm_verifier: b64 decode failed for %s: %s",
                       document_id, e)
        return None

    try:
        from pdf2image import convert_from_bytes
    except Exception as e:  # noqa: BLE001
        logger.warning("vlm_verifier: pdf2image missing: %s", e)
        return None

    try:
        # first_page/last_page are both inclusive and 1-based.
        images = convert_from_bytes(
            pdf_bytes, dpi=dpi, first_page=page, last_page=page,
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("vlm_verifier: render failed for %s p%d: %s",
                       document_id, page, e)
        return None
    if not images:
        return None

    buf = BytesIO()
    images[0].save(buf, format="PNG", optimize=True)
    png_bytes = buf.getvalue()

    try:
        r.cache_client.setex(
            cache_key, PAGE_RENDER_TTL_SEC,
            base64.b64encode(png_bytes).decode("ascii"),
        )
    except Exception:  # noqa: BLE001
        pass
    return png_bytes


# ---------------------------------------------------------------------------
# VLM call
# ---------------------------------------------------------------------------
async def _call_vlm(prompt: str, image_bytes: bytes,
                    timeout: float = VLM_TIMEOUT_SEC) -> Optional[str]:
    """One round-trip to Qwen-VL via llm-gateway. force_backend=vlm
    pins routing to 192.168.1.62 regardless of vision sniffing."""
    img_b64 = base64.b64encode(image_bytes).decode("ascii")
    payload = {
        "messages": [
            {"role": "user", "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url",
                 "image_url": {"url": f"data:image/png;base64,{img_b64}"}},
            ]},
        ],
        "mode": "offline",
        "force_backend": "vlm",
        "temperature": 0.0,
        "max_tokens": VLM_MAX_TOKENS,
        # Qwen-VL handles response_format=json_object in instruct mode.
        # vLLM guided_json is preferred when the schema is known.
        "extra": {"response_format": {"type": "json_object"}},
    }
    try:
        async with httpx.AsyncClient(timeout=timeout) as c:
            r = await c.post(f"{LLM_GATEWAY_URL}/generate", json=payload)
            r.raise_for_status()
            body = r.json()
    except Exception as e:  # noqa: BLE001
        logger.warning("vlm_verifier: gateway error: %s", e)
        return None
    return (body.get("response") or body.get("text") or "").strip()


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------
async def verify_value(*, document_id: str, page: int,
                       field: str, value: str,
                       language: Optional[str] = None,
                       timeout: float = VLM_TIMEOUT_SEC,
                       ) -> Dict[str, Any]:
    """Cross-check that `value` for `field` is actually visible on the
    requested page. Returns a structured dict; never raises.

    Output shape:
        {
          "ok": bool,                # whether the VLM call succeeded
          "confirmed": bool|null,    # whether value matches the page
          "evidence_text": str,      # verbatim text the VLM read
          "confidence": float,       # 0-1
          "note": str,               # rationale / explanation
          "error": str|None,         # transport error if ok=false
        }
    """
    img = render_pdf_page(document_id, page)
    if img is None:
        return {
            "ok": False, "confirmed": None,
            "evidence_text": "", "confidence": 0.0,
            "note": "page image unavailable",
            "error": "no stashed PDF / render failed",
        }

    lang_hint = ""
    if language:
        lang_hint = f"\nDocument language hint: {language}."

    prompt = (
        f"You are a precise visual verifier for engineering "
        f"specifications.{lang_hint}\n\n"
        f"# TASK\n"
        f"Look at the attached page image and tell me whether the value "
        f"`{value}` is genuinely present for the field `{field}`.\n\n"
        f"# RULES\n"
        f"- Set `confirmed=true` ONLY if you can SEE the value on this "
        f"page as a stated value for that field.\n"
        f"- Set `confirmed=false` if the page either contradicts the "
        f"value or does not mention the field at all.\n"
        f"- `evidence_text` MUST be a literal quote from the page (or "
        f"your best transcription of a value in a table). Do not "
        f"paraphrase.\n"
        f"- `note` is a one-sentence rationale.\n"
        f"- `confidence` is your honest 0-1 calibration on the "
        f"confirmation, not on your OCR accuracy.\n\n"
        f"# OUTPUT\n"
        f'Return a single JSON object: {{"confirmed": bool, '
        f'"evidence_text": str, "confidence": number, "note": str}}.'
    )

    raw = await _call_vlm(prompt, img, timeout=timeout)
    if not raw:
        return {
            "ok": False, "confirmed": None,
            "evidence_text": "", "confidence": 0.0,
            "note": "vlm call failed",
            "error": "gateway returned no response",
        }

    parsed = _parse_vlm_json(raw)
    if parsed is None:
        # The VLM gave prose; capture it as a low-confidence answer.
        return {
            "ok": True, "confirmed": None,
            "evidence_text": raw[:240], "confidence": 0.0,
            "note": "vlm did not return JSON",
            "error": None,
        }
    ev = (parsed.get("evidence_text") or "").translate(_PERSIAN_DIGITS)
    try:
        conf = float(parsed.get("confidence") or 0.0)
    except (TypeError, ValueError):
        conf = 0.0
    return {
        "ok": True,
        "confirmed": bool(parsed.get("confirmed")),
        "evidence_text": ev[:480],
        "confidence": max(0.0, min(1.0, conf)),
        "note": (parsed.get("note") or "")[:240],
        "error": None,
    }


async def locate_value_box(pdf_bytes: bytes, page_1based: int,
                           field: str, value: Any,
                           *, zoom: float = 2.0,
                           timeout: float = 60.0) -> Optional[list]:
    """Ask Qwen-VL to LOCATE where `value` for `field` sits on the page and
    return its bounding box as fractions of the page image, [x0,y0,x1,y1] in
    0..1 (top-left → bottom-right). None when not found / on any failure.

    This is the reliable locator for this corpus: the PDF text layer is
    RTL/LTR-scrambled and table-heavy, so token/word matching mis-fires on
    stray numbers (e.g. a table row label "40"). The VLM reads the page
    visually and points at the actual region, which is what the user asked
    for. Renders the page itself (fitz) so it needs no Redis stash; normalized
    coords are renderer-independent and map onto whatever image the viewer
    shows."""
    try:
        import fitz  # PyMuPDF
    except Exception as e:  # noqa: BLE001
        logger.debug("locate_value_box: fitz unavailable: %s", e)
        return None
    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    except Exception as e:  # noqa: BLE001
        logger.debug("locate_value_box: open failed: %s", e)
        return None
    try:
        pno = max(0, min(doc.page_count - 1, int(page_1based) - 1))
        pix = doc[pno].get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
        png = pix.tobytes("png")
        iw, ih = pix.width, pix.height
    except Exception as e:  # noqa: BLE001
        logger.debug("locate_value_box: render failed: %s", e)
        return None
    finally:
        try:
            doc.close()
        except Exception:
            pass

    prompt = (
        "You are a precise visual locator for engineering specification "
        "pages (the text may be garbled or in a table).\n\n"
        f"Find on this page the region that states the value `{value}` for "
        f"the parameter `{field}`. Look for the value, its number, or the "
        "row/cell/sentence that contains it.\n\n"
        "Return ONLY a JSON object with the bounding box of that region as "
        "FRACTIONS of the image size, each between 0 and 1:\n"
        '{"found": true, "box": [x0, y0, x1, y1]}\n'
        "where x0,y0 is the TOP-LEFT and x1,y1 the BOTTOM-RIGHT corner "
        "(x = left→right, y = top→bottom). If the value is not on this page, "
        'return {"found": false}. No other text.'
    )
    raw = await _call_vlm(prompt, png, timeout=timeout)
    if not raw:
        return None
    parsed = _parse_vlm_json(raw)
    if not parsed or not parsed.get("found"):
        return None
    box = parsed.get("box") or parsed.get("bbox") or parsed.get("bbox_2d")
    if not isinstance(box, (list, tuple)) or len(box) != 4:
        return None
    try:
        x0, y0, x1, y1 = (float(v) for v in box)
    except (TypeError, ValueError):
        return None
    # Normalise to fractions. Qwen-VL may answer in fractions (0..1),
    # 0..1000 grid units, or absolute pixels of the sent image — detect by
    # magnitude and divide accordingly.
    mx = max(abs(x0), abs(y0), abs(x1), abs(y1))
    if mx <= 1.5:
        sx = sy = 1.0
    elif mx <= 1000.0:
        sx = sy = 1000.0
    else:
        sx, sy = float(iw), float(ih)
    x0, x1 = x0 / sx, x1 / sx
    y0, y1 = y0 / sy, y1 / sy
    # Order + clamp; reject degenerate boxes.
    x0, x1 = sorted((max(0.0, min(1.0, x0)), max(0.0, min(1.0, x1))))
    y0, y1 = sorted((max(0.0, min(1.0, y0)), max(0.0, min(1.0, y1))))
    if (x1 - x0) < 0.005 or (y1 - y0) < 0.005:
        return None
    logger.info("locate_value_box: VLM located %r on page %d box=%s",
                field, page_1based, [round(v, 3) for v in (x0, y0, x1, y1)])
    return [x0, y0, x1, y1]


async def describe_page(*, document_id: str, page: int,
                        language: Optional[str] = None,
                        timeout: float = VLM_TIMEOUT_SEC,
                        ) -> Dict[str, Any]:
    """Return a markdown description of the page (best for diagrams,
    SLDs, charts). The agent uses this when the user asks "what does
    page N show?" — the verifier path is for confirmation of a value,
    this path is for explanation."""
    img = render_pdf_page(document_id, page)
    if img is None:
        return {"ok": False, "markdown": "",
                "error": "no stashed PDF / render failed"}

    lang_hint = ""
    if language:
        lang_hint = f"\nDocument language hint: {language}."

    prompt = (
        f"You are reading a page from an engineering specification.{lang_hint}\n\n"
        f"# TASK\n"
        f"Produce a markdown summary of what is on this page: section "
        f"headings, key technical values (with units), any tables "
        f"rendered as markdown tables (preserve row/column structure), "
        f"any drawings or diagrams briefly described in text. "
        f"Persian text: transcribe verbatim, do not translate.\n\n"
        f"# OUTPUT\n"
        f"Plain markdown. No code fences."
    )
    raw = await _call_vlm(prompt, img, timeout=timeout)
    if not raw:
        return {"ok": False, "markdown": "",
                "error": "gateway returned no response"}
    return {"ok": True,
            "markdown": raw.translate(_PERSIAN_DIGITS),
            "error": None}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
_JSON_FENCED_RE = re.compile(r"```(?:json)?\s*(\{.*?\})\s*```", re.DOTALL)


def _parse_vlm_json(text: str) -> Optional[Dict[str, Any]]:
    """Lenient JSON extractor: tries plain parse first, then code fences,
    then the outermost {...} substring."""
    s = text.strip()
    if not s:
        return None
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        pass
    m = _JSON_FENCED_RE.search(s)
    if m:
        try:
            return json.loads(m.group(1))
        except json.JSONDecodeError:
            pass
    a, b = s.find("{"), s.rfind("}")
    if a != -1 and b != -1 and b > a:
        try:
            return json.loads(s[a:b + 1])
        except json.JSONDecodeError:
            pass
    return None
