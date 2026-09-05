"""
Monitoring and Logging Infrastructure
=====================================
Error handling, logging, and monitoring stubs for the chatbot system.

Features:
- Structured logging
- Error tracking
- Performance metrics
- Health checks
- Alert hooks

Author: Simorgh Industrial Assistant
"""

import logging
import time
import json
from typing import Dict, Any, List, Optional, Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from collections import defaultdict
from enum import Enum
import traceback

logger = logging.getLogger(__name__)


# =============================================================================
# ENUMS
# =============================================================================

class LogLevel(str, Enum):
    """Log levels"""
    DEBUG = "debug"
    INFO = "info"
    WARNING = "warning"
    ERROR = "error"
    CRITICAL = "critical"


class MetricType(str, Enum):
    """Types of metrics"""
    COUNTER = "counter"
    GAUGE = "gauge"
    HISTOGRAM = "histogram"
    TIMER = "timer"


class AlertSeverity(str, Enum):
    """Alert severity levels"""
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


# =============================================================================
# DATA CLASSES
# =============================================================================

@dataclass
class LogEntry:
    """Structured log entry"""
    timestamp: datetime
    level: LogLevel
    component: str
    message: str
    context: Dict[str, Any] = field(default_factory=dict)
    user_id: Optional[str] = None
    chat_id: Optional[str] = None
    error: Optional[str] = None
    traceback: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "timestamp": self.timestamp.isoformat(),
            "level": self.level.value,
            "component": self.component,
            "message": self.message,
            "context": self.context,
            "user_id": self.user_id,
            "chat_id": self.chat_id,
            "error": self.error,
            "traceback": self.traceback,
        }

    def to_json(self) -> str:
        return json.dumps(self.to_dict())


@dataclass
class Metric:
    """Metric data point"""
    name: str
    metric_type: MetricType
    value: float
    timestamp: datetime = field(default_factory=datetime.utcnow)
    tags: Dict[str, str] = field(default_factory=dict)
    unit: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "type": self.metric_type.value,
            "value": self.value,
            "timestamp": self.timestamp.isoformat(),
            "tags": self.tags,
            "unit": self.unit,
        }


@dataclass
class Alert:
    """Alert notification"""
    alert_id: str
    severity: AlertSeverity
    component: str
    message: str
    timestamp: datetime = field(default_factory=datetime.utcnow)
    context: Dict[str, Any] = field(default_factory=dict)
    resolved: bool = False
    resolved_at: Optional[datetime] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "alert_id": self.alert_id,
            "severity": self.severity.value,
            "component": self.component,
            "message": self.message,
            "timestamp": self.timestamp.isoformat(),
            "context": self.context,
            "resolved": self.resolved,
            "resolved_at": self.resolved_at.isoformat() if self.resolved_at else None,
        }


@dataclass
class HealthStatus:
    """Component health status"""
    component: str
    healthy: bool
    latency_ms: float = 0.0
    last_check: datetime = field(default_factory=datetime.utcnow)
    error: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "component": self.component,
            "healthy": self.healthy,
            "latency_ms": self.latency_ms,
            "last_check": self.last_check.isoformat(),
            "error": self.error,
            "metadata": self.metadata,
        }


# =============================================================================
# CHATBOT MONITOR
# =============================================================================

class ChatbotMonitor:
    """
    Central monitoring and observability hub.

    Features:
    - Structured logging with context
    - Metrics collection
    - Error tracking
    - Health checks
    - Alert management
    """

    def __init__(
        self,
        app_name: str = "simorgh-chatbot",
        log_level: LogLevel = LogLevel.INFO,
        max_logs: int = 10000,
        max_metrics: int = 100000,
        max_alerts: int = 1000,
    ):
        """
        Initialize monitor.

        Args:
            app_name: Application name for logging
            log_level: Minimum log level
            max_logs: Maximum log entries to keep in memory
            max_metrics: Maximum metrics to keep
            max_alerts: Maximum alerts to keep
        """
        self.app_name = app_name
        self.log_level = log_level
        self.max_logs = max_logs
        self.max_metrics = max_metrics
        self.max_alerts = max_alerts

        # Storage
        self._logs: List[LogEntry] = []
        self._metrics: Dict[str, List[Metric]] = defaultdict(list)
        self._alerts: List[Alert] = []
        self._active_alerts: Dict[str, Alert] = {}

        # Health check registry
        self._health_checks: Dict[str, Callable] = {}
        self._health_cache: Dict[str, HealthStatus] = {}

        # Alert hooks
        self._alert_hooks: List[Callable[[Alert], None]] = []

        # Counters
        self._counters: Dict[str, int] = defaultdict(int)
        self._gauges: Dict[str, float] = {}

        # Timers
        self._active_timers: Dict[str, float] = {}

        logger.info(f"ChatbotMonitor initialized for {app_name}")

    # =========================================================================
    # LOGGING
    # =========================================================================

    def log(
        self,
        level: LogLevel,
        component: str,
        message: str,
        context: Optional[Dict[str, Any]] = None,
        user_id: Optional[str] = None,
        chat_id: Optional[str] = None,
        error: Optional[Exception] = None,
    ):
        """
        Log a structured message.

        Args:
            level: Log level
            component: Component name
            message: Log message
            context: Additional context
            user_id: User identifier
            chat_id: Chat identifier
            error: Exception if any
        """
        # Check level
        level_order = [LogLevel.DEBUG, LogLevel.INFO, LogLevel.WARNING, LogLevel.ERROR, LogLevel.CRITICAL]
        if level_order.index(level) < level_order.index(self.log_level):
            return

        entry = LogEntry(
            timestamp=datetime.utcnow(),
            level=level,
            component=component,
            message=message,
            context=context or {},
            user_id=user_id,
            chat_id=chat_id,
            error=str(error) if error else None,
            traceback=traceback.format_exc() if error else None,
        )

        # Store log
        self._logs.append(entry)
        if len(self._logs) > self.max_logs:
            self._logs = self._logs[-self.max_logs:]

        # Also log to Python logger
        log_msg = f"[{component}] {message}"
        if context:
            log_msg += f" | Context: {context}"

        getattr(logger, level.value)(log_msg)

    def debug(self, component: str, message: str, **kwargs):
        """Log debug message"""
        self.log(LogLevel.DEBUG, component, message, **kwargs)

    def info(self, component: str, message: str, **kwargs):
        """Log info message"""
        self.log(LogLevel.INFO, component, message, **kwargs)

    def warning(self, component: str, message: str, **kwargs):
        """Log warning message"""
        self.log(LogLevel.WARNING, component, message, **kwargs)

    def error(self, component: str, message: str, **kwargs):
        """Log error message"""
        self.log(LogLevel.ERROR, component, message, **kwargs)

    def critical(self, component: str, message: str, **kwargs):
        """Log critical message"""
        self.log(LogLevel.CRITICAL, component, message, **kwargs)

    def get_logs(
        self,
        level: Optional[LogLevel] = None,
        component: Optional[str] = None,
        since: Optional[datetime] = None,
        limit: int = 100,
    ) -> List[LogEntry]:
        """Get filtered logs"""
        logs = self._logs

        if level:
            logs = [l for l in logs if l.level == level]

        if component:
            logs = [l for l in logs if l.component == component]

        if since:
            logs = [l for l in logs if l.timestamp >= since]

        return logs[-limit:]

    # =========================================================================
    # METRICS
    # =========================================================================

    def record_metric(
        self,
        name: str,
        value: float,
        metric_type: MetricType = MetricType.GAUGE,
        tags: Optional[Dict[str, str]] = None,
        unit: Optional[str] = None,
    ):
        """
        Record a metric.

        Args:
            name: Metric name
            value: Metric value
            metric_type: Type of metric
            tags: Metric tags
            unit: Measurement unit
        """
        metric = Metric(
            name=name,
            metric_type=metric_type,
            value=value,
            tags=tags or {},
            unit=unit,
        )

        self._metrics[name].append(metric)

        # Trim old metrics
        if len(self._metrics[name]) > self.max_metrics // 100:
            self._metrics[name] = self._metrics[name][-self.max_metrics // 100:]

    def increment(self, name: str, value: int = 1, tags: Optional[Dict[str, str]] = None):
        """Increment a counter"""
        self._counters[name] += value
        self.record_metric(name, self._counters[name], MetricType.COUNTER, tags)

    def gauge(self, name: str, value: float, tags: Optional[Dict[str, str]] = None):
        """Set a gauge value"""
        self._gauges[name] = value
        self.record_metric(name, value, MetricType.GAUGE, tags)

    def timer_start(self, name: str):
        """Start a timer"""
        self._active_timers[name] = time.time()

    def timer_stop(self, name: str, tags: Optional[Dict[str, str]] = None) -> float:
        """Stop a timer and record the duration"""
        if name not in self._active_timers:
            return 0.0

        duration = (time.time() - self._active_timers[name]) * 1000
        del self._active_timers[name]

        self.record_metric(f"{name}_ms", duration, MetricType.TIMER, tags, unit="ms")
        return duration

    def get_metrics(
        self,
        name: Optional[str] = None,
        since: Optional[datetime] = None,
    ) -> Dict[str, List[Metric]]:
        """Get metrics"""
        if name:
            metrics = {name: self._metrics.get(name, [])}
        else:
            metrics = dict(self._metrics)

        if since:
            metrics = {
                k: [m for m in v if m.timestamp >= since]
                for k, v in metrics.items()
            }

        return metrics

    # =========================================================================
    # HEALTH CHECKS
    # =========================================================================

    def register_health_check(
        self,
        component: str,
        check_fn: Callable[[], Dict[str, Any]],
    ):
        """
        Register a health check function.

        Args:
            component: Component name
            check_fn: Function that returns health status dict
        """
        self._health_checks[component] = check_fn
        self.info("monitor", f"Registered health check for {component}")

    async def check_health(
        self,
        component: Optional[str] = None,
    ) -> Dict[str, HealthStatus]:
        """
        Run health checks.

        Args:
            component: Specific component to check (None = all)

        Returns:
            Dict of component -> HealthStatus
        """
        results = {}

        checks = {component: self._health_checks[component]} if component else self._health_checks

        for comp, check_fn in checks.items():
            start_time = time.time()
            try:
                result = check_fn()
                latency = (time.time() - start_time) * 1000

                status = HealthStatus(
                    component=comp,
                    healthy=result.get("status") == "healthy",
                    latency_ms=latency,
                    metadata=result,
                )

            except Exception as e:
                latency = (time.time() - start_time) * 1000
                status = HealthStatus(
                    component=comp,
                    healthy=False,
                    latency_ms=latency,
                    error=str(e),
                )

            results[comp] = status
            self._health_cache[comp] = status

        return results

    def get_cached_health(self) -> Dict[str, HealthStatus]:
        """Get cached health status"""
        return self._health_cache.copy()

    # =========================================================================
    # ALERTS
    # =========================================================================

    def alert(
        self,
        severity: AlertSeverity,
        component: str,
        message: str,
        context: Optional[Dict[str, Any]] = None,
    ) -> Alert:
        """
        Create an alert.

        Args:
            severity: Alert severity
            component: Component raising alert
            message: Alert message
            context: Additional context

        Returns:
            Created Alert
        """
        import uuid

        alert = Alert(
            alert_id=str(uuid.uuid4()),
            severity=severity,
            component=component,
            message=message,
            context=context or {},
        )

        self._alerts.append(alert)
        self._active_alerts[alert.alert_id] = alert

        # Trim old alerts
        if len(self._alerts) > self.max_alerts:
            self._alerts = self._alerts[-self.max_alerts:]

        # Call alert hooks
        for hook in self._alert_hooks:
            try:
                hook(alert)
            except Exception as e:
                logger.error(f"Alert hook error: {e}")

        # Log the alert
        self.log(
            level=LogLevel.ERROR if severity in [AlertSeverity.HIGH, AlertSeverity.CRITICAL] else LogLevel.WARNING,
            component=component,
            message=f"ALERT [{severity.value}]: {message}",
            context=context,
        )

        return alert

    def resolve_alert(self, alert_id: str):
        """Resolve an active alert"""
        if alert_id in self._active_alerts:
            alert = self._active_alerts[alert_id]
            alert.resolved = True
            alert.resolved_at = datetime.utcnow()
            del self._active_alerts[alert_id]

            self.info("monitor", f"Alert resolved: {alert_id}")

    def get_active_alerts(self) -> List[Alert]:
        """Get all active (unresolved) alerts"""
        return list(self._active_alerts.values())

    def add_alert_hook(self, hook: Callable[[Alert], None]):
        """Add a hook to be called on new alerts"""
        self._alert_hooks.append(hook)

    # =========================================================================
    # ERROR TRACKING
    # =========================================================================

    def track_error(
        self,
        error: Exception,
        component: str,
        context: Optional[Dict[str, Any]] = None,
        user_id: Optional[str] = None,
        chat_id: Optional[str] = None,
        create_alert: bool = True,
    ):
        """
        Track an error.

        Args:
            error: The exception
            component: Component where error occurred
            context: Additional context
            user_id: User identifier
            chat_id: Chat identifier
            create_alert: Whether to create an alert
        """
        # Log the error
        self.log(
            level=LogLevel.ERROR,
            component=component,
            message=str(error),
            context=context,
            user_id=user_id,
            chat_id=chat_id,
            error=error,
        )

        # Increment error counter
        self.increment(f"errors.{component}")

        # Create alert if requested
        if create_alert:
            self.alert(
                severity=AlertSeverity.HIGH,
                component=component,
                message=f"Error: {str(error)}",
                context={
                    "error_type": type(error).__name__,
                    "traceback": traceback.format_exc(),
                    **(context or {}),
                },
            )

    # =========================================================================
    # SUMMARY METHODS
    # =========================================================================

    def get_summary(self) -> Dict[str, Any]:
        """Get monitoring summary"""
        return {
            "app_name": self.app_name,
            "log_counts": {
                level.value: len([l for l in self._logs if l.level == level])
                for level in LogLevel
            },
            "active_alerts": len(self._active_alerts),
            "total_alerts": len(self._alerts),
            "counters": dict(self._counters),
            "gauges": dict(self._gauges),
            "health_status": {
                k: v.healthy for k, v in self._health_cache.items()
            },
            "metrics_count": sum(len(v) for v in self._metrics.values()),
        }

    def export_logs(
        self,
        since: Optional[datetime] = None,
        format: str = "json",
    ) -> str:
        """Export logs in specified format"""
        logs = self.get_logs(since=since, limit=self.max_logs)

        if format == "json":
            return json.dumps([l.to_dict() for l in logs], indent=2)
        else:
            return "\n".join([l.to_json() for l in logs])


# =============================================================================
# DECORATORS
# =============================================================================

def monitor_function(component: str, monitor: Optional[ChatbotMonitor] = None):
    """
    Decorator to monitor function execution.

    Args:
        component: Component name
        monitor: Monitor instance (uses global if None)
    """
    def decorator(func):
        async def async_wrapper(*args, **kwargs):
            mon = monitor or get_monitor()
            mon.timer_start(f"{component}.{func.__name__}")
            try:
                result = await func(*args, **kwargs)
                mon.timer_stop(f"{component}.{func.__name__}")
                mon.increment(f"{component}.{func.__name__}.success")
                return result
            except Exception as e:
                mon.timer_stop(f"{component}.{func.__name__}")
                mon.track_error(e, component)
                raise

        def sync_wrapper(*args, **kwargs):
            mon = monitor or get_monitor()
            mon.timer_start(f"{component}.{func.__name__}")
            try:
                result = func(*args, **kwargs)
                mon.timer_stop(f"{component}.{func.__name__}")
                mon.increment(f"{component}.{func.__name__}.success")
                return result
            except Exception as e:
                mon.timer_stop(f"{component}.{func.__name__}")
                mon.track_error(e, component)
                raise

        import asyncio
        if asyncio.iscoroutinefunction(func):
            return async_wrapper
        return sync_wrapper

    return decorator


# =============================================================================
# SINGLETON
# =============================================================================

_monitor: Optional[ChatbotMonitor] = None


def get_monitor(
    app_name: str = "simorgh-chatbot",
    log_level: LogLevel = LogLevel.INFO,
) -> ChatbotMonitor:
    """Get or create monitor singleton"""
    global _monitor

    if _monitor is None:
        _monitor = ChatbotMonitor(
            app_name=app_name,
            log_level=log_level,
        )

    return _monitor
