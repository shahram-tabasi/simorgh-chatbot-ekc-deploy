"""
Hash Type Detector and Password Verification Utility
Supports SHA-256, MD5, bcrypt, and other common hash formats
"""
import hashlib
import re
from typing import Tuple, Optional


class HashDetector:
    """Detect and verify various password hash types"""

    @staticmethod
    def detect_hash_type(hash_string: str) -> str:
        """
        Detect the type of password hash

        Args:
            hash_string: The hash to analyze

        Returns:
            String indicating hash type: 'sha256', 'md5', 'bcrypt', 'unknown'
        """
        # Remove whitespace
        hash_clean = hash_string.strip()

        # Remove dashes if present (common in SQL Server binary format)
        hash_no_dashes = hash_clean.replace('-', '').replace(' ', '')

        # Bcrypt format: $2a$, $2b$, $2y$
        if re.match(r'^\$2[aby]\$\d+\$', hash_clean):
            return 'bcrypt'

        # SHA-256: 64 hex characters (32 bytes)
        if re.match(r'^[0-9A-Fa-f]{64}$', hash_no_dashes):
            return 'sha256'

        # MD5: 32 hex characters (16 bytes)
        if re.match(r'^[0-9A-Fa-f]{32}$', hash_no_dashes):
            return 'md5'

        # SHA-1: 40 hex characters (20 bytes)
        if re.match(r'^[0-9A-Fa-f]{40}$', hash_no_dashes):
            return 'sha1'

        return 'unknown'

    @staticmethod
    def normalize_hash(hash_string: str) -> str:
        """
        Normalize hash format by removing dashes and converting to lowercase

        Args:
            hash_string: Hash with possible dashes and mixed case

        Returns:
            Normalized lowercase hex string without dashes
        """
        return hash_string.replace('-', '').replace(' ', '').lower()

    @staticmethod
    def hash_password_sha256(password: str) -> str:
        """
        Hash password using SHA-256

        Args:
            password: Plain text password

        Returns:
            Lowercase hex SHA-256 hash (64 characters)
        """
        return hashlib.sha256(password.encode('utf-8')).hexdigest().lower()

    @staticmethod
    def verify_sha256(plain_password: str, stored_hash: str) -> bool:
        """
        Verify password against SHA-256 hash

        Args:
            plain_password: Plain text password to verify
            stored_hash: Stored hash (with or without dashes)

        Returns:
            True if password matches, False otherwise
        """
        # Normalize the stored hash
        normalized_stored = HashDetector.normalize_hash(stored_hash)

        # Hash the plain password
        password_hash = HashDetector.hash_password_sha256(plain_password)

        # Compare
        return password_hash == normalized_stored

    @staticmethod
    def verify_md5(plain_password: str, stored_hash: str) -> bool:
        """
        Verify password against MD5 hash (insecure, for legacy systems)

        Args:
            plain_password: Plain text password to verify
            stored_hash: Stored MD5 hash

        Returns:
            True if password matches, False otherwise
        """
        normalized_stored = HashDetector.normalize_hash(stored_hash)
        password_hash = hashlib.md5(plain_password.encode('utf-8')).hexdigest().lower()
        return password_hash == normalized_stored

    @staticmethod
    def verify_password(plain_password: str, stored_hash: str) -> Tuple[bool, str]:
        """
        Auto-detect hash type and verify password

        Args:
            plain_password: Plain text password to verify
            stored_hash: Stored hash in any supported format

        Returns:
            Tuple of (is_valid: bool, hash_type: str)
        """
        hash_type = HashDetector.detect_hash_type(stored_hash)

        if hash_type == 'sha256':
            is_valid = HashDetector.verify_sha256(plain_password, stored_hash)
            return is_valid, 'sha256'

        elif hash_type == 'md5':
            is_valid = HashDetector.verify_md5(plain_password, stored_hash)
            return is_valid, 'md5'

        elif hash_type == 'bcrypt':
            # Import bcrypt only if needed
            try:
                from passlib.context import CryptContext
                pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
                is_valid = pwd_context.verify(plain_password, stored_hash)
                return is_valid, 'bcrypt'
            except Exception:
                return False, 'bcrypt_error'

        return False, 'unknown'


# Test function for debugging
def test_hash_detector():
    """Test the hash detector with sample data"""

    # Sample SHA-256 hash with dashes (your format)
    sample_hash = "02-BD-79-04-D9-FB-73-3F-CD-27-42-69-CC-2B-9C-09-D7-EC-61-CB-15-08-39-5D-04-79-8F-30-AA-41-B6-94"
    sample_password = "test123"

    detector = HashDetector()

    print(f"Hash: {sample_hash}")
    print(f"Detected type: {detector.detect_hash_type(sample_hash)}")
    print(f"Normalized: {detector.normalize_hash(sample_hash)}")

    # Test with known password
    test_pass_hash = detector.hash_password_sha256("test123")
    print(f"\nSHA-256('test123'): {test_pass_hash}")

    # Verify
    is_valid, hash_type = detector.verify_password(sample_password, sample_hash)
    print(f"\nVerification result: {is_valid}")
    print(f"Hash type used: {hash_type}")


if __name__ == "__main__":
    test_hash_detector()
