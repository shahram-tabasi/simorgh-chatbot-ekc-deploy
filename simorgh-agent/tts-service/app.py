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

# Available voices (subset of edge-tts voices)
VOICE_MAP = {
    # English
    "en-female-1": "en-US-AriaNeural",
    "en-female-2": "en-US-JennyNeural",
    "en-male-1": "en-US-GuyNeural",
    "en-male-2": "en-US-ChristopherNeural",
    # Persian / Farsi
    "fa-female-1": "fa-IR-DilaraNeural",
    "fa-male-1": "fa-IR-FaridNeural",
    # Arabic
    "ar-female-1": "ar-SA-ZariyahNeural",
    "ar-male-1": "ar-SA-HamedNeural",
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
    """Resolve voice ID to edge-tts voice name"""
    if not voice_id:
        return DEFAULT_VOICE
    # Check if it's a friendly name
    if voice_id in VOICE_MAP:
        return VOICE_MAP[voice_id]
    # Check if it's already a full edge-tts voice name
    if "Neural" in voice_id:
        return voice_id
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

    # Generate speech
    try:
        logger.info(f"Synthesizing: {len(request.text)} chars, voice={voice}, rate={rate}")

        communicate = edge_tts.Communicate(
            text=request.text,
            voice=voice,
            rate=rate,
            volume=volume,
            proxy=TTS_PROXY,
        )

        # Collect audio data
        audio_data = io.BytesIO()
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                audio_data.write(chunk["data"])

        audio_data.seek(0)
        audio_bytes = audio_data.read()

        if not audio_bytes:
            raise HTTPException(status_code=500, detail="TTS engine returned empty audio")

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

    except edge_tts.exceptions.NoAudioReceived:
        logger.error("No audio received from edge-tts")
        raise HTTPException(status_code=500, detail="TTS synthesis failed: no audio received")
    except Exception as e:
        logger.error(f"TTS synthesis error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"TTS synthesis failed: {str(e)}")


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
