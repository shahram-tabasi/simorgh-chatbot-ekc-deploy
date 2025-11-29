"""
Unified LLM Service
===================
Supports both online (OpenAI) and offline (Local LLM) modes with intelligent fallback.

Features:
- Online mode: OpenAI API (gpt-4o, etc.)
- Offline mode: Local LLM servers (192.168.1.61, 192.168.1.62)
- Automatic fallback on failure
- Response caching via Redis
- Token usage tracking
- Streaming support

Author: Simorgh Industrial Assistant
"""

import os
import logging
import hashlib
import json
from typing import List, Dict, Any, Optional, Iterator, Union
from enum import Enum
import openai
import requests
from requests.exceptions import RequestException, Timeout

logger = logging.getLogger(__name__)


# =============================================================================
# CUSTOM EXCEPTIONS
# =============================================================================

class LLMError(Exception):
    """Base exception for LLM-related errors"""
    pass


class LLMOfflineError(LLMError):
    """Raised when local LLM servers are unavailable"""
    pass


class LLMOnlineError(LLMError):
    """Raised when OpenAI API is unavailable"""
    pass


class LLMTimeoutError(LLMError):
    """Raised when LLM request times out"""
    pass


# =============================================================================
# ENUMS
# =============================================================================

class LLMMode(str, Enum):
    """LLM operation modes"""
    ONLINE = "online"
    OFFLINE = "offline"
    AUTO = "auto"  # Try online first, fallback to offline


class LLMService:
    """
    Unified LLM Service

    Supports:
    - OpenAI API (gpt-4o, gpt-4-turbo, gpt-3.5-turbo)
    - Local LLM servers with fallback
    - Response caching
    - Token tracking
    - Streaming responses
    """

    def __init__(
        self,
        openai_api_key: str = None,
        openai_model: str = None,
        local_llm_url_1: str = None,
        local_llm_url_2: str = None,
        default_mode: str = None,
        redis_service=None
    ):
        """Initialize LLM service with configuration"""

        # OpenAI configuration
        self.openai_api_key = openai_api_key or os.getenv("OPENAI_API_KEY")
        self.openai_model = openai_model or os.getenv("OPENAI_MODEL", "gpt-4o")

        if self.openai_api_key:
            openai.api_key = self.openai_api_key
            logger.info(f"✅ OpenAI configured: {self.openai_model}")
        else:
            logger.warning("⚠️ OpenAI API key not configured")

        # Local LLM configuration
        self.local_llm_url_1 = local_llm_url_1 or os.getenv(
            "LOCAL_LLM_URL_1", "http://192.168.1.61/ai"
        )
        self.local_llm_url_2 = local_llm_url_2 or os.getenv(
            "LOCAL_LLM_URL_2", "http://192.168.1.62/ai"
        )

        logger.info(f"✅ Local LLM servers: {self.local_llm_url_1}, {self.local_llm_url_2}")

        # Default mode
        self.default_mode = LLMMode(
            default_mode or os.getenv("DEFAULT_LLM_MODE", "online")
        )

        # Redis for caching (optional)
        self.redis_service = redis_service

        # Statistics
        self.stats = {
            "total_requests": 0,
            "online_requests": 0,
            "offline_requests": 0,
            "cache_hits": 0,
            "failures": 0
        }

    def health_check(self) -> Dict[str, Any]:
        """Check health of all LLM endpoints"""
        health = {
            "openai": self._check_openai_health(),
            "local_llm_1": self._check_local_llm_health(self.local_llm_url_1),
            "local_llm_2": self._check_local_llm_health(self.local_llm_url_2),
            "stats": self.stats
        }

        overall_status = "healthy" if any(
            h["status"] == "healthy" for h in [
                health["openai"],
                health["local_llm_1"],
                health["local_llm_2"]
            ]
        ) else "unhealthy"

        health["status"] = overall_status
        return health

    def _check_openai_health(self) -> Dict[str, Any]:
        """Check OpenAI API availability"""
        if not self.openai_api_key:
            return {"status": "disabled", "message": "No API key"}

        try:
            # Try a minimal API call
            response = openai.models.list()
            return {
                "status": "healthy",
                "model": self.openai_model,
                "available": True
            }
        except Exception as e:
            logger.error(f"OpenAI health check failed: {e}")
            return {
                "status": "unhealthy",
                "error": str(e)
            }

    def _check_local_llm_health(self, url: str) -> Dict[str, Any]:
        """Check local LLM server health"""
        try:
            response = requests.get(f"{url}/health", timeout=5)
            if response.status_code == 200:
                return {
                    "status": "healthy",
                    "url": url,
                    "available": True
                }
            else:
                return {
                    "status": "unhealthy",
                    "url": url,
                    "error": f"Status code: {response.status_code}"
                }
        except Exception as e:
            return {
                "status": "unhealthy",
                "url": url,
                "error": str(e)
            }

    # =========================================================================
    # MAIN GENERATION METHODS
    # =========================================================================

    def generate(
        self,
        messages: List[Dict[str, str]],
        mode: Optional[str] = None,
        temperature: float = 0.7,
        max_tokens: Optional[int] = None,
        use_cache: bool = True,
        cache_ttl: int = 3600
    ) -> Dict[str, Any]:
        """
        Generate LLM response

        Args:
            messages: Chat messages in OpenAI format
            mode: "online", "offline", or "auto" (uses default if None)
            temperature: Sampling temperature (0-1)
            max_tokens: Maximum tokens to generate
            use_cache: Whether to use Redis cache
            cache_ttl: Cache lifetime in seconds

        Returns:
            {
                "response": str,
                "mode": str,
                "model": str,
                "tokens": {
                    "prompt": int,
                    "completion": int,
                    "total": int
                },
                "cached": bool
            }
        """
        self.stats["total_requests"] += 1

        # Determine mode
        effective_mode = LLMMode(mode) if mode else self.default_mode

        # Check cache
        if use_cache and self.redis_service:
            cache_key = self._generate_cache_key(
                messages, effective_mode, temperature, max_tokens
            )
            cached = self.redis_service.get_cached_llm_response(cache_key)

            if cached:
                self.stats["cache_hits"] += 1
                cached["cached"] = True
                logger.debug("Using cached LLM response")
                return cached

        # Generate response based on mode
        try:
            if effective_mode == LLMMode.ONLINE:
                result = self._generate_online(messages, temperature, max_tokens)
                self.stats["online_requests"] += 1

            elif effective_mode == LLMMode.OFFLINE:
                result = self._generate_offline(messages, temperature, max_tokens)
                self.stats["offline_requests"] += 1

            elif effective_mode == LLMMode.AUTO:
                # Try online first, fallback to offline
                try:
                    result = self._generate_online(messages, temperature, max_tokens)
                    self.stats["online_requests"] += 1
                except Exception as e:
                    logger.warning(f"Online LLM failed, falling back to offline: {e}")
                    result = self._generate_offline(messages, temperature, max_tokens)
                    self.stats["offline_requests"] += 1

            else:
                raise ValueError(f"Invalid LLM mode: {effective_mode}")

            result["cached"] = False

            # Cache the response
            if use_cache and self.redis_service:
                self.redis_service.cache_llm_response(
                    cache_key,
                    result["response"],
                    metadata={
                        "mode": result["mode"],
                        "model": result["model"],
                        "tokens": result.get("tokens")
                    },
                    ttl=cache_ttl
                )

            return result

        except Exception as e:
            self.stats["failures"] += 1
            logger.error(f"LLM generation failed: {e}")
            raise

    def _generate_online(
        self,
        messages: List[Dict[str, str]],
        temperature: float,
        max_tokens: Optional[int]
    ) -> Dict[str, Any]:
        """Generate response using OpenAI API"""
        if not self.openai_api_key:
            raise ValueError("OpenAI API key not configured")

        try:
            response = openai.chat.completions.create(
                model=self.openai_model,
                messages=messages,
                temperature=temperature,
                max_tokens=max_tokens,
                timeout=60
            )

            return {
                "response": response.choices[0].message.content,
                "mode": "online",
                "model": self.openai_model,
                "tokens": {
                    "prompt": response.usage.prompt_tokens,
                    "completion": response.usage.completion_tokens,
                    "total": response.usage.total_tokens
                },
                "finish_reason": response.choices[0].finish_reason
            }

        except openai.APITimeoutError as e:
            logger.error(f"OpenAI API timeout: {e}")
            raise LLMTimeoutError(f"OpenAI API request timed out: {str(e)}")
        except Exception as e:
            logger.error(f"OpenAI API error: {e}")
            raise LLMOnlineError(f"OpenAI API unavailable: {str(e)}")

    def _generate_offline(
        self,
        messages: List[Dict[str, str]],
        temperature: float,
        max_tokens: Optional[int]
    ) -> Dict[str, Any]:
        """Generate response using local LLM servers with fallback"""

        # Try primary server first
        try:
            return self._call_local_llm(
                self.local_llm_url_1,
                messages,
                temperature,
                max_tokens
            )
        except Exception as e:
            logger.warning(f"Primary LLM server failed: {e}")

            # Fallback to secondary server
            try:
                logger.info("Trying fallback LLM server...")
                return self._call_local_llm(
                    self.local_llm_url_2,
                    messages,
                    temperature,
                    max_tokens
                )
            except Exception as e2:
                logger.error(f"Both LLM servers failed: {e2}")
                raise LLMOfflineError(f"All local LLM servers unavailable (tried {self.local_llm_url_1} and {self.local_llm_url_2})")

    def _call_local_llm(
        self,
        url: str,
        messages: List[Dict[str, str]],
        temperature: float,
        max_tokens: Optional[int]
    ) -> Dict[str, Any]:
        """Call a local LLM server endpoint"""

        payload = {
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens or 2000,
            "stream": False
        }

        try:
            response = requests.post(
                f"{url}/chat",
                json=payload,
                timeout=120,
                headers={"Content-Type": "application/json"}
            )

            response.raise_for_status()
            data = response.json()

            return {
                "response": data.get("response", data.get("message", "")),
                "mode": "offline",
                "model": data.get("model", "local-llm"),
                "tokens": data.get("tokens", {
                    "prompt": 0,
                    "completion": 0,
                    "total": 0
                }),
                "server": url
            }

        except Timeout:
            raise LLMTimeoutError(f"Local LLM server timed out: {url}")
        except RequestException as e:
            raise Exception(f"Local LLM request failed: {url} - {str(e)}")

    # =========================================================================
    # STREAMING SUPPORT
    # =========================================================================

    def generate_stream(
        self,
        messages: List[Dict[str, str]],
        mode: Optional[str] = None,
        temperature: float = 0.7,
        max_tokens: Optional[int] = None
    ) -> Iterator[str]:
        """
        Generate streaming LLM response

        Args:
            messages: Chat messages
            mode: LLM mode
            temperature: Sampling temperature
            max_tokens: Max tokens

        Yields:
            Response chunks as they arrive
        """
        effective_mode = LLMMode(mode) if mode else self.default_mode

        if effective_mode == LLMMode.ONLINE:
            yield from self._stream_online(messages, temperature, max_tokens)
        else:
            yield from self._stream_offline(messages, temperature, max_tokens)

    def _stream_online(
        self,
        messages: List[Dict[str, str]],
        temperature: float,
        max_tokens: Optional[int]
    ) -> Iterator[str]:
        """Stream from OpenAI API"""
        if not self.openai_api_key:
            raise ValueError("OpenAI API key not configured")

        try:
            stream = openai.chat.completions.create(
                model=self.openai_model,
                messages=messages,
                temperature=temperature,
                max_tokens=max_tokens,
                stream=True
            )

            for chunk in stream:
                if chunk.choices[0].delta.content:
                    yield chunk.choices[0].delta.content

        except Exception as e:
            logger.error(f"OpenAI streaming error: {e}")
            raise

    def _stream_offline(
        self,
        messages: List[Dict[str, str]],
        temperature: float,
        max_tokens: Optional[int]
    ) -> Iterator[str]:
        """Stream from local LLM server"""

        payload = {
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens or 2000,
            "stream": True
        }

        # Try primary server
        try:
            url = self.local_llm_url_1
            response = requests.post(
                f"{url}/chat",
                json=payload,
                stream=True,
                timeout=120
            )
            response.raise_for_status()

            for line in response.iter_lines():
                if line:
                    try:
                        data = json.loads(line.decode('utf-8'))
                        if "chunk" in data:
                            yield data["chunk"]
                    except json.JSONDecodeError:
                        continue

        except Exception as e:
            logger.warning(f"Primary streaming failed: {e}, trying fallback...")

            # Fallback to secondary server
            try:
                url = self.local_llm_url_2
                response = requests.post(
                    f"{url}/chat",
                    json=payload,
                    stream=True,
                    timeout=120
                )
                response.raise_for_status()

                for line in response.iter_lines():
                    if line:
                        try:
                            data = json.loads(line.decode('utf-8'))
                            if "chunk" in data:
                                yield data["chunk"]
                        except json.JSONDecodeError:
                            continue

            except Exception as e2:
                logger.error(f"All streaming servers failed: {e2}")
                raise

    # =========================================================================
    # SPECIALIZED METHODS
    # =========================================================================

    def extract_entities(
        self,
        text: str,
        entity_types: List[str],
        mode: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """
        Extract entities from text using LLM

        Args:
            text: Input text
            entity_types: List of entity types to extract
            mode: LLM mode

        Returns:
            List of extracted entities
        """
        prompt = f"""Extract the following types of entities from the text below:

Entity Types: {', '.join(entity_types)}

Text:
{text}

Return a JSON array of entities in this format:
[
  {{"type": "EntityType", "value": "...", "properties": {{}}}},
  ...
]
"""

        messages = [
            {"role": "system", "content": "You are an expert entity extraction system."},
            {"role": "user", "content": prompt}
        ]

        result = self.generate(messages, mode=mode, temperature=0.3)

        # Parse JSON response
        try:
            entities = json.loads(result["response"])
            return entities
        except json.JSONDecodeError:
            logger.error("Failed to parse entity extraction response")
            return []

    def extract_relationships(
        self,
        entities: List[Dict[str, Any]],
        context: str,
        mode: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """
        Extract relationships between entities

        Args:
            entities: List of entities
            context: Context text
            mode: LLM mode

        Returns:
            List of relationships
        """
        entities_str = json.dumps(entities, indent=2)

        prompt = f"""Given these entities and context, extract relationships between them.

Entities:
{entities_str}

Context:
{context}

Return a JSON array of relationships:
[
  {{"from": "entity_id", "to": "entity_id", "type": "RELATIONSHIP_TYPE", "properties": {{}}}},
  ...
]
"""

        messages = [
            {"role": "system", "content": "You are an expert relationship extraction system."},
            {"role": "user", "content": prompt}
        ]

        result = self.generate(messages, mode=mode, temperature=0.3)

        try:
            relationships = json.loads(result["response"])
            return relationships
        except json.JSONDecodeError:
            logger.error("Failed to parse relationship extraction response")
            return []

    # =========================================================================
    # UTILITIES
    # =========================================================================

    def _generate_cache_key(
        self,
        messages: List[Dict[str, str]],
        mode: LLMMode,
        temperature: float,
        max_tokens: Optional[int]
    ) -> str:
        """Generate cache key for request"""
        key_data = {
            "messages": messages,
            "mode": mode.value,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "model": self.openai_model if mode == LLMMode.ONLINE else "local"
        }

        key_str = json.dumps(key_data, sort_keys=True)
        return hashlib.sha256(key_str.encode()).hexdigest()

    def get_stats(self) -> Dict[str, Any]:
        """Get service statistics"""
        return {
            **self.stats,
            "cache_hit_rate": (
                self.stats["cache_hits"] / self.stats["total_requests"]
                if self.stats["total_requests"] > 0 else 0
            )
        }

    def reset_stats(self):
        """Reset statistics counters"""
        self.stats = {
            "total_requests": 0,
            "online_requests": 0,
            "offline_requests": 0,
            "cache_hits": 0,
            "failures": 0
        }


# =============================================================================
# SINGLETON INSTANCE
# =============================================================================

_llm_instance: Optional[LLMService] = None


def get_llm_service(redis_service=None) -> LLMService:
    """Get or create LLM service singleton"""
    global _llm_instance

    if _llm_instance is None:
        _llm_instance = LLMService(redis_service=redis_service)

    return _llm_instance
