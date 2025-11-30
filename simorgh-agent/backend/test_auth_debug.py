#!/usr/bin/env python3
"""
Authentication Debug Script
============================
Use this script to test password hashing and verify your authentication setup.

Usage:
    python3 test_auth_debug.py
"""

import sys
import os
sys.path.insert(0, os.path.dirname(__file__))

from services.hash_detector import HashDetector


def test_sample_hash():
    """Test with the sample hash provided by user"""
    print("=" * 70)
    print("AUTHENTICATION DEBUG SCRIPT")
    print("=" * 70)

    # Sample hash from user
    sample_hash = "02-BD-79-04-D9-FB-73-3F-CD-27-42-69-CC-2B-9C-09-D7-EC-61-CB-15-08-39-5D-04-79-8F-30-AA-41-B6-94"

    detector = HashDetector()

    print(f"\n1. HASH ANALYSIS")
    print(f"   Raw hash: {sample_hash}")
    print(f"   Detected type: {detector.detect_hash_type(sample_hash)}")
    print(f"   Normalized: {detector.normalize_hash(sample_hash)}")

    print(f"\n2. TEST COMMON PASSWORDS")
    common_passwords = [
        "123456",
        "password",
        "admin",
        "test123",
        "12345678",
        "qwerty"
    ]

    for pwd in common_passwords:
        is_valid, hash_type = detector.verify_password(pwd, sample_hash)
        if is_valid:
            print(f"   ✅ MATCH FOUND: '{pwd}' (hash type: {hash_type})")
            return pwd
        else:
            pwd_hash = detector.hash_password_sha256(pwd)
            print(f"   ❌ '{pwd}' -> {pwd_hash[:32]}...")

    print(f"\n3. NO MATCH FOUND")
    print(f"   The password is not one of the common passwords tested.")

    return None


def interactive_test():
    """Interactive password testing"""
    print("\n" + "=" * 70)
    print("INTERACTIVE PASSWORD TESTING")
    print("=" * 70)

    detector = HashDetector()

    stored_hash = input("\nEnter stored hash (with or without dashes): ").strip()

    if not stored_hash:
        print("No hash provided, exiting.")
        return

    hash_type = detector.detect_hash_type(stored_hash)
    print(f"\nDetected hash type: {hash_type}")
    print(f"Normalized hash: {detector.normalize_hash(stored_hash)}")

    while True:
        password = input("\nEnter password to test (or 'quit' to exit): ").strip()

        if password.lower() in ['quit', 'exit', 'q']:
            break

        if not password:
            continue

        is_valid, detected_type = detector.verify_password(password, stored_hash)

        if is_valid:
            print(f"   ✅ PASSWORD MATCHES! (verified with {detected_type})")
        else:
            # Show what the hash would be
            if hash_type == 'sha256':
                pwd_hash = detector.hash_password_sha256(password)
                print(f"   ❌ No match")
                print(f"      SHA-256('{password}'): {pwd_hash}")
            else:
                print(f"   ❌ No match")


def hash_password_tool():
    """Tool to hash a password"""
    print("\n" + "=" * 70)
    print("PASSWORD HASHING TOOL")
    print("=" * 70)

    detector = HashDetector()

    password = input("\nEnter password to hash: ").strip()

    if not password:
        print("No password provided.")
        return

    sha256_hash = detector.hash_password_sha256(password)

    print(f"\nSHA-256 Hash:")
    print(f"  Lowercase: {sha256_hash}")
    print(f"  Uppercase: {sha256_hash.upper()}")
    print(f"  With dashes: {'-'.join([sha256_hash[i:i+2].upper() for i in range(0, len(sha256_hash), 2)])}")


def main():
    """Main menu"""
    while True:
        print("\n" + "=" * 70)
        print("AUTHENTICATION DEBUG TOOL")
        print("=" * 70)
        print("\n1. Test sample hash from user")
        print("2. Interactive password testing")
        print("3. Hash a password (SHA-256)")
        print("4. Exit")

        choice = input("\nSelect option (1-4): ").strip()

        if choice == '1':
            test_sample_hash()
        elif choice == '2':
            interactive_test()
        elif choice == '3':
            hash_password_tool()
        elif choice == '4':
            print("\nExiting...")
            break
        else:
            print("\nInvalid choice, please try again.")


if __name__ == "__main__":
    main()
