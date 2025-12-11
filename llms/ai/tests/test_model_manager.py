"""
Unit tests for ModelManager
"""

import pytest
import torch
from unittest.mock import Mock, patch, AsyncMock
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

    @patch('torch.cuda.is_available')
    @patch('torch.cuda.get_device_properties')
    def test_get_gpu_memory(self, mock_props, mock_cuda, model_manager):
        """Test GPU memory detection"""
        mock_cuda.return_value = True
        mock_props.return_value = Mock(total_memory=24 * 1024**3)  # 24GB

        memory = model_manager._get_gpu_memory()
        assert memory == 24.0

    @patch('torch.cuda.is_available')
    def test_get_gpu_memory_no_cuda(self, mock_cuda, model_manager):
        """Test GPU memory when CUDA not available"""
        mock_cuda.return_value = False
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

    def test_get_status_uninitialized(self, model_manager):
        """Test status when model not initialized"""
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

    @pytest.mark.skipif(not torch.cuda.is_available(), reason="Requires CUDA")
    async def test_initialization_fallback_4bit(self):
        """
        Test that initialization falls back to 4-bit when vLLM fails.
        This test requires actual GPU and model availability.
        """
        # This would require actual model files - skip in CI
        pytest.skip("Requires actual model files and GPU")

    @pytest.mark.skipif(not torch.cuda.is_available(), reason="Requires CUDA")
    async def test_vllm_initialization(self):
        """
        Test vLLM initialization with sufficient GPU memory.
        This test requires actual GPU and model availability.
        """
        pytest.skip("Requires actual vLLM installation and model files")
