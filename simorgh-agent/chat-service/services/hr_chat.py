"""
HR / Strategy general-chat — fast direct-RAG path
=================================================

Bypasses the chatbot_core planner and MCP tools entirely. The user
asks an HR or organization-strategy question, this service:

  1. Embeds the query via embeddings-service.
  2. Retrieves top-K passages from Qdrant collection HR_KB_COLLECTION
     (populated by hr-kb-service/ingest_local.py). Soft category
     biasing — hr_manner topics get a small boost on HR-flavoured
     queries, org_strategy on strategy queries — so the right corpus
     wins ties.
  3. If the best score is below RELEVANCE_THRESHOLD, hard-refuses
     with a topic-suggestion message. No hallucination via fallback
     to general world knowledge.
  4. Builds a tight grounding prompt: system message that constrains
     the model to ONLY the provided passages, followed by numbered
     passage blocks the model can cite.
  5. Streams the answer from gpt-oss-20b on 192.168.1.61 via
     llm-gateway's /generate/stream (force_backend="offline_text").

Public surface — one function, async generator yielding (event, data)
tuples that the route layer wraps in SSE frames:
  * ("meta",     {"hits": [...]})   — emitted first; the UI uses
                                       this to render "From: <file>"
                                       citation badges immediately.
  * ("chunk",    "<text>")          — model output deltas.
  * ("refusal",  "<text>")          — emitted instead of chunks when
                                       retrieval was below threshold.
  * ("done",     {"reason": "..."}) — final frame.
  * ("error",    "<msg>")           — terminal error.
"""

from __future__ import annotations

import json
import logging
import os
import re
from typing import Any, AsyncIterator, Dict, List, Optional, Tuple

import httpx
from qdrant_client import QdrantClient
from qdrant_client.http import models as qmodels

log = logging.getLogger(__name__)

EMBEDDINGS_URL    = os.getenv("EMBEDDINGS_URL", "http://embeddings-service:8031")
QDRANT_URL        = os.getenv("QDRANT_URL", "http://qdrant:6333")
LLM_GATEWAY_URL   = os.getenv("LLM_GATEWAY_URL", "http://llm-gateway:8030")
HR_KB_COLLECTION  = os.getenv("HR_KB_COLLECTION", "hr_general_kb")
HR_LLM_MODEL      = os.getenv("HR_LLM_MODEL", "gpt-oss-20b")

# Top-K retrieved from Qdrant. A bit high because we re-rank by
# blending score with a category-affinity bias before truncating.
RETRIEVAL_K     = int(os.getenv("HR_RETRIEVAL_K", "8"))
GROUNDING_K     = int(os.getenv("HR_GROUNDING_K", "5"))
# Cosine score below which we treat the query as out-of-corpus.
# Lowered from 0.30 → 0.15 after operator-reported false refusals on
# obvious queries. Multilingual sentence-transformer models tend to
# produce lower absolute scores than English-only ones; 0.15 still
# rejects pure noise but lets in soft matches that gpt-oss can rule
# on. Override via HR_RELEVANCE_THRESHOLD if you need it stricter.
RELEVANCE_THRESHOLD = float(os.getenv("HR_RELEVANCE_THRESHOLD", "0.15"))
# Per-chunk character cap injected into the prompt (so a single 1800-
# char window section doesn't blow the context window).
PROMPT_CHUNK_CHAR_CAP = int(os.getenv("HR_PROMPT_CHUNK_CHARS", "1200"))


_qdrant: Optional[QdrantClient] = None


def _qdrant_client() -> QdrantClient:
    global _qdrant
    if _qdrant is None:
        _qdrant = QdrantClient(url=QDRANT_URL, timeout=30.0)
    return _qdrant


# ---------------------------------------------------------------------------
# Step 1: embed
# ---------------------------------------------------------------------------
async def _embed(text: str) -> Optional[List[float]]:
    async with httpx.AsyncClient(timeout=15.0) as c:
        try:
            r = await c.post(f"{EMBEDDINGS_URL}/embeddings", json={"text": text})
            r.raise_for_status()
            return r.json().get("embedding")
        except Exception as e:
            log.warning("hr_chat embed failed: %s", e)
            return None


# ---------------------------------------------------------------------------
# Step 2: retrieve + soft category bias
# ---------------------------------------------------------------------------
# Light heuristic — when the query mentions strategy/vision/values
# words, nudge org_strategy hits up; for HR-domain words, nudge
# hr_manner. The bias is small (0.04) so a clearly-on-topic hit from
# the "wrong" category still wins. Both English and Persian markers.
_STRATEGY_MARKERS = re.compile(
    r"چشم\s*انداز|چشم‌انداز|ماموریت|مأموریت|رسالت|ارزش‌?ها|استراتژی|"
    r"خط\s*مشی|سند\s*استراتژیک|swot|ife|efe|"
    r"vision|mission|values|strategy|strategies|policy",
    re.IGNORECASE,
)
_HR_MARKERS = re.compile(
    r"مرخصی|اضافه\s*کاری|اضافه‌کاری|حضور|غیاب|تردد|استخدام|جذب|انتصاب|ارتقا|"
    r"وام|تسهیلات|قرارداد|استعفا|خروج|تسویه|حقوق|دستمزد|پرسنل|"
    r"leave|attendance|overtime|hiring|salary|loan|resignation|contract",
    re.IGNORECASE,
)


def _category_bias(query: str) -> Dict[str, float]:
    bias = {"hr_manner": 0.0, "org_strategy": 0.0, "fs_drop": 0.0}
    if _STRATEGY_MARKERS.search(query):
        bias["org_strategy"] += 0.04
    if _HR_MARKERS.search(query):
        bias["hr_manner"] += 0.04
    return bias


async def retrieve(query: str, top_k: int = RETRIEVAL_K,
                    category: Optional[str] = None) -> List[Dict[str, Any]]:
    vec = await _embed(query)
    if vec is None:
        log.error("hr_chat retrieve: EMBED RETURNED NONE for q=%r url=%s "
                  "→ refusal path will fire. Check embeddings-service "
                  "reachability and EMBEDDINGS_URL env.",
                  query[:80], EMBEDDINGS_URL)
        return []
    qfilter = None
    if category:
        qfilter = qmodels.Filter(must=[qmodels.FieldCondition(
            key="category", match=qmodels.MatchValue(value=category),
        )])
    try:
        hits = _qdrant_client().search(
            collection_name=HR_KB_COLLECTION,
            query_vector=vec, limit=top_k,
            query_filter=qfilter, with_payload=True,
        )
    except Exception as e:
        log.error("hr_chat retrieve: QDRANT SEARCH FAILED collection=%s "
                  "url=%s err=%s → refusal path will fire.",
                  HR_KB_COLLECTION, QDRANT_URL, e)
        return []
    log.info("hr_chat retrieve: q=%r hits=%d top_score=%.4f category=%s "
             "embed_dim=%d collection=%s",
             query[:80], len(hits),
             float(hits[0].score) if hits else 0.0,
             category or "(any)", len(vec), HR_KB_COLLECTION)
    bias = _category_bias(query)
    out: List[Dict[str, Any]] = []
    for h in hits:
        payload = h.payload or {}
        cat = payload.get("category", "")
        raw = float(h.score)
        out.append({
            "score": raw + bias.get(cat, 0.0),
            "raw_score": raw,
            "text": payload.get("text", ""),
            "doc_id": payload.get("doc_id"),
            "doc_title": payload.get("doc_title"),
            "doc_code": payload.get("doc_code"),
            "filename": payload.get("filename"),
            "category": cat,
            "topic": payload.get("topic"),
            "section_path": payload.get("section_path"),
            "chunk_type": payload.get("chunk_type"),
            "card_title": payload.get("card_title"),
        })
    # Re-sort by biased score and stable on raw as tiebreaker.
    out.sort(key=lambda x: (x["score"], x["raw_score"]), reverse=True)
    return out


# ---------------------------------------------------------------------------
# Step 3: grounding prompt
# ---------------------------------------------------------------------------
SYSTEM_PROMPT = (
    "شما دستیار سازمانی شرکت الکتروکویر هستید. "
    "وظیفه شما پاسخ به سوالات کارکنان درباره منابع انسانی (HR) و "
    "استراتژی سازمان است.\n\n"
    "قوانین حیاتی:\n"
    "1. پاسخ شما باید **فقط** از روی متن منابع ارائه شده باشد. "
    "از دانش عمومی یا خلاقیت پرهیز کنید.\n"
    "2. اگر پاسخ سوال در منابع نیست، صادقانه بگویید "
    "«این موضوع در منابع موجود ذکر نشده است» و توقف کنید.\n"
    "3. در پایان هر ادعا، شماره منبع را در کروشه ذکر کنید، مثلاً [1] یا [2].\n"
    "4. پاسخ کوتاه، دقیق و به زبان سوال کاربر (فارسی یا انگلیسی) باشد.\n"
    "5. از حدس زدن اعداد، تاریخ‌ها یا نام‌ها خودداری کنید — فقط آنچه در منابع است.\n"
    "6. اگر سوال خارج از حوزه HR یا استراتژی سازمان است "
    "(مثلاً درباره پروژه‌ها، مشخصات فنی، یا سوال شخصی)، "
    "بگویید «این سامانه فقط برای سوالات منابع انسانی و استراتژی سازمان است»."
)


REFUSAL_PERSIAN = (
    "متاسفم، پاسخ این سوال در منابع HR و استراتژی سازمان موجود نیست. "
    "این سامانه برای پاسخ به سوالات زیر طراحی شده است:\n\n"
    "📋 **منابع انسانی:** مرخصی، اضافه کاری، حضور و غیاب، استخدام و جذب، "
    "ارتقا و انتصاب، وام و تسهیلات، قطع همکاری\n\n"
    "🎯 **استراتژی سازمان:** چشم‌انداز، مأموریت، ارزش‌ها، خط‌مشی، "
    "استراتژی‌های ده‌گانه، اهداف و برنامه‌ها\n\n"
    "لطفاً سوال خود را در این حوزه‌ها مطرح کنید."
)


def build_grounding_prompt(query: str, hits: List[Dict[str, Any]]) -> List[Dict[str, str]]:
    """Build the messages list for the LLM. Sources are numbered so
    the model can cite them; each passage is trimmed to PROMPT_CHUNK_CHAR_CAP
    so the prompt fits comfortably in gpt-oss-20b's context."""
    passages: List[str] = []
    for i, h in enumerate(hits[:GROUNDING_K], start=1):
        text = h["text"] or ""
        if len(text) > PROMPT_CHUNK_CHAR_CAP:
            text = text[:PROMPT_CHUNK_CHAR_CAP].rstrip() + " …"
        title = h.get("doc_title") or h.get("filename") or "?"
        section = h.get("section_path") or ""
        header = f"[{i}] {title}"
        if section and section != title:
            header += f" — {section}"
        passages.append(f"{header}\n{text}")
    sources_block = "\n\n".join(passages) if passages else "(منبعی یافت نشد)"
    user_msg = (
        f"سوال کاربر:\n{query}\n\n"
        f"منابع (فقط با تکیه بر این متون پاسخ بده، در هر ادعا با [n] ارجاع بده):\n\n"
        f"{sources_block}"
    )
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": user_msg},
    ]


def _format_citations(hits: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Compact citation list for the UI ("From: <file> > <heading>")."""
    out: List[Dict[str, Any]] = []
    for i, h in enumerate(hits[:GROUNDING_K], start=1):
        out.append({
            "n": i,
            "doc_id": h.get("doc_id"),
            "doc_title": h.get("doc_title"),
            "doc_code": h.get("doc_code"),
            "filename": h.get("filename"),
            "section_path": h.get("section_path"),
            "category": h.get("category"),
            "topic": h.get("topic"),
            "chunk_type": h.get("chunk_type"),
            "score": round(float(h.get("raw_score", 0)), 4),
        })
    return out


# ---------------------------------------------------------------------------
# Step 4: stream from gpt-oss on .61 via llm-gateway
# ---------------------------------------------------------------------------
async def _stream_llm(messages: List[Dict[str, str]]) -> AsyncIterator[str]:
    """Open a single SSE connection to llm-gateway's /generate/stream
    forcing the offline_text backend (gpt-oss-20b on 192.168.1.61).
    Yields content delta strings."""
    payload = {
        "messages": messages,
        "mode": "offline",          # bypass online routing
        "force_backend": "offline_text",
        "model": HR_LLM_MODEL,
        "temperature": 0.2,         # grounded answers, low creativity
        "max_tokens": 800,
    }
    async with httpx.AsyncClient(timeout=120.0) as c:
        async with c.stream("POST", f"{LLM_GATEWAY_URL}/generate/stream",
                             json=payload) as r:
            if r.status_code != 200:
                body = (await r.aread()).decode("utf-8", errors="replace")[:300]
                raise RuntimeError(f"llm-gateway {r.status_code}: {body}")
            async for line in r.aiter_lines():
                if not line or not line.startswith("data: "):
                    continue
                data = line[6:].strip()
                if data in ("[DONE]", ""):
                    continue
                try:
                    obj = json.loads(data)
                except Exception:
                    continue
                if "chunk" in obj:
                    yield obj["chunk"]
                elif obj.get("done"):
                    return
                elif "error" in obj:
                    raise RuntimeError(obj["error"])


# ---------------------------------------------------------------------------
# Public entrypoint — one async generator the route wraps in SSE
# ---------------------------------------------------------------------------
async def stream_hr_answer(
    query: str,
    category: Optional[str] = None,
) -> AsyncIterator[Tuple[str, Any]]:
    """Drive the full pipeline. Yields (event_kind, payload) tuples
    so the route can render SSE frames in whatever format the UI wants."""
    query = (query or "").strip()
    if not query:
        yield ("error", "empty query")
        return

    try:
        hits = await retrieve(query, top_k=RETRIEVAL_K, category=category)
    except Exception as e:
        log.exception("hr_chat retrieve failed")
        yield ("error", f"retrieval failed: {e}")
        return

    citations = _format_citations(hits)
    top_score = max((h["raw_score"] for h in hits), default=0.0)

    # Surface the citation list immediately so the UI can render
    # "From: <file>" badges while the answer is still being typed.
    yield ("meta", {
        "hits": citations,
        "top_score": round(top_score, 4),
        "threshold": RELEVANCE_THRESHOLD,
    })

    if not hits or top_score < RELEVANCE_THRESHOLD:
        log.info("hr_chat refusal: top_score=%.3f threshold=%.3f q=%r",
                 top_score, RELEVANCE_THRESHOLD, query[:80])
        yield ("refusal", REFUSAL_PERSIAN)
        yield ("done", {"reason": "below_threshold", "top_score": top_score})
        return

    messages = build_grounding_prompt(query, hits)
    try:
        async for delta in _stream_llm(messages):
            yield ("chunk", delta)
        yield ("done", {"reason": "ok"})
    except Exception as e:
        log.exception("hr_chat llm stream failed")
        yield ("error", f"llm failed: {e}")
