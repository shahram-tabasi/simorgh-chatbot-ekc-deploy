"""
container_mirror
================
Thin re-export of the canonical implementation in
simorgh_clients.container_mirror. Kept here so callers that already
`from services.container_mirror import mirror_message` keep working.
"""
from simorgh_clients.container_mirror import (  # noqa: F401
    mirror_message,
    destroy_session_container,
    MIRROR_PATH,
)
