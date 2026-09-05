"""
Cancellation Service
====================
Handles request cancellation detection and propagation throughout the backend.

When users cancel requests in the frontend, this service ensures all backend
operations stop gracefully to save resources.

Author: Simorgh Industrial Assistant
"""

import asyncio
import logging
from typing import Optional, Callable
from fastapi import Request
from contextlib import contextmanager
import time

logger = logging.getLogger(__name__)


class CancellationToken:
    """
    Cancellation token that can be checked during long-running operations
    """

    def __init__(self, request: Optional[Request] = None):
        """
        Initialize cancellation token

        Args:
            request: FastAPI Request object (used to detect client disconnection)
        """
        self.request = request
        self._cancelled = False
        self._cancel_callbacks = []

    async def is_cancelled(self) -> bool:
        """
        Check if operation should be cancelled

        Returns:
            True if cancelled, False otherwise
        """
        if self._cancelled:
            return True

        # Check if client disconnected
        if self.request:
            try:
                # FastAPI's is_disconnected() is async
                is_disconnected = await self.request.is_disconnected()
                if is_disconnected:
                    logger.warning("🚫 Client disconnected - operation cancelled")
                    self._cancelled = True
                    await self._trigger_cancel_callbacks()
                    return True
            except Exception as e:
                logger.debug(f"Could not check disconnect status: {e}")

        return False

    def cancel(self):
        """Manually cancel the operation"""
        if not self._cancelled:
            self._cancelled = True
            logger.info("🚫 Operation manually cancelled")
            # Note: callbacks will be triggered when is_cancelled() is next called

    def add_cancel_callback(self, callback: Callable):
        """
        Add a callback to run when cancelled

        Args:
            callback: Function to call on cancellation
        """
        self._cancel_callbacks.append(callback)

    async def _trigger_cancel_callbacks(self):
        """Trigger all registered cancel callbacks"""
        for callback in self._cancel_callbacks:
            try:
                if asyncio.iscoroutinefunction(callback):
                    await callback()
                else:
                    callback()
            except Exception as e:
                logger.error(f"Error in cancel callback: {e}")


class CancellationService:
    """
    Service for managing operation cancellation throughout the backend
    """

    @staticmethod
    def create_token(request: Optional[Request] = None) -> CancellationToken:
        """
        Create a new cancellation token

        Args:
            request: FastAPI Request object

        Returns:
            CancellationToken instance
        """
        return CancellationToken(request)

    @staticmethod
    async def check_cancelled(token: Optional[CancellationToken]):
        """
        Check if operation is cancelled and raise exception if so

        Args:
            token: CancellationToken to check

        Raises:
            asyncio.CancelledError: If operation was cancelled
        """
        if token and await token.is_cancelled():
            raise asyncio.CancelledError("Operation cancelled by user")

    @staticmethod
    async def with_cancellation_check(
        token: Optional[CancellationToken],
        operation: Callable,
        *args,
        **kwargs
    ):
        """
        Execute an operation with cancellation checking

        Args:
            token: CancellationToken to check
            operation: Async or sync function to execute
            *args, **kwargs: Arguments to pass to operation

        Returns:
            Result of operation

        Raises:
            asyncio.CancelledError: If cancelled before or during operation
        """
        # Check before starting
        await CancellationService.check_cancelled(token)

        # Execute operation
        if asyncio.iscoroutinefunction(operation):
            result = await operation(*args, **kwargs)
        else:
            result = operation(*args, **kwargs)

        # Check after completing
        await CancellationService.check_cancelled(token)

        return result


class PeriodicCancellationChecker:
    """
    Helper to periodically check for cancellation during long operations
    """

    def __init__(
        self,
        token: Optional[CancellationToken],
        check_interval: float = 0.5
    ):
        """
        Initialize periodic checker

        Args:
            token: CancellationToken to check
            check_interval: How often to check (seconds)
        """
        self.token = token
        self.check_interval = check_interval
        self.last_check = 0

    async def check_now(self):
        """
        Check for cancellation now

        Raises:
            asyncio.CancelledError: If cancelled
        """
        if self.token:
            current_time = time.time()

            # Only check if enough time has passed
            if current_time - self.last_check >= self.check_interval:
                self.last_check = current_time

                if await self.token.is_cancelled():
                    raise asyncio.CancelledError("Operation cancelled by user")


@contextmanager
def cancellation_context(token: Optional[CancellationToken] = None):
    """
    Context manager for operations that need cancellation support

    Usage:
        with cancellation_context(token) as checker:
            # Do some work
            checker.check()  # Raises if cancelled
            # Do more work
            checker.check()
    """
    checker = PeriodicCancellationChecker(token)

    try:
        yield checker
    except asyncio.CancelledError:
        logger.info("🚫 Operation cancelled in context")
        raise
    except Exception as e:
        logger.error(f"Error in cancellation context: {e}")
        raise


def get_cancellation_service() -> CancellationService:
    """FastAPI dependency for cancellation service"""
    return CancellationService()
