#!/bin/bash
# check-models.sh
# Check if models are downloaded and provide status

MODEL_CACHE_PATH="${MODEL_CACHE_PATH:-/home/ubuntu/models}"

echo "=== Model Status Check ==="
echo ""

# Check if base directory exists
if [ ! -d "$MODEL_CACHE_PATH" ]; then
    echo "❌ Model directory doesn't exist: $MODEL_CACHE_PATH"
    echo "   Run: mkdir -p $MODEL_CACHE_PATH"
    exit 1
fi

echo "✓ Model directory exists: $MODEL_CACHE_PATH"
echo ""

# Check 4-bit model
FOURBIT_DIR="$MODEL_CACHE_PATH/huggingface/models--unsloth--gpt-oss-20b-unsloth-bnb-4bit"
if [ -d "$FOURBIT_DIR" ]; then
    SIZE=$(du -sh "$FOURBIT_DIR" 2>/dev/null | cut -f1)
    echo "✓ 4-bit model found: $SIZE"
else
    echo "❌ 4-bit model NOT found"
    echo "   Expected: $FOURBIT_DIR"
fi

# Check 16-bit model
SIXTEENBIT_DIR="$MODEL_CACHE_PATH/unsloth-gpt-oss-20b-16bit"
if [ -d "$SIXTEENBIT_DIR" ]; then
    SIZE=$(du -sh "$SIXTEENBIT_DIR" 2>/dev/null | cut -f1)
    echo "✓ 16-bit model found: $SIZE"

    # Check for critical files
    if [ -f "$SIXTEENBIT_DIR/config.json" ]; then
        echo "  ✓ config.json present"
    else
        echo "  ⚠ config.json missing"
    fi

    if ls "$SIXTEENBIT_DIR"/*.safetensors &>/dev/null || ls "$SIXTEENBIT_DIR"/*.bin &>/dev/null; then
        echo "  ✓ Model weights present"
    else
        echo "  ⚠ Model weights missing"
    fi
else
    echo "❌ 16-bit model NOT found"
    echo "   Expected: $SIXTEENBIT_DIR"
fi

# Check initialization marker
if [ -f "$MODEL_CACHE_PATH/.init_complete" ]; then
    echo "✓ Initialization marker present"
else
    echo "⚠ Initialization marker missing"
fi

echo ""

# Check initializer container status
if command -v docker &> /dev/null; then
    echo "=== Initializer Status ==="
    if docker ps -a --filter "name=model_initializer" --format "table {{.Status}}" | grep -q "Exited"; then
        EXIT_CODE=$(docker inspect model_initializer --format='{{.State.ExitCode}}' 2>/dev/null)
        if [ "$EXIT_CODE" = "0" ]; then
            echo "✓ Initializer completed successfully"
        else
            echo "❌ Initializer failed (exit code: $EXIT_CODE)"
            echo "   Check logs: docker logs model_initializer"
        fi
    elif docker ps --filter "name=model_initializer" --format "{{.Status}}" | grep -q "Up"; then
        echo "⏳ Initializer is currently running..."
        echo "   Monitor: docker logs -f model_initializer"
    else
        echo "⚠ Initializer hasn't run yet"
    fi
fi

echo ""
echo "=== Disk Usage ==="
df -h "$MODEL_CACHE_PATH" | tail -1

echo ""
echo "=== Recommendations ==="

# Provide recommendations
if [ ! -d "$FOURBIT_DIR" ] || [ ! -d "$SIXTEENBIT_DIR" ]; then
    echo "⚠ Models are missing or incomplete"
    echo ""
    echo "To download models:"
    echo "  1. Run: cd ~/llm-deployment"
    echo "  2. Run: docker compose up -d model_initializer"
    echo "  3. Monitor: docker logs -f model_initializer"
    echo "  4. Wait for completion (30-60 minutes)"
    echo ""
    echo "Or manually download:"
    echo "  python -c 'from huggingface_hub import snapshot_download; snapshot_download(\"unsloth/gpt-oss-20b-unsloth-bnb-4bit\", cache_dir=\"$MODEL_CACHE_PATH/huggingface\")'"
else
    echo "✅ Models are ready! You can start the AI service:"
    echo "  docker compose up -d"
fi
