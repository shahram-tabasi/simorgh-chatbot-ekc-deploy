"""
Audio Summary Service
======================
Generates audio summaries from documents using Text-to-Speech.

Supports multiple TTS providers:
1. OpenAI TTS (high quality, paid)
2. ElevenLabs (natural voices, paid)
3. Edge-TTS (free, Microsoft Azure)

Features:
- Document audio summaries
- Podcast-style overviews
- Multi-voice conversations
- Caching for repeated requests

Author: Simorgh Industrial Assistant
"""

import os
import logging
import asyncio
import hashlib
from typing import Dict, Any, List, Optional, Tuple
from dataclasses import dataclass
from pathlib import Path
from enum import Enum

logger = logging.getLogger(__name__)


class TTSProvider(Enum):
    """Available TTS providers"""
    OPENAI = "openai"
    ELEVENLABS = "elevenlabs"
    EDGE_TTS = "edge_tts"


@dataclass
class AudioResult:
    """Result of audio generation"""
    audio_path: str
    audio_url: str
    duration_seconds: float
    provider: str
    voice: str
    text_length: int
    cached: bool = False


@dataclass
class PodcastResult:
    """Result of podcast-style audio generation"""
    audio_path: str
    audio_url: str
    duration_seconds: float
    segments: List[Dict[str, Any]]
    transcript: str


class AudioSummaryService:
    """
    Service for generating audio summaries from documents.

    Usage:
        service = AudioSummaryService()

        # Simple audio summary
        result = await service.generate_audio_summary(
            text="This is the document summary...",
            project_number="04A12065"
        )

        # Podcast-style with multiple voices
        podcast = await service.generate_podcast_overview(
            project_number="04A12065",
            style="conversational"
        )
    """

    # Audio storage directory
    AUDIO_DIR = Path("/app/uploads/audio")

    # Voice configurations
    OPENAI_VOICES = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"]
    ELEVENLABS_VOICES = ["Rachel", "Domi", "Bella", "Antoni", "Thomas"]
    EDGE_VOICES = {
        "en": "en-US-AriaNeural",
        "fa": "fa-IR-DilaraNeural"
    }

    def __init__(
        self,
        llm_service=None,
        synthesis_service=None,
        redis_service=None,
        default_provider: TTSProvider = TTSProvider.EDGE_TTS
    ):
        """
        Initialize audio service.

        Args:
            llm_service: LLM for script generation
            synthesis_service: DocumentSynthesisService for summaries
            redis_service: Redis for caching
            default_provider: Default TTS provider
        """
        self.llm = llm_service
        self.synthesis = synthesis_service
        self.redis = redis_service
        self.default_provider = default_provider

        # Create audio directory
        self.AUDIO_DIR.mkdir(parents=True, exist_ok=True)

        # Check available providers
        self._check_providers()

        logger.info(f"AudioSummaryService initialized with {default_provider.value}")

    def _check_providers(self):
        """Check which TTS providers are available"""
        self.available_providers = []

        # Check OpenAI
        if os.getenv("OPENAI_API_KEY"):
            self.available_providers.append(TTSProvider.OPENAI)
            logger.info("OpenAI TTS available")

        # Check ElevenLabs
        if os.getenv("ELEVENLABS_API_KEY"):
            self.available_providers.append(TTSProvider.ELEVENLABS)
            logger.info("ElevenLabs TTS available")

        # Edge-TTS is always available (no API key needed)
        self.available_providers.append(TTSProvider.EDGE_TTS)
        logger.info("Edge-TTS available (free)")

    async def generate_audio_summary(
        self,
        text: str = None,
        project_number: str = None,
        chat_id: str = None,
        voice: str = None,
        provider: TTSProvider = None,
        language: str = "en"
    ) -> Optional[AudioResult]:
        """
        Generate audio from text or document summary.

        Args:
            text: Text to convert (if None, generates from documents)
            project_number: Project OENUM
            chat_id: Chat ID
            voice: Voice to use
            provider: TTS provider
            language: Language code

        Returns:
            AudioResult with file path and URL
        """
        try:
            provider = provider or self.default_provider

            # Get text if not provided
            if not text:
                if not self.synthesis:
                    logger.error("No text provided and synthesis service not available")
                    return None

                synthesis = await self.synthesis.generate_multi_doc_synthesis(
                    project_number=project_number,
                    chat_id=chat_id
                )

                if not synthesis:
                    return None

                text = self._format_synthesis_for_audio(synthesis)

            # Check cache
            cache_key = self._get_cache_key(text, voice, provider)
            cached_path = self._check_cache(cache_key)
            if cached_path:
                return AudioResult(
                    audio_path=str(cached_path),
                    audio_url=f"/api/audio/{cached_path.name}",
                    duration_seconds=self._estimate_duration(text),
                    provider=provider.value,
                    voice=voice or "default",
                    text_length=len(text),
                    cached=True
                )

            # Generate audio based on provider
            if provider == TTSProvider.OPENAI:
                result = await self._generate_openai_tts(text, voice, language)
            elif provider == TTSProvider.ELEVENLABS:
                result = await self._generate_elevenlabs_tts(text, voice, language)
            else:
                result = await self._generate_edge_tts(text, voice, language)

            if result:
                # Cache the result
                self._save_to_cache(cache_key, result.audio_path)

            return result

        except Exception as e:
            logger.error(f"Audio summary generation failed: {e}", exc_info=True)
            return None

    async def generate_podcast_overview(
        self,
        project_number: str = None,
        chat_id: str = None,
        style: str = "conversational",
        duration_target: int = 120  # seconds
    ) -> Optional[PodcastResult]:
        """
        Generate podcast-style audio overview with multiple voices.

        Args:
            project_number: Project OENUM
            chat_id: Chat ID
            style: "conversational", "professional", "casual"
            duration_target: Target duration in seconds

        Returns:
            PodcastResult with audio and transcript
        """
        try:
            if not self.synthesis:
                logger.error("Synthesis service required for podcast generation")
                return None

            # Get document synthesis
            synthesis = await self.synthesis.generate_multi_doc_synthesis(
                project_number=project_number,
                chat_id=chat_id
            )

            if not synthesis:
                return None

            # Generate podcast script
            script = await self._generate_podcast_script(synthesis, style, duration_target)

            if not script:
                return None

            # Generate audio segments
            segments = []
            audio_files = []

            for segment in script:
                voice = segment.get("voice", "default")
                text = segment.get("text", "")

                audio_result = await self.generate_audio_summary(
                    text=text,
                    voice=voice,
                    provider=self.default_provider
                )

                if audio_result:
                    segments.append({
                        "speaker": segment.get("speaker", "Host"),
                        "text": text,
                        "audio_path": audio_result.audio_path,
                        "duration": audio_result.duration_seconds
                    })
                    audio_files.append(audio_result.audio_path)

            # Combine audio files
            if audio_files:
                combined_path = await self._combine_audio_files(
                    audio_files,
                    project_number or chat_id
                )

                total_duration = sum(s.get("duration", 0) for s in segments)
                transcript = "\n\n".join(
                    f"**{s['speaker']}**: {s['text']}" for s in segments
                )

                return PodcastResult(
                    audio_path=str(combined_path),
                    audio_url=f"/api/audio/{combined_path.name}",
                    duration_seconds=total_duration,
                    segments=segments,
                    transcript=transcript
                )

            return None

        except Exception as e:
            logger.error(f"Podcast generation failed: {e}", exc_info=True)
            return None

    async def _generate_openai_tts(
        self,
        text: str,
        voice: str = None,
        language: str = "en"
    ) -> Optional[AudioResult]:
        """Generate audio using OpenAI TTS"""
        try:
            import httpx

            api_key = os.getenv("OPENAI_API_KEY")
            if not api_key:
                logger.error("OpenAI API key not configured")
                return None

            voice = voice or "alloy"
            if voice not in self.OPENAI_VOICES:
                voice = "alloy"

            # Limit text length (OpenAI limit is 4096 chars)
            if len(text) > 4000:
                text = text[:4000] + "..."

            async with httpx.AsyncClient(timeout=60.0) as client:
                response = await client.post(
                    "https://api.openai.com/v1/audio/speech",
                    headers={
                        "Authorization": f"Bearer {api_key}",
                        "Content-Type": "application/json"
                    },
                    json={
                        "model": "tts-1",
                        "input": text,
                        "voice": voice,
                        "response_format": "mp3"
                    }
                )

                if response.status_code == 200:
                    # Save audio file
                    filename = f"openai_{hashlib.md5(text.encode()).hexdigest()[:8]}.mp3"
                    filepath = self.AUDIO_DIR / filename

                    with open(filepath, "wb") as f:
                        f.write(response.content)

                    return AudioResult(
                        audio_path=str(filepath),
                        audio_url=f"/api/audio/{filename}",
                        duration_seconds=self._estimate_duration(text),
                        provider="openai",
                        voice=voice,
                        text_length=len(text)
                    )
                else:
                    logger.error(f"OpenAI TTS failed: {response.status_code}")
                    return None

        except Exception as e:
            logger.error(f"OpenAI TTS error: {e}")
            return None

    async def _generate_elevenlabs_tts(
        self,
        text: str,
        voice: str = None,
        language: str = "en"
    ) -> Optional[AudioResult]:
        """Generate audio using ElevenLabs"""
        try:
            import httpx

            api_key = os.getenv("ELEVENLABS_API_KEY")
            if not api_key:
                logger.error("ElevenLabs API key not configured")
                return None

            # Default voice ID (Rachel)
            voice_id = os.getenv("ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM")

            async with httpx.AsyncClient(timeout=60.0) as client:
                response = await client.post(
                    f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}",
                    headers={
                        "xi-api-key": api_key,
                        "Content-Type": "application/json"
                    },
                    json={
                        "text": text[:5000],  # ElevenLabs limit
                        "model_id": "eleven_monolingual_v1",
                        "voice_settings": {
                            "stability": 0.5,
                            "similarity_boost": 0.75
                        }
                    }
                )

                if response.status_code == 200:
                    filename = f"elevenlabs_{hashlib.md5(text.encode()).hexdigest()[:8]}.mp3"
                    filepath = self.AUDIO_DIR / filename

                    with open(filepath, "wb") as f:
                        f.write(response.content)

                    return AudioResult(
                        audio_path=str(filepath),
                        audio_url=f"/api/audio/{filename}",
                        duration_seconds=self._estimate_duration(text),
                        provider="elevenlabs",
                        voice=voice or "Rachel",
                        text_length=len(text)
                    )
                else:
                    logger.error(f"ElevenLabs TTS failed: {response.status_code}")
                    return None

        except Exception as e:
            logger.error(f"ElevenLabs TTS error: {e}")
            return None

    async def _generate_edge_tts(
        self,
        text: str,
        voice: str = None,
        language: str = "en"
    ) -> Optional[AudioResult]:
        """Generate audio using Edge-TTS (free)"""
        try:
            import edge_tts

            # Select voice based on language
            voice = voice or self.EDGE_VOICES.get(language, self.EDGE_VOICES["en"])

            filename = f"edge_{hashlib.md5(text.encode()).hexdigest()[:8]}.mp3"
            filepath = self.AUDIO_DIR / filename

            communicate = edge_tts.Communicate(text, voice)
            await communicate.save(str(filepath))

            return AudioResult(
                audio_path=str(filepath),
                audio_url=f"/api/audio/{filename}",
                duration_seconds=self._estimate_duration(text),
                provider="edge_tts",
                voice=voice,
                text_length=len(text)
            )

        except ImportError:
            logger.error("edge-tts package not installed. Run: pip install edge-tts")
            return None
        except Exception as e:
            logger.error(f"Edge-TTS error: {e}")
            return None

    async def _generate_podcast_script(
        self,
        synthesis,
        style: str,
        duration_target: int
    ) -> Optional[List[Dict[str, Any]]]:
        """Generate podcast script using LLM"""
        if not self.llm:
            # Fallback: simple script
            return [
                {
                    "speaker": "Host",
                    "voice": self.EDGE_VOICES["en"],
                    "text": f"Welcome to the document overview. {synthesis.overview}"
                }
            ]

        try:
            prompt = f"""Create a podcast script for a {duration_target} second audio overview.
Style: {style}

Document Overview:
{synthesis.overview}

Key Topics:
{', '.join(synthesis.common_themes)}

FAQ Highlights:
{chr(10).join(f"Q: {faq['question']} A: {faq['answer']}" for faq in synthesis.faq[:3])}

Create a script with two speakers (Host and Expert) discussing the documents.
Keep it natural and engaging. Target: {duration_target} seconds (about {duration_target * 2} words).

Output format (JSON array):
[
    {{"speaker": "Host", "text": "..."}},
    {{"speaker": "Expert", "text": "..."}}
]
"""

            messages = [
                {"role": "system", "content": "You are a podcast scriptwriter. Output only valid JSON."},
                {"role": "user", "content": prompt}
            ]

            if hasattr(self.llm, 'async_generate'):
                result = await self.llm.async_generate(messages=messages, temperature=0.7)
            else:
                result = self.llm.generate(messages=messages, temperature=0.7)

            response = result.get("response", "")

            # Parse JSON
            import json
            import re

            match = re.search(r'\[[\s\S]*\]', response)
            if match:
                script = json.loads(match.group(0))

                # Add voice to each segment
                for segment in script:
                    if segment.get("speaker") == "Host":
                        segment["voice"] = self.EDGE_VOICES["en"]
                    else:
                        segment["voice"] = "en-US-GuyNeural"  # Different voice for expert

                return script

        except Exception as e:
            logger.error(f"Podcast script generation failed: {e}")

        return None

    async def _combine_audio_files(
        self,
        audio_files: List[str],
        identifier: str
    ) -> Path:
        """Combine multiple audio files into one"""
        try:
            from pydub import AudioSegment

            combined = AudioSegment.empty()

            for filepath in audio_files:
                segment = AudioSegment.from_mp3(filepath)
                combined += segment
                combined += AudioSegment.silent(duration=500)  # 0.5s pause

            output_path = self.AUDIO_DIR / f"podcast_{identifier}.mp3"
            combined.export(str(output_path), format="mp3")

            return output_path

        except ImportError:
            logger.error("pydub not installed. Run: pip install pydub")
            # Return first file as fallback
            return Path(audio_files[0]) if audio_files else None
        except Exception as e:
            logger.error(f"Audio combination failed: {e}")
            return Path(audio_files[0]) if audio_files else None

    def _format_synthesis_for_audio(self, synthesis) -> str:
        """Format synthesis for audio narration"""
        parts = [
            "Here's an overview of your documents.",
            "",
            synthesis.overview,
            ""
        ]

        if synthesis.common_themes:
            parts.append(f"The main topics covered are: {', '.join(synthesis.common_themes[:5])}.")
            parts.append("")

        if synthesis.faq:
            parts.append("Here are some frequently asked questions:")
            for faq in synthesis.faq[:3]:
                parts.append(f"Question: {faq['question']}")
                parts.append(f"Answer: {faq['answer']}")
                parts.append("")

        return " ".join(parts)

    def _get_cache_key(self, text: str, voice: str, provider: TTSProvider) -> str:
        """Generate cache key for audio"""
        content = f"{text}:{voice}:{provider.value}"
        return hashlib.md5(content.encode()).hexdigest()

    def _check_cache(self, cache_key: str) -> Optional[Path]:
        """Check if audio is cached"""
        for ext in [".mp3", ".wav"]:
            for filepath in self.AUDIO_DIR.glob(f"*{cache_key[:8]}*{ext}"):
                if filepath.exists():
                    return filepath
        return None

    def _save_to_cache(self, cache_key: str, audio_path: str):
        """Save cache reference"""
        if self.redis:
            self.redis.set(
                f"audio_cache:{cache_key}",
                {"path": audio_path},
                db="cache",
                ttl=86400  # 24 hours
            )

    def _estimate_duration(self, text: str) -> float:
        """Estimate audio duration in seconds"""
        # Average speaking rate: ~150 words per minute
        words = len(text.split())
        return (words / 150) * 60


# =============================================================================
# SINGLETON
# =============================================================================

_audio_service_instance: Optional[AudioSummaryService] = None


def get_audio_summary_service(
    llm_service=None,
    synthesis_service=None,
    redis_service=None
) -> AudioSummaryService:
    """Get or create audio summary service singleton"""
    global _audio_service_instance

    if _audio_service_instance is None:
        _audio_service_instance = AudioSummaryService(
            llm_service=llm_service,
            synthesis_service=synthesis_service,
            redis_service=redis_service
        )

    return _audio_service_instance
