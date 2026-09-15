# =============================================================================
# Faster-Whisper Server — offline Persian-tuned STT (OpenAI /v1/audio compat)
# =============================================================================
# Drop-in replacement for stt-service. Uses faster-whisper (4× faster than
# vanilla openai-whisper via CTranslate2) and bakes a Persian-fine-tuned
# Whisper model into the image at build time.
#
# Default model (~3 GB on disk after CT2 conversion):
#   MohammadGholizadeh/whisper-large-v3-persian-common-voice-17
#     Fine-tuned on 250k Persian Common Voice samples. WER ~10-14% on clean
#     Persian speech (vs vanilla whisper-large-v3 ~25-30% on the same data).
#
# Alternative — faster but slightly less accurate:
#   --build-arg WHISPER_MODEL=vhdm/whisper-large-fa-v1
#     Based on whisper-large-v3-turbo. ~14% WER, materially lower latency
#     because turbo is ~3× faster than large.
#
# Build (once, on connected host):
#   docker build --build-arg WHISPER_MODEL=... -t simorgh-whisper:offline \
#     -f whisper/Dockerfile whisper/
# =============================================================================
FROM fedirz/faster-whisper-server:latest-cpu

ARG WHISPER_MODEL=MohammadGholizadeh/whisper-large-v3-persian-common-voice-17

# Pre-download the model into the image so runtime never reaches HuggingFace.
# faster-whisper auto-converts to CTranslate2 format on first use; do that
# at build time so the first call isn't slow.
ENV HF_HOME=/root/.cache/huggingface
RUN python3 -c "from faster_whisper import WhisperModel; \
                WhisperModel('${WHISPER_MODEL}', device='cpu', compute_type='int8')"

ENV HF_HUB_OFFLINE=1
ENV TRANSFORMERS_OFFLINE=1
ENV WHISPER_MODEL=${WHISPER_MODEL}
ENV WHISPER_DEFAULT_LANGUAGE=fa
# int8: 4× memory savings vs float16, ~5% slower.
ENV WHISPER_COMPUTE_TYPE=int8

EXPOSE 8000
