"""
Unit tests for ModelManager
"""

import pytest
from unittest.mock import Mock, patch, AsyncMock, MagicMock
from services.model_manager import ModelManager, ModelPrecision


class TestModelManager:
    """Test ModelManager functionality"""

    @pytest.fixture
    def model_manager(self):
        """Create ModelManager instance for testing"""
        return ModelManager(
            model_name="test-model",
            model_path="/tmp/test-model",
            max_model_len=2048,
            gpu_memory_utilization=0.8,
        )

    def test_initialization(self, model_manager):
        """Test ModelManager initialization"""
        assert model_manager.model_name == "test-model"
        assert model_manager.model_path == "/tmp/test-model"
        assert model_manager.max_model_len == 2048
        assert model_manager.model is None
        assert model_manager.tokenizer is None
        assert model_manager.precision is None

    @patch('services.model_manager.torch')
    def test_get_gpu_memory(self, mock_torch, model_manager):
        """Test GPU memory detection"""
        mock_torch.cuda.is_available.return_value = True
        mock_props = Mock(total_memory=24 * 1024**3)  # 24GB
        mock_torch.cuda.get_device_properties.return_value = mock_props

        memory = model_manager._get_gpu_memory()
        assert memory == 24.0

    @patch('services.model_manager.torch')
    def test_get_gpu_memory_no_cuda(self, mock_torch, model_manager):
        """Test GPU memory when CUDA not available"""
        mock_torch.cuda.is_available.return_value = False
        memory = model_manager._get_gpu_memory()
        assert memory == 0.0

    def test_format_messages(self, model_manager):
        """Test message formatting"""
        messages = [
            {"role": "system", "content": "You are helpful"},
            {"role": "user", "content": "Hello"}
        ]

        # Test fallback formatting
        model_manager.tokenizer = None
        prompt = model_manager._format_messages(messages)

        assert "system:" in prompt.lower() or "you are helpful" in prompt.lower()
        assert "user:" in prompt.lower() or "hello" in prompt.lower()

    def test_format_messages_with_harmony_encoding(self, model_manager):
        """Test message formatting with Harmony encoding (GPT-OSS models)"""
        messages = [
            {"role": "system", "content": "You are helpful"},
            {"role": "user", "content": "Hello"}
        ]
        
        # Mock the Harmony encoding by patching at module level
        expected_prompt = "<|start|>system<|channel|>final<|message|>You are helpful<|end|><|start|>user<|channel|>final<|message|>Hello<|end|>"
        
        with patch('services.model_manager.encode_conversations_with_harmony', return_value=expected_prompt) as mock_harmony:
            model_manager.is_vllm = True
            prompt = model_manager._format_messages(messages)
            
            # Verify Harmony encoder was called correctly
            mock_harmony.assert_called_once_with(
                messages,
                add_generation_prompt=True,
                tokenize=False
            )
            assert prompt == expected_prompt

    def test_format_messages_harmony_import_error_fallback(self, model_manager):
        """Test that formatting falls back when Harmony encoding is not available"""
        messages = [
            {"role": "system", "content": "You are helpful"},
            {"role": "user", "content": "Hello"}
        ]
        
        # Simulate ImportError when trying to import Harmony encoder
        with patch('services.model_manager.encode_conversations_with_harmony', side_effect=ImportError("No module named 'unsloth_zoo'")):
            # Set up a mock tokenizer for fallback
            mock_tokenizer = Mock()
            mock_tokenizer.apply_chat_template.return_value = "fallback prompt"
            model_manager.tokenizer = mock_tokenizer
            model_manager.is_vllm = True
            
            prompt = model_manager._format_messages(messages)
            
            # Should fall back to standard chat template
            assert prompt == "fallback prompt"
            mock_tokenizer.apply_chat_template.assert_called_once()

    def test_format_messages_harmony_encoding_error_fallback(self, model_manager):
        """Test that formatting falls back when Harmony encoding raises an exception"""
        messages = [
            {"role": "system", "content": "You are helpful"},
            {"role": "user", "content": "Hello"}
        ]
        
        # Simulate an error during Harmony encoding
        with patch('services.model_manager.encode_conversations_with_harmony', side_effect=Exception("Harmony encoding failed")):
            # Set up a mock tokenizer for fallback
            mock_tokenizer = Mock()
            mock_tokenizer.apply_chat_template.return_value = "fallback prompt"
            model_manager.tokenizer = mock_tokenizer
            model_manager.is_vllm = True
            
            prompt = model_manager._format_messages(messages)
            
            # Should fall back to standard chat template
            assert prompt == "fallback prompt"
            mock_tokenizer.apply_chat_template.assert_called_once()

    @pytest.mark.asyncio
    async def test_generate_vllm_garbage_detection(self, model_manager):
        """Test that garbage output is detected and handled in vLLM generation"""
        # Set up model manager as vLLM
        model_manager.is_vllm = True
        model_manager.model = Mock()
        model_manager.tokenizer = Mock()
        
        # Mock _format_messages to return a simple prompt
        model_manager._format_messages = Mock(return_value="test prompt")
        
        # Create garbage output
        garbage_output = "!" * 120  # 120 exclamation marks
        
        # Mock the vLLM generate call
        mock_output = Mock()
        mock_output.outputs = [Mock()]
        mock_output.outputs[0].text = garbage_output
        mock_output.outputs[0].token_ids = [1] * 100  # 100 tokens
        model_manager.model.generate.return_value = [mock_output]
        
        messages = [{"role": "user", "content": "test"}]
        
        # Patch vLLM imports and asyncio
        with patch('services.model_manager.SamplingParams'):
            with patch('asyncio.get_event_loop') as mock_loop:
                # Set up the event loop mock
                mock_event_loop = Mock()
                async def mock_executor(executor, func):
                    return func()
                mock_event_loop.run_in_executor = AsyncMock(side_effect=mock_executor)
                mock_loop.return_value = mock_event_loop
                
                result, tokens = await model_manager._generate_vllm(messages, 100, 0.7, 0.95)
        
        # Verify that error message was returned instead of garbage
        assert "technical issue" in result
        assert "!!!" not in result

    @pytest.mark.asyncio
    async def test_generate_vllm_normal_output(self, model_manager):
        """Test that normal output passes through without garbage detection"""
        # Set up model manager as vLLM
        model_manager.is_vllm = True
        model_manager.model = Mock()
        model_manager.tokenizer = Mock()
        
        # Mock _format_messages to return a simple prompt
        model_manager._format_messages = Mock(return_value="test prompt")
        
        # Create normal output
        normal_output = "This is a normal response with good diversity in characters and words."
        
        # Mock the vLLM generate call
        mock_output = Mock()
        mock_output.outputs = [Mock()]
        mock_output.outputs[0].text = normal_output
        mock_output.outputs[0].token_ids = [1] * 15  # 15 tokens
        model_manager.model.generate.return_value = [mock_output]
        
        messages = [{"role": "user", "content": "test"}]
        
        # Patch vLLM imports and asyncio
        with patch('services.model_manager.SamplingParams'):
            with patch('asyncio.get_event_loop') as mock_loop:
                # Set up the event loop mock
                mock_event_loop = Mock()
                async def mock_executor(executor, func):
                    return func()
                mock_event_loop.run_in_executor = AsyncMock(side_effect=mock_executor)
                mock_loop.return_value = mock_event_loop
                
                result, tokens = await model_manager._generate_vllm(messages, 100, 0.7, 0.95)
        
        # Verify that normal output was returned
        assert result == normal_output
        assert tokens == 15

    @patch('services.model_manager.torch')
    @pytest.mark.asyncio
    async def test_vllm_tokenizer_loads_from_model_path(
        self, mock_torch, model_manager
    ):
        """Test that vLLM loads tokenizer from model path, NOT LoRA adapter path"""
        # Setup mocks
        mock_torch.cuda.is_available.return_value = True
        mock_props = Mock(total_memory=25 * 1024**3)  # 25GB
        mock_torch.cuda.get_device_properties.return_value = mock_props
        mock_torch.cuda.empty_cache = Mock()
        
        with patch('os.path.exists', return_value=True):
            with patch('services.model_manager.LLM') as mock_llm:
                with patch('services.model_manager.AutoTokenizer') as mock_tokenizer:
                    with patch('services.model_manager.gc'):
                        mock_tokenizer_instance = Mock()
                        mock_tokenizer_instance.chat_template = "test_template"
                        mock_tokenizer.from_pretrained.return_value = mock_tokenizer_instance
                        
                        mock_llm_instance = Mock()
                        mock_llm.return_value = mock_llm_instance
                        
                        # Set LoRA adapter path to verify it's NOT used
                        model_manager.lora_adapter_path = "/tmp/lora_adapter"
                        
                        # Run vLLM initialization
                        await model_manager._try_vllm_init()
                        
                        # Verify tokenizer was loaded from MODEL PATH, not LoRA adapter path
                        mock_tokenizer.from_pretrained.assert_called_once()
                        call_args = mock_tokenizer.from_pretrained.call_args
                        
                        # The tokenizer path should be model_path_to_use (either model_path or model_name)
                        # It should NOT be the LoRA adapter path
                        tokenizer_path_used = call_args[0][0]
                        assert tokenizer_path_used != "/tmp/lora_adapter", \
                            "vLLM should NOT load tokenizer from LoRA adapter path"
                        assert tokenizer_path_used in [model_manager.model_path, model_manager.model_name], \
                            "vLLM should load tokenizer from model path or model name"

    @patch('services.model_manager.torch')
    def test_get_status_uninitialized(self, mock_torch, model_manager):
        """Test status when model not initialized"""
        mock_torch.cuda.is_available.return_value = False
        status = model_manager.get_status()

        assert status["model_name"] == "test-model"
        assert status["model_loaded"] is False
        assert status["precision"] == "uninitialized"

    @pytest.mark.asyncio
    async def test_generate_not_initialized(self, model_manager):
        """Test generation fails when model not initialized"""
        with pytest.raises(RuntimeError, match="Model not initialized"):
            await model_manager.generate(
                messages=[{"role": "user", "content": "test"}]
            )

    @pytest.mark.asyncio
    async def test_generate_stream_not_initialized(self, model_manager):
        """Test streaming fails when model not initialized"""
        with pytest.raises(RuntimeError, match="Model not initialized"):
            async for _ in model_manager.generate_stream(
                messages=[{"role": "user", "content": "test"}]
            ):
                pass


@pytest.mark.asyncio
class TestModelManagerIntegration:
    """Integration tests requiring actual GPU/model"""

    @patch('services.model_manager.torch')
    async def test_initialization_fallback_4bit(self, mock_torch):
        """
        Test that initialization falls back to 4-bit when vLLM fails.
        This test requires actual GPU and model availability.
        """
        # This would require actual model files - skip in CI
        pytest.skip("Requires actual model files and GPU")

    @patch('services.model_manager.torch')
    async def test_vllm_initialization(self, mock_torch):
        """
        Test vLLM initialization with sufficient GPU memory.
        This test requires actual GPU and model availability.
        """
        pytest.skip("Requires actual vLLM installation and model files")
