"""
TTS Service - Text-to-Speech using edge-tts
=============================================
Lightweight TTS service using Microsoft Edge's TTS engine.
Runs on CPU, no GPU required.

Features:
- Multiple voices and languages
- Fast synthesis with streaming support
- Audio caching for repeated requests
- Health check endpoint

Author: Simorgh Industrial Assistant
"""

import os
import io
import logging
import hashlib
import asyncio
from typing import Optional
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel, Field

import edge_tts

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Environment configuration
DEFAULT_VOICE = os.getenv("TTS_VOICE", "en-US-AriaNeural")
DEFAULT_LANGUAGE = os.getenv("TTS_LANGUAGE", "en")
CACHE_DIR = Path(os.getenv("TTS_CACHE_DIR", "/app/cache"))
MAX_CACHE_SIZE_MB = int(os.getenv("TTS_MAX_CACHE_MB", "500"))
MAX_TEXT_LENGTH = int(os.getenv("TTS_MAX_TEXT_LENGTH", "5000"))
# edge-tts opens a WSS to speech.platform.bing.com. aiohttp's WS client
# does NOT honour HTTP_PROXY env vars, so on hosts without direct outbound
# (e.g. .68 → xray on 172.17.0.1:10809) the connection dies with a DNS
# resolution error. Pass the proxy URL explicitly via Communicate(proxy=).
# Prefer an explicit TTS_PROXY override, fall back to HTTPS_PROXY/HTTP_PROXY.
TTS_PROXY = (
    os.getenv("TTS_PROXY")
    or os.getenv("HTTPS_PROXY")
    or os.getenv("https_proxy")
    or os.getenv("HTTP_PROXY")
    or os.getenv("http_proxy")
    or None
)

# Ensure cache directory exists
CACHE_DIR.mkdir(parents=True, exist_ok=True)

# FastAPI app
app = FastAPI(
    title="Simorgh TTS Service",
    description="Text-to-Speech service using edge-tts",
    version="1.0.0"
)

# CORS for frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Available voices (subset of edge-tts voices).
#
# Two key forms accepted: the historical "-1" / "-2" suffixed names
# (legacy clients still in production), AND the suffix-less form that
# the current frontend sends from MessageList.tsx (`fa-female` /
# `en-male` based on a Persian/Arabic regex on the rendered text).
# Keeping both avoids silent fallback to DEFAULT_VOICE — which is
# English-only and produces NO audio for Persian text, since
# Microsoft Edge TTS can't synthesize Persian Unicode through an
# English voice. See _resolve_voice() warning below.
VOICE_MAP = {
    # English
    "en-female":   "en-US-AriaNeural",
    "en-male":     "en-US-GuyNeural",
    "en-female-1": "en-US-AriaNeural",
    "en-female-2": "en-US-JennyNeural",
    "en-male-1":   "en-US-GuyNeural",
    "en-male-2":   "en-US-ChristopherNeural",
    # Persian / Farsi
    "fa-female":   "fa-IR-DilaraNeural",
    "fa-male":     "fa-IR-FaridNeural",
    "fa-female-1": "fa-IR-DilaraNeural",
    "fa-male-1":   "fa-IR-FaridNeural",
    # Arabic
    "ar-female":   "ar-SA-ZariyahNeural",
    "ar-male":     "ar-SA-HamedNeural",
    "ar-female-1": "ar-SA-ZariyahNeural",
    "ar-male-1":   "ar-SA-HamedNeural",
}


# =============================================================================
# PYDANTIC MODELS
# =============================================================================

class SynthesizeRequest(BaseModel):
    """TTS synthesis request"""
    text: str = Field(..., max_length=MAX_TEXT_LENGTH, description="Text to synthesize")
    voice: Optional[str] = Field(None, description="Voice ID (e.g., 'en-female-1', 'fa-male-1')")
    rate: Optional[str] = Field("+0%", description="Speech rate adjustment (e.g., '+10%', '-20%')")
    volume: Optional[str] = Field("+0%", description="Volume adjustment (e.g., '+10%', '-20%')")


class VoiceInfo(BaseModel):
    """Voice information"""
    id: str
    name: str
    language: str
    gender: str


# =============================================================================
# HELPER FUNCTIONS
# =============================================================================

def _get_cache_key(text: str, voice: str, rate: str, volume: str) -> str:
    """Generate cache key from request parameters"""
    key_str = f"{text}:{voice}:{rate}:{volume}"
    return hashlib.md5(key_str.encode()).hexdigest()


def _get_cache_path(cache_key: str) -> Path:
    """Get cache file path"""
    return CACHE_DIR / f"{cache_key}.mp3"


def _resolve_voice(voice_id: Optional[str]) -> str:
    """Resolve voice ID to edge-tts voice name.

    Falling back to DEFAULT_VOICE silently used to mask a real bug:
    the frontend sends `fa-female` for Persian text, but if that key
    wasn't in VOICE_MAP the fallback picked the English default
    voice — and Microsoft's TTS returns NO AUDIO when asked to read
    Persian script with an English voice, producing a 500 with the
    unhelpful "no audio received" log. Now we warn loudly so the
    next mismatch is obvious.
    """
    if not voice_id:
        return DEFAULT_VOICE
    if voice_id in VOICE_MAP:
        return VOICE_MAP[voice_id]
    # Accept a full edge-tts voice name passed through directly.
    if "Neural" in voice_id:
        return voice_id
    logger.warning(
        f"Unknown voice_id={voice_id!r}; falling back to DEFAULT_VOICE={DEFAULT_VOICE}. "
        f"If the request text is non-English this will produce 0 bytes of audio."
    )
    return DEFAULT_VOICE


def _cleanup_cache():
    """Remove old cache files if cache exceeds max size"""
    try:
        total_size = sum(f.stat().st_size for f in CACHE_DIR.glob("*.mp3"))
        max_bytes = MAX_CACHE_SIZE_MB * 1024 * 1024

        if total_size > max_bytes:
            files = sorted(CACHE_DIR.glob("*.mp3"), key=lambda f: f.stat().st_mtime)
            while total_size > max_bytes * 0.8 and files:
                f = files.pop(0)
                total_size -= f.stat().st_size
                f.unlink()
                logger.info(f"Cache cleanup: removed {f.name}")
    except Exception as e:
        logger.warning(f"Cache cleanup error: {e}")


# =============================================================================
# ENDPOINTS
# =============================================================================

@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {
        "status": "healthy",
        "service": "tts",
        "timestamp": datetime.utcnow().isoformat(),
        "default_voice": DEFAULT_VOICE,
        "cache_dir": str(CACHE_DIR),
        "proxy_configured": bool(TTS_PROXY),
    }


@app.post("/synthesize")
async def synthesize(request: SynthesizeRequest):
    """
    Synthesize text to speech audio (MP3).

    Returns MP3 audio stream.
    """
    if not request.text.strip():
        raise HTTPException(status_code=400, detail="Text cannot be empty")

    if len(request.text) > MAX_TEXT_LENGTH:
        raise HTTPException(
            status_code=400,
            detail=f"Text too long. Maximum {MAX_TEXT_LENGTH} characters."
        )

    voice = _resolve_voice(request.voice)
    rate = request.rate or "+0%"
    volume = request.volume or "+0%"

    # Check cache
    cache_key = _get_cache_key(request.text, voice, rate, volume)
    cache_path = _get_cache_path(cache_key)

    if cache_path.exists():
        logger.info(f"Cache hit: {cache_key[:8]}...")
        return StreamingResponse(
            open(cache_path, "rb"),
            media_type="audio/mpeg",
            headers={
                "Content-Disposition": "inline",
                "X-TTS-Cached": "true",
                "X-TTS-Voice": voice,
            }
        )

    # Microsoft's edge TTS endpoint is sporadically flaky through
    # high-latency proxies — `NoAudioReceived` (and empty-body returns)
    # fire for some requests with no obvious content pattern; same
    # text+voice usually succeeds on a second try. One retry with a
    # short backoff catches almost all transient cases. If the second
    # attempt also fails, the request body is logged in full so an
    # operator can reproduce and decide if frontend text-cleanup needs
    # tightening for some character class.
    logger.info(f"Synthesizing: {len(request.text)} chars, voice={voice}, rate={rate}")

    audio_bytes: bytes = b""
    for attempt in (1, 2):
        try:
            communicate = edge_tts.Communicate(
                text=request.text,
                voice=voice,
                rate=rate,
                volume=volume,
                proxy=TTS_PROXY,
            )
            buf = io.BytesIO()
            async for chunk in communicate.stream():
                if chunk["type"] == "audio":
                    buf.write(chunk["data"])
            audio_bytes = buf.getvalue()
            if audio_bytes:
                if attempt > 1:
                    logger.info(f"Synthesis succeeded on retry {attempt}")
                break
            # Empty body without exception — treat as the transient
            # "no audio" case and retry.
            logger.warning(f"Empty audio on attempt {attempt}; retrying")
        except edge_tts.exceptions.NoAudioReceived:
            logger.warning(f"NoAudioReceived on attempt {attempt}; retrying")
        except Exception as e:
            # Non-transient errors (network, library bugs, etc.) skip
            # retry — re-raising immediately so the client sees the
            # real cause instead of a generic "no audio" after 500ms.
            logger.error(f"TTS synthesis error: {e}", exc_info=True)
            raise HTTPException(status_code=500, detail=f"TTS synthesis failed: {str(e)}")
        if attempt == 1:
            await asyncio.sleep(0.25)

    if not audio_bytes:
        logger.error(
            "No audio received from edge-tts after 2 attempts. "
            f"voice={voice} rate={rate} text_len={len(request.text)} "
            f"text_preview={request.text[:300]!r}"
        )
        # 503 (Service Unavailable) — not 500 — because the failure is
        # almost always upstream connectivity to Microsoft, not a bug in
        # this service. The structured body lets the frontend distinguish
        # "TTS-needs-internet" from a generic crash and show a localised
        # message instead of a silent click on the speak button.
        return JSONResponse(
            status_code=503,
            content={
                "error_code": "tts_upstream_unavailable",
                "detail": "TTS upstream returned no audio after retries",
                "user_message_fa": (
                    "خدمات تبدیل متن به گفتار در حال حاضر در دسترس نیست. "
                    "اتصال اینترنت سرور را بررسی کنید."
                ),
                "user_message_en": (
                    "Text-to-speech is currently unavailable — the server "
                    "could not reach the upstream speech provider. Please "
                    "check the server's outbound internet connection."
                ),
                "voice": voice,
            },
        )

    # Cache the result
    try:
        cache_path.write_bytes(audio_bytes)
        _cleanup_cache()
    except Exception as e:
        logger.warning(f"Failed to cache audio: {e}")

    logger.info(f"Synthesized: {len(audio_bytes)} bytes, voice={voice}")

    return StreamingResponse(
        io.BytesIO(audio_bytes),
        media_type="audio/mpeg",
        headers={
            "Content-Disposition": "inline",
            "X-TTS-Cached": "false",
            "X-TTS-Voice": voice,
            "Content-Length": str(len(audio_bytes)),
        }
    )


@app.get("/voices")
async def list_voices():
    """List available voices"""
    voices = []
    for voice_id, edge_name in VOICE_MAP.items():
        parts = voice_id.split("-")
        lang = parts[0]
        gender = parts[1]
        voices.append(VoiceInfo(
            id=voice_id,
            name=edge_name,
            language=lang,
            gender=gender,
        ))
    return {"voices": [v.model_dump() for v in voices]}


@app.get("/voices/all")
async def list_all_voices():
    """List all available edge-tts voices"""
    try:
        voices = await edge_tts.list_voices()
        return {"voices": voices, "count": len(voices)}
    except Exception as e:
        logger.error(f"Failed to list voices: {e}")
        raise HTTPException(status_code=500, detail=str(e))
