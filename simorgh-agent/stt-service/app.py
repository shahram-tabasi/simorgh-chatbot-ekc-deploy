"""
STT Service - Speech-to-Text using Faster-Whisper
=================================================
Runs on CPU to avoid GPU memory conflicts with vLLM.

Features:
- Real-time audio transcription
- Support for multiple audio formats (webm, wav, mp3, ogg)
- Streaming transcription via WebSocket
- Language detection

Author: Simorgh Industrial Assistant
"""

import os
import io
import logging
import tempfile
import asyncio
from typing import Optional
from datetime import datetime

from fastapi import FastAPI, UploadFile, File, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import numpy as np
import soundfile as sf
from pydub import AudioSegment

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Environment configuration
MODEL_SIZE = os.getenv("WHISPER_MODEL_SIZE", "base")  # tiny, base, small, medium
DEVICE = os.getenv("WHISPER_DEVICE", "cpu")  # cpu or cuda
COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE_TYPE", "int8")  # int8, float16, float32

# FastAPI app
app = FastAPI(
    title="Simorgh STT Service",
    description="Speech-to-Text service using Faster-Whisper",
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

# Global model instance (lazy loading)
_whisper_model = None


def get_whisper_model():
    """Get or initialize Whisper model (lazy loading)"""
    global _whisper_model

    if _whisper_model is None:
        logger.info(f"Loading Faster-Whisper model: {MODEL_SIZE} on {DEVICE} with {COMPUTE_TYPE}")
        try:
            from faster_whisper import WhisperModel

            _whisper_model = WhisperModel(
                MODEL_SIZE,
                device=DEVICE,
                compute_type=COMPUTE_TYPE,
                download_root="/app/models"  # Cache models in container
            )
            logger.info(f"Whisper model loaded successfully")
        except Exception as e:
            logger.error(f"Failed to load Whisper model: {e}")
            raise

    return _whisper_model


def convert_audio_to_wav(audio_bytes: bytes, source_format: str = "webm") -> np.ndarray:
    """
    Convert audio bytes to numpy array for Whisper.

    Supports: webm, mp3, ogg, wav, m4a
    Returns: numpy array with 16kHz mono audio
    """
    try:
        # Create temp file with source format
        with tempfile.NamedTemporaryFile(suffix=f".{source_format}", delete=False) as temp_in:
            temp_in.write(audio_bytes)
            temp_in_path = temp_in.name

        # Load audio with pydub (handles various formats via ffmpeg)
        audio = AudioSegment.from_file(temp_in_path, format=source_format)

        # Convert to mono and 16kHz (Whisper requirement)
        audio = audio.set_channels(1)
        audio = audio.set_frame_rate(16000)

        # Export to WAV
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as temp_out:
            audio.export(temp_out.name, format="wav")
            temp_out_path = temp_out.name

        # Read WAV to numpy array
        audio_array, sample_rate = sf.read(temp_out_path)

        # Cleanup temp files
        os.unlink(temp_in_path)
        os.unlink(temp_out_path)

        # Ensure float32
        if audio_array.dtype != np.float32:
            audio_array = audio_array.astype(np.float32)

        logger.info(f"Audio converted: {len(audio_array)} samples at {sample_rate}Hz")
        return audio_array

    except Exception as e:
        logger.error(f"Audio conversion failed: {e}")
        raise HTTPException(status_code=400, detail=f"Audio conversion failed: {str(e)}")


class TranscriptionResponse(BaseModel):
    """Response model for transcription"""
    text: str
    language: str
    language_probability: float
    duration: float
    processing_time: float


@app.get("/health")
async def health_check():
    """Health check endpoint"""
    model_loaded = _whisper_model is not None
    return {
        "status": "healthy",
        "service": "stt",
        "model": MODEL_SIZE,
        "device": DEVICE,
        "model_loaded": model_loaded,
        "timestamp": datetime.now().isoformat()
    }


@app.get("/info")
async def model_info():
    """Get model information"""
    return {
        "model_size": MODEL_SIZE,
        "device": DEVICE,
        "compute_type": COMPUTE_TYPE,
        "supported_formats": ["webm", "wav", "mp3", "ogg", "m4a"],
        "sample_rate": 16000
    }


@app.post("/transcribe", response_model=TranscriptionResponse)
async def transcribe_audio(
    audio: UploadFile = File(...),
    language: Optional[str] = None
):
    """
    Transcribe audio file to text.

    Args:
        audio: Audio file (webm, wav, mp3, ogg, m4a)
        language: Optional language code (e.g., 'en', 'fa', 'ar'). Auto-detect if not provided.

    Returns:
        TranscriptionResponse with text and metadata
    """
    start_time = datetime.now()

    # Validate file
    if not audio.filename:
        raise HTTPException(status_code=400, detail="No filename provided")

    # Determine format from filename or content type
    filename = audio.filename.lower()
    if filename.endswith(".webm"):
        source_format = "webm"
    elif filename.endswith(".wav"):
        source_format = "wav"
    elif filename.endswith(".mp3"):
        source_format = "mp3"
    elif filename.endswith(".ogg"):
        source_format = "ogg"
    elif filename.endswith(".m4a"):
        source_format = "m4a"
    else:
        # Try to infer from content type
        content_type = audio.content_type or ""
        if "webm" in content_type:
            source_format = "webm"
        elif "wav" in content_type:
            source_format = "wav"
        elif "mp3" in content_type:
            source_format = "mp3"
        elif "ogg" in content_type:
            source_format = "ogg"
        else:
            source_format = "webm"  # Default to webm (browser recording format)

    logger.info(f"Received audio: {audio.filename}, format: {source_format}, size: {audio.size or 'unknown'}")

    try:
        # Read audio bytes
        audio_bytes = await audio.read()

        if len(audio_bytes) < 1000:
            raise HTTPException(status_code=400, detail="Audio file too small")

        # Convert to numpy array
        audio_array = convert_audio_to_wav(audio_bytes, source_format)

        # Get model
        model = get_whisper_model()

        # Transcribe
        segments, info = model.transcribe(
            audio_array,
            language=language,
            beam_size=5,
            vad_filter=True,  # Filter out non-speech
            vad_parameters=dict(min_silence_duration_ms=500)
        )

        # Collect all segments
        text_parts = []
        for segment in segments:
            text_parts.append(segment.text.strip())

        full_text = " ".join(text_parts)

        # Calculate processing time
        processing_time = (datetime.now() - start_time).total_seconds()

        logger.info(f"Transcription complete: {len(full_text)} chars in {processing_time:.2f}s, language: {info.language}")

        return TranscriptionResponse(
            text=full_text,
            language=info.language,
            language_probability=info.language_probability,
            duration=info.duration,
            processing_time=processing_time
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Transcription failed: {e}")
        raise HTTPException(status_code=500, detail=f"Transcription failed: {str(e)}")


@app.websocket("/ws/transcribe")
async def websocket_transcribe(websocket: WebSocket):
    """
    WebSocket endpoint for real-time streaming transcription.

    Protocol:
    1. Client connects
    2. Client sends audio chunks as binary
    3. Client sends {"action": "transcribe"} to trigger transcription
    4. Server responds with {"text": "...", "is_final": true/false}
    5. Client sends {"action": "close"} to end session
    """
    await websocket.accept()
    logger.info("WebSocket connection established")

    audio_buffer = io.BytesIO()

    try:
        while True:
            # Receive data
            data = await websocket.receive()

            if "bytes" in data:
                # Audio chunk received
                audio_buffer.write(data["bytes"])
                await websocket.send_json({"status": "chunk_received", "buffer_size": audio_buffer.tell()})

            elif "text" in data:
                # JSON command received
                import json
                try:
                    command = json.loads(data["text"])
                except json.JSONDecodeError:
                    await websocket.send_json({"error": "Invalid JSON"})
                    continue

                action = command.get("action")

                if action == "transcribe":
                    # Get audio from buffer
                    audio_bytes = audio_buffer.getvalue()

                    if len(audio_bytes) < 1000:
                        await websocket.send_json({"error": "Audio too short", "is_final": True})
                        continue

                    try:
                        # Convert and transcribe
                        source_format = command.get("format", "webm")
                        audio_array = convert_audio_to_wav(audio_bytes, source_format)

                        model = get_whisper_model()
                        segments, info = model.transcribe(
                            audio_array,
                            language=command.get("language"),
                            beam_size=5,
                            vad_filter=True
                        )

                        # Collect text
                        text_parts = []
                        for segment in segments:
                            text_parts.append(segment.text.strip())
                            # Send intermediate results
                            await websocket.send_json({
                                "text": segment.text.strip(),
                                "start": segment.start,
                                "end": segment.end,
                                "is_final": False
                            })

                        full_text = " ".join(text_parts)

                        # Send final result
                        await websocket.send_json({
                            "text": full_text,
                            "language": info.language,
                            "duration": info.duration,
                            "is_final": True
                        })

                        # Clear buffer after successful transcription
                        audio_buffer = io.BytesIO()

                    except Exception as e:
                        logger.error(f"WebSocket transcription failed: {e}")
                        await websocket.send_json({"error": str(e), "is_final": True})

                elif action == "clear":
                    # Clear buffer
                    audio_buffer = io.BytesIO()
                    await websocket.send_json({"status": "buffer_cleared"})

                elif action == "close":
                    await websocket.send_json({"status": "closing"})
                    break

    except WebSocketDisconnect:
        logger.info("WebSocket disconnected")
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
    finally:
        audio_buffer.close()


@app.on_event("startup")
async def startup_event():
    """Preload model on startup"""
    logger.info("STT Service starting...")

    # Preload model in background
    try:
        get_whisper_model()
        logger.info("Whisper model preloaded successfully")
    except Exception as e:
        logger.warning(f"Model preload failed (will load on first request): {e}")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)
