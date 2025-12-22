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
import asyncio
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

        # Local LLM configuration - via nginx load balancer
        # Backend sends offline traffic to /api/llm which nginx load balances to .61/.62
        self.local_llm_url = local_llm_url_1 or os.getenv(
            "LOCAL_LLM_URL", "http://localhost/api/llm"
        )

        logger.info(f"✅ Local LLM endpoint (load-balanced): {self.local_llm_url}")

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
            "local_llm": self._check_local_llm_health(self.local_llm_url),
            "stats": self.stats
        }

        overall_status = "healthy" if any(
            h["status"] == "healthy" for h in [
                health["openai"],
                health["local_llm"]
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

    async def generate(
        self,
        messages: List[Dict[str, str]],
        mode: Optional[str] = None,
        temperature: float = 0.7,
        max_tokens: Optional[int] = None,
        use_cache: bool = True,
        cache_ttl: int = 3600,
        inject_knowledge: bool = False,
        cancellation_token: Optional[Any] = None
    ) -> Dict[str, Any]:
        """
        Generate LLM response with cancellation support

        Args:
            messages: Chat messages in OpenAI format
            mode: "online", "offline", or "auto" (uses default if None)
            temperature: Sampling temperature (0-1)
            max_tokens: Maximum tokens to generate
            use_cache: Whether to use Redis cache
            cache_ttl: Cache lifetime in seconds
            inject_knowledge: If True, inject electrical knowledge base into system prompt
            cancellation_token: Optional CancellationToken for request cancellation

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

        Raises:
            asyncio.CancelledError: If operation was cancelled
        """
        # Check cancellation before starting
        if cancellation_token and await cancellation_token.is_cancelled():
            logger.warning("🚫 LLM generation cancelled before starting")
            raise asyncio.CancelledError("LLM generation cancelled by user")

        self.stats["total_requests"] += 1

        # Inject electrical knowledge base if requested
        if inject_knowledge:
            try:
                from knowledge.electrical_anthology import get_knowledge_context
                knowledge = get_knowledge_context()

                # Find system message and append knowledge
                system_message_found = False
                for msg in messages:
                    if msg.get("role") == "system":
                        # Append knowledge to existing system message
                        msg["content"] += f"\n\n## Reference Knowledge Base\n{knowledge}"
                        system_message_found = True
                        logger.info("✅ Injected electrical knowledge into existing system message")
                        break

                if not system_message_found:
                    # No system message exists, add one with knowledge
                    messages.insert(0, {
                        "role": "system",
                        "content": f"You are Simorgh, an expert electrical engineering assistant.\n\n## Reference Knowledge Base\n{knowledge}"
                    })
                    logger.info("✅ Injected electrical knowledge in new system message")

            except Exception as e:
                logger.warning(f"⚠️ Failed to inject knowledge base: {e}")
                # Continue without knowledge injection

        # Determine mode
        effective_mode = LLMMode(mode) if mode else self.default_mode
        logger.info(f"🎯 LLM Generate - Input mode: {mode}, Effective mode: {effective_mode.value}, Default mode: {self.default_mode.value}")

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
            # Check cancellation before API call
            if cancellation_token and await cancellation_token.is_cancelled():
                logger.warning("🚫 LLM generation cancelled before API call")
                raise asyncio.CancelledError("LLM generation cancelled by user")

            if effective_mode == LLMMode.ONLINE:
                logger.info(f"🌐 Calling ONLINE LLM (OpenAI {self.openai_model})")
                result = self._generate_online(messages, temperature, max_tokens, cancellation_token)
                self.stats["online_requests"] += 1

            elif effective_mode == LLMMode.OFFLINE:
                logger.info(f"💻 Calling OFFLINE LLM (Local server: {self.local_llm_url})")
                result = self._generate_offline(messages, temperature, max_tokens, cancellation_token)
                self.stats["offline_requests"] += 1

            elif effective_mode == LLMMode.AUTO:
                # Try online first, fallback to offline
                try:
                    result = self._generate_online(messages, temperature, max_tokens, cancellation_token)
                    self.stats["online_requests"] += 1
                except asyncio.CancelledError:
                    # Don't fallback on cancellation
                    raise
                except Exception as e:
                    logger.warning(f"Online LLM failed, falling back to offline: {e}")
                    # Check cancellation before fallback
                    if cancellation_token and await cancellation_token.is_cancelled():
                        raise asyncio.CancelledError("LLM generation cancelled during fallback")
                    result = self._generate_offline(messages, temperature, max_tokens, cancellation_token)
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
        max_tokens: Optional[int],
        cancellation_token: Optional[Any] = None
    ) -> Dict[str, Any]:
        """
        Generate response using OpenAI API

        Note: cancellation_token is accepted for future streaming support
        Currently, once the API call starts, it runs to completion
        """
        logger.info(f"🌐 _generate_online called - Model: {self.openai_model}")

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

            finish_reason = response.choices[0].finish_reason
            logger.info(f"✅ OpenAI response received - Tokens: {response.usage.total_tokens}, Finish reason: {finish_reason}")

            response_text = response.choices[0].message.content

            # Handle truncation (finish_reason = "length" means hit token limit)
            if finish_reason == "length" and max_tokens is None:
                logger.warning(f"⚠️ Response truncated due to token limit, attempting continuation...")
                response_text = self._continue_truncated_response(
                    messages, response_text, temperature, "online"
                )

            return {
                "response": response_text,
                "mode": "online",
                "model": self.openai_model,
                "tokens": {
                    "prompt": response.usage.prompt_tokens,
                    "completion": response.usage.completion_tokens,
                    "total": response.usage.total_tokens
                },
                "finish_reason": finish_reason
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
        max_tokens: Optional[int],
        cancellation_token: Optional[Any] = None
    ) -> Dict[str, Any]:
        """
        Generate response using local LLM via nginx load balancer

        Note: cancellation_token is accepted for future streaming support
        Currently, once the API call starts, it runs to completion
        """
        logger.info(f"📡 _generate_offline called - URL: {self.local_llm_url}")

        # Call load-balanced endpoint (nginx handles failover between .61/.62)
        try:
            return self._call_local_llm(
                self.local_llm_url,
                messages,
                temperature,
                max_tokens
            )
        except Exception as e:
            logger.error(f"❌ Local LLM endpoint failed: {e}")
            raise LLMOfflineError(f"Local LLM unavailable (load-balanced endpoint: {self.local_llm_url})")

    def _call_local_llm(
        self,
        url: str,
        messages: List[Dict[str, str]],
        temperature: float,
        max_tokens: Optional[int]
    ) -> Dict[str, Any]:
        """Call a local LLM server endpoint (non-streaming - consumes stream internally)"""

        # Extract system and user prompts from messages
        system_prompt = "You are Simorgh, an expert industrial electrical engineering assistant."
        for msg in messages:
            if msg.get("role") == "system":
                system_prompt = msg.get("content", system_prompt)

        user_prompt = messages[-1].get("content", "") if messages else ""

        payload = {
            "system_prompt": system_prompt,
            "user_prompt": user_prompt,
            "thinking_level": "medium",
            "stream": True  # Must be True for /generate-stream endpoint
        }

        full_url = f"{url.rstrip('/')}/generate-stream"
        logger.info(f"🔧 _call_local_llm - Full URL: {full_url}")
        logger.info(f"🔧 Payload: system_prompt length={len(system_prompt)}, user_prompt={user_prompt[:50]}...")

        try:
            response = requests.post(
                full_url,
                json=payload,
                timeout=180,
                headers={"Content-Type": "application/json"},
                stream=True  # Enable streaming
            )

            response.raise_for_status()

            # Consume the entire stream and aggregate chunks (SSE format)
            full_response = ""
            line_count = 0
            chunk_count = 0

            for line in response.iter_lines():
                if line:
                    line_count += 1
                    try:
                        decoded_line = line.decode('utf-8')

                        # Handle SSE format: strip "data: " prefix
                        if decoded_line.startswith('data: '):
                            decoded_line = decoded_line[6:]  # Remove "data: " prefix

                        logger.debug(f"📥 Stream line {line_count}: {decoded_line[:100]}...")

                        data = json.loads(decoded_line)
                        logger.debug(f"📦 Parsed JSON keys: {list(data.keys())}")

                        # Handle different response formats
                        if "chunk" in data:
                            # Incremental chunk format
                            chunk_count += 1
                            full_response += data["chunk"]
                        elif "output" in data:
                            # Complete output format (status: completed)
                            full_response = data["output"]
                            logger.info(f"✅ Received complete output (length: {len(full_response)})")
                        elif "text" in data:
                            # Alternative chunk format
                            chunk_count += 1
                            full_response += data["text"]
                        else:
                            logger.debug(f"ℹ️ Status update: {data.get('status', 'unknown')}")
                    except json.JSONDecodeError as e:
                        logger.warning(f"⚠️ JSON decode error on line {line_count}: {e}, Raw: {line[:100]}")
                        continue

            logger.info(f"✅ Local LLM response received - Lines: {line_count}, Chunks: {chunk_count}, Response length: {len(full_response)}")

            # Extract only the final answer (strip reasoning/analysis)
            clean_response = self._extract_final_answer(full_response)
            logger.info(f"🎯 Extracted final answer - Original: {len(full_response)} chars, Clean: {len(clean_response)} chars")

            return {
                "response": clean_response,
                "mode": "offline",
                "model": "local-llm",
                "tokens": {
                    "prompt": 0,
                    "completion": 0,
                    "total": 0
                },
                "server": url
            }

        except Timeout:
            raise LLMTimeoutError(f"Local LLM server timed out: {url}")
        except RequestException as e:
            raise Exception(f"Local LLM request failed: {url} - {str(e)}")

    def _extract_final_answer(self, raw_response: str) -> str:
        """
        Extract only the final user-facing answer from local LLM response.

        Local LLM returns format like:
        system...developer...user...assistantanalysis...assistantfinal<ACTUAL ANSWER>

        We want to extract only the content after 'assistantfinal'.
        """
        if not raw_response:
            return raw_response

        # Look for the final answer marker
        final_marker = "assistantfinal"

        if final_marker in raw_response:
            # Extract everything after the marker
            parts = raw_response.split(final_marker, 1)
            if len(parts) > 1:
                final_answer = parts[1].strip()
                logger.debug(f"📝 Extracted final answer after '{final_marker}' marker")
                return final_answer

        # Fallback: if no marker found, return original response
        logger.warning(f"⚠️ No '{final_marker}' marker found, returning full response")
        return raw_response

    def _continue_truncated_response(
        self,
        original_messages: List[Dict[str, str]],
        partial_response: str,
        temperature: float,
        mode: str,
        max_continuations: int = 3
    ) -> str:
        """
        Continue a truncated response by asking LLM to continue from where it left off

        Args:
            original_messages: Original conversation messages
            partial_response: Truncated response received
            temperature: Sampling temperature
            mode: "online" or "offline"
            max_continuations: Maximum number of continuation attempts

        Returns:
            Complete response (concatenated)
        """
        full_response = partial_response
        continuation_count = 0

        while continuation_count < max_continuations:
            continuation_count += 1

            # Create continuation prompt
            continuation_messages = original_messages.copy()
            continuation_messages.append({
                "role": "assistant",
                "content": full_response
            })
            continuation_messages.append({
                "role": "user",
                "content": "Please continue from where you left off. Complete your previous response."
            })

            logger.info(f"🔄 Continuation attempt {continuation_count}/{max_continuations}")

            try:
                if mode == "online":
                    continuation_result = self._generate_online(
                        continuation_messages, temperature, max_tokens=None
                    )
                else:
                    continuation_result = self._generate_offline(
                        continuation_messages, temperature, max_tokens=None
                    )

                continuation_text = continuation_result["response"]
                finish_reason = continuation_result.get("finish_reason", "stop")

                # Append continuation
                full_response += continuation_text

                # If finished naturally, break
                if finish_reason == "stop":
                    logger.info(f"✅ Response completed after {continuation_count} continuation(s)")
                    break

                # If still truncated, continue loop
                logger.warning(f"⚠️ Continuation {continuation_count} also truncated, trying again...")

            except Exception as e:
                logger.error(f"❌ Continuation failed: {e}")
                # Return what we have so far
                break

        if continuation_count >= max_continuations:
            logger.warning(f"⚠️ Reached max continuations ({max_continuations}), returning partial response")

        return full_response

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
        """Stream from local LLM via nginx load balancer"""

        payload = {
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens or 2000,
            "stream": True
        }

        # Call load-balanced endpoint (nginx handles failover between .61/.62)
        try:
            url = f"{self.local_llm_url.rstrip('/')}/generate-stream"

            payload = {
                "system_prompt": "You are Simorgh, an expert industrial electrical engineering assistant.",
                "user_prompt": messages[-1]["content"],  # فقط آخرین پیام کاربر
                "thinking_level": "medium",
                "stream": True
            }

            response = requests.post(
                url,
                json=payload,
                stream=True,
                timeout=180  # چون local کندتره
            )
            response.raise_for_status()

            for line in response.iter_lines():
                if line:
                    try:
                        decoded_line = line.decode('utf-8')

                        # Handle SSE format: strip "data: " prefix
                        if decoded_line.startswith('data: '):
                            decoded_line = decoded_line[6:]

                        data = json.loads(decoded_line)

                        # Handle different response formats
                        if "chunk" in data:
                            # Incremental chunk format
                            yield data["chunk"]
                        elif "output" in data:
                            # Complete output format - extract final answer and yield
                            raw_output = data["output"]
                            clean_output = self._extract_final_answer(raw_output)
                            yield clean_output
                        elif "text" in data:
                            # Alternative chunk format
                            yield data["text"]
                        # Skip status updates without content
                    except json.JSONDecodeError:
                        continue

        except Exception as e:
            logger.error(f"Local LLM streaming failed: {e}")
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
    # EMBEDDING GENERATION
    # =========================================================================

    def generate_embedding(
        self,
        text: str,
        mode: Optional[str] = None,
        model: Optional[str] = None
    ) -> List[float]:
        """
        Generate embedding vector for text using LLM

        This provides better semantic understanding than generic embedding models,
        especially for domain-specific technical content.

        Args:
            text: Input text to embed
            mode: "online", "offline", or None (uses default)
            model: Optional specific embedding model (online mode only)

        Returns:
            Embedding vector as list of floats

        Raises:
            LLMError: If embedding generation fails
        """
        # Determine mode
        effective_mode = LLMMode(mode) if mode else self.default_mode

        try:
            if effective_mode == LLMMode.ONLINE or effective_mode == LLMMode.AUTO:
                # Use OpenAI embeddings API
                return self._generate_embedding_online(text, model)

            elif effective_mode == LLMMode.OFFLINE:
                # Use local LLM embeddings endpoint
                return self._generate_embedding_offline(text)

            else:
                raise ValueError(f"Invalid LLM mode for embeddings: {effective_mode}")

        except Exception as e:
            # If AUTO mode and online fails, try offline
            if effective_mode == LLMMode.AUTO:
                try:
                    logger.warning(f"Online embedding failed, falling back to offline: {e}")
                    return self._generate_embedding_offline(text)
                except Exception as offline_error:
                    logger.error(f"Both online and offline embedding failed: {offline_error}")
                    raise LLMError(f"Embedding generation failed: {offline_error}")
            raise LLMError(f"Embedding generation failed: {e}")

    def _generate_embedding_online(
        self,
        text: str,
        model: Optional[str] = None
    ) -> List[float]:
        """
        Generate embedding using OpenAI API

        Args:
            text: Input text
            model: Optional specific model (default: text-embedding-3-large)

        Returns:
            Embedding vector
        """
        if not self.openai_api_key:
            raise LLMOnlineError("OpenAI API key not configured")

        # Use text-embedding-3-large for best quality (3072 dimensions)
        # Alternative: text-embedding-3-small (1536 dimensions, faster)
        embedding_model = model or "text-embedding-3-large"

        try:
            response = openai.embeddings.create(
                model=embedding_model,
                input=text
            )

            embedding = response.data[0].embedding
            logger.debug(f"✅ Generated online embedding ({len(embedding)} dimensions)")
            return embedding

        except Exception as e:
            logger.error(f"❌ OpenAI embedding failed: {e}")
            raise LLMOnlineError(f"OpenAI embedding failed: {e}")

    def _generate_embedding_offline(
        self,
        text: str,
        timeout: int = 30
    ) -> List[float]:
        """
        Generate embedding using local LLM server

        Calls the local LLM's embedding endpoint to generate embeddings.
        This uses the same model understanding as generation, providing
        better domain-specific semantic matching.

        Args:
            text: Input text
            timeout: Request timeout in seconds

        Returns:
            Embedding vector
        """
        try:
            # Call local LLM embedding endpoint
            # The endpoint should accept: {"input": "text"}
            # And return: {"embedding": [float, ...]}

            response = requests.post(
                f"{self.local_llm_url}/embeddings",
                json={"input": text},
                timeout=timeout,
                headers={"Content-Type": "application/json"}
            )

            if response.status_code == 200:
                data = response.json()

                # Handle different response formats
                if "embedding" in data:
                    embedding = data["embedding"]
                elif "data" in data and len(data["data"]) > 0:
                    # OpenAI-compatible format
                    embedding = data["data"][0]["embedding"]
                else:
                    raise LLMOfflineError(f"Unexpected response format: {data}")

                logger.debug(f"✅ Generated offline embedding ({len(embedding)} dimensions)")
                return embedding

            else:
                error_msg = f"Local LLM embedding failed: HTTP {response.status_code}"
                logger.error(f"❌ {error_msg}")

                # If embedding endpoint doesn't exist, try fallback with generation
                logger.warning("⚠️ Trying fallback: using LLM generation for embedding")
                return self._generate_embedding_offline_fallback(text, timeout)

        except requests.exceptions.Timeout:
            raise LLMTimeoutError(f"Local LLM embedding timeout after {timeout}s")

        except RequestException as e:
            logger.warning(f"Local LLM embedding request failed: {e}")
            # Try fallback method
            return self._generate_embedding_offline_fallback(text, timeout)

    def _generate_embedding_offline_fallback(
        self,
        text: str,
        timeout: int = 30
    ) -> List[float]:
        """
        Fallback method: Generate embedding by asking LLM to create a semantic representation

        This is a creative fallback that asks the LLM to generate a normalized embedding
        from the text by extracting semantic features.

        Args:
            text: Input text
            timeout: Request timeout in seconds

        Returns:
            Embedding vector
        """
        # Ask LLM to generate a semantic embedding
        # This uses the LLM's understanding to create a meaningful vector
        embedding_prompt = f"""Extract semantic features from this text and return ONLY a JSON array of exactly 768 floating point numbers between -1.0 and 1.0 representing the semantic embedding.

Text: {text[:500]}

Return only the JSON array, nothing else."""

        try:
            messages = [
                {"role": "system", "content": "You are a semantic embedding generator. Return ONLY a JSON array of 768 floats."},
                {"role": "user", "content": embedding_prompt}
            ]

            result = self._generate_offline(messages, temperature=0.1, max_tokens=4096)

            # Parse the embedding from response
            response_text = result["response"].strip()

            # Try to extract JSON array from response
            import re
            json_match = re.search(r'\[([\d\s,.\-eE]+)\]', response_text)
            if json_match:
                embedding = json.loads(json_match.group(0))

                # Ensure it's the right dimension
                if len(embedding) >= 768:
                    embedding = embedding[:768]  # Truncate if too long
                else:
                    # Pad with zeros if too short
                    embedding.extend([0.0] * (768 - len(embedding)))

                logger.debug(f"✅ Generated fallback embedding ({len(embedding)} dimensions)")
                return embedding
            else:
                raise LLMOfflineError("Failed to parse embedding from LLM response")

        except Exception as e:
            logger.error(f"❌ Fallback embedding generation failed: {e}")
            raise LLMOfflineError(f"Fallback embedding failed: {e}")

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
