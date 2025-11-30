# Complete Login Flow Documentation
# =====================================
# Simorgh Authentication System - Step-by-Step Guide

## OVERVIEW

```
User Browser → Login Component → AuthContext → Nginx → Backend API
    → TPMSAuthService → MySQL Database → Hash Verification → JWT Token
    → Response → Frontend Storage → Redirect to App
```

---

## STEP-BY-STEP FLOW

### STEP 1: User Enters Credentials (Frontend)
**File:** `frontend/src/components/Login.tsx`

```typescript
// User fills form
const [username, setUsername] = useState('');
const [password, setPassword] = useState('');

// User clicks login button
const handleSubmit = async (e: React.FormEvent) => {
  e.preventDefault();
  setIsLoading(true);
  setError(null);

  try {
    await login(username, password);  // Calls AuthContext
  } catch (err: any) {
    setError(err.response?.data?.detail || 'Login failed. Please try again.');
  } finally {
    setIsLoading(false);
  }
};
```

**Possible Failures:**
- ❌ Empty username/password (frontend validation should catch)
- ❌ Network offline (axios will throw network error)

---

### STEP 2: AuthContext Makes API Request
**File:** `frontend/src/context/AuthContext.tsx`

```typescript
const login = async (username: string, password: string) => {
  try {
    setError(null);

    // API call to backend
    const response = await axios.post(
      `${API_BASE}/auth/login`,  // http://localhost/api/auth/login
      {
        username,
        password
      },
      {
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );

    const { access_token, user: userData } = response.data;

    // Store in state
    setToken(access_token);
    setUser(userData);

    // Persist in localStorage
    localStorage.setItem('simorgh_token', access_token);
    localStorage.setItem('simorgh_user', JSON.stringify(userData));

  } catch (err: any) {
    setError(err.response?.data?.detail || 'Authentication failed');
    throw err;
  }
};
```

**Environment Variable:**
```typescript
const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost/api';
```

**Possible Failures:**
- ❌ API_BASE_URL incorrect (wrong server)
- ❌ Network error (server down)
- ❌ CORS error (misconfigured)
- ❌ Timeout (server not responding)

---

### STEP 3: Request Goes Through Nginx
**File:** `nginx_configs/conf.d/default.conf`

```nginx
# Frontend makes request to: http://localhost/api/auth/login
location /api/ {
    limit_req zone=api_limit burst=30 nodelay;

    # Proxy to backend container
    proxy_pass http://backend/;  # backend:8890

    # Headers
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # Timeouts
    proxy_connect_timeout 300s;
    proxy_send_timeout 600s;
    proxy_read_timeout 600s;

    client_max_body_size 100M;
}
```

**What Nginx Does:**
1. Receives: `POST http://localhost/api/auth/login`
2. Strips `/api` prefix
3. Forwards to: `POST http://backend:8890/auth/login`

**Possible Failures:**
- ❌ Rate limit exceeded (429 Too Many Requests)
- ❌ Backend container not running (502 Bad Gateway)
- ❌ Backend not responding (504 Gateway Timeout)
- ❌ Request too large (413 Request Entity Too Large)

---

### STEP 4: Backend API Receives Request
**File:** `backend/routes/auth.py`

```python
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel

router = APIRouter(prefix="/auth", tags=["authentication"])

class LoginRequest(BaseModel):
    username: str
    password: str

class LoginResponse(BaseModel):
    access_token: str
    user: dict

@router.post("/login", response_model=LoginResponse)
async def login(
    request: LoginRequest,
    tpms_auth: TPMSAuthService = Depends(get_tpms_auth_service)
):
    """
    Login endpoint - Authenticates user against TPMS database

    Flow:
    1. Validate request body
    2. Call TPMSAuthService.authenticate_user()
    3. If successful, create JWT token
    4. Return token + user data
    """

    # Authenticate user
    user = tpms_auth.authenticate_user(
        username=request.username,
        password=request.password
    )

    if not user:
        raise HTTPException(
            status_code=401,
            detail="Invalid username or password"
        )

    # Create JWT token
    access_token = create_access_token(
        data={"sub": user["EMPUSERNAME"]}
    )

    return LoginResponse(
        access_token=access_token,
        user=user
    )
```

**Possible Failures:**
- ❌ Invalid JSON body (422 Unprocessable Entity)
- ❌ Missing username/password (422 Unprocessable Entity)
- ❌ TPMSAuthService not initialized (500 Internal Server Error)
- ❌ Database connection failed (500 Internal Server Error)

---

### STEP 5: TPMS Auth Service Queries Database
**File:** `backend/services/tpms_auth_service.py`

```python
def authenticate_user(self, username: str, password: str) -> Optional[Dict[str, Any]]:
    """
    Authenticate user against technical_user table

    Steps:
    1. Connect to MySQL database
    2. Query technical_user table
    3. Retrieve user record
    4. Get stored password hash
    5. Verify password using HashDetector
    6. Return user data or None
    """

    if not self.enabled:
        logger.warning("TPMS auth disabled, denying access")
        return None

    try:
        # STEP 5.1: Connect to database
        with self.get_connection() as conn:
            cursor = conn.cursor()

            # STEP 5.2: Query technical_user table
            query = """
            SELECT ID, EMPUSERNAME, USER_UID, DraftPassword
            FROM technical_user
            WHERE EMPUSERNAME = %s
            LIMIT 1
            """

            cursor.execute(query, (username,))
            user = cursor.fetchone()

            # STEP 5.3: Check if user exists
            if not user:
                logger.warning(f"User not found: {username}")
                return None

            # STEP 5.4: Get stored password hash
            stored_password = user.get("DraftPassword")
            if not stored_password:
                logger.error(f"No password hash found for user: {username}")
                return None

            # STEP 5.5: Convert binary to hex if needed
            if isinstance(stored_password, bytes):
                stored_password = stored_password.hex()

            # STEP 5.6: Verify password using HashDetector
            hash_detector = HashDetector()
            is_valid, hash_type = hash_detector.verify_password(
                password,
                stored_password
            )

            if not is_valid:
                logger.warning(
                    f"Invalid password for user: {username} "
                    f"(hash type: {hash_type})"
                )
                return None

            logger.info(
                f"Authentication successful for {username} "
                f"(hash type: {hash_type})"
            )

            # STEP 5.7: Return user data (without password)
            return {
                "ID": user["ID"],
                "EMPUSERNAME": user["EMPUSERNAME"],
                "USER_UID": user["USER_UID"]
            }

    except Exception as e:
        logger.error(f"Authentication error: {e}")
        return None
```

**Database Connection:**
```python
@contextmanager
def get_connection(self):
    """Connect to MySQL TPMS database"""
    conn = pymysql.connect(
        host=self.host,        # MYSQL_HOST env var
        port=self.port,        # MYSQL_PORT (default 3306)
        user=self.user,        # MYSQL_USER env var
        password=self.password, # MYSQL_PASSWORD env var
        database=self.database, # MYSQL_DATABASE (default TPMS)
        connect_timeout=10,
        read_timeout=10,
        charset='utf8mb4',
        cursorclass=pymysql.cursors.DictCursor
    )
    yield conn
    conn.close()
```

**Possible Failures:**
- ❌ Database not configured (self.enabled = False)
- ❌ Cannot connect to MySQL server (connection timeout)
- ❌ Invalid credentials (access denied)
- ❌ Database doesn't exist (unknown database)
- ❌ Table doesn't exist (table 'technical_user' not found)
- ❌ Username not found in database (return None)
- ❌ DraftPassword field is NULL (return None)
- ❌ Password hash format unrecognized (return None)
- ❌ Password doesn't match (return None)

---

### STEP 6: Hash Verification Process
**File:** `backend/services/hash_detector.py`

```python
class HashDetector:

    @staticmethod
    def verify_password(plain_password: str, stored_hash: str) -> Tuple[bool, str]:
        """
        Auto-detect hash type and verify password

        Process:
        1. Detect hash type from format
        2. Normalize hash (remove dashes, lowercase)
        3. Hash the plain password
        4. Compare hashes
        5. Return (is_valid, hash_type)
        """

        # STEP 6.1: Detect hash type
        hash_type = HashDetector.detect_hash_type(stored_hash)

        if hash_type == 'sha256':
            # STEP 6.2: Normalize stored hash
            normalized_stored = HashDetector.normalize_hash(stored_hash)
            # Remove dashes: "02-BD-79..." → "02bd79..."

            # STEP 6.3: Hash the plain password
            password_hash = hashlib.sha256(
                plain_password.encode('utf-8')
            ).hexdigest().lower()

            # STEP 6.4: Compare
            is_valid = (password_hash == normalized_stored)

            return is_valid, 'sha256'

        elif hash_type == 'md5':
            normalized_stored = HashDetector.normalize_hash(stored_hash)
            password_hash = hashlib.md5(
                plain_password.encode('utf-8')
            ).hexdigest().lower()
            is_valid = (password_hash == normalized_stored)
            return is_valid, 'md5'

        elif hash_type == 'bcrypt':
            from passlib.context import CryptContext
            pwd_context = CryptContext(schemes=["bcrypt"])
            is_valid = pwd_context.verify(plain_password, stored_hash)
            return is_valid, 'bcrypt'

        return False, 'unknown'

    @staticmethod
    def detect_hash_type(hash_string: str) -> str:
        """Detect hash type from format"""
        hash_no_dashes = hash_string.replace('-', '').replace(' ', '')

        # Bcrypt: $2a$10$...
        if re.match(r'^\$2[aby]\$\d+\$', hash_string):
            return 'bcrypt'

        # SHA-256: 64 hex characters (32 bytes)
        if re.match(r'^[0-9A-Fa-f]{64}$', hash_no_dashes):
            return 'sha256'

        # MD5: 32 hex characters (16 bytes)
        if re.match(r'^[0-9A-Fa-f]{32}$', hash_no_dashes):
            return 'md5'

        return 'unknown'

    @staticmethod
    def normalize_hash(hash_string: str) -> str:
        """Remove dashes and convert to lowercase"""
        return hash_string.replace('-', '').replace(' ', '').lower()
```

**Example:**
```python
# Stored hash (from database):
stored = "02-BD-79-04-D9-FB-73-3F-CD-27-42-69-CC-2B-9C-09-D7-EC-61-CB-15-08-39-5D-04-79-8F-30-AA-41-B6-94"

# User entered password:
password = "mypassword123"

# Step 1: Detect type → "sha256"
# Step 2: Normalize → "02bd7904d9fb733fcd274269cc2b9c09d7ec61cb1508395d04798f30aa41b694"
# Step 3: Hash password → hashlib.sha256("mypassword123") → "xyz123..."
# Step 4: Compare → "02bd79..." == "xyz123..." → False (password wrong)
```

**Possible Failures:**
- ❌ Hash type unknown (unrecognized format)
- ❌ Hash corrupted (invalid hex characters)
- ❌ Password doesn't match (wrong password)

---

### STEP 7: JWT Token Creation
**File:** `backend/services/auth_utils.py`

```python
import jwt
from datetime import datetime, timedelta

SECRET_KEY = os.getenv("JWT_SECRET_KEY", "your-secret-key-change-in-production")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24  # 24 hours

def create_access_token(data: Dict[str, Any], expires_delta: Optional[timedelta] = None) -> str:
    """
    Create JWT access token

    Token contains:
    - sub: username (subject)
    - exp: expiration time
    - iat: issued at time
    """
    to_encode = data.copy()

    # Set expiration
    if expires_delta:
        expire = datetime.utcnow() + expires_delta
    else:
        expire = datetime.utcnow() + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)

    to_encode.update({
        "exp": expire,
        "iat": datetime.utcnow()
    })

    # Encode JWT
    encoded_jwt = jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)

    return encoded_jwt
```

**Token Example:**
```
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhbGkucmV6YWVpIiwiZXhwIjoxNzAxMzUwNDAwLCJpYXQiOjE3MDEyNjQwMDB9.xyz123...
```

**Decoded:**
```json
{
  "sub": "ali.rezaei",
  "exp": 1701350400,
  "iat": 1701264000
}
```

**Possible Failures:**
- ❌ SECRET_KEY not set (weak security)
- ❌ Token encoding fails (library error)

---

### STEP 8: Backend Returns Response
**File:** `backend/routes/auth.py`

```python
# Success response
return LoginResponse(
    access_token="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    user={
        "ID": 123,
        "EMPUSERNAME": "ali.rezaei",
        "USER_UID": "AR001"
    }
)

# HTTP 200 OK
# Content-Type: application/json
# Body:
{
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "ID": 123,
    "EMPUSERNAME": "ali.rezaei",
    "USER_UID": "AR001"
  }
}
```

**Error Response:**
```python
# HTTP 401 Unauthorized
raise HTTPException(
    status_code=401,
    detail="Invalid username or password"
)

# Body:
{
  "detail": "Invalid username or password"
}
```

---

### STEP 9: Frontend Receives Response
**File:** `frontend/src/context/AuthContext.tsx`

```typescript
// Success path
const { access_token, user: userData } = response.data;

setToken(access_token);
setUser(userData);

localStorage.setItem('simorgh_token', access_token);
localStorage.setItem('simorgh_user', JSON.stringify(userData));

// User is now authenticated
// App.tsx will detect isAuthenticated=true and show main app
```

**Error Path:**
```typescript
catch (err: any) {
  // Extract error message
  const errorMessage = err.response?.data?.detail || 'Authentication failed';

  // Set error state
  setError(errorMessage);

  // Throw to Login component
  throw err;
}
```

---

### STEP 10: Login Component Shows Result
**File:** `frontend/src/components/Login.tsx`

```typescript
// Success
await login(username, password);
// Component will unmount, App shows main interface

// Error
catch (err: any) {
  setError(err.response?.data?.detail || 'Login failed. Please try again.');
  setIsLoading(false);
  // Show error message to user
}
```

**UI States:**
- Loading: Shows spinner, disables form
- Error: Shows red alert with error message
- Success: Redirects to main app

---

### STEP 11: App Redirects to Main Interface
**File:** `frontend/src/App.tsx`

```typescript
function AppContent() {
  const { isAuthenticated, isLoading } = useAuth();

  // Show loading spinner
  if (isLoading) {
    return <div>Loading...</div>;
  }

  // Show login page
  if (!isAuthenticated) {
    return <Login />;
  }

  // Show main app (authenticated)
  return (
    <div>
      <Sidebar />
      <ChatArea />
      <SettingsPanel />
    </div>
  );
}
```

---

## COMPLETE FAILURE MATRIX

### Frontend Failures

| Error | Cause | User Sees | How to Debug |
|-------|-------|-----------|--------------|
| Network Error | Server down | "Login failed. Please try again." | Check browser console, check server status |
| CORS Error | Wrong API URL | Console error | Check API_BASE_URL env var |
| 401 Unauthorized | Wrong password | "Invalid username or password" | Check credentials |
| 422 Validation | Empty fields | Validation error | Frontend should prevent this |
| 500 Server Error | Backend crash | "Login failed. Please try again." | Check backend logs |
| Timeout | Slow server | "Login failed. Please try again." | Increase timeout, check server |

### Backend Failures

| Error | Cause | Logs Show | How to Fix |
|-------|-------|-----------|-----------|
| User not found | Username wrong | `User not found: {username}` | Check username spelling |
| No password hash | NULL in database | `No password hash found for user` | Check database data |
| Invalid password | Wrong password | `Invalid password for user` | User entered wrong password |
| Hash type unknown | Corrupted hash | `(hash type: unknown)` | Check database hash format |
| Database connection | MySQL down | `TPMS MySQL connection error` | Check MySQL connection |
| Database not configured | Missing env vars | `TPMS authentication not configured` | Set MYSQL_* env vars |
| Table doesn't exist | Wrong database | `Table 'technical_user' doesn't exist` | Check database schema |

### Database Failures

| Error | Cause | How to Fix |
|-------|-------|-----------|
| Connection timeout | MySQL not running | Start MySQL: `docker-compose up mysql` |
| Access denied | Wrong credentials | Check MYSQL_USER, MYSQL_PASSWORD |
| Unknown database | Database doesn't exist | Create database or check MYSQL_DATABASE |
| Table not found | Wrong table name | Verify table exists: `SHOW TABLES;` |
| NULL password | Data incomplete | Update record: `UPDATE technical_user SET DraftPassword=...` |

---

## DEBUGGING CHECKLIST

### 1. Check Frontend Console
```javascript
// Browser Developer Tools → Console
// Look for:
- Network requests to /api/auth/login
- Response status (200, 401, 500)
- Error messages
- CORS errors
```

### 2. Check Backend Logs
```bash
docker-compose logs -f backend | grep -i "auth"

# Look for:
# ✅ Authentication successful for ali.rezaei (hash type: sha256)
# ❌ User not found: ali.rezaei
# ❌ Invalid password for user: ali.rezaei (hash type: sha256)
# ❌ TPMS MySQL connection error
```

### 3. Test API Directly
```bash
curl -X POST http://localhost/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"ali.rezaei","password":"test123"}' \
  -v

# Success (200):
# {"access_token":"eyJ...","user":{...}}

# Failure (401):
# {"detail":"Invalid username or password"}
```

### 4. Test Database Connection
```bash
docker-compose exec backend python3 -c "
from services.tpms_auth_service import TPMSAuthService
service = TPMSAuthService()
print(service.health_check())
"

# Should show:
# {'status': 'healthy', 'database': 'TPMS', 'version': '...'}
```

### 5. Test Password Hash
```bash
docker-compose exec backend python3 test_auth_debug.py

# Choose option 2: Interactive testing
# Enter your hash and password to verify
```

### 6. Check Environment Variables
```bash
docker-compose exec backend printenv | grep -E "(MYSQL|JWT)"

# Should show:
# MYSQL_HOST=192.168.1.60
# MYSQL_PORT=3306
# MYSQL_USER=simorgh_user
# MYSQL_PASSWORD=***
# MYSQL_DATABASE=TPMS
# JWT_SECRET_KEY=***
```

---

## COMMON ISSUES & SOLUTIONS

### Issue 1: "Login failed. Please try again."

**Symptoms:** Generic error message, no details

**Debug Steps:**
1. Open browser console → Network tab
2. Find request to `/api/auth/login`
3. Check response status and body
4. Check backend logs

**Solutions:**
- 401: Wrong username/password
- 500: Backend error (check logs)
- 502: Backend not running
- 504: Backend timeout

---

### Issue 2: Password Always Wrong

**Symptoms:** Correct credentials but always fails

**Debug Steps:**
1. Check backend logs for hash type detected
2. Verify stored hash in database
3. Test with debug script

**Solutions:**
```bash
# Get stored hash from database
docker-compose exec mysql mysql -u root -p -e \
  "SELECT EMPUSERNAME, HEX(DraftPassword) FROM TPMS.technical_user WHERE EMPUSERNAME='ali.rezaei';"

# Test with debug script
docker-compose exec backend python3 test_auth_debug.py

# If hash doesn't match, regenerate:
# SHA-256 of "mypassword":
# echo -n "mypassword" | sha256sum
# Store in database with dashes or without
```

---

### Issue 3: User Not Found

**Symptoms:** "Invalid username or password" even with correct username

**Debug Steps:**
1. Check exact username spelling
2. Check database table

**Solutions:**
```sql
-- List all usernames
SELECT EMPUSERNAME FROM technical_user;

-- Check specific user
SELECT * FROM technical_user WHERE EMPUSERNAME = 'ali.rezaei';

-- Note: Username is case-sensitive!
```

---

### Issue 4: Database Connection Failed

**Symptoms:** "Login failed" + logs show connection error

**Debug Steps:**
1. Check if MySQL is running
2. Test connection manually
3. Verify credentials

**Solutions:**
```bash
# Check MySQL container
docker-compose ps mysql

# Test connection
docker-compose exec backend python3 -c "
import pymysql
conn = pymysql.connect(
    host='192.168.1.60',
    port=3306,
    user='simorgh_user',
    password='your_password',
    database='TPMS'
)
print('Connected!')
conn.close()
"
```

---

## TESTING WORKFLOW

### Complete End-to-End Test

```bash
# 1. Start all services
docker-compose up -d

# 2. Check backend is healthy
curl http://localhost/api/health
# Should return: {"status":"healthy"}

# 3. Test database connection
docker-compose exec backend python3 -c "
from services.tpms_auth_service import TPMSAuthService
print(TPMSAuthService().health_check())
"

# 4. Test authentication directly
docker-compose exec backend python3 -c "
from services.tpms_auth_service import TPMSAuthService
service = TPMSAuthService()
result = service.authenticate_user('ali.rezaei', 'test123')
print('Success!' if result else 'Failed!')
print(result)
"

# 5. Test API endpoint
curl -X POST http://localhost/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"ali.rezaei","password":"test123"}'

# 6. Test from frontend (browser)
# Open http://localhost
# Enter credentials
# Check browser console for errors
```

---

## SUMMARY

The login flow has **11 distinct steps** with **multiple possible failure points**:

1. ✅ User enters credentials
2. ✅ Frontend calls AuthContext
3. ✅ AuthContext makes API request
4. ✅ Nginx proxies to backend
5. ✅ Backend receives request
6. ✅ TPMS service queries database
7. ✅ Database returns user record
8. ✅ HashDetector verifies password
9. ✅ JWT token created
10. ✅ Response sent to frontend
11. ✅ Frontend stores token and redirects

**Most Common Failures:**
1. Wrong password (user error)
2. User not found (typo in username)
3. Database not configured (missing env vars)
4. Hash format mismatch (SHA-256 vs bcrypt)
5. Database connection failed (MySQL down)

**Debug Priority:**
1. Check backend logs first
2. Test database connection
3. Verify password hash format
4. Test API endpoint directly
5. Check frontend console last
