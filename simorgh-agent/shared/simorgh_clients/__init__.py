"""Shared client modules used by every simorgh service.

  • runtime_broker  — thin async client for the ephemeral docker exec broker
  • gitlab_mcp      — thin async client for gitlab-mcp REST API
  • shell_service_compat — adapter exposing the OLD ShellServiceClient
                           surface; routes exec → runtime-broker and
                           file/git ops → gitlab-mcp. Lets us delete the
                           shell-service backend without touching every
                           caller in one PR.
"""
from .runtime_broker import RuntimeBrokerClient, get_runtime_broker
from .gitlab_mcp     import GitlabMCPClient, get_gitlab_mcp

__all__ = [
    "RuntimeBrokerClient", "get_runtime_broker",
    "GitlabMCPClient", "get_gitlab_mcp",
]
