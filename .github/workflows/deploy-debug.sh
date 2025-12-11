#!/bin/bash
# Debug deployment script to identify where hanging occurs

set -ex  # Exit on error, print all commands

CENTRAL_SERVER="217.219.39.212"
CENTRAL_PORT="2324"
TARGET_SERVER="192.168.1.61"
DEPLOY_KEY="$HOME/.ssh/deploy_key"

echo "========================================="
echo "DEBUG: Starting deployment at $(date)"
echo "========================================="

# Test 1: Can we reach central server?
echo "TEST 1: Testing connection to central server..."
timeout 30 ssh -p $CENTRAL_PORT -i $DEPLOY_KEY -o ConnectTimeout=10 \
    ***@$CENTRAL_SERVER "echo 'Central server reachable'" || {
    echo "ERROR: Cannot reach central server"
    exit 1
}

# Test 2: Can central reach target?
echo "TEST 2: Testing connection from central to target..."
timeout 30 ssh -p $CENTRAL_PORT -i $DEPLOY_KEY ***@$CENTRAL_SERVER \
    "timeout 20 ssh -o ConnectTimeout=10 ***@$TARGET_SERVER 'echo Target reachable'" || {
    echo "ERROR: Central cannot reach target"
    exit 1
}

# Test 3: Create small test tarball
echo "TEST 3: Creating small test tarball..."
echo "test" > /tmp/test.txt
tar -czf /tmp/test.tar.gz -C /tmp test.txt
echo "Tarball size: $(du -h /tmp/test.tar.gz | cut -f1)"

# Test 4: SCP to central
echo "TEST 4: Testing SCP to central..."
timeout 60 scp -P $CENTRAL_PORT -i $DEPLOY_KEY /tmp/test.tar.gz \
    ***@$CENTRAL_SERVER:/tmp/ || {
    echo "ERROR: Cannot SCP to central"
    exit 1
}

# Test 5: SCP from central to target
echo "TEST 5: Testing SCP from central to target..."
timeout 120 ssh -p $CENTRAL_PORT -i $DEPLOY_KEY ***@$CENTRAL_SERVER \
    "timeout 60 scp /tmp/test.tar.gz ***@$TARGET_SERVER:/tmp/" || {
    echo "ERROR: Cannot SCP from central to target"
    exit 1
}

# Test 6: Cleanup
echo "TEST 6: Cleaning up test files..."
ssh -p $CENTRAL_PORT -i $DEPLOY_KEY ***@$CENTRAL_SERVER "rm /tmp/test.tar.gz" || true
ssh -p $CENTRAL_PORT -i $DEPLOY_KEY ***@$CENTRAL_SERVER \
    "ssh ***@$TARGET_SERVER 'rm /tmp/test.tar.gz'" || true
rm /tmp/test.tar.gz /tmp/test.txt

echo "========================================="
echo "SUCCESS: All connectivity tests passed!"
echo "========================================="

# Now try actual deployment
echo "Creating actual deployment tarball..."
tar -czf /tmp/llms-deploy.tar.gz -C ./llms \
    --exclude='__pycache__' \
    --exclude='*.pyc' \
    --exclude='.git' \
    --exclude='tests' \
    .

TARBALL_SIZE=$(du -h /tmp/llms-deploy.tar.gz | cut -f1)
echo "Deployment tarball size: $TARBALL_SIZE"

echo "Copying to central server..."
timeout 180 scp -P $CENTRAL_PORT -i $DEPLOY_KEY \
    -o ConnectTimeout=30 -o ServerAliveInterval=60 \
    /tmp/llms-deploy.tar.gz ***@$CENTRAL_SERVER:/tmp/ || {
    echo "ERROR: Failed to copy to central"
    rm /tmp/llms-deploy.tar.gz
    exit 1
}

echo "Copying from central to target..."
timeout 300 ssh -p $CENTRAL_PORT -i $DEPLOY_KEY ***@$CENTRAL_SERVER << 'ENDSSH'
set -ex
timeout 240 scp -o ConnectTimeout=30 -o ServerAliveInterval=60 \
    /tmp/llms-deploy.tar.gz ***@192.168.1.61:/tmp/
echo "Copy to target complete"

timeout 60 ssh -o ConnectTimeout=30 \
    ***@192.168.1.61 'cd ~/llm-deployment && tar -xzf /tmp/llms-deploy.tar.gz && rm /tmp/llms-deploy.tar.gz'
echo "Extraction complete"

rm /tmp/llms-deploy.tar.gz
echo "Cleanup complete"
ENDSSH

rm /tmp/llms-deploy.tar.gz

echo "========================================="
echo "DEPLOYMENT COMPLETE at $(date)"
echo "========================================="
