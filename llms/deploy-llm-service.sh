#!/bin/bash
# deploy-llm-service.sh
# Smart deployment script that handles model downloads

set -e

echo "=== LLM Service Deployment ==="

# Configuration
MODEL_CACHE_PATH="${MODEL_CACHE_PATH:-/home/ubuntu/models}"
MODELS_COMPLETE_MARKER="$MODEL_CACHE_PATH/.init_complete"

# Check if models are already downloaded
if [ -f "$MODELS_COMPLETE_MARKER" ]; then
    echo "✓ Models already downloaded, skipping initializer..."

    # Start only ai_service (skip initializer)
    docker compose up -d ai_service nginx gpu_monitor

else
    echo "⚠ Models not found, running initializer in background..."

    # Start initializer in detached mode
    docker compose up -d model_initializer

    # Wait for initializer in background
    echo "⏳ Initializer running... You can monitor with:"
    echo "   docker compose logs -f model_initializer"
    echo ""
    echo "This may take 30-60 minutes for first download."
    echo "Once complete, run this script again to start services."
fi

echo ""
echo "=== Deployment Complete ==="
echo "Check status: docker compose ps"
echo "View logs: docker compose logs -f"
