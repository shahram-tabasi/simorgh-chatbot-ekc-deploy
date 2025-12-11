# Deployment Helper Scripts

This directory contains standalone deployment and debugging scripts that can be used for manual deployments or troubleshooting.

## Scripts Overview

### `deploy-debug.sh`
**Purpose**: Comprehensive debugging script to test connectivity and identify deployment issues.

**What it does**:
1. Tests SSH connection to central server (217.219.39.212:2324)
2. Tests SSH connection from central to target server
3. Creates and transfers a small test tarball
4. Runs full deployment if all tests pass
5. Provides detailed output at each step

**When to use**:
- When GitHub Actions deployment fails
- To diagnose SSH connectivity issues
- To test the deployment path manually

**Usage**:
```bash
export SSH_USER="your_username"
export CENTRAL_SERVER="217.219.39.212"
export CENTRAL_PORT="2324"
export TARGET_SERVER="192.168.1.61"  # or 192.168.1.62
export DEPLOY_KEY="$HOME/.ssh/deploy_key"

cd llms
./scripts/deploy-debug.sh
```

### `deploy-rsync.sh`
**Purpose**: Alternative deployment using rsync instead of tar+scp.

**What it does**:
1. Uses rsync to sync files to central server
2. Uses rsync from central to target server
3. More efficient for incremental updates
4. Better progress reporting

**When to use**:
- For faster incremental deployments
- When tar+scp is too slow
- When you need better transfer progress visibility

**Usage**:
```bash
export SSH_USER="your_username"
export CENTRAL_SERVER="217.219.39.212"
export CENTRAL_PORT="2324"
export TARGET_SERVER="192.168.1.61"
export DEPLOY_KEY="$HOME/.ssh/deploy_key"

cd llms
./scripts/deploy-rsync.sh
```

### `deploy-improved.sh`
**Purpose**: Production-ready deployment script with comprehensive error handling.

**What it does**:
1. Creates optimized tarball (respects .deployignore)
2. Transfers to central server with timeout
3. Transfers from central to target with timeout
4. Extracts on target server
5. Cleans up temporary files
6. Provides status updates at each step

**When to use**:
- For manual production deployments
- When GitHub Actions is unavailable
- For testing deployment changes locally

**Usage**:
```bash
export SSH_USER="your_username"
export CENTRAL_SERVER="217.219.39.212"
export CENTRAL_PORT="2324"
export TARGET_SERVER="192.168.1.61"
export DEPLOY_KEY="$HOME/.ssh/deploy_key"

cd llms
./scripts/deploy-improved.sh
```

## Environment Variables

All scripts support the following environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `SSH_USER` | SSH username for central server | Required |
| `CENTRAL_SERVER` | Central server hostname/IP | 217.219.39.212 |
| `CENTRAL_PORT` | SSH port for central server | 2324 |
| `TARGET_SERVER` | Target LLM server IP | 192.168.1.61 |
| `DEPLOY_KEY` | Path to SSH private key | $HOME/.ssh/deploy_key |

## Prerequisites

1. SSH key configured and accessible at `$DEPLOY_KEY`
2. SSH key added to central server's authorized_keys
3. Central server can SSH to target server
4. Current directory is the `llms/` directory
5. Required commands available: `ssh`, `scp`, `tar`, `rsync` (for rsync script)

## Troubleshooting

### "Permission denied (publickey)"
- Verify SSH key is correct: `ls -l $DEPLOY_KEY`
- Test central server access: `ssh -p $CENTRAL_PORT -i $DEPLOY_KEY $SSH_USER@$CENTRAL_SERVER`

### "Connection timed out"
- Check network connectivity
- Verify firewall rules allow SSH on port 2324
- Try increasing timeout values in scripts

### "No space left on device"
- Clean up old Docker images on target: `docker system prune -af`
- Check disk space: `df -h`

## Notes

- These scripts are alternatives to GitHub Actions deployment
- GitHub Actions workflow (`.github/workflows/llm-deploy.yml`) is the primary deployment method
- Scripts use the same deployment logic as GitHub Actions
- Always test on non-production server (192.168.1.62) first
