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
RETRIEVAL_K     = int(os.getenv("HR_RETRIEVAL_K", "12"))
GROUNDING_K     = int(os.getenv("HR_GROUNDING_K", "8"))
# Cosine score below which we treat the query as out-of-corpus.
# Lowered from 0.30 → 0.15 after operator-reported false refusals on
# obvious queries. Multilingual sentence-transformer models tend to
# produce lower absolute scores than English-only ones; 0.15 still
# rejects pure noise but lets in soft matches that gpt-oss can rule
# on. Override via HR_RELEVANCE_THRESHOLD if you need it stricter.
RELEVANCE_THRESHOLD = float(os.getenv("HR_RELEVANCE_THRESHOLD", "0.15"))
# Per-chunk character cap injected into the prompt. Bumped from 1200
# to 2400 so the new comprehensive summary cards (e.g. leave_all_types
# at ~1500 chars, recruitment_summary at ~1800, access_summary at
# ~2100) reach the LLM intact. Previously the cap was silently
# truncating the most authoritative cards mid-list, which was the
# direct cause of "the bot only listed 2 out of 12 leave types"
# bug reports.
PROMPT_CHUNK_CHAR_CAP = int(os.getenv("HR_PROMPT_CHUNK_CHARS", "2400"))


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
    "شما دستیار سرمایه انسانی و استراتژی شرکت الکتروکویر هستید. "
    "وظیفه شما توضیح کامل، مستند، و قابل فهم مقررات و سیاست‌های "
    "سازمان به همکاران است. مانند یک کارشناس باتجربه پاسخ دهید — "
    "نه پاسخ خلاصه و خشک، بلکه توضیحی که هم پاسخ مستقیم سوال را "
    "بدهد و هم زمینه، شرایط، استثناها، و روش عملی را روشن کند.\n\n"
    "ساختار پاسخ‌های مفصل (برای سوالات اطلاعاتی واقعی):\n"
    "  ۱) **پاسخ مستقیم** — یک یا دو جمله که جان سوال را پاسخ می‌دهد، "
    "با اعداد و تاریخ‌های دقیق از منابع.\n"
    "  ۲) **مبنای قانونی یا سند مرجع** — اگر در منبع به ماده‌ای از "
    "قانون کار، استاندارد ISO، یا کد سند داخلی (مثل EKWI-AD-006-01) "
    "اشاره شده، آن را بیاورید تا کاربر بداند پاسخ از کجا آمده.\n"
    "  ۳) **اعداد، فرمول‌ها، سقف‌ها** — هر مقدار عددی را با واحد و "
    "بازه‌اش نقل کنید. اگر فرمول محاسبه‌ای در منبع آمده (مثل فوق‌العاده "
    "اضافه کاری = ۱.۴ × مزد ساعت عادی)، آن را به‌روشنی توضیح دهید.\n"
    "  ۴) **شرایط، تبصره‌ها، استثناها** — همه تبصره‌ها و شرایط جانبی "
    "که در منابع آمده را ذکر کنید. کاربر اغلب همین جزئیات را نیاز دارد.\n"
    "  ۵) **روند عملی** — اگر منبع روش ثبت، تأیید، یا پیگیری را "
    "توضیح می‌دهد (مثلاً ثبت در سامانه کسرا، فرم BPMS، تأیید مدیر)، "
    "این مراحل را به ترتیب ذکر کنید.\n"
    "  ۶) **نکات مرتبط** — اگر منابع به موضوعات مرتبط اشاره می‌کنند "
    "(مثلاً مرخصی استعلاجی → ماده ۵۹ تأمین اجتماعی)، آنها را هم "
    "بگنجانید.\n\n"
    "اصول رفتاری:\n"
    "• اگر کاربر سلام یا احوال‌پرسی کرد، با لحن گرم و کوتاه پاسخ "
    "بدهید و موضوعاتی که می‌توانید کمک کنید را معرفی کنید — هرگز "
    "احوال‌پرسی را با جمله‌ی محدودیت رد نکنید.\n"
    "• از ساختار خوانا استفاده کنید: لیست‌های شماره‌دار یا گلوله‌ای "
    "برای اقلام جدا، **bold** برای اعداد و اصطلاحات کلیدی، "
    "پاراگراف‌بندی منطقی، و سرتیتر در پاسخ‌های طولانی.\n"
    "• هر ادعای کلیدی را با شماره منبع در کروشه دنبال کنید "
    "(مثلاً [1]، [2]). لازم نیست در پایان هر جمله بیاید — کافی است "
    "ادعاهای اصلی و عددی منبع داشته باشند. اگر چند منبع یک نکته را "
    "تأیید می‌کنند، همه را ذکر کنید: [1][3].\n"
    "• اگر منابع فقط بخشی از سوال را پوشش می‌دهند، آن بخش را "
    "**کامل و مفصل** توضیح دهید (با همه شرایط و استثناها)، سپس "
    "صریحاً بگویید چه جنبه‌هایی در منابع موجود نیست، و کاربر را به "
    "سوال دقیق‌تر یا تماس با واحد سرمایه انسانی راهنمایی کنید.\n"
    "• اگر سوال کاملاً خارج از حوزه HR، آیین‌نامه‌ها، تسهیلات، و "
    "استراتژی سازمان است، با لحن دوستانه بگویید این موضوع خارج "
    "از تخصص شما است و سه چهار مثال از موضوعاتی که می‌توانید کمک "
    "کنید بیاورید (مرخصی، اضافه کاری، وام، استخدام، چشم‌انداز، "
    "استراتژی، مقاصد آرمانی).\n"
    "• اعداد، تاریخ‌ها، فرمول‌ها، و نام‌ها را **فقط** از منابع نقل کنید. "
    "اگر یک جزئیات خاص در منابع موجود نیست، حدس نزنید — صریحاً "
    "بگویید «این جزئیات در منابع موجود ذکر نشده است» و فقط همان "
    "بخش را خالی بگذارید، نه کل پاسخ.\n"
    "• پاسخ به همان زبان سوال کاربر باشد (فارسی به فارسی، انگلیسی "
    "به انگلیسی)."
)


REFUSAL_PERSIAN = (
    "در حال حاضر اطلاعات مرتبط با این سوال در منابع HR و استراتژی "
    "سازمان پیدا نکردم. می‌توانم در این موضوعات کمک کنم:\n\n"
    "📋 منابع انسانی — مرخصی، اضافه کاری، حضور و غیاب، استخدام، "
    "انتصاب و ارتقا، وام و تسهیلات، قطع همکاری\n"
    "🎯 استراتژی سازمان — چشم‌انداز، مأموریت، ارزش‌ها، خط‌مشی، "
    "استراتژی‌ها، اهداف و برنامه‌ها، مقاصد آرمانی\n\n"
    "لطفاً سوال خود را در این حوزه‌ها مطرح کنید یا با کلمات دقیق‌تر "
    "بپرسید تا بتوانم پاسخ بهتری بدهم."
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
        f"منابع موجود (با تکیه بر این متون، پاسخ کامل و توضیحی بده — "
        f"شامل پاسخ مستقیم، مبنای قانونی یا کد سند، اعداد و فرمول‌ها، "
        f"شرایط و تبصره‌ها، روند عملی، و نکات مرتبط که در منابع آمده. "
        f"در ادعاهای کلیدی با شماره منبع در کروشه ارجاع بده، مثلاً [1] یا [2][4]):\n\n"
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
        # llm-gateway accepts force_backend in {"text", "vlm"}. "text"
        # resolves to LOCAL_LLM_URL_TEXT (gpt-oss-20b on 192.168.1.61
        # by default). Earlier draft used "offline_text" — that's the
        # gateway's INTERNAL backend_kind name, not the public input.
        "force_backend": "text",
        "model": HR_LLM_MODEL,
        # 0.1 — deterministic answers. Operators reported "different
        # answer each time per user/turn" on identical questions,
        # which was confusing employees. At 0.1 the model picks the
        # most-likely token at each step; combined with the strict
        # system prompt and the comprehensive summary cards, this
        # gives the same canonical answer every run. Persian prose
        # still flows naturally because the grounding passages are
        # already well-formed Persian (we're paraphrasing, not
        # composing).
        "temperature": float(os.getenv("HR_LLM_TEMPERATURE", "0.1")),
        # 2500 — bumped from 800. The new prompt asks for a multi-
        # section explanation (direct answer + legal basis + numbers
        # + conditions + procedure + related notes); 800 was getting
        # cut off mid-list. 2500 is well under gpt-oss-20b's ~8k
        # context with our 7-passage grounding block.
        "max_tokens": int(os.getenv("HR_LLM_MAX_TOKENS", "2500")),
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
