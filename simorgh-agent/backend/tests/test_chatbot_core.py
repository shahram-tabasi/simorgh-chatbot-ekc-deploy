"""
Chatbot Core Tests
==================
Tests for the enhanced chatbot_core architecture.

Run with: pytest tests/test_chatbot_core.py -v

Author: Simorgh Industrial Assistant
"""

import pytest
import asyncio
from unittest.mock import MagicMock, AsyncMock
from datetime import datetime

# Import chatbot core components
import sys
sys.path.insert(0, '..')

from chatbot_core.models import (
    ChatType,
    SessionStage,
    MemoryTier,
    DocumentCategory,
    UserContext,
    ProjectInfo,
    DocumentContext,
    ChatHistoryEntry,
    GeneralSessionContext,
    ProjectSessionContext,
    ExternalToolConfig,
    ToolCategory,
    PromptTemplate,
)
from chatbot_core.memory_manager import (
    MemoryManager,
    RedisNamespace,
)
from chatbot_core.cocoindex_dataflow import (
    CocoIndexDataflowManager,
    BaseDataflow,
    DataflowStep,
    DataflowMode,
)
from chatbot_core.llm_wrapper import (
    EnhancedLLMWrapper,
    PromptTemplateRegistry,
)
from chatbot_core.session_manager import (
    ChatSessionManager,
)
from chatbot_core.external_tools import (
    ExternalToolsManager,
)
from chatbot_core.document_ingestion import (
    DocumentIngestionPipeline,
    DocumentChunker,
)
from chatbot_core.monitoring import (
    ChatbotMonitor,
    LogLevel,
    MetricType,
    AlertSeverity,
)
from chatbot_core.registry import (
    ExtensionRegistry,
    ExtensionType,
    HookPoint,
)


# =============================================================================
# FIXTURES
# =============================================================================

@pytest.fixture
def mock_redis():
    """Mock Redis service"""
    redis = MagicMock()
    redis.get_chat_history.return_value = [
        {"message_id": "1", "role": "user", "content": "Hello", "timestamp": datetime.utcnow().isoformat()},
        {"message_id": "2", "role": "assistant", "content": "Hi!", "timestamp": datetime.utcnow().isoformat()},
    ]
    redis.ping.return_value = True
    return redis


@pytest.fixture
def mock_qdrant():
    """Mock Qdrant service"""
    qdrant = MagicMock()
    qdrant.add_document_chunks.return_value = True
    qdrant.semantic_search.return_value = []
    qdrant.generate_embedding.return_value = [0.1] * 768
    return qdrant


@pytest.fixture
def mock_neo4j():
    """Mock Neo4j service"""
    neo4j = MagicMock()
    neo4j.get_project_entities.return_value = []
    neo4j.get_project_relationships.return_value = []
    return neo4j


@pytest.fixture
def mock_llm():
    """Mock LLM service"""
    llm = MagicMock()
    llm.generate.return_value = {
        "response": "This is a test response",
        "model": "gpt-4",
        "mode": "online",
        "tokens": {"total": 100, "prompt": 50, "completion": 50},
    }
    llm.health_check.return_value = {"status": "ok", "current_mode": "online"}
    return llm


# =============================================================================
# MODEL TESTS
# =============================================================================

class TestModels:
    """Test data models"""

    def test_user_context(self):
        """Test UserContext creation"""
        user = UserContext(
            user_id="user123",
            username="testuser",
            email="test@example.com",
        )
        assert user.user_id == "user123"
        assert user.username == "testuser"

        data = user.to_dict()
        assert "user_id" in data
        assert data["username"] == "testuser"

    def test_general_session_context(self):
        """Test GeneralSessionContext"""
        user = UserContext(user_id="user123")
        context = GeneralSessionContext(
            chat_id="chat123",
            chat_type=ChatType.GENERAL,
            user=user,
        )

        assert context.chat_type == ChatType.GENERAL
        assert context.enable_internet_search == True
        assert context.enable_wikipedia == True

    def test_project_session_context(self):
        """Test ProjectSessionContext"""
        user = UserContext(user_id="user123")
        project = ProjectInfo(
            project_id="proj1",
            project_number="OE-2024-001",
            project_name="Test Project",
            domain="electrical",
        )

        context = ProjectSessionContext(
            chat_id="chat123",
            chat_type=ChatType.PROJECT,
            user=user,
            project=project,
            stage=SessionStage.ANALYSIS,
        )

        assert context.chat_type == ChatType.PROJECT
        assert context.stage == SessionStage.ANALYSIS
        assert context.allows_external_tools == True

        # Change to DESIGN stage
        context.stage = SessionStage.DESIGN
        assert context.allows_external_tools == False

    def test_external_tool_config(self):
        """Test ExternalToolConfig context checking"""
        config = ExternalToolConfig(
            tool_id="test_tool",
            tool_name="Test Tool",
            category=ToolCategory.INTERNET_SEARCH,
            enabled=True,
            allowed_stages=[SessionStage.ANALYSIS],
            allowed_chat_types=[ChatType.GENERAL, ChatType.PROJECT],
        )

        # Should be allowed for general chat
        assert config.is_allowed_for_context(ChatType.GENERAL) == True

        # Should be allowed for project in ANALYSIS
        assert config.is_allowed_for_context(
            ChatType.PROJECT, SessionStage.ANALYSIS
        ) == True

        # Should NOT be allowed for project in DESIGN
        assert config.is_allowed_for_context(
            ChatType.PROJECT, SessionStage.DESIGN
        ) == False


# =============================================================================
# MEMORY MANAGER TESTS
# =============================================================================

class TestMemoryManager:
    """Test MemoryManager"""

    def test_redis_namespace(self):
        """Test Redis key namespacing"""
        # General chat keys
        assert "general:chat_id:chat123" in RedisNamespace.general_chat("chat123")
        assert "general:chat_id:chat123:history" == RedisNamespace.general_history("chat123")

        # Project chat keys
        assert "project:project_id:proj1" in RedisNamespace.project_chat("proj1", "chat123")
        assert "project:project_id:proj1:shared_history" == RedisNamespace.project_shared_history("proj1")

    @pytest.mark.asyncio
    async def test_memory_manager_init(self, mock_redis):
        """Test MemoryManager initialization"""
        manager = MemoryManager(redis_service=mock_redis)
        assert manager.redis is not None
        assert manager.stats["reads"] == 0

    @pytest.mark.asyncio
    async def test_get_chat_history_general(self, mock_redis):
        """Test getting history for general chat"""
        manager = MemoryManager(redis_service=mock_redis)

        result = await manager.get_chat_history(
            chat_type=ChatType.GENERAL,
            chat_id="chat123",
            limit=10,
        )

        assert result.success == True

    @pytest.mark.asyncio
    async def test_store_message(self, mock_redis):
        """Test storing a message"""
        manager = MemoryManager(redis_service=mock_redis)

        result = await manager.store_message(
            chat_type=ChatType.GENERAL,
            chat_id="chat123",
            user_id="user123",
            role="user",
            content="Test message",
        )

        assert result.success == True
        assert MemoryTier.REDIS in result.tiers_written


# =============================================================================
# SESSION MANAGER TESTS
# =============================================================================

class TestSessionManager:
    """Test ChatSessionManager"""

    @pytest.mark.asyncio
    async def test_create_general_session(self, mock_redis):
        """Test creating a general session"""
        memory = MemoryManager(redis_service=mock_redis)
        manager = ChatSessionManager(memory_manager=memory, redis_service=mock_redis)

        context = await manager.create_general_session(
            user_id="user123",
            username="testuser",
        )

        assert context.chat_type == ChatType.GENERAL
        assert context.user.user_id == "user123"
        assert context.chat_id is not None

    @pytest.mark.asyncio
    async def test_create_project_session(self, mock_redis):
        """Test creating a project session"""
        memory = MemoryManager(redis_service=mock_redis)
        manager = ChatSessionManager(memory_manager=memory, redis_service=mock_redis)

        context = await manager.create_project_session(
            user_id="user123",
            project_id="proj1",
            project_number="OE-2024-001",
            project_name="Test Project",
            stage=SessionStage.ANALYSIS,
        )

        assert context.chat_type == ChatType.PROJECT
        assert context.project.project_number == "OE-2024-001"
        assert context.stage == SessionStage.ANALYSIS
        assert context.allows_external_tools == True


# =============================================================================
# LLM WRAPPER TESTS
# =============================================================================

class TestLLMWrapper:
    """Test EnhancedLLMWrapper"""

    def test_template_registry(self):
        """Test prompt template registry"""
        registry = PromptTemplateRegistry()

        # Check default templates exist
        general = registry.get_for_chat_type(ChatType.GENERAL)
        assert general is not None
        assert general.template_id == "general_default"

        project = registry.get_for_chat_type(ChatType.PROJECT)
        assert project is not None
        assert project.template_id == "project_default"

    def test_build_system_prompt_general(self, mock_llm):
        """Test building system prompt for general chat"""
        wrapper = EnhancedLLMWrapper(llm_service=mock_llm)

        user = UserContext(user_id="user123", username="testuser")
        context = GeneralSessionContext(
            chat_id="chat123",
            chat_type=ChatType.GENERAL,
            user=user,
        )

        prompt = wrapper.build_system_prompt(context)

        assert "Simorgh" in prompt
        assert "industrial" in prompt.lower()

    def test_build_system_prompt_project(self, mock_llm):
        """Test building system prompt for project chat"""
        wrapper = EnhancedLLMWrapper(llm_service=mock_llm)

        user = UserContext(user_id="user123")
        project = ProjectInfo(
            project_id="proj1",
            project_number="OE-2024-001",
            project_name="Test Project",
        )
        context = ProjectSessionContext(
            chat_id="chat123",
            chat_type=ChatType.PROJECT,
            user=user,
            project=project,
            stage=SessionStage.ANALYSIS,
        )

        prompt = wrapper.build_system_prompt(context)

        assert "OE-2024-001" in prompt
        assert "project" in prompt.lower()
        assert "ANALYSIS" in prompt or "analysis" in prompt.lower()


# =============================================================================
# EXTERNAL TOOLS TESTS
# =============================================================================

class TestExternalTools:
    """Test ExternalToolsManager"""

    def test_tools_initialization(self):
        """Test tools manager initialization"""
        manager = ExternalToolsManager()

        # Check default tools registered
        tools = manager.list_tools()
        assert "internet_search" in [t.tool_id for t in tools]
        assert "wikipedia" in [t.tool_id for t in tools]
        assert "python_engine" in [t.tool_id for t in tools]

    def test_tool_availability_general(self):
        """Test tool availability for general chat"""
        manager = ExternalToolsManager()

        user = UserContext(user_id="user123")
        context = GeneralSessionContext(
            chat_id="chat123",
            chat_type=ChatType.GENERAL,
            user=user,
        )

        available = manager.get_available_tools(context)
        assert len(available) > 0

    def test_tool_availability_project_analysis(self):
        """Test tool availability for project in analysis stage"""
        manager = ExternalToolsManager()

        user = UserContext(user_id="user123")
        context = ProjectSessionContext(
            chat_id="chat123",
            chat_type=ChatType.PROJECT,
            user=user,
            stage=SessionStage.ANALYSIS,
        )

        available = manager.get_available_tools(context)
        tool_ids = [t.tool_id for t in available]
        assert "internet_search" in tool_ids
        assert "wikipedia" in tool_ids

    def test_tool_availability_project_design(self):
        """Test tool availability for project in design stage"""
        manager = ExternalToolsManager()

        user = UserContext(user_id="user123")
        context = ProjectSessionContext(
            chat_id="chat123",
            chat_type=ChatType.PROJECT,
            user=user,
            stage=SessionStage.DESIGN,
        )

        available = manager.get_available_tools(context)
        tool_ids = [t.tool_id for t in available]

        # Tools should NOT be available in DESIGN stage
        assert "internet_search" not in tool_ids


# =============================================================================
# DOCUMENT INGESTION TESTS
# =============================================================================

class TestDocumentIngestion:
    """Test DocumentIngestionPipeline"""

    def test_document_chunker(self):
        """Test document chunking"""
        chunker = DocumentChunker(chunk_size=100, overlap=20)

        content = "This is a test. " * 50  # ~800 chars
        chunks = chunker.chunk_by_size(content)

        assert len(chunks) > 1
        for chunk in chunks:
            assert "text" in chunk
            assert "chunk_index" in chunk

    @pytest.mark.asyncio
    async def test_document_ingestion(self, mock_qdrant, mock_llm):
        """Test document ingestion pipeline"""
        pipeline = DocumentIngestionPipeline(
            qdrant_service=mock_qdrant,
            llm_service=mock_llm,
        )

        result = await pipeline.ingest_document(
            content="This is test document content. " * 20,
            filename="test.txt",
            user_id="user123",
            chat_type=ChatType.GENERAL,
            chat_id="chat123",
            category=DocumentCategory.GENERAL,
            generate_summary=False,  # Skip for test
        )

        assert result.success == True
        assert result.chunks_created > 0


# =============================================================================
# MONITORING TESTS
# =============================================================================

class TestMonitoring:
    """Test ChatbotMonitor"""

    def test_logging(self):
        """Test structured logging"""
        monitor = ChatbotMonitor(log_level=LogLevel.DEBUG)

        monitor.info("test", "Test message", context={"key": "value"})
        monitor.warning("test", "Warning message")
        monitor.error("test", "Error message")

        logs = monitor.get_logs(limit=10)
        assert len(logs) >= 3

    def test_metrics(self):
        """Test metrics collection"""
        monitor = ChatbotMonitor()

        monitor.increment("test_counter")
        monitor.increment("test_counter")
        monitor.gauge("test_gauge", 42.5)

        metrics = monitor.get_metrics()
        assert "test_counter" in metrics
        assert "test_gauge" in metrics

    def test_alerts(self):
        """Test alert creation"""
        monitor = ChatbotMonitor()

        alert = monitor.alert(
            AlertSeverity.HIGH,
            "test",
            "Test alert message",
        )

        assert alert.severity == AlertSeverity.HIGH
        assert len(monitor.get_active_alerts()) == 1

        monitor.resolve_alert(alert.alert_id)
        assert len(monitor.get_active_alerts()) == 0


# =============================================================================
# REGISTRY TESTS
# =============================================================================

class TestRegistry:
    """Test ExtensionRegistry"""

    def test_hook_registration(self):
        """Test hook registration and triggering"""
        registry = ExtensionRegistry()

        callback_called = []

        def test_callback(context):
            callback_called.append(context)
            return "result"

        registry.register_hook(
            HookPoint.MESSAGE_RECEIVED,
            test_callback,
        )

        # Trigger hook (sync version for test)
        import asyncio
        loop = asyncio.get_event_loop()
        results = loop.run_until_complete(
            registry.trigger_hook(HookPoint.MESSAGE_RECEIVED, {"test": True})
        )

        assert len(callback_called) == 1
        assert callback_called[0]["test"] == True

    def test_extension_summary(self):
        """Test registry summary"""
        registry = ExtensionRegistry()

        summary = registry.get_summary()
        assert "total_extensions" in summary
        assert "by_type" in summary
        assert "hooks_registered" in summary


# =============================================================================
# INTEGRATION TESTS
# =============================================================================

class TestIntegration:
    """Integration tests"""

    @pytest.mark.asyncio
    async def test_full_chat_flow(self, mock_redis, mock_qdrant, mock_llm):
        """Test complete chat flow"""
        from chatbot_core.integration import ChatbotCore

        # Initialize core
        core = ChatbotCore()
        core.initialize(
            redis_service=mock_redis,
            qdrant_service=mock_qdrant,
            llm_service=mock_llm,
        )

        assert core.is_initialized == True

        # Create chat
        context = await core.create_chat(
            user_id="user123",
            chat_type=ChatType.GENERAL,
            username="testuser",
        )

        assert context.chat_id is not None
        assert context.chat_type == ChatType.GENERAL

        # Send message (mocked)
        # Note: Full flow would require more mock setup
        stats = core.get_stats()
        assert stats["initialized"] == True


# =============================================================================
# RUN TESTS
# =============================================================================

if __name__ == "__main__":
    pytest.main([__file__, "-v"])
