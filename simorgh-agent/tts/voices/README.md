# Piper TTS voices

This directory is mounted into the openedai-speech container at
`/app/voices`. Pre-download voices here before bringing up the
service so the runtime is fully offline.

## Persian voice (required)

```bash
cd simorgh-agent/tts/voices
# Voice model + speaker config (~75 MB total)
wget https://huggingface.co/karim23657/Persian-Piper-Model-gyro/resolve/main/fa_IR-amir-medium.onnx
wget https://huggingface.co/karim23657/Persian-Piper-Model-gyro/resolve/main/fa_IR-amir-medium.onnx.json
```

Alternative Persian voices (community-trained, swap as needed):
- `fa_IR-gyro-medium` — different speaker, same quality tier
- `fa_IR-ganji-medium` — slower / more formal cadence

## English voice (optional fallback)

```bash
wget https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx
wget https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx.json
```

## Voice mapping

The container reads `/app/config/voice_to_speaker.yaml` (see `../config/`)
to map the OpenAI voice names (`alloy`, `echo`, etc.) to your local Piper
files. Edit that file if you add more voices.
