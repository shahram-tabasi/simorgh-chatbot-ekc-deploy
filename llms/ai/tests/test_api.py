"""
Integration tests for FastAPI endpoints
"""

import pytest
from fastapi.testclient import TestClient
from unittest.mock import Mock, patch, AsyncMock
import json

# Mock the model manager before importing app
mock_model_manager = Mock()
mock_model_manager.model = Mock()
mock_model_manager.tokenizer = Mock()
mock_model_manager.model_name = "test-model"
mock_model_manager.get_status = Mock(return_value={
    "model_name": "test-model",
    "precision": "16-bit",
    "engine": "vllm",
    "model_loaded": True,
    "max_model_len": 4096,
    "gpu_memory_allocated_gb": 10.5,
    "gpu_memory_reserved_gb": 12.0,
})


class TestHealthEndpoint:
    """Test health check endpoint"""

    @pytest.fixture
    def client(self):
        """Create test client"""
        with patch('app.model_manager', mock_model_manager):
            from app import app
            with TestClient(app) as client:
                yield client

    def test_health_check_success(self, client):
        """Test health check returns correct status"""
        response = client.get("/health")

        assert response.status_code == 200
        data = response.json()

        assert data["status"] == "healthy"
        assert data["model"] == "test-model"
        assert data["precision"] == "16-bit"
        assert data["model_loaded"] is True
        assert data["engine"] == "vllm"


class TestModelsEndpoint:
    """Test /v1/models endpoint"""

    @pytest.fixture
    def client(self):
        """Create test client"""
        with patch('app.model_manager', mock_model_manager):
            from app import app
            with TestClient(app) as client:
                yield client

    def test_list_models(self, client):
        """Test listing models"""
        response = client.get("/v1/models")

        assert response.status_code == 200
        data = response.json()

        assert data["object"] == "list"
        assert len(data["data"]) > 0
        assert data["data"][0]["id"] == "test-model"


class TestChatCompletionsEndpoint:
    """Test /v1/chat/completions endpoint"""

    @pytest.fixture
    def client(self):
        """Create test client with mocked model manager"""
        # Mock generate method
        async def mock_generate(messages, **kwargs):
            return "This is a test response", 10

        mock_model_manager.generate = AsyncMock(side_effect=mock_generate)

        with patch('app.model_manager', mock_model_manager):
            with patch('app.langchain_agent', None):
                from app import app
                with TestClient(app) as client:
                    yield client

    def test_chat_completion_non_streaming(self, client):
        """Test non-streaming chat completion"""
        request_data = {
            "model": "test-model",
            "messages": [
                {"role": "user", "content": "Hello, how are you?"}
            ],
            "temperature": 0.7,
            "max_tokens": 100,
            "stream": False
        }

        response = client.post("/v1/chat/completions", json=request_data)

        assert response.status_code == 200
        data = response.json()

        assert data["object"] == "chat.completion"
        assert len(data["choices"]) == 1
        assert data["choices"][0]["message"]["role"] == "assistant"
        assert data["choices"][0]["message"]["content"] == "This is a test response"
        assert data["choices"][0]["finish_reason"] == "stop"
        assert "usage" in data
        assert data["usage"]["completion_tokens"] == 10

    def test_chat_completion_validation_error(self, client):
        """Test validation error handling"""
        request_data = {
            "model": "test-model",
            "messages": "invalid",  # Should be array
        }

        response = client.post("/v1/chat/completions", json=request_data)

        assert response.status_code == 422

    def test_chat_completion_with_system_message(self, client):
        """Test chat completion with system message"""
        request_data = {
            "model": "test-model",
            "messages": [
                {"role": "system", "content": "You are a helpful assistant"},
                {"role": "user", "content": "Hello"}
            ],
            "stream": False
        }

        response = client.post("/v1/chat/completions", json=request_data)

        assert response.status_code == 200
        data = response.json()
        assert data["choices"][0]["message"]["content"] == "This is a test response"


class TestChatCompletionsStreaming:
    """Test streaming chat completions"""

    @pytest.fixture
    def client(self):
        """Create test client with mocked streaming"""
        async def mock_generate_stream(messages, **kwargs):
            # Yield chunks
            chunks = ["Hello", " world", "!"]
            for chunk in chunks:
                yield chunk

        mock_model_manager.generate_stream = AsyncMock(side_effect=mock_generate_stream)

        with patch('app.model_manager', mock_model_manager):
            with patch('app.langchain_agent', None):
                from app import app
                with TestClient(app) as client:
                    yield client

    def test_chat_completion_streaming(self, client):
        """Test streaming chat completion"""
        request_data = {
            "model": "test-model",
            "messages": [
                {"role": "user", "content": "Hello"}
            ],
            "stream": True
        }

        response = client.post("/v1/chat/completions", json=request_data)

        assert response.status_code == 200
        assert response.headers["content-type"] == "text/event-stream; charset=utf-8"

        # Parse SSE chunks
        chunks = []
        for line in response.iter_lines():
            if line.startswith(b"data: "):
                data_str = line[6:].decode('utf-8')
                if data_str != "[DONE]":
                    chunks.append(data_str)

        assert len(chunks) > 0


class TestLegacyEndpoint:
    """Test legacy /generate endpoint"""

    @pytest.fixture
    def client(self):
        """Create test client"""
        async def mock_generate(messages, **kwargs):
            return "Legacy response", 15

        mock_model_manager.generate = AsyncMock(side_effect=mock_generate)

        with patch('app.model_manager', mock_model_manager):
            with patch('app.langchain_agent', None):
                from app import app
                with TestClient(app) as client:
                    yield client

    def test_legacy_generate_endpoint(self, client):
        """Test backward compatibility with legacy endpoint"""
        request_data = {
            "system_prompt": "You are helpful",
            "user_prompt": "Hello",
            "thinking_level": "medium",
            "max_tokens": 100
        }

        response = client.post("/generate", json=request_data)

        assert response.status_code == 200
        data = response.json()

        assert "output" in data
        assert "tokens_used" in data
        assert data["output"] == "Legacy response"
        assert data["tokens_used"] == 15


@pytest.mark.asyncio
class TestMetricsEndpoint:
    """Test Prometheus metrics endpoint"""

    @pytest.fixture
    def client(self):
        """Create test client"""
        with patch('app.model_manager', mock_model_manager):
            from app import app
            with TestClient(app) as client:
                yield client

    def test_metrics_endpoint(self, client):
        """Test metrics are exposed"""
        response = client.get("/metrics")

        assert response.status_code == 200
        # Metrics should be in Prometheus format
        content = response.json()
        assert isinstance(content, str)
