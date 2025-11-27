# GitHub Secrets Configuration Guide

This document lists all GitHub repository secrets required for the CI/CD workflow.

## 📋 Required Secrets

### 1. Neo4j Credentials

**`NEO4J_PASSWORD`** ⭐ **REQUIRED**
- **Description**: Password for Neo4j database
- **Usage**: Knowledge graph database authentication
- **Example**: `simorgh_secure_2024_production`
- **Security**: Use a strong, unique password (16+ characters)

---

### 2. CocoIndex Database

**`COCOINDEX_DB_PASSWORD`** ⭐ **REQUIRED**
- **Description**: PostgreSQL password for CocoIndex metadata database
- **Usage**: Document processing framework backend
- **Example**: `cocoindex_prod_2024`
- **Security**: Use a strong password

---

### 3. SQL Server Authentication (Optional)

**`SQL_SERVER_HOST`** (Optional)
- **Description**: SQL Server hostname or IP address
- **Usage**: External user authentication and authorization
- **Example**: `192.168.1.100` or `sqlserver.company.com`
- **Note**: If not set, SQL authentication will be disabled

**`SQL_SERVER_PORT`** (Optional)
- **Description**: SQL Server port
- **Default**: `1433`
- **Example**: `1433`

**`SQL_SERVER_USER`** (Optional)
- **Description**: SQL Server read-only username
- **Usage**: User authentication queries
- **Example**: `simorgh_readonly`
- **Security**: Use a read-only account with minimal permissions

**`SQL_SERVER_PASSWORD`** (Optional)
- **Description**: SQL Server user password
- **Example**: `ReadOnly@2024`
- **Security**: Strong password for read-only account

**`SQL_SERVER_DATABASE`** (Optional)
- **Description**: Database name containing user/project tables
- **Example**: `ProjectManagement`

---

### 4. OpenAI API (Optional)

**`OPENAI_API_KEY`** (Optional)
- **Description**: OpenAI API key for online LLM mode
- **Usage**: GPT-4o access for entity extraction and chat
- **Example**: `sk-proj-abc123...`
- **Note**: If not set, system will only work in offline mode (local LLMs)
- **Security**: Keep this highly confidential, rotate regularly
- **Cost**: Monitor usage to avoid unexpected charges

---

## 🔧 How to Set GitHub Secrets

### Via GitHub Web Interface

1. Go to your repository on GitHub
2. Click **Settings** > **Secrets and variables** > **Actions**
3. Click **New repository secret**
4. Enter the secret name and value
5. Click **Add secret**

### Via GitHub CLI

```bash
# Install GitHub CLI
# macOS: brew install gh
# Linux: See https://cli.github.com/

# Authenticate
gh auth login

# Set secrets
gh secret set NEO4J_PASSWORD --body "your_secure_password"
gh secret set COCOINDEX_DB_PASSWORD --body "your_cocoindex_password"

# Optional: SQL Server
gh secret set SQL_SERVER_HOST --body "192.168.1.100"
gh secret set SQL_SERVER_PORT --body "1433"
gh secret set SQL_SERVER_USER --body "readonly_user"
gh secret set SQL_SERVER_PASSWORD --body "readonly_password"
gh secret set SQL_SERVER_DATABASE --body "ProjectManagement"

# Optional: OpenAI
gh secret set OPENAI_API_KEY --body "sk-proj-your-key-here"
```

---

## ✅ Verification Checklist

After setting secrets, verify them:

```bash
# List all secrets (values are hidden)
gh secret list

# Expected output:
# NEO4J_PASSWORD              Updated YYYY-MM-DD
# COCOINDEX_DB_PASSWORD       Updated YYYY-MM-DD
# SQL_SERVER_HOST             Updated YYYY-MM-DD (optional)
# SQL_SERVER_PORT             Updated YYYY-MM-DD (optional)
# SQL_SERVER_USER             Updated YYYY-MM-DD (optional)
# SQL_SERVER_PASSWORD         Updated YYYY-MM-DD (optional)
# SQL_SERVER_DATABASE         Updated YYYY-MM-DD (optional)
# OPENAI_API_KEY              Updated YYYY-MM-DD (optional)
```

---

## 🔐 Security Best Practices

### 1. Password Strength

**Required Secrets:**
```
NEO4J_PASSWORD:           16+ characters, mixed case, numbers, symbols
COCOINDEX_DB_PASSWORD:    16+ characters, mixed case, numbers, symbols
```

**Example Strong Passwords:**
```
NEO4J_PASSWORD:           S!morgh@Neo4j#2024$Pr0d
COCOINDEX_DB_PASSWORD:    C0co!ndex#Db@2024$Secure
SQL_SERVER_PASSWORD:      ReadOnly@S!morgh#2024
```

### 2. SQL Server Security

- **Use READ-ONLY account**: Never use admin credentials
- **Minimal permissions**: Only SELECT on required tables
- **Network restrictions**: Limit access to specific IP ranges
- **Connection encryption**: Use TLS/SSL for SQL Server connections

**Example SQL Server Setup:**

```sql
-- Create read-only user
CREATE LOGIN simorgh_readonly WITH PASSWORD = 'StrongPassword@2024';
USE ProjectManagement;
CREATE USER simorgh_readonly FOR LOGIN simorgh_readonly;

-- Grant minimal permissions
GRANT SELECT ON Users TO simorgh_readonly;
GRANT SELECT ON UserProjectAccess TO simorgh_readonly;
GRANT SELECT ON Projects TO simorgh_readonly;

-- Verify permissions
EXEC sp_helprotect @username = 'simorgh_readonly';
```

### 3. OpenAI API Security

- **Usage limits**: Set monthly spending limits in OpenAI dashboard
- **Key rotation**: Rotate API keys every 90 days
- **Monitor usage**: Enable usage alerts
- **Rate limiting**: Configure appropriate rate limits

**OpenAI Dashboard:**
- https://platform.openai.com/account/billing/limits
- Set spending limit (e.g., $100/month)
- Enable email alerts at 75% and 90%

### 4. Secret Rotation Schedule

| Secret | Rotation Frequency | Method |
|--------|-------------------|---------|
| `NEO4J_PASSWORD` | Every 90 days | Manual rotation |
| `COCOINDEX_DB_PASSWORD` | Every 90 days | Manual rotation |
| `SQL_SERVER_PASSWORD` | Every 90 days | Coordinate with IT |
| `OPENAI_API_KEY` | Every 90 days | Generate new in OpenAI dashboard |

### 5. Audit Log

Keep a record of secret changes:

```markdown
## Secret Change Log

| Date | Secret | Action | Changed By |
|------|--------|--------|------------|
| 2024-01-15 | NEO4J_PASSWORD | Created | admin@company.com |
| 2024-01-15 | OPENAI_API_KEY | Created | admin@company.com |
| 2024-04-15 | NEO4J_PASSWORD | Rotated | admin@company.com |
```

---

## 🚨 Troubleshooting

### Workflow Fails with "Secret not found"

**Symptom:**
```
Error: Environment variable NEO4J_PASSWORD is not set
```

**Solution:**
1. Verify secret is set: `gh secret list`
2. Check secret name matches exactly (case-sensitive)
3. Re-add the secret if needed

### SQL Server Connection Fails

**Symptom:**
```
INFO: SQL Server auth not configured (optional)
```

**Solution:**
- If you need SQL auth, ensure all 5 SQL secrets are set:
  - `SQL_SERVER_HOST`
  - `SQL_SERVER_PORT`
  - `SQL_SERVER_USER`
  - `SQL_SERVER_PASSWORD`
  - `SQL_SERVER_DATABASE`

### OpenAI API Errors

**Symptom:**
```
INFO: OpenAI not configured, will use offline mode only
```

**Solution:**
- If you need online LLM mode, set `OPENAI_API_KEY`
- Verify API key is valid: https://platform.openai.com/api-keys
- Check billing account has available credits

---

## 📊 Deployment Modes

Based on which secrets are set, the system operates in different modes:

### Mode 1: Full Featured (Recommended)

**Secrets Required:**
- ✅ NEO4J_PASSWORD
- ✅ COCOINDEX_DB_PASSWORD
- ✅ OPENAI_API_KEY
- ✅ All SQL_SERVER_* secrets

**Features:**
- ✅ Knowledge graph with Neo4j
- ✅ Document processing with CocoIndex
- ✅ Hybrid LLM (OpenAI + Local)
- ✅ SQL Server user authentication

### Mode 2: Open Access (No SQL Auth)

**Secrets Required:**
- ✅ NEO4J_PASSWORD
- ✅ COCOINDEX_DB_PASSWORD
- ✅ OPENAI_API_KEY
- ❌ SQL_SERVER_* secrets

**Features:**
- ✅ Knowledge graph with Neo4j
- ✅ Document processing with CocoIndex
- ✅ Hybrid LLM (OpenAI + Local)
- ❌ No user authentication (open access)

### Mode 3: Offline Only

**Secrets Required:**
- ✅ NEO4J_PASSWORD
- ✅ COCOINDEX_DB_PASSWORD
- ❌ OPENAI_API_KEY
- ❌ SQL_SERVER_* secrets

**Features:**
- ✅ Knowledge graph with Neo4j
- ✅ Document processing with CocoIndex
- ✅ Local LLM only (no OpenAI)
- ❌ No user authentication (open access)

---

## 📝 Environment Variable Reference

The workflow creates a `.env` file on the deployment server with these values:

```bash
# From GitHub Secrets
NEO4J_PASSWORD=${{ secrets.NEO4J_PASSWORD }}
COCOINDEX_DB_PASSWORD=${{ secrets.COCOINDEX_DB_PASSWORD }}
SQL_SERVER_HOST=${{ secrets.SQL_SERVER_HOST }}
SQL_SERVER_PORT=${{ secrets.SQL_SERVER_PORT }}
SQL_SERVER_USER=${{ secrets.SQL_SERVER_USER }}
SQL_SERVER_PASSWORD=${{ secrets.SQL_SERVER_PASSWORD }}
SQL_SERVER_DATABASE=${{ secrets.SQL_SERVER_DATABASE }}
OPENAI_API_KEY=${{ secrets.OPENAI_API_KEY }}

# Hardcoded in Workflow
DEFAULT_LLM_MODE=online
LOCAL_LLM_URL_1=http://192.168.1.61/ai
LOCAL_LLM_URL_2=http://192.168.1.62/ai
```

---

## 🔗 Related Documentation

- [Architecture Redesign Guide](./ARCHITECTURE_REDESIGN.md)
- [Environment Variables](./simorgh-agent/.env.example)
- [Deployment Guide](./ARCHITECTURE_REDESIGN.md#-deployment)
- [GitHub Secrets Documentation](https://docs.github.com/en/actions/security-guides/encrypted-secrets)

---

**Last Updated:** 2024-01-15
**Maintained By:** Simorgh Engineering Team
