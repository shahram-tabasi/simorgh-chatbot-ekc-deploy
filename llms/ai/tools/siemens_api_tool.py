"""
Siemens Developer API Tool - Product Information Hub Integration

Provides a LangChain-compatible tool that queries the Siemens
Product Information Hub API for product lifecycle data, delivery info,
obsolescence warnings, successor/substitute products.

Authentication: API Key in Authorization header (no Bearer prefix)
Base URL: https://product-information-hub.siemens.cloud/api/
API Docs: https://developer.siemens.com/product-information-api/overview.html

Endpoints:
- GET /products/{mlfb}/obsolescence  - Lifecycle & obsolescence data
- GET /products/{mlfb}/delivery      - Delivery & availability info
- GET /api-key-details               - Check API key credits

Get your API key:
1. Visit https://xcelerator.siemens.com/global/en/all-offerings/apis/p/product-information-hub.html
2. Click "Get sandbox access" or "Explore subscription options"
3. Or contact Siemens support for an evaluation key

When internet is unavailable (e.g., local LLM running offline),
the tool gracefully falls back and warns the user.
"""

import logging
import os
import re
import time
from typing import Optional, Dict, Any, List

try:
    from langchain.tools import Tool
except ImportError:
    from langchain_core.tools import Tool

from .connectivity import check_internet_available, get_offline_warning

logger = logging.getLogger(__name__)

# Siemens API configuration from environment
SIEMENS_API_KEY = os.getenv("SIEMENS_API_KEY", "")
SIEMENS_API_BASE = os.getenv(
    "SIEMENS_API_BASE",
    "https://product-information-hub.siemens.cloud/api"
)


class SiemensAPIToolWrapper:
    """
    Wrapper for Siemens Product Information Hub API.

    Provides product lookup by MLFB/order number with:
    - Simple API Key authentication (in Authorization header)
    - Product obsolescence status and successor info
    - Product delivery/availability info
    - Graceful offline fallback with user warning
    """

    def __init__(self):
        self._initialized = False

    def _lazy_init(self):
        """Validate configuration on first use."""
        if self._initialized:
            return

        if not SIEMENS_API_KEY:
            logger.warning(
                "⚠️ Siemens API key not configured. "
                "Set SIEMENS_API_KEY env var."
            )
        self._initialized = True
        logger.info("✅ Siemens Product Information Hub tool initialized")

    def _get_headers(self) -> Dict[str, str]:
        """Get request headers with API key auth (no Bearer prefix)."""
        return {
            "Authorization": SIEMENS_API_KEY,
            "Accept": "application/json",
        }

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

        # Check if API key is configured
        if not SIEMENS_API_KEY:
            return (
                "Siemens API key is not configured. "
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
            # No direct search endpoint — try to extract possible MLFBs
            # or return guidance for the LLM
            result = self._handle_text_query(query)

        elapsed = time_mod.time() - start_time
        logger.info(
            f"✅ [SIEMENS TOOL] Search completed in {elapsed:.2f}s - "
            f"Result length: {len(result)} chars"
        )
        return result

    def _extract_mlfb(self, query: str) -> Optional[str]:
        """
        Extract MLFB/order number from query string.

        Siemens MLFB format examples:
        - 6ES7214-1AG40-0XB0  (SIMATIC)
        - 1PH8350-7MK40-0AX0  (Motors)
        - 3VA2125-5AP32-0AA0  (Circuit breakers)
        - 6GK5008-0BA10-1AB2  (SCALANCE)
        """
        # Common Siemens MLFB patterns
        patterns = [
            # Standard MLFB: 6ES7214-1AG40-0XB0
            r'\b(\d[A-Z0-9]{2}\d{4}-\d[A-Z0-9]{3}\d-\d[A-Z0-9]{3}\d)\b',
            # With possible spaces instead of hyphens
            r'\b(\d[A-Z0-9]{2}\d{4}[\s-]\d[A-Z0-9]{3}\d[\s-]\d[A-Z0-9]{3}\d)\b',
            # Looser pattern: digit + alphanum block + hyphen blocks
            r'\b(\d[A-Z]{2}\d{4}-\d[A-Z]{2}\d{2}-\d[A-Z]{2}\d)\b',
        ]
        for pattern in patterns:
            match = re.search(pattern, query.upper())
            if match:
                # Normalize: spaces to hyphens
                mlfb = match.group(1).replace(" ", "-")
                logger.info(f"🔍 [SIEMENS TOOL] Extracted MLFB: {mlfb}")
                return mlfb

        return None

    def _lookup_by_mlfb(self, mlfb: str) -> str:
        """
        Look up product by MLFB/order number.

        Queries both obsolescence and delivery endpoints for full info.
        """
        import requests

        results = []

        # Query obsolescence endpoint
        obsolescence = self._get_obsolescence(mlfb, requests)
        if obsolescence:
            results.append(obsolescence)

        # Query delivery endpoint
        delivery = self._get_delivery(mlfb, requests)
        if delivery:
            results.append(delivery)

        if results:
            return f"Product MLFB: {mlfb}\n\n" + "\n\n".join(results)
        else:
            return (
                f"No data found for product {mlfb} in Siemens Product "
                f"Information Hub. The product number may be incorrect "
                f"or not yet indexed. Please answer from your training "
                f"knowledge about this Siemens product."
            )

    def _get_obsolescence(self, mlfb: str, requests_mod) -> Optional[str]:
        """Get obsolescence/lifecycle info for a product."""
        try:
            response = requests_mod.get(
                f"{SIEMENS_API_BASE}/products/{mlfb}/obsolescence",
                headers=self._get_headers(),
                timeout=15,
            )

            if response.status_code == 404:
                return None
            if response.status_code == 401:
                logger.error("❌ [SIEMENS TOOL] API key invalid or expired")
                return "API key authentication failed. Please check SIEMENS_API_KEY."
            if response.status_code == 403:
                logger.error("❌ [SIEMENS TOOL] Insufficient API credits")
                return "Insufficient API credits. Check your subscription."

            response.raise_for_status()
            data = response.json()
            return self._format_obsolescence(data)

        except requests_mod.ConnectionError:
            logger.error(f"❌ [SIEMENS TOOL] Connection error for {mlfb}")
            return None
        except requests_mod.Timeout:
            logger.error(f"❌ [SIEMENS TOOL] Timeout for {mlfb}")
            return None
        except Exception as e:
            logger.error(f"❌ [SIEMENS TOOL] Obsolescence query failed: {e}")
            return None

    def _get_delivery(self, mlfb: str, requests_mod) -> Optional[str]:
        """Get delivery/availability info for a product."""
        try:
            response = requests_mod.get(
                f"{SIEMENS_API_BASE}/products/{mlfb}/delivery",
                headers=self._get_headers(),
                timeout=15,
            )

            if response.status_code == 404:
                return None
            if response.status_code in (401, 403):
                return None  # Already reported in obsolescence

            response.raise_for_status()
            data = response.json()
            return self._format_delivery(data)

        except Exception as e:
            logger.error(f"❌ [SIEMENS TOOL] Delivery query failed: {e}")
            return None

    def _format_obsolescence(self, data: Dict[str, Any]) -> str:
        """Format obsolescence/lifecycle data."""
        parts = ["--- Lifecycle & Obsolescence ---"]

        # Product info
        name = data.get("productName", data.get("name", ""))
        if name:
            parts.append(f"Product Name: {name}")

        # Lifecycle phase
        phase = data.get("lifecyclePhase", data.get("phase", ""))
        if phase:
            parts.append(f"Lifecycle Phase: {phase}")

        status = data.get("lifecycleStatus", data.get("status", ""))
        if status:
            parts.append(f"Status: {status}")

        # Obsolescence dates
        prod_stop = data.get("productionStopDate", data.get("endOfProduction", ""))
        if prod_stop:
            parts.append(f"Production Stop Date: {prod_stop}")

        repair_stop = data.get("repairServiceStopDate", data.get("endOfRepair", ""))
        if repair_stop:
            parts.append(f"Repair Service Stop: {repair_stop}")

        spare_stop = data.get("sparePartsStopDate", data.get("endOfSpares", ""))
        if spare_stop:
            parts.append(f"Spare Parts Stop: {spare_stop}")

        # Action recommendation
        action = data.get("actionRecommendation", data.get("recommendation", ""))
        if action:
            parts.append(f"Action Recommendation: {action}")

        # Successor products
        successors = data.get("successors", data.get("successorProducts", []))
        if successors:
            if isinstance(successors, list):
                for s in successors:
                    if isinstance(s, dict):
                        s_mlfb = s.get("mlfb", s.get("orderNumber", ""))
                        s_name = s.get("productName", s.get("name", ""))
                        parts.append(f"Successor: {s_mlfb} ({s_name})")
                    else:
                        parts.append(f"Successor: {s}")
            else:
                parts.append(f"Successor: {successors}")

        # Substitutes
        substitutes = data.get("substitutes", data.get("substituteProducts", []))
        if substitutes:
            if isinstance(substitutes, list):
                for s in substitutes:
                    if isinstance(s, dict):
                        s_mlfb = s.get("mlfb", s.get("orderNumber", ""))
                        s_name = s.get("productName", s.get("name", ""))
                        parts.append(f"Substitute: {s_mlfb} ({s_name})")
                    else:
                        parts.append(f"Substitute: {s}")
            else:
                parts.append(f"Substitute: {substitutes}")

        return "\n".join(parts)

    def _format_delivery(self, data: Dict[str, Any]) -> str:
        """Format delivery/availability data."""
        parts = ["--- Delivery & Availability ---"]

        avail = data.get("availability", data.get("deliveryStatus", ""))
        if avail:
            parts.append(f"Availability: {avail}")

        lead_time = data.get("leadTime", data.get("deliveryTime", ""))
        if lead_time:
            parts.append(f"Lead Time: {lead_time}")

        stock = data.get("stockStatus", data.get("inStock", ""))
        if stock:
            parts.append(f"Stock Status: {stock}")

        country = data.get("deliveryCountry", data.get("country", ""))
        if country:
            parts.append(f"Delivery Country: {country}")

        # Any additional delivery info
        for key in ("minOrderQuantity", "packagingUnit", "priceGroup"):
            val = data.get(key, "")
            if val:
                parts.append(f"{key}: {val}")

        return "\n".join(parts)

    def _handle_text_query(self, query: str) -> str:
        """
        Handle text queries when no MLFB is detected.

        The Product Information Hub only supports lookup by MLFB,
        not free-text search. Guide the LLM accordingly.
        """
        return (
            f"The Siemens Product Information Hub requires a specific "
            f"product order number (MLFB) for lookup. The query '{query}' "
            f"does not contain a recognizable MLFB number.\n\n"
            f"Please answer the user's question about '{query}' from your "
            f"training knowledge. If the user can provide a specific Siemens "
            f"order number (e.g., 6ES7214-1AG40-0XB0), you can look it up "
            f"for exact lifecycle and availability data."
        )

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
                "about a specific Siemens product by its order number (MLFB). "
                "Returns lifecycle status, obsolescence warnings, delivery "
                "availability, and successor/substitute products. "
                "Input MUST be a Siemens MLFB order number "
                "(e.g., '6ES7214-1AG40-0XB0' or '1PH8350-7MK40-0AX0'). "
                "If the user asks about Siemens products by name without "
                "an order number, answer from your knowledge instead."
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
    The tool will still work without an API key but will return
    a message asking the LLM to use its training knowledge.

    Returns:
        Configured Siemens API tool, or None if disabled
    """
    enabled = os.getenv("ENABLE_SIEMENS_API", "false").lower() == "true"

    if not enabled:
        logger.info("Siemens API tool disabled (ENABLE_SIEMENS_API != true)")
        return None

    if not SIEMENS_API_KEY:
        logger.warning(
            "⚠️ Siemens API enabled but SIEMENS_API_KEY not set. "
            "Tool will prompt LLM to use training knowledge."
        )

    logger.info("Creating Siemens Product Information Hub tool")
    return create_siemens_api_tool()
