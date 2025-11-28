# GitHub Secrets Setup Guide

This guide explains how to configure all required GitHub secrets for the Simorgh deployment workflow.

## Required Secrets

### 1. GHCR_TOKEN (GitHub Container Registry Token)
**Purpose:** Authenticates GitHub Actions to push Docker images to GitHub Container Registry

**How to create:**
1. Go to GitHub Settings → Developer settings → Personal access tokens → Tokens (classic)
2. Click "Generate new token (classic)"
3. Give it a descriptive name: `Simorgh GHCR Deploy Token`
4. Set expiration (recommended: 90 days or No expiration for production)
5. Select these scopes:
   - ✅ `write:packages` - Upload packages to GitHub Package Registry
   - ✅ `read:packages` - Download packages from GitHub Package Registry
   - ✅ `delete:packages` - Delete packages from GitHub Package Registry (optional)
   - ✅ `repo` - Full control of private repositories (if your repo is private)
6. Click "Generate token"
7. **Copy the token immediately** (you won't see it again!)
8. Go to your repository → Settings → Secrets and variables → Actions
9. Click "New repository secret"
10. Name: `GHCR_TOKEN`
11. Value: Paste the token you copied
12. Click "Add secret"

### 2. SSH_PRIVATE_KEY (SSH Key for Server Access)
**Purpose:** Allows GitHub Actions to deploy to your server at 217.219.39.212:2324

**How to create:**
1. On your local server (192.168.1.68), generate an SSH key pair:
   ```bash
   ssh-keygen -t ed25519 -C "github-actions-deploy" -f ~/.ssh/github_deploy_key
   ```
   When prompted for a passphrase, press Enter (no passphrase)

2. Copy the public key to the server's authorized_keys:
   ```bash
   cat ~/.ssh/github_deploy_key.pub >> ~/.ssh/authorized_keys
   ```

3. Test the SSH connection:
   ```bash
   ssh -i ~/.ssh/github_deploy_key -p 2324 ubuntu@217.219.39.212
   ```

4. Copy the **private key** content:
   ```bash
   cat ~/.ssh/github_deploy_key
   ```

5. Go to your repository → Settings → Secrets and variables → Actions
6. Click "New repository secret"
7. Name: `SSH_PRIVATE_KEY`
8. Value: Paste the entire private key (including `-----BEGIN OPENSSH PRIVATE KEY-----` and `-----END OPENSSH PRIVATE KEY-----`)
9. Click "Add secret"

### 3. SSH_USER (SSH Username)
**Purpose:** Username to connect to the deployment server

**How to create:**
1. Go to your repository → Settings → Secrets and variables → Actions
2. Click "New repository secret"
3. Name: `SSH_USER`
4. Value: `ubuntu` (or your server username)
5. Click "Add secret"

### 4. NEO4J_PASSWORD (Neo4j Database Password)
**Purpose:** Password for Neo4j database

**How to create:**
1. Choose a strong password (e.g., `YourSecureNeo4jPassword123!`)
2. Go to your repository → Settings → Secrets and variables → Actions
3. Click "New repository secret"
4. Name: `NEO4J_PASSWORD`
5. Value: Your chosen password
6. Click "Add secret"

### 5. COCOINDEX_DB_PASSWORD (CocoIndex Database Password)
**Purpose:** Password for CocoIndex PostgreSQL database

**How to create:**
1. Choose a strong password (e.g., `YourSecureCocoIndexPassword123!`)
2. Go to your repository → Settings → Secrets and variables → Actions
3. Click "New repository secret"
4. Name: `COCOINDEX_DB_PASSWORD`
5. Value: Your chosen password
6. Click "Add secret"

## Optional Secrets

### SQL Server Authentication (Optional)
Only required if you want to use external SQL Server authentication.

**SQL_SERVER_HOST:**
- Name: `SQL_SERVER_HOST`
- Value: Your SQL Server hostname/IP

**SQL_SERVER_PORT:**
- Name: `SQL_SERVER_PORT`
- Value: `1433` (or your SQL Server port)

**SQL_SERVER_USER:**
- Name: `SQL_SERVER_USER`
- Value: Your SQL Server username

**SQL_SERVER_PASSWORD:**
- Name: `SQL_SERVER_PASSWORD`
- Value: Your SQL Server password

**SQL_SERVER_DATABASE:**
- Name: `SQL_SERVER_DATABASE`
- Value: Your database name

### OpenAI API (Optional)
Only required if you want to use OpenAI's GPT-4 in online mode.

**OPENAI_API_KEY:**
- Name: `OPENAI_API_KEY`
- Value: Your OpenAI API key (starts with `sk-`)
- Get it from: https://platform.openai.com/api-keys

## Verification Checklist

After adding all secrets, verify you have:

### Required (Must Have):
- ✅ GHCR_TOKEN
- ✅ SSH_PRIVATE_KEY
- ✅ SSH_USER
- ✅ NEO4J_PASSWORD
- ✅ COCOINDEX_DB_PASSWORD

### Optional (Nice to Have):
- ⬜ SQL_SERVER_HOST
- ⬜ SQL_SERVER_PORT
- ⬜ SQL_SERVER_USER
- ⬜ SQL_SERVER_PASSWORD
- ⬜ SQL_SERVER_DATABASE
- ⬜ OPENAI_API_KEY

## Testing the Setup

Once all required secrets are configured:

1. **Trigger the workflow:**
   ```bash
   git push origin main
   ```

2. **Monitor the workflow:**
   - Go to your repository → Actions
   - Click on the running workflow
   - Watch the build and deployment progress

3. **Check for errors:**
   - Build job should successfully push images to GHCR
   - Deploy job should successfully connect via SSH
   - Health check should verify all services are running

## Troubleshooting

### GHCR 403 Forbidden
- Ensure GHCR_TOKEN has `write:packages` scope
- Verify the token hasn't expired
- Check repository visibility settings

### SSH Connection Failed
- Verify SSH_PRIVATE_KEY is correct (including header/footer)
- Ensure the public key is in `~/.ssh/authorized_keys` on the server
- Check firewall allows connections on port 2324
- Verify SSH_USER matches the server username

### Neo4j/CocoIndex Connection Failed
- Verify passwords are correct
- Check that secrets don't have extra spaces or newlines
- Ensure passwords meet complexity requirements

## Security Best Practices

1. **Rotate tokens regularly:** Update GHCR_TOKEN every 90 days
2. **Use strong passwords:** Minimum 16 characters with mixed case, numbers, symbols
3. **Limit token scope:** Only grant necessary permissions
4. **Monitor access logs:** Check GitHub Actions logs regularly
5. **Revoke compromised tokens:** If a token is exposed, revoke and regenerate immediately

## Next Steps

After configuring all secrets:
1. Push changes to trigger the workflow
2. Monitor the deployment in GitHub Actions
3. Verify services are accessible at http://192.168.1.68
4. Check API documentation at http://192.168.1.68/api/docs
5. Access Neo4j Browser at http://192.168.1.68:7474

---

For more information, see:
- [ARCHITECTURE_REDESIGN.md](./ARCHITECTURE_REDESIGN.md) - System architecture
- [.env.example](./simorgh-agent/.env.example) - Environment variables reference
