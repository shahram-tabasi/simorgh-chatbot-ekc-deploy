"""
Model Manager - Handles vLLM initialization with fallback to 4-bit loader

Responsibilities:
- GPU memory detection
- Model downloading from Hugging Face
- vLLM initialization (16-bit preferred)
- Fallback to 4-bit unsloth loader
- Async generation interface
"""

import os
import asyncio
import logging
import traceback
from typing import Optional, Dict, Any, List, AsyncIterator
from enum import Enum
import torch
import gc

logger = logging.getLogger(__name__)


class ModelPrecision(Enum):
    """Model precision options"""
    FP16 = "16-bit"
    INT4 = "4-bit (fallback)"


class ModelManager:
    """
    Manages model loading with vLLM (16-bit) or fallback to unsloth (4-bit).
    Provides async interface for text generation.
    """

    def __init__(
        self,
        model_name: str = "unsloth/gpt-oss-20b",
        model_path: str = "/models/unsloth-gpt-oss-20b-16bit",
        max_model_len: int = 4096,
        gpu_memory_utilization: float = 0.9,
        lora_adapter_path: Optional[str] = None,
    ):
        self.model_name = model_name
        self.model_path = model_path
        self.max_model_len = max_model_len
        self.gpu_memory_utilization = gpu_memory_utilization
        self.lora_adapter_path = lora_adapter_path

        self.model = None
        self.tokenizer = None
        self.precision: Optional[ModelPrecision] = None
        self.is_vllm = False
        self._generation_lock = asyncio.Lock()

    async def initialize(self):
        """
        Initialize model - try vLLM first, fallback to 4-bit if needed.
        """
        logger.info("=" * 60)
        logger.info("Starting Model Initialization")
        logger.info("=" * 60)

        # Check GPU availability
        if not torch.cuda.is_available():
            raise RuntimeError("CUDA not available - GPU required for model inference")

        gpu_memory_gb = self._get_gpu_memory()
        logger.info(f"Available GPU Memory: {gpu_memory_gb:.2f} GB")

        # Try vLLM with 16-bit first
        try:
            await self._try_vllm_init()
            return
        except Exception as e:
            logger.warning(f"vLLM initialization failed: {e}")
            logger.info("Falling back to 4-bit loader...")

        # Fallback to 4-bit unsloth
        try:
            await self._fallback_4bit_init()
        except Exception as e:
            logger.error(f"4-bit fallback initialization failed: {e}")
            raise RuntimeError("Failed to initialize model with both vLLM and 4-bit fallback")

    def _get_gpu_memory(self) -> float:
        """Get total GPU memory in GB"""
        if torch.cuda.is_available():
            props = torch.cuda.get_device_properties(0)
            return props.total_memory / (1024 ** 3)
        return 0.0

    async def _try_vllm_init(self):
        """Try to initialize vLLM with 16-bit model"""
        logger.info("Attempting vLLM initialization (16-bit)...")

        # Check if model needs to be downloaded
        if not os.path.exists(self.model_path):
            logger.info(f"Model not found at {self.model_path}")
            await self._download_hf_model()

        # Import vLLM (lazy import to avoid issues if not installed)
        try:
            from vllm import LLM, SamplingParams
            from transformers import AutoTokenizer
        except ImportError as e:
            raise ImportError(
                f"vLLM not installed or import failed: {e}\n"
                "Install with: pip install vllm"
            )

        # Check GPU memory requirements
        gpu_memory_gb = self._get_gpu_memory()
        required_memory_gb = 20.0  # Estimated for 20B model in FP16

        if gpu_memory_gb < required_memory_gb:
            raise RuntimeError(
                f"Insufficient GPU memory for 16-bit model. "
                f"Required: ~{required_memory_gb}GB, Available: {gpu_memory_gb:.2f}GB"
            )

        # Initialize vLLM
        loop = asyncio.get_event_loop()

        def _init_vllm():
            # Clear GPU cache
            gc.collect()
            torch.cuda.empty_cache()

            model_path_to_use = self.model_path if os.path.exists(self.model_path) else self.model_name

            model = LLM(
                model=model_path_to_use,
                max_model_len=self.max_model_len,
                gpu_memory_utilization=self.gpu_memory_utilization,
                tensor_parallel_size=1,
                trust_remote_code=True,
            )

            # CRITICAL FIX: Load tokenizer from the SAME path as the model
            # Do NOT use LoRA adapter path - that's only for 4-bit Unsloth
            tokenizer = AutoTokenizer.from_pretrained(
                model_path_to_use,
                trust_remote_code=True,
            )
            
            # Log tokenizer info for debugging
            logger.info(f"✅ Loaded tokenizer from: {model_path_to_use}")
            if hasattr(tokenizer, 'chat_template') and tokenizer.chat_template:
                logger.info(f"📋 Chat template loaded (first 100 chars): {tokenizer.chat_template[:100]}...")
            else:
                logger.warning("⚠️ No chat template found in tokenizer!")

            return model, tokenizer

        # Run blocking init in executor
        self.model, self.tokenizer = await loop.run_in_executor(None, _init_vllm)
        self.precision = ModelPrecision.FP16
        self.is_vllm = True

        logger.info("✅ vLLM initialization successful (16-bit)")
        self._log_gpu_stats()

    async def _fallback_4bit_init(self):
        """Fallback to 4-bit unsloth loader"""
        logger.info("Initializing 4-bit fallback loader...")

        try:
            from unsloth import FastLanguageModel
            from peft import PeftModel
        except ImportError as e:
            raise ImportError(
                f"Unsloth not installed: {e}\n"
                "Install with: pip install unsloth"
            )

        loop = asyncio.get_event_loop()

        def _init_4bit():
            gc.collect()
            torch.cuda.empty_cache()

            model, tokenizer = FastLanguageModel.from_pretrained(
                self.model_name,
                load_in_4bit=True,
                max_seq_length=self.max_model_len,
                dtype=None,
            )

            # Load LoRA adapter if available
            if self.lora_adapter_path and os.path.exists(self.lora_adapter_path):
                logger.info(f"Loading LoRA adapter from {self.lora_adapter_path}")
                model = PeftModel.from_pretrained(model, self.lora_adapter_path)

            return model, tokenizer

        self.model, self.tokenizer = await loop.run_in_executor(None, _init_4bit)
        self.precision = ModelPrecision.INT4
        self.is_vllm = False

        logger.info("✅ 4-bit fallback initialization successful")
        self._log_gpu_stats()

    async def _download_hf_model(self):
        """Download model from Hugging Face if not present"""
        logger.info(f"Downloading model {self.model_name} from Hugging Face...")

        try:
            from huggingface_hub import snapshot_download, HfApi
        except ImportError:
            raise ImportError(
                "huggingface_hub not installed. "
                "Install with: pip install huggingface_hub"
            )

        # Check if model requires acceptance
        try:
            api = HfApi()
            model_info = api.model_info(self.model_name)

            if hasattr(model_info, 'gated') and model_info.gated:
                logger.error(
                    f"\n{'=' * 60}\n"
                    f"⚠️  MODEL REQUIRES LICENSE ACCEPTANCE ⚠️\n"
                    f"{'=' * 60}\n"
                    f"The model '{self.model_name}' requires accepting terms.\n\n"
                    f"Steps to accept:\n"
                    f"1. Visit: https://huggingface.co/{self.model_name}\n"
                    f"2. Read and accept the model card/license\n"
                    f"3. Authenticate: huggingface-cli login\n"
                    f"4. Restart this service\n"
                    f"{'=' * 60}\n"
                )
                raise RuntimeError(
                    f"Model {self.model_name} requires license acceptance on Hugging Face"
                )
        except Exception as e:
            if "requires license acceptance" in str(e):
                raise
            # If we can't check gated status, continue anyway
            logger.warning(f"Could not verify model gated status: {e}")

        # Download model
        loop = asyncio.get_event_loop()

        def _download():
            os.makedirs(os.path.dirname(self.model_path), exist_ok=True)
            return snapshot_download(
                repo_id=self.model_name,
                local_dir=self.model_path,
                local_dir_use_symlinks=False,
            )

        try:
            downloaded_path = await loop.run_in_executor(None, _download)
            logger.info(f"✅ Model downloaded successfully to {downloaded_path}")
        except Exception as e:
            logger.error(f"Model download failed: {e}")
            raise

    def _log_gpu_stats(self):
        """Log GPU memory statistics"""
        if torch.cuda.is_available():
            allocated = torch.cuda.memory_allocated(0) / (1024 ** 3)
            reserved = torch.cuda.memory_reserved(0) / (1024 ** 3)
            logger.info(f"GPU Memory - Allocated: {allocated:.2f}GB, Reserved: {reserved:.2f}GB")

    async def generate(
        self,
        messages: List[Dict[str, str]],
        max_tokens: int = 1024,
        temperature: float = 0.7,
        top_p: float = 0.95,
        stream: bool = False,
        **kwargs
    ) -> tuple[str, int]:
        """
        Generate text response (non-streaming).

        Args:
            messages: Chat messages in OpenAI format
            max_tokens: Maximum tokens to generate
            temperature: Sampling temperature
            top_p: Nucleus sampling parameter
            stream: Whether to stream (not used in this method)
            **kwargs: Additional generation parameters

        Returns:
            Tuple of (generated_text, tokens_used)
        """
        if self.model is None:
            raise RuntimeError("Model not initialized")

        async with self._generation_lock:
            if self.is_vllm:
                return await self._generate_vllm(
                    messages, max_tokens, temperature, top_p, **kwargs
                )
            else:
                return await self._generate_4bit(
                    messages, max_tokens, temperature, top_p, **kwargs
                )

    async def generate_stream(
        self,
        messages: List[Dict[str, str]],
        max_tokens: int = 1024,
        temperature: float = 0.7,
        top_p: float = 0.95,
        **kwargs
    ) -> AsyncIterator[str]:
        """
        Generate text response with streaming.

        Yields:
            Text chunks as they are generated
        """
        if self.model is None:
            raise RuntimeError("Model not initialized")

        async with self._generation_lock:
            if self.is_vllm:
                async for chunk in self._generate_vllm_stream(
                    messages, max_tokens, temperature, top_p, **kwargs
                ):
                    yield chunk
            else:
                async for chunk in self._generate_4bit_stream(
                    messages, max_tokens, temperature, top_p, **kwargs
                ):
                    yield chunk

    async def _generate_vllm(
        self,
        messages: List[Dict[str, str]],
        max_tokens: int,
        temperature: float,
        top_p: float,
        **kwargs
    ) -> tuple[str, int]:
        """Generate with vLLM (non-streaming)"""
        from vllm import SamplingParams

        # Format messages into prompt using Harmony encoding
        prompt = self._format_messages(messages)
        logger.info(f"🤖 vLLM generation - Prompt length: {len(prompt)} chars, max_tokens: {max_tokens}")

        sampling_params = SamplingParams(
            max_tokens=max_tokens,
            temperature=temperature,
            top_p=top_p,
        )

        loop = asyncio.get_event_loop()

        def _generate():
            outputs = self.model.generate([prompt], sampling_params)
            output_text = outputs[0].outputs[0].text
            tokens_used = len(outputs[0].outputs[0].token_ids)

            logger.info(f"✅ vLLM generated {tokens_used} tokens, text length: {len(output_text)} chars")
            logger.info(f"📤 Output (first 200 chars): {output_text[:200]}")
            
            # Detect garbage output
            unique_chars = set(output_text.replace(' ', '').replace('\n', ''))
            if len(unique_chars) <= 5 and len(output_text) > 100:
                logger.error(f"🚨 GARBAGE OUTPUT DETECTED! Only {len(unique_chars)} unique chars: {unique_chars}")
                # Return error message instead of garbage
                error_msg = (
                    "I apologize, but I encountered a technical issue generating a response. "
                    "This may be due to a model configuration issue. Please try again or contact support."
                )
                return error_msg, tokens_used
            
            return output_text, tokens_used

        return await loop.run_in_executor(None, _generate)

    async def _generate_vllm_stream(
        self,
        messages: List[Dict[str, str]],
        max_tokens: int,
        temperature: float,
        top_p: float,
        **kwargs
    ) -> AsyncIterator[str]:
        """Generate with vLLM (streaming)"""
        # Note: vLLM doesn't support true async streaming yet
        # This is a workaround that generates and yields chunks
        text, _ = await self._generate_vllm(messages, max_tokens, temperature, top_p, **kwargs)

        # Simulate streaming by yielding chunks
        chunk_size = 10
        for i in range(0, len(text), chunk_size):
            yield text[i:i + chunk_size]
            await asyncio.sleep(0.01)  # Small delay to simulate streaming

    async def _generate_4bit(
        self,
        messages: List[Dict[str, str]],
        max_tokens: int,
        temperature: float,
        top_p: float,
        **kwargs
    ) -> tuple[str, int]:
        """Generate with 4-bit unsloth model"""
        loop = asyncio.get_event_loop()

        def _generate():
            inputs = self.tokenizer.apply_chat_template(
                messages,
                add_generation_prompt=True,
                return_tensors="pt",
                return_dict=True,
                reasoning_effort=kwargs.get("reasoning_effort", "medium"),
            ).to(self.model.device)

            outputs = self.model.generate(
                **inputs,
                max_new_tokens=max_tokens,
                temperature=temperature,
                top_p=top_p,
                do_sample=True,
            )

            full_text = self.tokenizer.decode(outputs[0], skip_special_tokens=False)
            tokens_used = outputs.shape[1]

            # Parse final output
            import re
            final_block_pattern = r'<\|start\|>assistant<\|channel\|>final<\|message\|>(.*?)(?:<\|end\|>|$)'
            match = re.search(final_block_pattern, full_text, re.DOTALL)
            if match:
                final_text = match.group(1).strip()
            else:
                final_text = full_text.strip()

            return final_text, tokens_used

        return await loop.run_in_executor(None, _generate)

    async def _generate_4bit_stream(
        self,
        messages: List[Dict[str, str]],
        max_tokens: int,
        temperature: float,
        top_p: float,
        **kwargs
    ) -> AsyncIterator[str]:
        """Generate with 4-bit model (streaming simulation)"""
        text, _ = await self._generate_4bit(messages, max_tokens, temperature, top_p, **kwargs)

        # Simulate streaming by yielding chunks
        chunk_size = 10
        for i in range(0, len(text), chunk_size):
            yield text[i:i + chunk_size]
            await asyncio.sleep(0.01)

    def _format_messages(self, messages: List[Dict[str, str]]) -> str:
        """
        Format messages into a prompt string.
        
        For GPT-OSS models, uses Harmony format encoding.
        Falls back to standard chat template or simple format if Harmony unavailable.
        """
        logger.info(f"📥 Formatting {len(messages)} messages for {'vLLM' if self.is_vllm else 'Unsloth'}")
        
        # Try Harmony encoding first (required for GPT-OSS models)
        try:
            from unsloth_zoo import encode_conversations_with_harmony
            
            # Convert messages to the format expected by Harmony encoder
            # Harmony expects a list of dicts with 'role' and 'content'
            prompt = encode_conversations_with_harmony(
                messages,
                add_generation_prompt=True,
                tokenize=False
            )
            logger.info(f"✅ Used Harmony encoding for GPT-OSS model")
            logger.info(f"📝 Formatted prompt (first 300 chars): {prompt[:300]}")
            logger.info(f"📝 Formatted prompt (last 150 chars): {prompt[-150:]}")
            return prompt
            
        except ImportError:
            logger.warning("⚠️ unsloth_zoo not available, trying standard chat template")
        except Exception as e:
            logger.warning(f"⚠️ Harmony encoding failed: {e}, trying standard chat template")
        
        # Fallback to standard chat template
        if self.tokenizer and hasattr(self.tokenizer, 'apply_chat_template'):
            try:
                prompt = self.tokenizer.apply_chat_template(
                    messages,
                    tokenize=False,
                    add_generation_prompt=True
                )
                logger.info(f"📝 Used standard chat template")
                logger.info(f"📝 Formatted prompt (first 300 chars): {prompt[:300]}")
                return prompt
            except Exception as e:
                logger.warning(f"⚠️ Chat template failed: {e}")
                logger.warning(f"Traceback: {traceback.format_exc()}")

        # Final fallback - simple format
        logger.warning("⚠️ Using simple fallback prompt formatting")
        prompt = ""
        for msg in messages:
            role = msg.get("role", "user")
            content = msg.get("content", "")
            if role == "system":
                prompt += f"System: {content}\n\n"
            elif role == "user":
                prompt += f"User: {content}\n\n"
            elif role == "assistant":
                prompt += f"Assistant: {content}\n\n"
        prompt += "Assistant:"
        logger.info(f"📝 Fallback prompt (first 200 chars): {prompt[:200]}")
        return prompt

    def get_status(self) -> Dict[str, Any]:
        """Get model status information"""
        status = {
            "model_name": self.model_name,
            "precision": self.precision.value if self.precision else "uninitialized",
            "engine": "vllm" if self.is_vllm else "unsloth-4bit",
            "model_loaded": self.model is not None,
            "max_model_len": self.max_model_len,
        }

        if torch.cuda.is_available():
            status["gpu_memory_allocated_gb"] = round(
                torch.cuda.memory_allocated(0) / (1024 ** 3), 2
            )
            status["gpu_memory_reserved_gb"] = round(
                torch.cuda.memory_reserved(0) / (1024 ** 3), 2
            )

        return status
