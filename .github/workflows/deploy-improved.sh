#!/bin/bash
# Improved deployment script with timeout handling and error recovery

set -e

# Configuration
CENTRAL_SERVER="217.219.39.212"
CENTRAL_PORT="2324"
TARGET_SERVER="192.168.1.61"
DEPLOY_KEY="$HOME/.ssh/deploy_key"
SSH_OPTS="-o ConnectTimeout=30 -o ServerAliveInterval=60 -o ServerAliveCountMax=3 -o StrictHostKeyChecking=no"

echo "=== Starting Deployment ==="

# Step 1: Create tarball (exclude unnecessary files)
echo "Creating tarball..."
if [ -f "./llms/.deployignore" ]; then
    tar -czf /tmp/llms-deploy.tar.gz -C ./llms \
        --exclude-from=./llms/.deployignore \
        .
else
    tar -czf /tmp/llms-deploy.tar.gz -C ./llms .
fi

TARBALL_SIZE=$(du -h /tmp/llms-deploy.tar.gz | cut -f1)
echo "✓ Tarball created: $TARBALL_SIZE"

# Step 2: Copy to central server
echo "Copying to central server..."
if timeout 120 scp -P $CENTRAL_PORT $SSH_OPTS -i $DEPLOY_KEY \
    /tmp/llms-deploy.tar.gz ***@$CENTRAL_SERVER:/tmp/; then
    echo "✓ Copied to central server"
else
    echo "✗ Failed to copy to central server"
    rm /tmp/llms-deploy.tar.gz
    exit 1
fi

# Step 3: Deploy to target server via central
echo "Deploying to target server..."
if timeout 300 ssh -p $CENTRAL_PORT $SSH_OPTS -i $DEPLOY_KEY ***@$CENTRAL_SERVER << 'ENDSSH'
set -e

echo "  → Copying to target server..."
if timeout 180 scp -o ConnectTimeout=30 -o ServerAliveInterval=60 \
    /tmp/llms-deploy.tar.gz ***@192.168.1.61:/tmp/; then
    echo "  ✓ Copied to target"
else
    echo "  ✗ Failed to copy to target"
    rm /tmp/llms-deploy.tar.gz
    exit 1
fi

echo "  → Extracting on target server..."
if timeout 60 ssh -o ConnectTimeout=30 -o ServerAliveInterval=60 \
    ***@192.168.1.61 'cd ~/llm-deployment && tar -xzf /tmp/llms-deploy.tar.gz && rm /tmp/llms-deploy.tar.gz'; then
    echo "  ✓ Extracted on target"
else
    echo "  ✗ Failed to extract on target"
    exit 1
fi

# Clean up central server
rm /tmp/llms-deploy.tar.gz
echo "  ✓ Cleaned up central server"
ENDSSH
then
    echo "✓ Deployment successful"
else
    echo "✗ Deployment failed"
    rm /tmp/llms-deploy.tar.gz
    exit 1
fi

# Clean up local
rm /tmp/llms-deploy.tar.gz
echo "✓ Cleaned up local files"

echo "=== Deployment Complete ==="
