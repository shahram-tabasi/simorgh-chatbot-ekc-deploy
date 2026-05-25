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

# Top-K retrieved from Qdrant. Wide net (15) so the re-ranker has
# room to surface a high-value card that lost the raw-cosine race
# to a short shallow heading. We then trim to GROUNDING_K=10 for the
# actual prompt — enough room for a summary card + the 2-3 leaf
# sections it cites + a few neighbour topics, without blowing the
# context.
RETRIEVAL_K     = int(os.getenv("HR_RETRIEVAL_K", "15"))
GROUNDING_K     = int(os.getenv("HR_GROUNDING_K", "10"))
# Cosine score below which we treat the query as out-of-corpus.
# 0.20 — slightly stricter than the previous 0.15. Combined with the
# intent router (which injects a priority card at score=0.99 when
# the query matches a known canonical pattern), this means:
#   • Intent-routed queries never refuse (priority card is 0.99).
#   • Cosine-only queries need a real semantic match at ≥0.20 raw,
#     otherwise refuse instead of letting the LLM hallucinate.
# Override via HR_RELEVANCE_THRESHOLD.
RELEVANCE_THRESHOLD = float(os.getenv("HR_RELEVANCE_THRESHOLD", "0.20"))
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


# Chunk-type re-ranking bias. Hand-curated "card" chunks always beat
# shallow section intros on enumeration questions: a 200-char
# "5. انواع مرخصی در قانون کار" intro that names 3 categories used to
# outrank the 2 KB `leave_all_types` card that lists all 12, because
# the heading contained the literal query phrase. +0.10 for cards is
# enough to flip that order without overriding genuinely strong leaf
# matches (a top section often scores 0.55-0.65, a top card 0.50-0.60
# pre-bias). +0.05 for explicit "summary" / "all_types" topics gives
# the magnet cards one extra nudge on list-everything queries.
_CHUNK_TYPE_BOOST = {"card": 0.10, "section": 0.0, "window": 0.0}
_SUMMARY_TOPIC_RE = re.compile(r"summary|all_types|all_summary", re.IGNORECASE)


def _chunk_bias(payload: Dict[str, Any]) -> float:
    boost = _CHUNK_TYPE_BOOST.get(payload.get("chunk_type") or "", 0.0)
    topic = payload.get("topic") or ""
    if _SUMMARY_TOPIC_RE.search(topic):
        boost += 0.05
    return boost


# ---------------------------------------------------------------------------
# Intent router — deterministic top-1 for well-known enumeration queries
# ---------------------------------------------------------------------------
# Even with a +0.10 chunk_type boost and +0.05 summary-topic boost,
# multilingual sentence transformers sometimes still rank a short
# section heading above a 2 KB summary card if the heading contains
# the exact query phrase verbatim. For high-frequency canonical
# queries this is unacceptable — operators report the same wrong
# answer ("only 2 of 12 leave types") on every retry.
#
# Each route fires when the query matches its regex; the named topics
# are then fetched DIRECTLY from Qdrant via topic-filter and inserted
# at the top of the results with score=0.99. Embedding-driven hits
# fill the remaining slots, so leaf-section evidence still reaches
# the LLM.
#
# Order matters within a single route — first topic listed becomes
# the top-1 citation in the prompt.
# Regex helpers — Persian writers freely mix half-spaces, ZWNJ, full
# spaces, and Arabic/Persian "y" (ی / ي). `_S` matches any of them
# zero-or-more times so a single pattern catches every variant.
_S = r"[\s‌‏ ]*"   # whitespace + ZWNJ + RTL + nbsp
_Y = r"[يی]"                       # Arabic ya & Persian ya
_A = r"[آا]"                       # alef variants


def _p(s: str) -> str:
    """Compact-pattern helper: writes a regex with __ standing in for
    flexible whitespace so the patterns below stay readable."""
    return s.replace(" ", _S).replace("ی", _Y).replace("ا", _A)


_INTENT_ROUTES: List[Tuple[re.Pattern, List[str]]] = [
    # ────────────────────────────────────────────────────────────
    # LEAVE — 4-tier hierarchical structure per EKWI-AD-006-01:
    #   1. مرخصی استحقاقی (with sub-types: روزانه، ساعتی، مجوز خروج،
    #      شیردهی، زایمان، ازدواج و فوت، تشویقی)
    #   2. مرخصی استعلاجی
    #   3. مرخصی بدون حقوق (with sub-type: تحصیلی)
    #   4. مرخصی حج
    # ────────────────────────────────────────────────────────────
    # Enumeration "what leave types exist?" — broadest match first.
    # Persian: انواع / لیست / فهرست / تمام / همه / کلیه + plural/ZWNJ
    # variants of "نوع". English: kinds of leave, leave types,
    # what leaves are available, list all leaves.
    (re.compile(_p(r"(انواع|لیست|فهرست|تمام|همه|کلیه)"
                   r"[\s‌]*مرخصی"
                   r"|(چه|چی|کدام)"
                   r"[\s‌]*(نوع|نوعی|نوع‌ها|نوع ها|نوع‌های|نوع های)?"
                   r"[\s‌]*مرخصی"
                   r"|مرخصی"
                   r"[\s‌]*(چه|چی|انواعش|چه نوع|چه چیز|چی هست)"
                   r"|ساختار[\s‌]*مرخصی"
                   r"|(kinds?|types?|all kinds?|list|what)"
                   r"[\s‌]*(of[\s‌]*)?leaves?"
                   r"|leaves?[\s‌]*(types?|available|allowed)"),
                re.IGNORECASE),
     ["leave_all_types", "anchor_leave_types"]),

    # Annual / استحقاقی durations
    (re.compile(_p(r"(چند روز|سقف|مدت|میزان|چقدر|چه قدر|تعداد روز)"
                   r"[\s‌]*مرخصی[\s‌]*(استحقاقی|سالانه|سالیانه)"
                   r"|مرخصی[\s‌]*(استحقاقی|سالانه|سالیانه)"
                   r"[\s‌]*(چقدر|چه قدر|چند|چه میزان|سقف|مدت|"
                   r"چند روز|تعداد)"
                   r"|annual[\s‌]*leave"), re.IGNORECASE),
     ["anchor_leave_days", "leave_annual", "leave_all_types"]),

    # Storage / ذخیره / buyback
    (re.compile(_p(r"(ذخیره|انباشت|انباشته|ذخیره‌سازی)"
                   r"[\s‌]*مرخصی"
                   r"|بازخرید[\s‌]*مرخصی"
                   r"|مرخصی[\s‌]*(منفی|انباشته|ذخیره)"
                   r"|leave[\s‌]*(banking|carry|buyback)"), re.IGNORECASE),
     ["leave_buyback", "leave_banking", "leave_all_types"]),

    # Maternity / زایمان
    (re.compile(_p(r"(مرخصی[\s‌]*)?زایمان"
                   r"|maternity[\s‌]*leave?"
                   r"|بعد از زایمان|قبل از زایمان"), re.IGNORECASE),
     ["anchor_maternity_days", "leave_maternity", "leave_all_types"]),

    # Lactation / شیردهی
    (re.compile(_p(r"(مرخصی[\s‌]*)?(شیردهی|شیر ده|شیر دادن|حق شیر)"
                   r"|lactation|breast[\s‌]*feed"), re.IGNORECASE),
     ["leave_lactation", "leave_all_types"]),

    # Hourly / ساعتی — sub-type of استحقاقی
    (re.compile(_p(r"مرخصی[\s‌]*ساعتی"
                   r"|ساعتی[\s‌]*مرخصی"
                   r"|hourly[\s‌]*leave?"), re.IGNORECASE),
     ["leave_hourly", "leave_all_types"]),

    # Daily / روزانه — sub-type of استحقاقی
    (re.compile(_p(r"مرخصی[\s‌]*روزانه"
                   r"|daily[\s‌]*leave?"), re.IGNORECASE),
     ["leave_daily_calculation", "leave_all_types"]),

    # Exit permit / مجوز خروج — sub-type of استحقاقی
    (re.compile(_p(r"مجوز[\s‌]*خروج"
                   r"|exit[\s‌]*permit"), re.IGNORECASE),
     ["leave_exit_permit", "leave_all_types"]),

    # Marriage / ازدواج
    (re.compile(_p(r"مرخصی[\s‌]*(ازدواج|عروسی|نکاح)"
                   r"|ازدواج[\s‌]*(و فوت|دائم)"
                   r"|marriage[\s‌]*leave?"), re.IGNORECASE),
     ["leave_marriage_bereavement", "leave_all_types"]),

    # Bereavement / فوت
    (re.compile(_p(r"مرخصی[\s‌]*(فوت|عزا|تدفین)"
                   r"|فوت[\s‌]*(پدر|مادر|همسر|فرزند)"
                   r"|bereavement|funeral"), re.IGNORECASE),
     ["leave_marriage_bereavement", "leave_all_types"]),

    # Incentive / تشویقی — sub-type of استحقاقی
    (re.compile(_p(r"مرخصی[\s‌]*(تشویقی|آموزشی|ترغیبی)"
                   r"|incentive[\s‌]*leave?"), re.IGNORECASE),
     ["leave_incentive", "leave_all_types"]),

    # Sick / استعلاجی
    (re.compile(_p(r"مرخصی[\s‌]*(استعلاجی|پزشکی|بیماری)"
                   r"|بیماری[\s‌]*و[\s‌]*مرخصی"
                   r"|sick[\s‌]*leave?"), re.IGNORECASE),
     ["leave_sick", "leave_sick_to_annual_conversion", "leave_all_types"]),

    # Unpaid / بدون حقوق
    (re.compile(_p(r"مرخصی[\s‌]*بدون[\s‌]*حقوق"
                   r"|بدون[\s‌]*حقوق[\s‌]*مرخصی"
                   r"|unpaid[\s‌]*leave?"), re.IGNORECASE),
     ["leave_unpaid", "leave_all_types"]),

    # Study / تحصیلی — sub-type of بدون حقوق
    (re.compile(_p(r"مرخصی[\s‌]*تحصیلی"
                   r"|تحصیلی[\s‌]*مرخصی"
                   r"|study[\s‌]*leave?"), re.IGNORECASE),
     ["leave_study", "leave_all_types"]),

    # Hajj / حج
    (re.compile(_p(r"مرخصی[\s‌]*(حج|عمره)"
                   r"|حج[\s‌]*(تمتع|واجب)"
                   r"|hajj[\s‌]*leave?|umrah"), re.IGNORECASE),
     ["leave_hajj", "leave_all_types"]),

    # Registration / how to register a leave
    (re.compile(_p(r"(ثبت|درخواست|گرفتن|چگونه|چطور|روش)"
                   r"[\s‌]*مرخصی"
                   r"|کسرا[\s‌]*مرخصی"
                   r"|سامانه[\s‌]*مرخصی"), re.IGNORECASE),
     ["leave_registration", "leave_all_types"]),

    # ────────────────────────────────────────────────────────────
    # OVERTIME
    # ────────────────────────────────────────────────────────────
    (re.compile(_p(r"(انواع|قواعد|سقف|حداکثر|نرخ|مقررات|قوانین|"
                   r"شرایط|چقدر|چه قدر|چگونه|چطور)"
                   r"[\s‌]*(اضافه[\s‌]*کاری|اضافه‌کاری)"
                   r"|(اضافه[\s‌]*کاری|اضافه‌کاری)"
                   r"[\s‌]*(چقدر|چند|چگونه|چیست|چی هست|سقف|نرخ)"
                   r"|overtime|extra[\s‌]*hours?"), re.IGNORECASE),
     ["overtime_summary", "anchor_overtime_cap", "overtime"]),
    (re.compile(_p(r"(شب[\s‌]*کاری|نوبت[\s‌]*کاری|"
                   r"شیفت|night[\s‌]*shift)"), re.IGNORECASE),
     ["night_shift", "overtime_summary"]),

    # ────────────────────────────────────────────────────────────
    # ATTENDANCE
    # ────────────────────────────────────────────────────────────
    (re.compile(_p(r"(کسرا|kasra|electrokavir\.com"
                   r"|سامانه[\s‌]*حضور"
                   r"|حضور[\s‌]*و[\s‌]*غیاب"
                   r"|نرم[\s‌]*افزار[\s‌]*حضور"
                   r"|نرم‌افزار[\s‌]*حضور"
                   r"|attendance[\s‌]*system)"), re.IGNORECASE),
     ["attendance_summary", "anchor_attendance_system", "attendance"]),
    (re.compile(_p(r"(تأخیر|تاخیر|دیر[\s‌]*آمدن|دیر[\s‌]*رسیدن"
                   r"|late[\s‌]*arrival)"), re.IGNORECASE),
     ["late_arrival", "attendance_summary"]),
    (re.compile(_p(r"(تردد[\s‌]*گذشته|بازه[\s‌]*ثبت"
                   r"|retroactive)"), re.IGNORECASE),
     ["retroactive_window", "attendance_summary"]),

    # ────────────────────────────────────────────────────────────
    # RECRUITMENT / HIRING
    # ────────────────────────────────────────────────────────────
    (re.compile(_p(r"(فرآیند|روند|مراحل|نحوه|چگونگی|چگونه|چطور)"
                   r"[\s‌]*(جذب|استخدام)"
                   r"|استخدام[\s‌]*(چگونه|چطور|چیست|چی هست)"
                   r"|recruitment|hiring[\s‌]*process"), re.IGNORECASE),
     ["recruitment_summary"]),
    (re.compile(_p(r"(شرایط[\s‌]*سنی|محدودیت[\s‌]*سن"
                   r"|سن[\s‌]*استخدام"
                   r"|age[\s‌]*limit)"), re.IGNORECASE),
     ["anchor_age_limit", "age_limit", "recruitment_summary"]),
    (re.compile(_p(r"مدارک[\s‌]*(استخدام|مورد[\s‌]*نیاز)"
                   r"|چه[\s‌]*مدارک"
                   r"|required[\s‌]*documents?"), re.IGNORECASE),
     ["anchor_recruitment_docs", "required_documents", "recruitment_summary"]),
    (re.compile(_p(r"(انواع|نوع|اقسام)[\s‌]*قرارداد"
                   r"|قرارداد[\s‌]*(کار|های[\s‌]*کار)"
                   r"|contract[\s‌]*types?"), re.IGNORECASE),
     ["contract_types", "recruitment_summary"]),
    (re.compile(_p(r"(شرایط[\s‌]*عمومی|عمومی[\s‌]*استخدام"
                   r"|general[\s‌]*requirements?)"), re.IGNORECASE),
     ["general_requirements", "recruitment_summary"]),

    # ────────────────────────────────────────────────────────────
    # TERMINATION / RESIGNATION
    # ────────────────────────────────────────────────────────────
    (re.compile(_p(r"(استعفا|استعفاء|قطع[\s‌]*همکاری"
                   r"|خروج[\s‌]*از[\s‌]*شرکت"
                   r"|ترک[\s‌]*خدمت|ترک[\s‌]*کار"
                   r"|resignation|termination)"
                   r"|(فرآیند|روند|مراحل|نحوه)"
                   r"[\s‌]*خروج"), re.IGNORECASE),
     ["termination_summary", "anchor_resignation_notice", "resignation_notice"]),
    (re.compile(_p(r"(تسویه|تسویه[\s‌]*حساب|settlement"
                   r"|پایان[\s‌]*همکاری[\s‌]*مالی)"), re.IGNORECASE),
     ["settlement", "termination_summary"]),
    (re.compile(_p(r"(مصاحبه[\s‌]*خروج"
                   r"|exit[\s‌]*interview)"), re.IGNORECASE),
     ["exit_interview", "termination_summary"]),

    # ────────────────────────────────────────────────────────────
    # LOAN
    # ────────────────────────────────────────────────────────────
    (re.compile(_p(r"(انواع|لیست|فهرست|چه[\s‌]*نوع|نوع‌های"
                   r"|all[\s‌]*kinds?|types?)"
                   r"[\s‌]*(وام|تسهیلات)"
                   r"|(وام|تسهیلات)[\s‌]*(چه|چی|چه نوع|انواعش)"
                   r"|loan[\s‌]*types?"), re.IGNORECASE),
     ["loan_summary", "anchor_loan_types", "loan_types"]),
    (re.compile(_p(r"(سقف|حداکثر|مبلغ|چقدر)[\s‌]*وام"
                   r"|loan[\s‌]*(amount|tier|cap)"), re.IGNORECASE),
     ["loan_tiers", "loan_summary"]),
    (re.compile(_p(r"وام[\s‌]*(ضروری|اضطراری|بیماری|تصادف)"
                   r"|emergency[\s‌]*loan"), re.IGNORECASE),
     ["loan_emergency_eligibility", "loan_summary"]),
    (re.compile(_p(r"وام[\s‌]*(امتیازی|بانکی)"), re.IGNORECASE),
     ["loan_summary", "loan_tiers"]),

    # ────────────────────────────────────────────────────────────
    # PROMOTION
    # ────────────────────────────────────────────────────────────
    (re.compile(_p(r"(انتصاب|ارتقا|ارتقاء|ارتقای)"
                   r"|(فرآیند|روند|مراحل)[\s‌]*(انتصاب|ارتقا)"
                   r"|promotion|appointment"), re.IGNORECASE),
     ["promotion_summary", "anchor_promotion_phase", "promotion_committee"]),
    (re.compile(_p(r"(کمیته[\s‌]*ارتقا"
                   r"|promotion[\s‌]*committee)"), re.IGNORECASE),
     ["promotion_committee", "promotion_summary"]),
    (re.compile(_p(r"(جانشین[\s‌]*پرور|جانشین"
                   r"|deputy|succession)"), re.IGNORECASE),
     ["deputy_phase", "promotion_summary"]),

    # ────────────────────────────────────────────────────────────
    # ACCESS CONTROL
    # ────────────────────────────────────────────────────────────
    (re.compile(_p(r"(تردد|حراست|نگهبانی|نگهبان"
                   r"|ورود[\s‌]*و[\s‌]*خروج"
                   r"|access[\s‌]*control|security[\s‌]*gate)"),
                re.IGNORECASE),
     ["access_summary"]),
    (re.compile(_p(r"(ساعات?[\s‌]*غیر[\s‌]*اداری"
                   r"|غیراداری|ساعات[\s‌]*غیر[\s‌]*اداری"
                   r"|ساعات[\s‌]*شب|تعطیلات[\s‌]*حضور"
                   r"|off[\s‌]*hours?)"), re.IGNORECASE),
     ["anchor_off_hours_request", "access_off_hours", "access_summary"]),
    (re.compile(_p(r"(انبار|بسته[\s‌]*بندی|بسته‌بندی"
                   r"|برگه[\s‌]*خروج|warehouse)"), re.IGNORECASE),
     ["access_warehouse_timing", "access_summary"]),
    (re.compile(_p(r"(مهمان|بازدید|کارآموز|visitor|guest|intern)"),
                re.IGNORECASE),
     ["access_visitors", "access_summary"]),

    # ────────────────────────────────────────────────────────────
    # STRATEGY / VISION / MISSION / VALUES / POLICY / GOALS
    # ────────────────────────────────────────────────────────────
    (re.compile(_p(r"(چشم[\s‌]*انداز|چشم‌انداز|vision)"), re.IGNORECASE),
     ["vision", "anchor_vision", "vision_1408"]),
    (re.compile(_p(r"(مأموریت|ماموریت|رسالت|mission)"), re.IGNORECASE),
     ["mission", "anchor_mission"]),
    (re.compile(_p(r"(ارزش[\s‌]*های|ارزش‌های|ارزش[\s‌]*ها"
                   r"|values|core[\s‌]*values?)"), re.IGNORECASE),
     ["values", "anchor_values"]),
    (re.compile(_p(r"(استراتژی[\s‌]*ها|استراتژی‌ها"
                   r"|۱۰[\s‌]*استراتژی|10[\s‌]*استراتژی"
                   r"|ده[\s‌]*استراتژی|strategies|strategy)"
                   r"|(فهرست|لیست|انواع)[\s‌]*استراتژی"), re.IGNORECASE),
     ["strategies", "anchor_strategies", "strategies_all_summary"]),
    (re.compile(_p(r"(خط[\s‌]*مشی|policy|خط‌مشی)"), re.IGNORECASE),
     ["policy"]),
    (re.compile(_p(r"(مقاصد[\s‌]*آرمانی|مولفه[\s‌]*های[\s‌]*آرمانی"
                   r"|آرمان[\s‌]*شرکت|aspirational[\s‌]*goals?)"),
                re.IGNORECASE),
     ["aspirational_goals_summary"]),
]


def _route_topics_for(query: str) -> List[str]:
    """Return the ordered list of priority topics for this query, or []
    if no intent route matches. Matches are exclusive — first route
    wins so a query like 'مرخصی زایمان' triggers the maternity route,
    not the generic 'انواع مرخصی' route."""
    for pat, topics in _INTENT_ROUTES:
        if pat.search(query):
            return topics
    return []


def _fetch_topic_card(topic: str) -> Optional[Dict[str, Any]]:
    """Pull the canonical card payload for a topic directly from
    Qdrant, bypassing the cosine-similarity search. Returns the same
    shape as a normal retrieve() row so the rest of the pipeline
    treats it identically."""
    try:
        records, _ = _qdrant_client().scroll(
            collection_name=HR_KB_COLLECTION,
            scroll_filter=qmodels.Filter(must=[
                qmodels.FieldCondition(key="topic",
                                       match=qmodels.MatchValue(value=topic)),
                qmodels.FieldCondition(key="chunk_type",
                                       match=qmodels.MatchValue(value="card")),
            ]),
            with_payload=True, limit=1,
        )
    except Exception as e:
        log.warning("hr_chat _fetch_topic_card(%s) failed: %s", topic, e)
        return None
    if not records:
        return None
    payload = records[0].payload or {}
    return {
        "score": 0.99,            # priority-injected; sits above all
        "raw_score": 0.99,        # cosine-driven results
        "text": payload.get("text", ""),
        "doc_id": payload.get("doc_id"),
        "doc_title": payload.get("doc_title"),
        "doc_code": payload.get("doc_code"),
        "filename": payload.get("filename"),
        "category": payload.get("category", ""),
        "topic": payload.get("topic"),
        "section_path": payload.get("section_path"),
        "chunk_type": payload.get("chunk_type"),
        "card_title": payload.get("card_title"),
    }


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
            "score": raw + bias.get(cat, 0.0) + _chunk_bias(payload),
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

    # Intent-routed top-1 injection. If the query matches a known
    # enumeration pattern, fetch the priority cards directly from
    # Qdrant by topic-filter and prepend them. This bypasses cosine
    # similarity entirely for the priority slots, guaranteeing the
    # canonical answer reaches the LLM regardless of how the
    # multilingual embedder ranks competing shallow sections.
    priority_topics = _route_topics_for(query)
    if priority_topics:
        injected: List[Dict[str, Any]] = []
        injected_topics: set = set()
        for t in priority_topics:
            card = _fetch_topic_card(t)
            if card and card["topic"] not in injected_topics:
                injected.append(card)
                injected_topics.add(card["topic"])
        if injected:
            # Drop dupes that would also appear in cosine results.
            seen = {c["topic"] for c in injected if c.get("topic")}
            tail = [r for r in out if r.get("topic") not in seen]
            out = injected + tail
            log.info("hr_chat intent route: q=%r injected=%s",
                     query[:60], [c["topic"] for c in injected])

    return out


# ---------------------------------------------------------------------------
# Step 3: grounding prompt
# ---------------------------------------------------------------------------
SYSTEM_PROMPT = (
    "شما دستیار سرمایه انسانی و استراتژی شرکت الکتروکویر هستید. "
    "وظیفه شما **فقط و فقط** نقل دقیق محتوای منابع پیوست‌شده است. "
    "این منابع از مدارک رسمی شرکت استخراج شده‌اند و شما **اجازه ندارید** "
    "از دانش عمومی خود، حافظه قبلی، یا تجربه‌های مشابه استفاده کنید.\n\n"
    "**قواعد قطعی (بدون استثنا):**\n"
    "۱) فقط چیزی بنویسید که عیناً در منابع پیوست‌شده آمده است. هر "
    "عدد، تاریخ، ماده قانون، کد سند (EKWI-AD-...)، نام شخص، روند "
    "اجرایی، و شرط را **مستقیماً** از منابع برداشت کنید.\n"
    "۲) **هیچ‌گاه** عددی را که در منابع نیست تخمین یا اضافه نکنید "
    "(مثلاً ننویسید \"معمولاً ۱۴ روز\" یا \"تا حداکثر ۱۰ روز\" اگر این "
    "اعداد در منبع نیامده).\n"
    "۳) **هیچ‌گاه** قانون یا ماده‌ای را که در منابع ذکر نشده ابداع "
    "نکنید. اگر منبع به ماده‌ای اشاره می‌کند آن را نقل کنید؛ اگر نه، "
    "نه.\n"
    "۴) **هیچ‌گاه** فرآیند یا مرحله‌ای (مثل \"تأیید مدیر ارشد\" یا "
    "\"ارائه گواهی دوره‌ای\") را که در منابع نیست بیفزایید.\n"
    "۵) اگر اطلاعات لازم برای بخشی از سؤال در منابع نیست، صریحاً "
    "بنویسید: «این مورد در منابع موجود ذکر نشده است» و آن بخش را "
    "خالی بگذارید — حدس نزنید.\n"
    "۶) اگر سوال کاملاً خارج از منابع است، با لحن دوستانه بگویید "
    "این موضوع در مدارک شرکت پوشش داده نشده و کاربر را به واحد "
    "سرمایه انسانی ارجاع دهید — هرگز از دانش عمومی پاسخ نسازید.\n\n"
    "**ساختار پاسخ** (پاسخ همان زبان سؤال):\n"
    "  ۱) **پاسخ مستقیم** — یک‌دو جمله که جان سوال را پاسخ می‌دهد، "
    "با اعداد دقیق منبع.\n"
    "  ۲) **مبنای قانونی یا سند مرجع** — ماده قانون / کد سند داخلی "
    "(مثل EKWI-AD-006-01) اگر در منبع آمده.\n"
    "  ۳) **اعداد، فرمول‌ها، سقف‌ها** — فقط ارقامی که در منابع آمده.\n"
    "  ۴) **شرایط، تبصره‌ها، استثناها** — تنها تبصره‌هایی که در منابع "
    "آمده. تبصره ابداعی ممنوع.\n"
    "  ۵) **روند عملی** — فقط مراحل ذکر شده در منبع (مثل ثبت در "
    "سامانه کسرا، فرم BPMS، تأیید مدیر) — نه چیز دیگر.\n"
    "  ۶) **نکات مرتبط** — فقط نکات صراحتاً در منابع.\n\n"
    "**اصول قالب‌بندی:**\n"
    "• هر ادعای کلیدی را با شماره منبع در کروشه دنبال کنید "
    "(مثلاً [1]، [2][3]). \n"
    "• از **bold** برای اعداد و اصطلاحات کلیدی استفاده کنید.\n"
    "• از لیست‌های شماره‌دار/گلوله‌ای برای اقلام جدا استفاده کنید.\n"
    "• سلام/احوال‌پرسی را کوتاه و گرم پاسخ بدهید و موضوعات قابل کمک "
    "را معرفی کنید (مرخصی، اضافه کاری، وام، استخدام، انتصاب، تردد، "
    "قطع همکاری، چشم‌انداز، مأموریت، ارزش‌ها، استراتژی‌ها، مقاصد "
    "آرمانی).\n"
    "• پاسخ به همان زبان سوال (فارسی به فارسی، انگلیسی به انگلیسی).\n\n"
    "**یادآوری نهایی:** اگر شک دارید که اطلاعاتی در منابع هست یا نه، "
    "فرض را بر این بگذارید که **نیست**. خالی گذاشتن بهتر از ساختن است."
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
        # 0.0 — fully greedy / deterministic. The corpus doesn't
        # change and operators require identical answers across
        # users and across turns. At 0.0 the LLM picks the
        # single most-likely token every step → bit-identical
        # output for identical input. Combined with the strict
        # "only from sources" system prompt and the intent-routed
        # priority cards, this delivers the canonical answer
        # every time.
        "temperature": float(os.getenv("HR_LLM_TEMPERATURE", "0.0")),
        # 1 sample, no nucleus tweaking — same reasoning as above.
        "top_p": float(os.getenv("HR_LLM_TOP_P", "1.0")),
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
