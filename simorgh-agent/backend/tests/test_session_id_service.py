"""
Unit Tests for Session ID Service
==================================
Tests the Session ID Generator with Redis-backed atomic counters.

Author: Simorgh Industrial Assistant
"""

import pytest
from datetime import datetime
from unittest.mock import Mock, patch
from services.session_id_service import SessionIDService


class TestSessionIDService:
    """Test Session ID Generation Service"""

    @pytest.fixture
    def mock_redis(self):
        """Create a mock Redis client"""
        mock = Mock()
        mock.incr = Mock(return_value=1)
        mock.expire = Mock()
        mock.get = Mock(return_value=None)
        return mock

    @pytest.fixture
    def service(self, mock_redis):
        """Create SessionIDService with mocked Redis"""
        return SessionIDService(mock_redis)

    def test_generate_general_session_id_format(self, service, mock_redis):
        """Test general session ID format: G-yyyyMM-nnnnnn"""
        # Mock Redis counter
        mock_redis.incr.return_value = 123

        with patch('services.session_id_service.datetime') as mock_datetime:
            mock_datetime.now.return_value = datetime(2025, 12, 3)

            session_id = service.generate_general_session_id()

            # Check format
            assert session_id == "G-202512-000123"
            assert session_id.startswith("G-")

            # Verify Redis was called correctly
            mock_redis.incr.assert_called_once_with("session:counter:general:202512")
            mock_redis.expire.assert_called_once()

    def test_generate_project_session_id_format(self, service, mock_redis):
        """Test project session ID format: P-ProjectID-nnnnnn"""
        # Mock Redis counter
        mock_redis.incr.return_value = 456

        session_id = service.generate_project_session_id("12345")

        # Check format
        assert session_id == "P-12345-000456"
        assert session_id.startswith("P-")

        # Verify Redis was called correctly
        mock_redis.incr.assert_called_once_with("session:counter:project:12345")

    def test_generate_general_session_id_increments(self, service, mock_redis):
        """Test that counter increments for each call"""
        # Simulate incrementing counter
        mock_redis.incr.side_effect = [1, 2, 3]

        id1 = service.generate_general_session_id()
        id2 = service.generate_general_session_id()
        id3 = service.generate_general_session_id()

        # Check that IDs are different
        assert id1 != id2 != id3

        # All should have same prefix (year-month)
        assert id1.split("-")[0] == "G"
        assert id2.split("-")[0] == "G"
        assert id3.split("-")[0] == "G"

    def test_generate_project_session_id_per_project_counter(self, service, mock_redis):
        """Test that each project has its own counter"""
        # Different projects get independent counters
        mock_redis.incr.side_effect = [1, 1, 2]

        id_proj1 = service.generate_project_session_id("12345")
        id_proj2 = service.generate_project_session_id("67890")
        id_proj1_again = service.generate_project_session_id("12345")

        # Check formats
        assert id_proj1 == "P-12345-000001"
        assert id_proj2 == "P-67890-000001"  # Different project, counter resets
        assert id_proj1_again == "P-12345-000002"  # Same project, counter continues

    def test_generate_message_id_format(self, service):
        """Test message ID format: S-{sessionId}-M-nnn"""
        session_id = "G-202512-000123"
        message_id = service.generate_message_id(session_id, 1)

        assert message_id == "S-G-202512-000123-M-001"

        message_id_2 = service.generate_message_id(session_id, 10)
        assert message_id_2 == "S-G-202512-000123-M-010"

    def test_parse_session_id_general(self, service):
        """Test parsing general session ID"""
        session_id = "G-202512-000123"
        category, identifier = service.parse_session_id(session_id)

        assert category == "general"
        assert identifier == "202512"

    def test_parse_session_id_project(self, service):
        """Test parsing project session ID"""
        session_id = "P-12345-000456"
        category, identifier = service.parse_session_id(session_id)

        assert category == "project"
        assert identifier == "12345"

    def test_parse_session_id_invalid(self, service):
        """Test parsing invalid session ID raises error"""
        with pytest.raises(ValueError):
            service.parse_session_id("invalid-id")

        with pytest.raises(ValueError):
            service.parse_session_id("X-202512-000123")

    def test_validate_session_id_valid(self, service):
        """Test validation of valid session IDs"""
        assert service.validate_session_id("G-202512-000123") is True
        assert service.validate_session_id("P-12345-000456") is True

    def test_validate_session_id_invalid(self, service):
        """Test validation of invalid session IDs"""
        assert service.validate_session_id("invalid") is False
        assert service.validate_session_id("G-202512-12") is False  # Wrong length
        assert service.validate_session_id("X-202512-000123") is False  # Wrong category
        assert service.validate_session_id("G-202512") is False  # Missing counter

    def test_get_counter_status_general(self, service, mock_redis):
        """Test getting counter status for general sessions"""
        mock_redis.get.return_value = "123"

        count = service.get_counter_status("general", "202512")

        assert count == 123
        mock_redis.get.assert_called_once_with("session:counter:general:202512")

    def test_get_counter_status_project(self, service, mock_redis):
        """Test getting counter status for project sessions"""
        mock_redis.get.return_value = "456"

        count = service.get_counter_status("project", "12345")

        assert count == 456
        mock_redis.get.assert_called_once_with("session:counter:project:12345")

    def test_get_counter_status_not_set(self, service, mock_redis):
        """Test getting counter status when counter not set"""
        mock_redis.get.return_value = None

        count = service.get_counter_status("general", "202512")

        assert count == 0

    def test_generate_general_session_id_padding(self, service, mock_redis):
        """Test that counter is zero-padded to 6 digits"""
        test_cases = [
            (1, "000001"),
            (12, "000012"),
            (123, "000123"),
            (1234, "001234"),
            (12345, "012345"),
            (123456, "123456"),
        ]

        for counter, expected_suffix in test_cases:
            mock_redis.incr.return_value = counter
            session_id = service.generate_general_session_id()
            assert session_id.endswith(expected_suffix)

    def test_generate_project_session_id_padding(self, service, mock_redis):
        """Test that project counter is zero-padded to 6 digits"""
        mock_redis.incr.return_value = 7

        session_id = service.generate_project_session_id("12345")

        assert session_id == "P-12345-000007"

    def test_monthly_counter_reset(self, service, mock_redis):
        """Test that general counters are per month"""
        mock_redis.incr.side_effect = [1, 1]

        with patch('services.session_id_service.datetime') as mock_datetime:
            # December 2025
            mock_datetime.now.return_value = datetime(2025, 12, 3)
            id_dec = service.generate_general_session_id()

            # January 2026 - different month, different counter
            mock_datetime.now.return_value = datetime(2026, 1, 5)
            id_jan = service.generate_general_session_id()

            # Check that both start at 000001 (different months)
            assert id_dec == "G-202512-000001"
            assert id_jan == "G-202601-000001"

            # Verify Redis was called with different keys
            assert mock_redis.incr.call_count == 2
            calls = [call[0][0] for call in mock_redis.incr.call_args_list]
            assert "session:counter:general:202512" in calls
            assert "session:counter:general:202601" in calls


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
