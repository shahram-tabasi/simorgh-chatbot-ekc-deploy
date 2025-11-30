# MySQL Authentication Setup Guide
## How to Configure Your HeidiSQL Credentials

---

## 🎯 **The Problem**

You can access TPMS database via HeidiSQL, but the application can't authenticate users because:
1. MySQL credentials are not configured in docker-compose environment
2. The application doesn't know your HeidiSQL login details

---

## ✅ **Solution: 3 Simple Steps**

### **Step 1: Get Your HeidiSQL Connection Details**

Open HeidiSQL and check your **Session Manager** settings:

```
📋 Your HeidiSQL Settings:

   Hostname/IP:  _________________ (e.g., 192.168.1.148)
   User:         _________________ (e.g., tpms_readonly or your_username)
   Password:     _________________ (your database password)
   Port:         _________________ (usually 3306)
   Database:     _________________ (usually TPMS)
```

**IMPORTANT:** Write these down! You'll need them in Step 2.

---

### **Step 2: Create .env File with Your Credentials**

**Navigate to the simorgh-agent directory:**
```bash
cd /home/user/simorgh-chatbot-ekc-deploy/simorgh-agent
```

**Copy the example file:**
```bash
cp .env.example .env
```

**Edit the .env file:**
```bash
nano .env
# Or use your preferred editor: vim .env, code .env, etc.
```

**Find the MySQL section (around line 55) and fill in YOUR HeidiSQL credentials:**

```bash
# -----------------------------------------------------------------------------
# MYSQL - EXTERNAL AUTHENTICATION (READ-ONLY)
# -----------------------------------------------------------------------------
MYSQL_HOST=192.168.1.148              # ← Your HeidiSQL hostname
MYSQL_PORT=3306                        # ← Your HeidiSQL port
MYSQL_USER=your_heidisql_username     # ← Your HeidiSQL username
MYSQL_PASSWORD=your_heidisql_password # ← Your HeidiSQL password
MYSQL_DATABASE=TPMS                    # ← Your HeidiSQL database
```

**Example (replace with YOUR actual values):**
```bash
MYSQL_HOST=192.168.1.148
MYSQL_PORT=3306
MYSQL_USER=tpms_readonly
MYSQL_PASSWORD=SecurePass123
MYSQL_DATABASE=TPMS
```

**Also set a secure JWT secret key (around line 147):**
```bash
# Generate a random key:
JWT_SECRET_KEY=your-very-secure-random-key-here-min-32-characters

# Or generate one automatically:
# openssl rand -hex 32
```

**Save and exit:**
- Nano: `Ctrl + X`, then `Y`, then `Enter`
- Vim: `:wq` then `Enter`

---

### **Step 3: Restart the Application**

```bash
# Navigate to simorgh-agent directory (if not already there)
cd /home/user/simorgh-chatbot-ekc-deploy/simorgh-agent

# Restart backend container to load new environment variables
docker-compose restart backend

# Check if backend started successfully
docker-compose logs -f backend | grep -i "mysql\|auth"
```

**Look for:**
```
✅ TPMS Auth Service initialized: 192.168.1.148:3306/TPMS
```

**NOT:**
```
❌ TPMS MySQL credentials not fully configured
```

---

## 🧪 **Step 4: Test Authentication**

### **Test 1: Verify Configuration**

```bash
docker-compose exec backend python3 check_mysql_config.py
```

**Should show:**
```
📋 Connection Parameters:
   Host:     192.168.1.148
   Port:     3306
   Database: TPMS
   User:     your_heidisql_username
   Password: ******
   Enabled:  True

✅ Database connection successful
✅ Can read technical_user table:
      Total users: 50
```

### **Test 2: Test Login Flow**

```bash
docker-compose exec backend python3 debug_login_flow.py m.soltani <password>
```

**Should pass all steps:**
```
✅ STEP 1: Initialize TPMS Auth Service
✅ STEP 2: Test Database Connection
✅ STEP 3: Query User from Database
✅ STEP 4: Detect Hash Type
✅ STEP 5: Hash the Provided Password
✅ STEP 6: Compare Hashes
✅ STEP 7: Create JWT Token
✅ STEP 8: Full Authentication Test

✅ ALL TESTS PASSED - LOGIN SHOULD WORK
```

### **Test 3: Try Login from Browser**

1. Open http://localhost
2. Enter username: `m.soltani`
3. Enter password: `<your_password>`
4. Click Login
5. Should redirect to main app! 🎉

---

## ❓ **Troubleshooting**

### **Issue 1: "TPMS MySQL credentials not fully configured"**

**Cause:** .env file not created or credentials missing

**Fix:**
```bash
# Check if .env exists
ls -la .env

# If not, copy from example
cp .env.example .env

# Edit and fill in credentials
nano .env

# Restart
docker-compose restart backend
```

---

### **Issue 2: "Connection timeout" or "Can't connect"**

**Cause:** Wrong hostname or MySQL server not accessible from Docker

**Fix:**
```bash
# Test connection from Docker container
docker-compose exec backend ping -c 3 192.168.1.148

# Test MySQL port
docker-compose exec backend nc -zv 192.168.1.148 3306

# If these fail, check:
# 1. MySQL server is running
# 2. Firewall allows connections from Docker network
# 3. MySQL bind-address allows external connections
```

---

### **Issue 3: "Access denied for user"**

**Cause:** Wrong username or password

**Fix:**
```bash
# Test credentials directly
mysql -h 192.168.1.148 -u your_username -p

# If this fails, your credentials are wrong
# If this works, check .env has exact same credentials
```

---

### **Issue 4: "SELECT command denied"** (Your current issue)

**Cause:** User has permission to connect but not to SELECT from technical_user

**Fix Option 1 - Grant permissions (if you have admin access):**
```sql
-- Connect as admin
mysql -u root -p -h 192.168.1.148

-- Grant SELECT permission
GRANT SELECT ON TPMS.technical_user TO 'your_username'@'%';
GRANT SELECT ON TPMS.permission TO 'your_username'@'%';
FLUSH PRIVILEGES;
```

**Fix Option 2 - Use different user (if available):**
```bash
# In .env, change to a user with SELECT permissions
MYSQL_USER=admin_user  # Or another user with read access
MYSQL_PASSWORD=admin_password
```

**Fix Option 3 - Ask database administrator:**
If you don't have permission to grant access:
1. Contact your database administrator
2. Request read-only SELECT access for your user on:
   - `TPMS.technical_user` table
   - `TPMS.permission` table (or `draft.permission`)

---

## 📋 **Verification Checklist**

Before testing login, verify:

- [ ] .env file exists in simorgh-agent directory
- [ ] MYSQL_HOST is set to your MySQL server IP
- [ ] MYSQL_PORT is set (usually 3306)
- [ ] MYSQL_USER matches your HeidiSQL username
- [ ] MYSQL_PASSWORD matches your HeidiSQL password
- [ ] MYSQL_DATABASE is set to TPMS
- [ ] JWT_SECRET_KEY is set to a secure random string
- [ ] Backend container restarted after .env changes
- [ ] Backend logs show "TPMS Auth Service initialized"
- [ ] check_mysql_config.py shows successful connection
- [ ] debug_login_flow.py passes all 8 steps
- [ ] Login works from browser

---

## 🔒 **Security Best Practices**

1. **Never commit .env to git:**
   ```bash
   # .env should be in .gitignore
   echo ".env" >> .gitignore
   ```

2. **Use read-only database user:**
   - Authentication only needs SELECT permissions
   - Never use admin/root accounts
   - Create dedicated user: `simorgh_auth`

3. **Strong JWT secret:**
   ```bash
   # Generate secure random key
   openssl rand -hex 32
   ```

4. **Rotate credentials regularly:**
   - Change database passwords every 90 days
   - Update JWT secret periodically
   - Monitor failed login attempts

---

## 📞 **Getting Help**

If you're still having issues:

1. **Check backend logs:**
   ```bash
   docker-compose logs backend | tail -100
   ```

2. **Run full diagnostic:**
   ```bash
   docker-compose exec backend python3 check_mysql_config.py
   docker-compose exec backend python3 debug_login_flow.py m.soltani <password>
   ```

3. **Share the output:**
   - Copy the complete output from both commands
   - Include any error messages
   - Note what step fails

---

## 🎉 **Success Checklist**

You know it's working when:

✅ `check_mysql_config.py` shows healthy connection
✅ `debug_login_flow.py` passes all 8 steps
✅ Backend logs show: `Authentication successful for m.soltani (hash type: sha256)`
✅ Login page accepts credentials and redirects to app
✅ Settings panel shows your actual username (not "Ali Rezaei")
✅ Can create projects and check permissions

---

## 📚 **Related Documentation**

- **LOGIN_FLOW_DOCUMENTATION.md** - Complete login flow explained
- **debug_login_flow.py** - Step-by-step authentication testing
- **test_auth_debug.py** - Password hash testing tool

---

**Last Updated:** 2025-11-30
**Author:** Simorgh Development Team
