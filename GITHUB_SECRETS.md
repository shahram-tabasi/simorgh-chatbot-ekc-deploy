# GitHub Secrets Configuration

This document lists all GitHub secrets required for the Simorgh Industrial Electrical Assistant deployment workflows.

## Required Secrets

### 1. GitHub Container Registry (GHCR)

#### `GHCR_TOKEN`
- **Type:** Personal Access Token (classic)
- **Required Scopes:** `write:packages`, `read:packages`, `delete:packages`
- **Purpose:** Authentication for pushing/pulling Docker images to/from GitHub Container Registry
- **How to create:**
  1. Go to GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic)
  2. Click "Generate new token (classic)"
  3. Select scopes: `write:packages`, `read:packages`, `delete:packages`
  4. Copy the generated token
  5. Add to repository secrets as `GHCR_TOKEN`

---

### 2. SSH Deployment

#### `SSH_PRIVATE_KEY`
- **Type:** SSH Private Key (RSA or Ed25519)
- **Purpose:** SSH authentication for deploying to remote server (217.219.39.212:2324)
- **How to create:**
  ```bash
  # Generate SSH key pair
  ssh-keygen -t ed25519 -C "github-actions-deploy" -f ~/.ssh/simorgh_deploy_key -N ""

  # Copy public key to remote server
  ssh-copy-id -p 2324 -i ~/.ssh/simorgh_deploy_key.pub user@217.219.39.212

  # Copy private key content for GitHub secret
  cat ~/.ssh/simorgh_deploy_key
  ```
- **Add to GitHub:**
  - Copy the **entire private key** (including `-----BEGIN` and `-----END` lines)
  - Add as repository secret named `SSH_PRIVATE_KEY`

#### `SSH_USER`
- **Value:** The SSH username for the deployment server
- **Example:** `ubuntu` or your specific username
- **Purpose:** Username for SSH connection to 217.219.39.212

---

### 3. Database Credentials

#### `NEO4J_PASSWORD`
- **Type:** String
- **Purpose:** Password for Neo4j graph database
- **Recommendation:** Use a strong password (minimum 12 characters, mixed case, numbers, symbols)
- **Example:** `simorgh_secure_2024` (change this!)

#### `COCOINDEX_DB_PASSWORD`
- **Type:** String
- **Purpose:** Password for CocoIndex PostgreSQL database
- **Recommendation:** Use a strong password
- **Example:** `cocoindex_2024` (change this!)

---

### 4. MySQL Authentication (Optional but Recommended)

These secrets are for connecting to your external MySQL database at **192.168.1.148:3306** for user authentication and project access control.

#### `MYSQL_HOST`
- **Value:** `192.168.1.148`
- **Purpose:** MySQL server hostname/IP

#### `MYSQL_PORT`
- **Value:** `3306`
- **Purpose:** MySQL server port

#### `MYSQL_USER`
- **Value:** `technical`
- **Purpose:** MySQL username for read-only access

#### `MYSQL_PASSWORD`
- **Value:** `HoJETA`
- **Purpose:** MySQL password for authentication

#### `MYSQL_DATABASE`
- **Value:** Your database name (e.g., `projects`, `engineering`, etc.)
- **Purpose:** Database containing user/project tables

**Note:** If these are not configured, the application will run without MySQL authentication (all users allowed).

---

### 5. OpenAI API (Optional but Recommended)

#### `OPENAI_API_KEY`
- **Type:** OpenAI API Key
- **Purpose:** Enable online LLM mode using OpenAI GPT models
- **How to get:**
  1. Go to https://platform.openai.com/api-keys
  2. Create a new API key
  3. Copy the key (starts with `sk-`)
- **Format:** `sk-proj-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`

**Note:** If not configured, the system will use only local LLM servers (offline mode). With the key configured and `DEFAULT_LLM_MODE=auto`, it will try OpenAI first and fall back to local LLMs if unavailable.

---

## Quick Setup Checklist

Use this checklist to ensure all secrets are properly configured:

### Critical Secrets (Required)
- [ ] `GHCR_TOKEN` - GitHub Container Registry authentication
- [ ] `SSH_PRIVATE_KEY` - SSH deployment key
- [ ] `SSH_USER` - SSH username
- [ ] `NEO4J_PASSWORD` - Neo4j database password
- [ ] `COCOINDEX_DB_PASSWORD` - CocoIndex PostgreSQL password

### Optional Secrets (Recommended)
- [ ] `MYSQL_HOST` - MySQL server address
- [ ] `MYSQL_PORT` - MySQL server port
- [ ] `MYSQL_USER` - MySQL username
- [ ] `MYSQL_PASSWORD` - MySQL password
- [ ] `MYSQL_DATABASE` - MySQL database name
- [ ] `OPENAI_API_KEY` - OpenAI API key for GPT models

---

## Adding Secrets to GitHub

1. Go to your repository on GitHub
2. Click **Settings** → **Secrets and variables** → **Actions**
3. Click **New repository secret**
4. Enter the secret name exactly as shown above (case-sensitive)
5. Paste the secret value
6. Click **Add secret**
7. Repeat for all secrets

---

## Verifying Secrets

After adding secrets, you can verify they're recognized by the workflow:

1. Go to **Actions** tab
2. Trigger a workflow run
3. Check the deployment logs for verification messages like:
   ```
   NEO4J_PASSWORD: [SET]
   COCOINDEX_DB_PASSWORD: [SET]
   MYSQL_HOST: [SET]
   OPENAI_API_KEY: [SET]
   ```

---

## Security Best Practices

1. **Never commit secrets to the repository**
   - Secrets should only be in GitHub Secrets
   - `.env` files are gitignored

2. **Use strong passwords**
   - Minimum 12 characters
   - Mix of uppercase, lowercase, numbers, symbols

3. **Rotate secrets regularly**
   - Change database passwords every 90 days
   - Regenerate API keys annually

4. **Limit secret access**
   - Only use read-only MySQL credentials
   - Use principle of least privilege

5. **Monitor secret usage**
   - Review workflow logs for unauthorized access
   - Check GitHub audit logs regularly

---

## Troubleshooting

### Secret not recognized
- Verify the secret name matches exactly (case-sensitive)
- Check for extra spaces in secret value
- Re-add the secret if needed

### SSH connection failed
- Verify public key is in `~/.ssh/authorized_keys` on remote server
- Check SSH key has correct permissions (600)
- Test SSH connection manually: `ssh -p 2324 -i ~/.ssh/deploy_key user@217.219.39.212`

### Database connection failed
- Verify credentials are correct
- Check database server is accessible from Docker containers
- Confirm database exists and user has proper permissions

### GHCR push failed
- Verify GHCR_TOKEN has `write:packages` scope
- Check token hasn't expired
- Ensure repository owner name is lowercase in workflow

---

## Current Configuration Summary

Based on your provided information:

| Secret | Value | Status |
|--------|-------|--------|
| `MYSQL_HOST` | `192.168.1.148` | ✅ Provided |
| `MYSQL_PORT` | `3306` | ✅ Provided |
| `MYSQL_USER` | `technical` | ✅ Provided |
| `MYSQL_PASSWORD` | `HoJETA` | ✅ Provided |
| `MYSQL_DATABASE` | *To be determined* | ⚠️ Needed |
| `OPENAI_API_KEY` | *Your API key* | ⚠️ Needed |
| `NEO4J_PASSWORD` | *Your choice* | ⚠️ Needed |
| `COCOINDEX_DB_PASSWORD` | *Your choice* | ⚠️ Needed |
| `SSH_PRIVATE_KEY` | *Your SSH key* | ⚠️ Needed |
| `SSH_USER` | *Your SSH username* | ⚠️ Needed |
| `GHCR_TOKEN` | *Your GitHub PAT* | ⚠️ Needed |

---

## Need Help?

If you encounter issues with secrets configuration:

1. Check workflow logs in the Actions tab
2. Review the deployment step outputs
3. Verify secrets are correctly named
4. Test database connections manually from the deployment server

For security concerns, never share secret values in issues or pull requests.
