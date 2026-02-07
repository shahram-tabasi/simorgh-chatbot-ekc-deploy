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

### 6. JWT_SECRET_KEY (JWT Token Signing Key)
**Purpose:** Secret key for signing JWT access and refresh tokens. **Critical for security.**

**How to create:**
1. Generate a secure random key:
   ```bash
   python3 -c "import secrets; print(secrets.token_hex(32))"
   ```
2. Go to your repository → Settings → Secrets and variables → Actions
3. Click "New repository secret"
4. Name: `JWT_SECRET_KEY`
5. Value: Paste the generated 64-character hex string
6. Click "Add secret"

> **Warning:** If you change this, all existing user sessions and tokens will be invalidated.

### 7. GOOGLE_CLIENT_ID (Google OAuth Client ID)
**Purpose:** Client ID for Google OAuth 2.0 login

**How to create:**
1. Go to [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
2. Create a project (or select existing one)
3. Go to **APIs & Services → Credentials**
4. Click **Create Credentials → OAuth 2.0 Client ID**
5. Application type: **Web application**
6. Name: `Simorgh AI`
7. **Authorized JavaScript origins:**
   - `https://simorghai.electrokavir.com`
8. **Authorized redirect URIs:**
   - `https://simorghai.electrokavir.com/chatbot/auth/google/callback`
9. Click **Create**
10. Copy the **Client ID** (looks like `xxxxx.apps.googleusercontent.com`)
11. Go to your repository → Settings → Secrets and variables → Actions
12. Name: `GOOGLE_CLIENT_ID`
13. Value: Paste the Client ID

### 8. GOOGLE_CLIENT_SECRET (Google OAuth Client Secret)
**Purpose:** Client secret for Google OAuth 2.0 login

**How to create:**
1. From the same Google Cloud credentials page (step 7 above)
2. Copy the **Client Secret**
3. Go to your repository → Settings → Secrets and variables → Actions
4. Name: `GOOGLE_CLIENT_SECRET`
5. Value: Paste the Client Secret

### 9. SMTP_USER (Email Sender Address)
**Purpose:** Gmail address used to send verification and password reset emails

**How to create:**
1. Go to your repository → Settings → Secrets and variables → Actions
2. Click "New repository secret"
3. Name: `SMTP_USER`
4. Value: Your Gmail address (e.g., `simorgh.ekc.ai@gmail.com`)

### 10. SMTP_PASSWORD (Gmail App Password)
**Purpose:** App-specific password for Gmail SMTP. **Not your regular Gmail password.**

**How to create:**
1. Enable 2-Factor Authentication on your Google account:
   - Go to https://myaccount.google.com/security
   - Enable **2-Step Verification**
2. Generate an App Password:
   - Go to https://myaccount.google.com/apppasswords
   - Select app: **Mail**
   - Select device: **Other** → type `Simorgh Server`
   - Click **Generate**
   - Copy the 16-character password (e.g., `abcd efgh ijkl mnop`)
3. Go to your repository → Settings → Secrets and variables → Actions
4. Name: `SMTP_PASSWORD`
5. Value: Paste the 16-character app password (without spaces)

## Optional Secrets

### MySQL / TPMS Authentication (Optional)
Only required if you use legacy TPMS username/password login.

| Secret Name | Value | Example |
|-------------|-------|---------|
| `MYSQL_HOST` | MySQL server IP or hostname | `192.168.1.148` |
| `MYSQL_PORT` | MySQL server port | `3306` |
| `MYSQL_USER` | MySQL read-only username | `technical` |
| `MYSQL_PASSWORD` | MySQL password | `your_password` |
| `MYSQL_DATABASE` | MySQL database name | `TPMS` |

### OpenAI API (Optional)
Only required if you want to use OpenAI's GPT-4 in online mode.

| Secret Name | Value | Example |
|-------------|-------|---------|
| `OPENAI_API_KEY` | Your OpenAI API key | `sk-...` |

Get it from: https://platform.openai.com/api-keys

### Hugging Face (Optional)
Only required for gated LLM models on local servers.

| Secret Name | Value | Example |
|-------------|-------|---------|
| `HF_TOKEN` | Hugging Face access token | `hf_...` |

## Verification Checklist

After adding all secrets, verify you have:

### Required (Must Have):
- ✅ GHCR_TOKEN
- ✅ SSH_PRIVATE_KEY
- ✅ SSH_USER
- ✅ NEO4J_PASSWORD
- ✅ COCOINDEX_DB_PASSWORD
- ✅ JWT_SECRET_KEY
- ✅ GOOGLE_CLIENT_ID
- ✅ GOOGLE_CLIENT_SECRET
- ✅ SMTP_USER
- ✅ SMTP_PASSWORD

### Optional (Nice to Have):
- ⬜ MYSQL_HOST
- ⬜ MYSQL_PORT
- ⬜ MYSQL_USER
- ⬜ MYSQL_PASSWORD
- ⬜ MYSQL_DATABASE
- ⬜ OPENAI_API_KEY
- ⬜ HF_TOKEN

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

4. **Test login features:**
   - Go to `https://simorghai.electrokavir.com/chatbot/signup`
   - Register a new account → should receive verification email
   - Try "Continue with Google" → should redirect to Google consent screen

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

### Email Not Sending
- Verify SMTP_USER is a valid Gmail address
- Verify SMTP_PASSWORD is an App Password (not your regular Gmail password)
- Ensure 2-Factor Authentication is enabled on the Google account
- Check backend logs: `docker logs backend --tail=50`

### Google OAuth 500 Error
- Verify GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set correctly
- Check that the redirect URI in Google Cloud Console matches exactly:
  `https://simorghai.electrokavir.com/chatbot/auth/google/callback`
- Ensure the OAuth consent screen is configured (can be in "Testing" mode)
- If in testing mode, add test users in Google Cloud Console

### Signup/Login Page 404
- The frontend Docker image needs to be rebuilt after this update
- Ensure the workflow ran successfully and built the new frontend image
- Check: `docker logs frontend --tail=20`

## Security Best Practices

1. **Rotate tokens regularly:** Update GHCR_TOKEN every 90 days
2. **Use strong passwords:** Minimum 16 characters with mixed case, numbers, symbols
3. **Limit token scope:** Only grant necessary permissions
4. **Monitor access logs:** Check GitHub Actions logs regularly
5. **Revoke compromised tokens:** If a token is exposed, revoke and regenerate immediately
6. **Never log secrets:** The workflow masks secret values in logs automatically
7. **JWT key rotation:** If JWT_SECRET_KEY is compromised, rotate immediately (invalidates all sessions)

## Next Steps

After configuring all secrets:
1. Push changes to trigger the workflow
2. Monitor the deployment in GitHub Actions
3. Verify services are accessible at https://simorghai.electrokavir.com/chatbot/
4. Test signup with email verification
5. Test Google OAuth login
6. Check API documentation at https://simorghai.electrokavir.com/chatbot/api/docs
7. Access Neo4j Browser at http://192.168.1.68:7474

---

For more information, see:
- [ARCHITECTURE_REDESIGN.md](./ARCHITECTURE_REDESIGN.md) - System architecture
- [.env.example](./simorgh-agent/.env.example) - Environment variables reference
