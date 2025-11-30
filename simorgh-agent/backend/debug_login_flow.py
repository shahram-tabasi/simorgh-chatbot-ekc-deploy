#!/usr/bin/env python3
"""
Login Flow Debugger
===================
This script tests each step of the login flow to identify where failures occur.

Usage:
    python3 debug_login_flow.py <username> <password>
    python3 debug_login_flow.py ali.rezaei mypassword123
"""

import sys
import os
import json
import hashlib
sys.path.insert(0, os.path.dirname(__file__))

from services.tpms_auth_service import TPMSAuthService
from services.hash_detector import HashDetector
from services.auth_utils import create_access_token


def print_header(text):
    """Print section header"""
    print("\n" + "=" * 70)
    print(f"  {text}")
    print("=" * 70)


def print_step(step_num, description, status=""):
    """Print step with status"""
    if status == "✅":
        print(f"\n{status} STEP {step_num}: {description}")
    elif status == "❌":
        print(f"\n{status} STEP {step_num}: {description}")
    else:
        print(f"\n📋 STEP {step_num}: {description}")


def print_detail(key, value, indent=3):
    """Print detail with indentation"""
    spaces = " " * indent
    print(f"{spaces}{key}: {value}")


def debug_login_flow(username: str, password: str):
    """
    Debug complete login flow step by step

    Args:
        username: Username to test
        password: Password to test
    """

    print_header("LOGIN FLOW DEBUGGER")
    print(f"Testing login for user: {username}")
    print(f"Password length: {len(password)} characters")

    # =========================================================================
    # STEP 1: Initialize TPMS Auth Service
    # =========================================================================
    print_step(1, "Initialize TPMS Auth Service")

    try:
        service = TPMSAuthService()

        print_detail("Status", "✅ Service initialized")
        print_detail("Enabled", service.enabled)
        print_detail("Host", service.host)
        print_detail("Port", service.port)
        print_detail("Database", service.database)
        print_detail("User", service.user)

        if not service.enabled:
            print("\n❌ FAILURE: TPMS auth service is not enabled")
            print("   Check environment variables:")
            print("   - MYSQL_HOST")
            print("   - MYSQL_PORT")
            print("   - MYSQL_USER")
            print("   - MYSQL_PASSWORD")
            print("   - MYSQL_DATABASE")
            return False

    except Exception as e:
        print(f"\n❌ FAILURE: Cannot initialize service: {e}")
        return False

    # =========================================================================
    # STEP 2: Test Database Connection
    # =========================================================================
    print_step(2, "Test Database Connection")

    try:
        health = service.health_check()

        if health["status"] == "healthy":
            print_detail("Status", "✅ Database connection successful")
            print_detail("Database", health.get("database"))
            print_detail("Host", health.get("host"))
            print_detail("MySQL Version", health.get("version"))
        else:
            print(f"\n❌ FAILURE: Database unhealthy")
            print_detail("Error", health.get("error", "Unknown"))
            return False

    except Exception as e:
        print(f"\n❌ FAILURE: Cannot connect to database: {e}")
        print("\nPossible causes:")
        print("   - MySQL server is not running")
        print("   - Wrong host/port configuration")
        print("   - Invalid database credentials")
        print("   - Network connectivity issues")
        return False

    # =========================================================================
    # STEP 3: Query User from Database
    # =========================================================================
    print_step(3, "Query User from Database")

    try:
        with service.get_connection() as conn:
            cursor = conn.cursor()

            query = """
            SELECT ID, EMPUSERNAME, USER_UID, DraftPassword
            FROM technical_user
            WHERE EMPUSERNAME = %s
            LIMIT 1
            """

            cursor.execute(query, (username,))
            user = cursor.fetchone()

            if not user:
                print(f"\n❌ FAILURE: User not found in database")
                print_detail("Username searched", username)
                print("\nTroubleshooting:")
                print("   - Check username spelling (case-sensitive)")
                print("   - List all users:")
                print(f"     SELECT EMPUSERNAME FROM technical_user;")
                return False

            print_detail("Status", "✅ User found")
            print_detail("ID", user.get("ID"))
            print_detail("EMPUSERNAME", user.get("EMPUSERNAME"))
            print_detail("USER_UID", user.get("USER_UID"))

            # Check password field
            stored_password = user.get("DraftPassword")

            if not stored_password:
                print(f"\n❌ FAILURE: DraftPassword is NULL or missing")
                print("\nFix:")
                print(f"   UPDATE technical_user SET DraftPassword = '<hash>' ")
                print(f"   WHERE EMPUSERNAME = '{username}';")
                return False

            print_detail("DraftPassword type", type(stored_password).__name__)

            # Convert bytes to hex if needed
            if isinstance(stored_password, bytes):
                stored_password_hex = stored_password.hex()
                print_detail("DraftPassword (hex)", stored_password_hex[:50] + "...")
                stored_password = stored_password_hex
            else:
                print_detail("DraftPassword", str(stored_password)[:50] + "...")

    except Exception as e:
        print(f"\n❌ FAILURE: Database query error: {e}")
        return False

    # =========================================================================
    # STEP 4: Detect Hash Type
    # =========================================================================
    print_step(4, "Detect Hash Type")

    try:
        detector = HashDetector()
        hash_type = detector.detect_hash_type(stored_password)
        normalized_hash = detector.normalize_hash(stored_password)

        print_detail("Detected type", hash_type)
        print_detail("Normalized hash", normalized_hash[:50] + "...")
        print_detail("Hash length", len(normalized_hash))

        if hash_type == "unknown":
            print(f"\n❌ FAILURE: Unknown hash type")
            print("\nSupported types:")
            print("   - SHA-256: 64 hex characters (32 bytes)")
            print("   - MD5: 32 hex characters (16 bytes)")
            print("   - bcrypt: $2a$, $2b$, $2y$ prefix")
            print(f"\nYour hash: {normalized_hash}")
            return False

    except Exception as e:
        print(f"\n❌ FAILURE: Hash detection error: {e}")
        return False

    # =========================================================================
    # STEP 5: Hash the Provided Password
    # =========================================================================
    print_step(5, "Hash the Provided Password")

    try:
        if hash_type == "sha256":
            password_hash = detector.hash_password_sha256(password)
            print_detail("Algorithm", "SHA-256")
            print_detail("Input", f'"{password}"')
            print_detail("Output", password_hash)

        elif hash_type == "md5":
            password_hash = hashlib.md5(password.encode('utf-8')).hexdigest().lower()
            print_detail("Algorithm", "MD5")
            print_detail("Input", f'"{password}"')
            print_detail("Output", password_hash)

        elif hash_type == "bcrypt":
            print_detail("Algorithm", "bcrypt")
            print_detail("Note", "Bcrypt uses verify function, not direct hash")
            password_hash = None

    except Exception as e:
        print(f"\n❌ FAILURE: Password hashing error: {e}")
        return False

    # =========================================================================
    # STEP 6: Compare Hashes
    # =========================================================================
    print_step(6, "Compare Hashes")

    try:
        is_valid, detected_type = detector.verify_password(password, stored_password)

        if hash_type in ["sha256", "md5"] and password_hash:
            print("\n   Comparison:")
            print(f"      Stored:   {normalized_hash}")
            print(f"      Computed: {password_hash}")
            print(f"      Match:    {password_hash == normalized_hash}")

        print_detail("\nVerification result", "✅ MATCH" if is_valid else "❌ NO MATCH")
        print_detail("Hash type verified", detected_type)

        if not is_valid:
            print(f"\n❌ FAILURE: Password does not match")
            print("\nPossible causes:")
            print("   - Wrong password entered")
            print("   - Hash in database is incorrect")
            print("   - Hash encoding issue (uppercase vs lowercase)")
            print("\nTo generate correct hash:")
            print(f"   echo -n '{password}' | sha256sum")
            print(f"   # Result should match stored hash")
            return False

    except Exception as e:
        print(f"\n❌ FAILURE: Password verification error: {e}")
        return False

    # =========================================================================
    # STEP 7: Create JWT Token
    # =========================================================================
    print_step(7, "Create JWT Token")

    try:
        user_data = {
            "ID": user["ID"],
            "EMPUSERNAME": user["EMPUSERNAME"],
            "USER_UID": user["USER_UID"]
        }

        token = create_access_token(data={"sub": user["EMPUSERNAME"]})

        print_detail("Status", "✅ Token created")
        print_detail("Token (first 50 chars)", token[:50] + "...")
        print_detail("User data", json.dumps(user_data, indent=11))

    except Exception as e:
        print(f"\n❌ FAILURE: Token creation error: {e}")
        return False

    # =========================================================================
    # STEP 8: Full Authentication Test
    # =========================================================================
    print_step(8, "Full Authentication Test")

    try:
        result = service.authenticate_user(username, password)

        if result:
            print_detail("Status", "✅ AUTHENTICATION SUCCESSFUL")
            print_detail("User ID", result.get("ID"))
            print_detail("Username", result.get("EMPUSERNAME"))
            print_detail("User UID", result.get("USER_UID"))
        else:
            print(f"\n❌ FAILURE: authenticate_user() returned None")
            print("\nThis should not happen if previous steps passed.")
            print("Check backend logs for details.")
            return False

    except Exception as e:
        print(f"\n❌ FAILURE: Authentication error: {e}")
        return False

    # =========================================================================
    # SUMMARY
    # =========================================================================
    print_header("✅ ALL TESTS PASSED - LOGIN SHOULD WORK")
    print("\nExpected API response:")
    print(json.dumps({
        "access_token": token[:30] + "...",
        "user": {
            "ID": user_data["ID"],
            "EMPUSERNAME": user_data["EMPUSERNAME"],
            "USER_UID": user_data["USER_UID"]
        }
    }, indent=2))

    print("\n\nNext steps:")
    print("1. Rebuild Docker image to include latest code")
    print("2. Test login from frontend")
    print("3. Check browser console for errors")
    print("4. Check backend logs: docker-compose logs -f backend")

    return True


def main():
    """Main entry point"""

    if len(sys.argv) < 3:
        print("Usage: python3 debug_login_flow.py <username> <password>")
        print("\nExample:")
        print("  python3 debug_login_flow.py ali.rezaei mypassword123")
        print("\nThis script will test each step of the login flow and")
        print("show exactly where failures occur.")
        sys.exit(1)

    username = sys.argv[1]
    password = sys.argv[2]

    success = debug_login_flow(username, password)

    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
