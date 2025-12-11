#!/bin/bash
# Alternative deployment using rsync (more reliable for large transfers)

set -e

CENTRAL_SERVER="217.219.39.212"
CENTRAL_PORT="2324"
TARGET_SERVER="192.168.1.61"
DEPLOY_KEY="$HOME/.ssh/deploy_key"
SSH_OPTS="-o ConnectTimeout=30 -o ServerAliveInterval=60 -o ServerAliveCountMax=3"

echo "=== Deploying via Rsync ==="

# Option 1: Direct rsync to central, then central to target
echo "Step 1: Syncing to central server..."
timeout 300 rsync -avz --delete \
    -e "ssh -p $CENTRAL_PORT $SSH_OPTS -i $DEPLOY_KEY" \
    --exclude='.git' \
    --exclude='__pycache__' \
    --exclude='*.pyc' \
    --exclude='tests/' \
    --exclude='*.md' \
    ./llms/ ***@$CENTRAL_SERVER:/tmp/llms-staging/

echo "Step 2: Syncing from central to target..."
timeout 300 ssh -p $CENTRAL_PORT $SSH_OPTS -i $DEPLOY_KEY ***@$CENTRAL_SERVER << 'ENDSSH'
    rsync -avz --delete \
        -e "ssh $SSH_OPTS" \
        /tmp/llms-staging/ ***@192.168.1.61:~/llm-deployment/

    # Clean up
    rm -rf /tmp/llms-staging/
ENDSSH

echo "✓ Deployment complete"
