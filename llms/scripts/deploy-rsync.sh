#!/bin/bash
# Alternative deployment using rsync (more reliable for large transfers)

set -e

# Configuration with environment variable support
CENTRAL_SERVER="${CENTRAL_SERVER:-217.219.39.212}"
CENTRAL_PORT="${CENTRAL_PORT:-2324}"
TARGET_SERVER="${TARGET_SERVER:-192.168.1.61}"
TARGET_USER="${TARGET_USER:-ubuntu}"
DEPLOY_KEY="${DEPLOY_KEY:-$HOME/.ssh/deploy_key}"
SSH_OPTS="-o ConnectTimeout=30 -o ServerAliveInterval=60 -o ServerAliveCountMax=3"

# Validate required environment variables
if [ -z "$SSH_USER" ]; then
    echo "ERROR: SSH_USER environment variable is required"
    echo "Usage: SSH_USER=your_username $0"
    exit 1
fi

echo "=== Deploying via Rsync ==="
echo "Target: $TARGET_USER@$TARGET_SERVER"

# Option 1: Direct rsync to central, then central to target
echo "Step 1: Syncing to central server..."
timeout 300 rsync -avz --delete \
    -e "ssh -p $CENTRAL_PORT $SSH_OPTS -i $DEPLOY_KEY" \
    --exclude='.git' \
    --exclude='__pycache__' \
    --exclude='*.pyc' \
    --exclude='tests/' \
    --exclude='*.md' \
    . $SSH_USER@$CENTRAL_SERVER:/tmp/llms-staging/

echo "Step 2: Syncing from central to target..."
timeout 300 ssh -p $CENTRAL_PORT $SSH_OPTS -i $DEPLOY_KEY $SSH_USER@$CENTRAL_SERVER << ENDSSH
    rsync -avz --delete \
        -e "ssh $SSH_OPTS" \
        /tmp/llms-staging/ $TARGET_USER@$TARGET_SERVER:~/llm-deployment/

    # Clean up
    rm -rf /tmp/llms-staging/
ENDSSH

echo "✓ Deployment complete"
