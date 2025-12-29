"""
Wikipedia Tool - Free Wikipedia search capability for scientific and technical data

Provides a LangChain-compatible Wikipedia search tool for accessing:
- Scientific data and standards
- Electrical standards (IEC, IEEE, NEMA, etc.)
- Famous people and historical figures
- Technical definitions and concepts

Uses the free Wikipedia API with no rate limits for reasonable usage.
"""

import logging
from typing import Optional, List, Dict, Any

# Import Tool with fallback for different LangChain versions
try:
    from langchain.tools import Tool
except ImportError:
    from langchain_core.tools import Tool

logger = logging.getLogger(__name__)


class WikipediaToolWrapper:
    """
    Wrapper for Wikipedia search functionality.

    This is a free, zero-cost tool that provides access to:
    - Scientific and technical information
    - Electrical engineering standards
    - Famous people and biographies
    - Definitions and concepts

    Uses the wikipedia-api package for reliable access.
    """

    def __init__(
        self,
        language: str = "en",
        max_results: int = 3,
        max_chars: int = 4000,
        categories_filter: Optional[List[str]] = None
    ):
        """
        Initialize Wikipedia tool.

        Args:
            language: Wikipedia language code (default: "en")
            max_results: Maximum number of search results to return
            max_chars: Maximum characters to return per article summary
            categories_filter: Optional list of categories to prioritize
        """
        self.language = language
        self.max_results = max_results
        self.max_chars = max_chars
        self.categories_filter = categories_filter or []
        self._wiki = None
        self._initialized = False

    def _lazy_init(self):
        """Lazy initialization of Wikipedia wrapper"""
        if not self._initialized:
            try:
                import wikipediaapi
                self._wiki = wikipediaapi.Wikipedia(
                    user_agent='SimorghChatbot/1.0 (https://simorgh.ai; contact@simorgh.ai)',
                    language=self.language,
                    extract_format=wikipediaapi.ExtractFormat.WIKI
                )
                self._initialized = True
                logger.info("✅ Wikipedia tool initialized")
            except ImportError:
                logger.warning("⚠️ wikipedia-api not installed, trying alternative method")
                self._wiki = None
                self._initialized = True
            except Exception as e:
                logger.error(f"Failed to initialize Wikipedia tool: {e}")
                raise

    def search(self, query: str) -> str:
        """
        Search Wikipedia for information.

        Args:
            query: Search query string

        Returns:
            Wikipedia search results as formatted string
        """
        import time
        start_time = time.time()

        if not self._initialized:
            self._lazy_init()

        try:
            logger.info(f"🔍 [WIKIPEDIA TOOL] Starting search for: '{query}'")

            # Try using wikipedia-api package
            if self._wiki is not None:
                result = self._search_with_wikipediaapi(query)
            else:
                # Fallback to requests-based search
                result = self._search_with_requests(query)

            elapsed = time.time() - start_time
            logger.info(f"✅ [WIKIPEDIA TOOL] Search completed in {elapsed:.2f}s - Result length: {len(result)} chars")
            return result

        except Exception as e:
            elapsed = time.time() - start_time
            logger.error(f"❌ [WIKIPEDIA TOOL] Search failed after {elapsed:.2f}s: {e}")
            return f"Wikipedia search error: {str(e)}"

    def _search_with_wikipediaapi(self, query: str) -> str:
        """Search using wikipedia-api package"""
        try:
            # Get the page directly
            page = self._wiki.page(query)

            if page.exists():
                # Get summary (first few sections)
                summary = page.summary[:self.max_chars]

                # Format result
                result = f"**{page.title}**\n\n"
                result += f"{summary}\n\n"
                result += f"Source: {page.fullurl}\n"

                # Add related categories if relevant
                categories = [cat for cat in list(page.categories.keys())[:5]]
                if categories:
                    result += f"\nCategories: {', '.join(categories)}"

                logger.info(f"Wikipedia search completed: {len(result)} characters")
                return result
            else:
                # Try search if direct page doesn't exist
                return self._search_fallback(query)

        except Exception as e:
            logger.warning(f"wikipedia-api search failed: {e}, trying fallback")
            return self._search_fallback(query)

    def _search_fallback(self, query: str) -> str:
        """Fallback search using Wikipedia's search API"""
        return self._search_with_requests(query)

    def _search_with_requests(self, query: str) -> str:
        """Search using direct HTTP requests to Wikipedia API"""
        import requests

        try:
            # Step 1: Search for pages
            search_url = f"https://{self.language}.wikipedia.org/w/api.php"
            search_params = {
                "action": "query",
                "list": "search",
                "srsearch": query,
                "srlimit": self.max_results,
                "format": "json",
                "srprop": "snippet|titlesnippet"
            }

            response = requests.get(search_url, params=search_params, timeout=10)
            response.raise_for_status()
            search_data = response.json()

            search_results = search_data.get("query", {}).get("search", [])

            if not search_results:
                return f"No Wikipedia results found for: {query}"

            # Step 2: Get summaries for top results
            results = []
            for item in search_results[:self.max_results]:
                title = item["title"]

                # Get page extract (summary)
                extract_params = {
                    "action": "query",
                    "titles": title,
                    "prop": "extracts|info",
                    "exintro": True,
                    "explaintext": True,
                    "exsectionformat": "plain",
                    "inprop": "url",
                    "format": "json"
                }

                extract_response = requests.get(search_url, params=extract_params, timeout=10)
                extract_data = extract_response.json()

                pages = extract_data.get("query", {}).get("pages", {})
                for page_id, page_info in pages.items():
                    if page_id != "-1":
                        extract = page_info.get("extract", "")[:self.max_chars // self.max_results]
                        url = page_info.get("fullurl", f"https://{self.language}.wikipedia.org/wiki/{title.replace(' ', '_')}")

                        results.append(f"**{title}**\n{extract}\nSource: {url}\n")

            if results:
                combined = "\n---\n".join(results)
                logger.info(f"Wikipedia search completed: {len(combined)} characters, {len(results)} results")
                return combined
            else:
                return f"No Wikipedia content found for: {query}"

        except requests.Timeout:
            logger.error("Wikipedia API timeout")
            return "Wikipedia search timed out. Please try again."
        except Exception as e:
            logger.error(f"Wikipedia HTTP search failed: {e}")
            return f"Wikipedia search error: {str(e)}"

    def get_page(self, title: str) -> str:
        """
        Get a specific Wikipedia page by title.

        Args:
            title: Page title

        Returns:
            Page content as formatted string
        """
        if not self._initialized:
            self._lazy_init()

        try:
            if self._wiki is not None:
                page = self._wiki.page(title)
                if page.exists():
                    return f"**{page.title}**\n\n{page.summary[:self.max_chars]}\n\nSource: {page.fullurl}"
                else:
                    return f"Wikipedia page not found: {title}"
            else:
                # Use requests fallback
                return self._search_with_requests(title)
        except Exception as e:
            logger.error(f"Wikipedia page retrieval failed: {e}")
            return f"Error retrieving Wikipedia page: {str(e)}"

    def get_langchain_tool(self) -> Tool:
        """
        Get LangChain Tool instance.

        Returns:
            LangChain Tool configured for Wikipedia search
        """
        return Tool(
            name="wikipedia_search",
            description=(
                "Search Wikipedia for factual information, scientific data, technical standards, "
                "famous people, historical events, and verified knowledge. "
                "Especially useful for:\n"
                "- Electrical standards (IEC, IEEE, NEMA, NEC, UL)\n"
                "- Scientific concepts and formulas\n"
                "- Technical definitions and specifications\n"
                "- Famous engineers, scientists, and inventors\n"
                "- Historical technical developments\n"
                "Input should be a search query or specific topic name."
            ),
            func=self.search,
        )


def create_wikipedia_tool(
    language: str = "en",
    max_results: int = 3,
    max_chars: int = 4000
) -> Tool:
    """
    Factory function to create a Wikipedia tool.

    Args:
        language: Wikipedia language code
        max_results: Maximum results to return
        max_chars: Maximum characters per result

    Returns:
        LangChain Tool for Wikipedia search
    """
    wrapper = WikipediaToolWrapper(
        language=language,
        max_results=max_results,
        max_chars=max_chars
    )
    return wrapper.get_langchain_tool()


def create_wikipedia_tool_from_env() -> Tool:
    """
    Create Wikipedia tool based on environment configuration.

    Environment Variables:
        WIKIPEDIA_LANGUAGE: Language code (default: "en")
        WIKIPEDIA_MAX_RESULTS: Max results (default: 3)
        WIKIPEDIA_MAX_CHARS: Max chars per result (default: 4000)

    Returns:
        Configured Wikipedia tool
    """
    import os

    language = os.getenv("WIKIPEDIA_LANGUAGE", "en")
    max_results = int(os.getenv("WIKIPEDIA_MAX_RESULTS", "3"))
    max_chars = int(os.getenv("WIKIPEDIA_MAX_CHARS", "4000"))

    logger.info(f"Creating Wikipedia tool: lang={language}, max_results={max_results}")

    return create_wikipedia_tool(
        language=language,
        max_results=max_results,
        max_chars=max_chars
    )


# Specialized electrical standards search
class ElectricalStandardsWikipedia(WikipediaToolWrapper):
    """
    Specialized Wikipedia tool for electrical standards and engineering.

    Pre-configured with electrical engineering categories and terminology.
    """

    ELECTRICAL_PREFIXES = [
        "IEC", "IEEE", "NEMA", "NEC", "UL", "EN", "BS", "DIN", "JIS",
        "electrical", "power", "voltage", "current", "circuit", "transformer",
        "motor", "cable", "switchgear", "breaker", "relay", "protection"
    ]

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.categories_filter = [
            "Electrical_engineering",
            "Electrical_standards",
            "IEEE_standards",
            "IEC_standards",
            "Power_engineering"
        ]

    def search_standard(self, standard_code: str) -> str:
        """
        Search for a specific electrical standard.

        Args:
            standard_code: Standard code like "IEC 61131" or "IEEE 802.3"

        Returns:
            Information about the standard
        """
        # Enhance query for better results
        enhanced_query = f"{standard_code} standard electrical"
        return self.search(enhanced_query)

    def get_langchain_tool(self) -> Tool:
        """Get specialized electrical engineering Wikipedia tool"""
        return Tool(
            name="electrical_standards_wiki",
            description=(
                "Search Wikipedia specifically for electrical engineering standards, "
                "specifications, and technical information. Use this for:\n"
                "- IEC standards (e.g., IEC 61131, IEC 60947)\n"
                "- IEEE standards (e.g., IEEE 802, IEEE 1547)\n"
                "- NEMA ratings and specifications\n"
                "- NEC (National Electrical Code) articles\n"
                "- UL certifications and standards\n"
                "- Electrical engineering concepts and calculations\n"
                "Input should be a standard code or electrical engineering term."
            ),
            func=self.search,
        )


def create_electrical_wiki_tool() -> Tool:
    """Create specialized electrical standards Wikipedia tool"""
    wrapper = ElectricalStandardsWikipedia()
    return wrapper.get_langchain_tool()
