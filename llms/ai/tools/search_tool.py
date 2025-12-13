"""
Search Tool - Free search capability using DuckDuckGo

Provides a LangChain-compatible search tool that uses DuckDuckGo
as a free alternative to SerpAPI.
"""

import logging
from typing import Optional, Dict, Any

# Import Tool with fallback for different LangChain versions
try:
    from langchain.tools import Tool
except ImportError:
    from langchain_core.tools import Tool

from langchain_community.utilities import DuckDuckGoSearchAPIWrapper

logger = logging.getLogger(__name__)


class SearchToolWrapper:
    """
    Wrapper for search functionality using DuckDuckGo.

    This is a free, zero-cost alternative to SerpAPI.
    For production, consider:
    - Self-hosted SerpAPI alternative
    - Serper.dev (limited free tier)
    - Custom search implementation
    """

    def __init__(self, max_results: int = 5):
        """
        Initialize search tool.

        Args:
            max_results: Maximum number of search results to return
        """
        self.max_results = max_results
        self._search = None
        self._initialized = False

    def _lazy_init(self):
        """Lazy initialization of search wrapper"""
        if not self._initialized:
            try:
                self._search = DuckDuckGoSearchAPIWrapper(max_results=self.max_results)
                self._initialized = True
                logger.info("✅ DuckDuckGo search tool initialized")
            except Exception as e:
                logger.error(f"Failed to initialize DuckDuckGo search: {e}")
                raise

    def search(self, query: str) -> str:
        """
        Execute search query.

        Args:
            query: Search query string

        Returns:
            Search results as formatted string
        """
        if not self._initialized:
            self._lazy_init()

        try:
            logger.info(f"Executing search query: {query}")
            results = self._search.run(query)
            logger.info(f"Search completed: {len(results)} characters returned")
            return results
        except Exception as e:
            logger.error(f"Search failed: {e}")
            return f"Search error: {str(e)}"

    def get_langchain_tool(self) -> Tool:
        """
        Get LangChain Tool instance.

        Returns:
            LangChain Tool configured for search
        """
        return Tool(
            name="web_search",
            description=(
                "Search the web for current information, news, or facts. "
                "Useful when you need up-to-date information or when the user "
                "asks about current events, recent developments, or information "
                "not in your training data. Input should be a search query string."
            ),
            func=self.search,
        )


def create_search_tool(max_results: int = 5) -> Tool:
    """
    Factory function to create a search tool.

    Args:
        max_results: Maximum number of results

    Returns:
        LangChain Tool for search
    """
    wrapper = SearchToolWrapper(max_results=max_results)
    return wrapper.get_langchain_tool()


# Alternative: Self-hosted SerpAPI adapter
# For production environments, you can deploy a self-hosted search service

class SelfHostedSearchTool:
    """
    Adapter for self-hosted SerpAPI-compatible endpoint.

    To use:
    1. Deploy serpapi-bing or similar service
    2. Set SEARCH_API_URL environment variable
    3. Configure with API key if needed
    """

    def __init__(
        self,
        api_url: str,
        api_key: Optional[str] = None,
        max_results: int = 5
    ):
        """
        Initialize self-hosted search.

        Args:
            api_url: URL of self-hosted search API
            api_key: Optional API key
            max_results: Max results to return
        """
        self.api_url = api_url
        self.api_key = api_key
        self.max_results = max_results

    def search(self, query: str) -> str:
        """Execute search via self-hosted API"""
        import requests

        try:
            params = {
                "q": query,
                "num": self.max_results
            }

            headers = {}
            if self.api_key:
                headers["X-API-Key"] = self.api_key

            response = requests.get(
                self.api_url,
                params=params,
                headers=headers,
                timeout=10
            )
            response.raise_for_status()

            data = response.json()

            # Format results
            results = []
            for item in data.get("organic_results", [])[:self.max_results]:
                title = item.get("title", "")
                link = item.get("link", "")
                snippet = item.get("snippet", "")
                results.append(f"{title}\n{snippet}\n{link}\n")

            return "\n".join(results)

        except Exception as e:
            logger.error(f"Self-hosted search failed: {e}")
            return f"Search error: {str(e)}"

    def get_langchain_tool(self) -> Tool:
        """Get LangChain Tool for self-hosted search"""
        return Tool(
            name="web_search",
            description=(
                "Search the web for current information using self-hosted search API. "
                "Input should be a search query string."
            ),
            func=self.search,
        )


def create_search_tool_from_env() -> Tool:
    """
    Create search tool based on environment configuration.

    Checks for SEARCH_API_URL environment variable.
    If present, uses self-hosted search. Otherwise, uses DuckDuckGo.

    Returns:
        Configured search tool
    """
    import os

    search_api_url = os.getenv("SEARCH_API_URL")
    search_api_key = os.getenv("SEARCH_API_KEY")

    if search_api_url:
        logger.info(f"Using self-hosted search at {search_api_url}")
        tool = SelfHostedSearchTool(
            api_url=search_api_url,
            api_key=search_api_key,
            max_results=5
        )
        return tool.get_langchain_tool()
    else:
        logger.info("Using DuckDuckGo search (free)")
        return create_search_tool(max_results=5)
