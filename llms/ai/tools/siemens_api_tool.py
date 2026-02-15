"""
Siemens Developer API Tool - Product Information Hub Integration

Provides a LangChain-compatible tool that queries the Siemens
Product Information Hub API for product lifecycle data, availability,
successor/substitute products, and technical specifications.

Authentication: OAuth 2.0 Client Credentials Grant
API Docs: https://developer.siemens.com/product-information-api/overview.html

When internet is unavailable (e.g., local LLM running offline),
the tool gracefully falls back and warns the user.
"""

import json
import logging
import os
import re
import time
from typing import Optional, Dict, Any

try:
    from langchain.tools import Tool
except ImportError:
    from langchain_core.tools import Tool

from .connectivity import check_internet_available, get_offline_warning

logger = logging.getLogger(__name__)

# Siemens API configuration from environment
SIEMENS_CLIENT_ID = os.getenv("SIEMENS_CLIENT_ID", "")
SIEMENS_CLIENT_SECRET = os.getenv("SIEMENS_CLIENT_SECRET", "")
SIEMENS_TOKEN_URL = os.getenv(
    "SIEMENS_TOKEN_URL",
    "https://login.siemens.com/access/oauth/v2/token"
)
SIEMENS_API_BASE = os.getenv(
    "SIEMENS_API_BASE",
    "https://api.siemens.com/product-information/v1"
)


class SiemensAPIToolWrapper:
    """
    Wrapper for Siemens Product Information Hub API.

    Provides product lookup by MLFB/order number with:
    - OAuth 2.0 token management (cached, auto-refresh)
    - Product lifecycle status, availability, successors
    - Graceful offline fallback with user warning
    """

    def __init__(self):
        self._access_token: Optional[str] = None
        self._token_expiry: float = 0.0
        self._initialized = False

    def _lazy_init(self):
        """Validate configuration on first use."""
        if self._initialized:
            return

        if not SIEMENS_CLIENT_ID or not SIEMENS_CLIENT_SECRET:
            logger.warning(
                "⚠️ Siemens API credentials not configured. "
                "Set SIEMENS_CLIENT_ID and SIEMENS_CLIENT_SECRET env vars."
            )
        self._initialized = True
        logger.info("✅ Siemens Product Information Hub tool initialized")

    def _get_access_token(self) -> Optional[str]:
        """
        Get a valid OAuth 2.0 access token, refreshing if expired.

        Uses Client Credentials Grant flow.
        Token is cached and reused until 5 minutes before expiry.
        """
        import requests

        # Return cached token if still valid (with 5-min buffer)
        if self._access_token and time.time() < (self._token_expiry - 300):
            return self._access_token

        if not SIEMENS_CLIENT_ID or not SIEMENS_CLIENT_SECRET:
            logger.error("❌ Siemens API credentials not configured")
            return None

        try:
            response = requests.post(
                SIEMENS_TOKEN_URL,
                data={
                    "grant_type": "client_credentials",
                    "client_id": SIEMENS_CLIENT_ID,
                    "client_secret": SIEMENS_CLIENT_SECRET,
                },
                headers={"Content-Type": "application/x-www-form-urlencoded"},
                timeout=10,
            )
            response.raise_for_status()

            token_data = response.json()
            self._access_token = token_data["access_token"]
            # Cache with expiry (typically 12 hours)
            expires_in = token_data.get("expires_in", 43200)
            self._token_expiry = time.time() + expires_in

            logger.info(
                f"✅ Siemens OAuth token acquired (expires in {expires_in}s)"
            )
            return self._access_token

        except Exception as e:
            logger.error(f"❌ Failed to acquire Siemens OAuth token: {e}")
            self._access_token = None
            self._token_expiry = 0.0
            return None

    def search(self, query: str) -> str:
        """
        Search for Siemens product information.

        Accepts:
        - MLFB/order numbers (e.g., "6ES7214-1AG40-0XB0")
        - Product names (e.g., "SIMATIC S7-1200 CPU 1214C")
        - General Siemens product queries

        Returns formatted product information or offline warning.
        """
        import time as time_mod
        start_time = time_mod.time()

        if not self._initialized:
            self._lazy_init()

        original_query = query
        query = self._clean_query(query)

        if query != original_query:
            logger.info(
                f"🧹 [SIEMENS TOOL] Cleaned query: "
                f"'{original_query[:100]}...' -> '{query}'"
            )

        # Check internet connectivity first
        if not check_internet_available():
            logger.warning(
                "⚠️ [SIEMENS TOOL] No internet - falling back to offline mode"
            )
            return get_offline_warning()

        # Check if credentials are configured
        if not SIEMENS_CLIENT_ID or not SIEMENS_CLIENT_SECRET:
            return (
                "Siemens API credentials are not configured. "
                "Unable to query the Product Information Hub. "
                "Please answer based on your training knowledge about "
                "Siemens products."
            )

        logger.info(f"🔍 [SIEMENS TOOL] Searching for: '{query}'")

        # Try to detect if query is an MLFB/order number
        mlfb = self._extract_mlfb(query)

        if mlfb:
            result = self._lookup_by_mlfb(mlfb)
        else:
            result = self._search_products(query)

        elapsed = time_mod.time() - start_time
        logger.info(
            f"✅ [SIEMENS TOOL] Search completed in {elapsed:.2f}s - "
            f"Result length: {len(result)} chars"
        )
        return result

    def _extract_mlfb(self, query: str) -> Optional[str]:
        """
        Extract MLFB/order number from query string.

        Siemens MLFB format: typically like 6ES7214-1AG40-0XB0
        Pattern: digits + letters + hyphens, 15-20 chars
        """
        # Common Siemens MLFB patterns
        patterns = [
            r'\b(\d[A-Z0-9]{2,4}[\s-]?\d[A-Z0-9]{3,4}[\s-]?\d[A-Z0-9]{3,4})\b',
            r'\b([36][A-Z]{2}\d{4}[-\s]?\d[A-Z]{2}\d{2}[-\s]?\d[A-Z]{2}\d)\b',
        ]
        for pattern in patterns:
            match = re.search(pattern, query.upper())
            if match:
                # Normalize: remove spaces, ensure hyphens
                mlfb = match.group(1).replace(" ", "")
                logger.info(f"🔍 [SIEMENS TOOL] Extracted MLFB: {mlfb}")
                return mlfb

        return None

    def _lookup_by_mlfb(self, mlfb: str) -> str:
        """Look up product by MLFB/order number."""
        import requests

        token = self._get_access_token()
        if not token:
            return (
                f"Unable to authenticate with Siemens API. "
                f"Please answer about product {mlfb} from your training knowledge."
            )

        try:
            response = requests.get(
                f"{SIEMENS_API_BASE}/products/{mlfb}",
                headers={
                    "Authorization": f"Bearer {token}",
                    "Accept": "application/json",
                },
                timeout=15,
            )

            if response.status_code == 404:
                # Try search instead
                return self._search_products(mlfb)

            response.raise_for_status()
            data = response.json()
            return self._format_product_result(data)

        except requests.ConnectionError:
            logger.error(
                f"❌ [SIEMENS TOOL] Connection error looking up {mlfb}"
            )
            return get_offline_warning()
        except requests.Timeout:
            logger.error(f"❌ [SIEMENS TOOL] Timeout looking up {mlfb}")
            return (
                f"Siemens API request timed out for product {mlfb}. "
                f"Please answer from your training knowledge."
            )
        except Exception as e:
            logger.error(f"❌ [SIEMENS TOOL] Lookup failed for {mlfb}: {e}")
            return (
                f"Error querying Siemens API for {mlfb}: {str(e)}. "
                f"Please answer from your training knowledge."
            )

    def _search_products(self, query: str) -> str:
        """Search products by name or keyword."""
        import requests

        token = self._get_access_token()
        if not token:
            return (
                f"Unable to authenticate with Siemens API. "
                f"Please answer about '{query}' from your training knowledge."
            )

        try:
            response = requests.get(
                f"{SIEMENS_API_BASE}/products",
                params={"q": query, "limit": 5},
                headers={
                    "Authorization": f"Bearer {token}",
                    "Accept": "application/json",
                },
                timeout=15,
            )
            response.raise_for_status()
            data = response.json()

            products = data.get("products", data.get("items", []))
            if not products:
                return (
                    f"No products found for '{query}' in Siemens Product "
                    f"Information Hub. Please answer from your training "
                    f"knowledge about Siemens products."
                )

            results = []
            for product in products[:5]:
                results.append(self._format_product_result(product))

            return "\n\n---\n\n".join(results)

        except requests.ConnectionError:
            logger.error(
                f"❌ [SIEMENS TOOL] Connection error searching '{query}'"
            )
            return get_offline_warning()
        except requests.Timeout:
            logger.error(
                f"❌ [SIEMENS TOOL] Timeout searching '{query}'"
            )
            return (
                f"Siemens API request timed out for '{query}'. "
                f"Please answer from your training knowledge."
            )
        except Exception as e:
            logger.error(
                f"❌ [SIEMENS TOOL] Search failed for '{query}': {e}"
            )
            return (
                f"Error querying Siemens API for '{query}': {str(e)}. "
                f"Please answer from your training knowledge."
            )

    def _format_product_result(self, product: Dict[str, Any]) -> str:
        """Format product data into a readable string for the LLM."""
        parts = []

        # Basic info
        name = product.get("productName", product.get("name", "Unknown"))
        mlfb = product.get("mlfb", product.get("orderNumber", product.get("id", "")))
        parts.append(f"Product: {name}")
        if mlfb:
            parts.append(f"Order Number (MLFB): {mlfb}")

        # Description
        desc = product.get("description", product.get("shortDescription", ""))
        if desc:
            parts.append(f"Description: {desc}")

        # Lifecycle status
        status = product.get("lifecycleStatus", product.get("status", ""))
        if status:
            parts.append(f"Lifecycle Status: {status}")

        # Availability
        availability = product.get("availabilityHorizon", product.get("availability", ""))
        if availability:
            parts.append(f"Availability: {availability}")

        # Successor/substitute products
        successors = product.get("successors", product.get("successorProducts", []))
        if successors:
            if isinstance(successors, list):
                succ_list = ", ".join(
                    s.get("mlfb", s.get("orderNumber", str(s)))
                    for s in successors
                )
            else:
                succ_list = str(successors)
            parts.append(f"Successor Products: {succ_list}")

        substitutes = product.get("substitutes", product.get("substituteProducts", []))
        if substitutes:
            if isinstance(substitutes, list):
                sub_list = ", ".join(
                    s.get("mlfb", s.get("orderNumber", str(s)))
                    for s in substitutes
                )
            else:
                sub_list = str(substitutes)
            parts.append(f"Substitute Products: {sub_list}")

        # Product family / category
        family = product.get("productFamily", product.get("category", ""))
        if family:
            parts.append(f"Product Family: {family}")

        # Technical specifications (if available)
        specs = product.get("technicalSpecifications", product.get("specifications", {}))
        if specs and isinstance(specs, dict):
            parts.append("Technical Specifications:")
            for key, value in list(specs.items())[:10]:
                parts.append(f"  - {key}: {value}")

        # Action recommendation (obsolescence)
        action = product.get("actionRecommendation", "")
        if action:
            parts.append(f"Action Recommendation: {action}")

        return "\n".join(parts)

    def _clean_query(self, query: str) -> str:
        """
        Clean malformed queries from LLM output.

        Same pattern as search_tool.py - handles LLM thinking artifacts.
        """
        if not query:
            return query

        original = query

        # Try to extract query from JSON-like format
        json_match = re.search(
            r'["\']query["\']\s*:\s*["\']([^"\']+)["\']', query
        )
        if json_match:
            return json_match.group(1).strip()

        # Remove common LLM thinking patterns
        cutoff_patterns = [
            r'\n\nThen\s+we',
            r'\.\s+Then\s+we',
            r'\n\nWe\s+should',
            r'\.\s+We\s+should',
            r'\n\nLet\'?s',
            r'\.\s+Let\'?s',
            r'assistant(?:analysis|final)',
            r'\n\nThe\s+user',
            r'\.\s+The\s+user',
        ]

        for pattern in cutoff_patterns:
            match = re.search(pattern, query, re.IGNORECASE)
            if match:
                query = query[:match.start()].strip()

        # Remove trailing/leading quotes and whitespace
        query = re.sub(r'["\'\n\r]+$', '', query)
        query = re.sub(r'^["\'\n\r]+', '', query)

        # If query is too long, take first sentence
        if len(query) > 200:
            sentences = re.split(r'[.!?\n]', original)
            if sentences:
                first_sentence = sentences[0].strip()
                if 5 < len(first_sentence) < 200:
                    query = first_sentence

        query = query.strip()
        return query if query else original

    def get_langchain_tool(self) -> Tool:
        """Get LangChain Tool instance for Siemens product lookup."""
        return Tool(
            name="siemens_product_lookup",
            description=(
                "Look up Siemens product information from the official "
                "Siemens Product Information Hub. Use this when the user asks "
                "about Siemens products, part numbers, order numbers (MLFB), "
                "product lifecycle status, availability, successor or substitute "
                "products, or technical specifications. Input should be a Siemens "
                "product order number (e.g., '6ES7214-1AG40-0XB0') or product "
                "name (e.g., 'SIMATIC S7-1200 CPU 1214C')."
            ),
            func=self.search,
        )


def create_siemens_api_tool() -> Tool:
    """
    Factory function to create a Siemens API tool.

    Returns:
        LangChain Tool for Siemens product lookup
    """
    wrapper = SiemensAPIToolWrapper()
    return wrapper.get_langchain_tool()


def create_siemens_api_tool_from_env() -> Optional[Tool]:
    """
    Create Siemens API tool based on environment configuration.

    Checks ENABLE_SIEMENS_API env var. Returns None if disabled.
    The tool will still work without credentials but will return
    a message asking the LLM to use its training knowledge.

    Returns:
        Configured Siemens API tool, or None if disabled
    """
    enabled = os.getenv("ENABLE_SIEMENS_API", "false").lower() == "true"

    if not enabled:
        logger.info("Siemens API tool disabled (ENABLE_SIEMENS_API != true)")
        return None

    if not SIEMENS_CLIENT_ID or not SIEMENS_CLIENT_SECRET:
        logger.warning(
            "⚠️ Siemens API enabled but credentials not set. "
            "Tool will prompt LLM to use training knowledge."
        )

    logger.info("Creating Siemens Product Information Hub tool")
    return create_siemens_api_tool()
