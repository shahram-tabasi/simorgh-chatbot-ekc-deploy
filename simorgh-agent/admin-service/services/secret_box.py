"""
Secret box — symmetric encryption for `system_settings.value` rows whose
`is_secret = TRUE`.

Uses Fernet (AES-128-CBC + HMAC-SHA256) keyed on MASTER_ENCRYPTION_KEY,
which must be a 32-byte url-safe base64 string. If the env var is unset
or invalid the box runs in PLAINTEXT mode and logs a loud warning —
secrets are then stored as-is, which is fine for development but a
production-only deployment must set the key.
"""
from __future__ import annotations

import base64
import logging
import os
from typing import Optional

from cryptography.fernet import Fernet, InvalidToken

logger = logging.getLogger("secret-box")

_FERNET: Optional[Fernet] = None
_PLAINTEXT_MODE = False

# Anything we wrote with the box has this prefix; lets us round-trip safely
# when the master key is rotated or temporarily missing.
_PREFIX = "fer:"


def _load() -> None:
    global _FERNET, _PLAINTEXT_MODE
    raw = os.getenv("MASTER_ENCRYPTION_KEY", "").strip()
    if not raw:
        _PLAINTEXT_MODE = True
        logger.warning(
            "MASTER_ENCRYPTION_KEY not set — secret values stored in PLAINTEXT. "
            "Generate one with: python -c 'from cryptography.fernet import Fernet; "
            "print(Fernet.generate_key().decode())'"
        )
        return
    try:
        # Fernet wants 32 url-safe base64 bytes. Accept either the canonical
        # form or a raw 32-byte value the user happens to pass through.
        if len(raw) == 32:
            raw = base64.urlsafe_b64encode(raw.encode("utf-8")).decode("ascii")
        _FERNET = Fernet(raw.encode("ascii"))
    except Exception as exc:
        _PLAINTEXT_MODE = True
        logger.error("MASTER_ENCRYPTION_KEY invalid (%s) — running in PLAINTEXT mode.", exc)


_load()


def encrypt(plaintext: Optional[str]) -> Optional[str]:
    """Encrypt a value for storage. None passes through unchanged."""
    if plaintext is None:
        return None
    if _PLAINTEXT_MODE or _FERNET is None:
        return plaintext
    token = _FERNET.encrypt(plaintext.encode("utf-8")).decode("ascii")
    return _PREFIX + token


def decrypt(ciphertext: Optional[str]) -> Optional[str]:
    """Decrypt a stored value. Plaintext rows pass through (back-compat)."""
    if ciphertext is None:
        return None
    if not ciphertext.startswith(_PREFIX):
        # Was written in plaintext mode (or before encryption was enabled).
        return ciphertext
    if _FERNET is None:
        # Encrypted row but no key available — surface that explicitly so
        # callers don't accidentally treat the cipher blob as a value.
        raise RuntimeError(
            "Encrypted setting present but MASTER_ENCRYPTION_KEY is unset/invalid"
        )
    try:
        return _FERNET.decrypt(ciphertext[len(_PREFIX):].encode("ascii")).decode("utf-8")
    except InvalidToken as exc:
        raise RuntimeError("Encrypted setting could not be decrypted (key mismatch?)") from exc


def is_plaintext_mode() -> bool:
    return _PLAINTEXT_MODE


def mask(value: Optional[str]) -> Optional[str]:
    """Return a masked-but-recognisable form for UI display."""
    if value is None:
        return None
    if value == "":
        return ""
    if len(value) <= 6:
        return "•" * len(value)
    return value[:2] + "•" * (len(value) - 4) + value[-2:]
