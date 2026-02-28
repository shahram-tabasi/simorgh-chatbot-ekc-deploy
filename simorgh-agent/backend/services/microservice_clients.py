"""
Microservice Clients
======================
HTTP clients for all agent microservices.
Each client wraps a FastAPI microservice with typed async methods.
"""

import logging
import os
from typing import Optional, List, Dict, Any

import httpx

logger = logging.getLogger(__name__)

# Service URLs (configurable via env vars)
SEARCH_SERVICE_URL = os.getenv("SEARCH_SERVICE_URL", "http://search-service:8020")
TPMS_FETCHER_URL = os.getenv("TPMS_FETCHER_URL", "http://tpms-fetcher:8021")
PROJECT_INIT_URL = os.getenv("PROJECT_INIT_URL", "http://project-init:8022")
PROJECT_ANALYSIS_URL = os.getenv("PROJECT_ANALYSIS_URL", "http://project-analysis:8023")
COMMAND_GEN_URL = os.getenv("COMMAND_GEN_URL", "http://command-gen:8024")
FILE_EXPORT_URL = os.getenv("FILE_EXPORT_URL", "http://file-export:8025")
EPLAN_BRIDGE_URL = os.getenv("EPLAN_BRIDGE_URL", "http://eplan-bridge:8026")
MAIL_GATEWAY_URL = os.getenv("MAIL_GATEWAY_URL", "http://mail-gateway:8027")

DEFAULT_TIMEOUT = 60


class SearchServiceClient:
    """Client for the DuckDuckGo search microservice."""

    def __init__(self, base_url: str = None):
        self.base_url = (base_url or SEARCH_SERVICE_URL).rstrip("/")

    async def search(self, query: str, max_results: int = 5,
                     region: str = "wt-wt", time_range: str = None) -> Dict:
        async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT) as client:
            resp = await client.post(f"{self.base_url}/search", json={
                "query": query,
                "max_results": max_results,
                "region": region,
                "time_range": time_range,
            })
            resp.raise_for_status()
            return resp.json()

    async def search_news(self, query: str, max_results: int = 5) -> Dict:
        async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT) as client:
            resp = await client.post(f"{self.base_url}/search/news", json={
                "query": query,
                "max_results": max_results,
            })
            resp.raise_for_status()
            return resp.json()


class TPMSFetcherClient:
    """Client for the TPMS data fetcher microservice."""

    def __init__(self, base_url: str = None):
        self.base_url = (base_url or TPMS_FETCHER_URL).rstrip("/")

    async def fetch_project(self, oenum: str) -> Dict:
        async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT) as client:
            resp = await client.post(f"{self.base_url}/fetch/{oenum}")
            resp.raise_for_status()
            return resp.json()

    async def get_project(self, oenum: str) -> Dict:
        async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT) as client:
            resp = await client.get(f"{self.base_url}/project/{oenum}")
            resp.raise_for_status()
            return resp.json()

    async def get_project_text(self, oenum: str) -> str:
        async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT) as client:
            resp = await client.get(f"{self.base_url}/project/{oenum}/text")
            resp.raise_for_status()
            return resp.json().get("text", "")


class ProjectInitClient:
    """Client for the project initialization microservice."""

    def __init__(self, base_url: str = None):
        self.base_url = (base_url or PROJECT_INIT_URL).rstrip("/")

    async def init_project(self, project_id: str, project_name: str,
                           owner_id: str, oenum: str = None) -> Dict:
        async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT) as client:
            resp = await client.post(f"{self.base_url}/init", json={
                "project_id": project_id,
                "project_name": project_name,
                "owner_id": owner_id,
                "oenum": oenum,
            })
            resp.raise_for_status()
            return resp.json()

    async def get_status(self, init_id: str) -> Dict:
        async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT) as client:
            resp = await client.get(f"{self.base_url}/status/{init_id}")
            resp.raise_for_status()
            return resp.json()


class ProjectAnalysisClient:
    """Client for the project analysis microservice."""

    def __init__(self, base_url: str = None):
        self.base_url = (base_url or PROJECT_ANALYSIS_URL).rstrip("/")

    async def analyze(self, project_id: str, depth: str = "medium") -> Dict:
        async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT) as client:
            resp = await client.post(f"{self.base_url}/analyze", json={
                "project_id": project_id,
                "depth": depth,
            })
            resp.raise_for_status()
            return resp.json()

    async def get_report(self, report_id: str) -> Dict:
        async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT) as client:
            resp = await client.get(f"{self.base_url}/report/{report_id}")
            resp.raise_for_status()
            return resp.json()


class CommandGenClient:
    """Client for the command generation microservice."""

    def __init__(self, base_url: str = None):
        self.base_url = (base_url or COMMAND_GEN_URL).rstrip("/")

    async def generate(self, task_description: str, project_id: str,
                       task_type: str = "search", context: str = None) -> Dict:
        async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT) as client:
            resp = await client.post(f"{self.base_url}/generate", json={
                "task_description": task_description,
                "task_type": task_type,
                "project_id": project_id,
                "context": context,
            })
            resp.raise_for_status()
            return resp.json()

    async def validate(self, command: str) -> Dict:
        async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT) as client:
            resp = await client.post(f"{self.base_url}/validate", json={
                "command": command,
            })
            resp.raise_for_status()
            return resp.json()


class FileExportClient:
    """Client for the file export microservice."""

    def __init__(self, base_url: str = None):
        self.base_url = (base_url or FILE_EXPORT_URL).rstrip("/")

    async def export_excel(self, project_id: str, title: str,
                           tables: List[Dict], filename: str = "export.xlsx") -> Dict:
        async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT) as client:
            resp = await client.post(f"{self.base_url}/export/excel", json={
                "project_id": project_id,
                "title": title,
                "filename": filename,
                "tables": tables,
            })
            resp.raise_for_status()
            return resp.json()

    async def export_word(self, project_id: str, title: str,
                          sections: List[Dict], tables: List[Dict] = None,
                          filename: str = "report.docx") -> Dict:
        async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT) as client:
            resp = await client.post(f"{self.base_url}/export/word", json={
                "project_id": project_id,
                "title": title,
                "filename": filename,
                "sections": sections,
                "tables": tables or [],
            })
            resp.raise_for_status()
            return resp.json()

    async def export_pdf(self, project_id: str, title: str,
                         content: str, filename: str = "report.pdf") -> Dict:
        async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT) as client:
            resp = await client.post(f"{self.base_url}/export/pdf", json={
                "project_id": project_id,
                "title": title,
                "filename": filename,
                "content": content,
            })
            resp.raise_for_status()
            return resp.json()


class EplanBridgeClient:
    """Client for the EPLAN TCP bridge microservice."""

    def __init__(self, base_url: str = None):
        self.base_url = (base_url or EPLAN_BRIDGE_URL).rstrip("/")

    async def draw(self, project_name: str, eplan_data: List[Dict],
                   port: int = 12000, username: str = "agent") -> Dict:
        async with httpx.AsyncClient(timeout=180) as client:
            resp = await client.post(f"{self.base_url}/draw", json={
                "project_name": project_name,
                "eplan_data": eplan_data,
                "port": port,
                "username": username,
            })
            resp.raise_for_status()
            return resp.json()

    async def get_job(self, job_id: str) -> Dict:
        async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT) as client:
            resp = await client.get(f"{self.base_url}/job/{job_id}")
            resp.raise_for_status()
            return resp.json()

    async def resolve_port(self, username: str = "agent") -> Dict:
        async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT) as client:
            resp = await client.post(f"{self.base_url}/port/resolve", json={
                "username": username,
            })
            resp.raise_for_status()
            return resp.json()


class MailGatewayClient:
    """Client for the mail-gateway microservice."""

    def __init__(self, base_url: str = None):
        self.base_url = (base_url or MAIL_GATEWAY_URL).rstrip("/")
        self.token = os.getenv("MAIL_GATEWAY_TOKEN", "")

    def _headers(self) -> Dict:
        headers = {}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        return headers

    async def create_project_email(
        self, project_id: str, project_name: str,
        oenum: str = None, owner_id: str = None,
    ) -> Dict:
        """Create a project-specific email address."""
        async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT) as client:
            resp = await client.post(
                f"{self.base_url}/project-email/create",
                json={
                    "project_id": project_id,
                    "project_name": project_name,
                    "oenum": oenum,
                    "owner_id": owner_id,
                },
                headers=self._headers(),
            )
            resp.raise_for_status()
            return resp.json()

    async def get_project_email(self, project_id: str) -> Dict:
        """Get the email address for a project."""
        async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT) as client:
            resp = await client.get(
                f"{self.base_url}/project-email/{project_id}",
                headers=self._headers(),
            )
            resp.raise_for_status()
            return resp.json()

    async def get_inbox(self, project_id: str, limit: int = 50) -> Dict:
        """Get received emails for a project."""
        async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT) as client:
            resp = await client.get(
                f"{self.base_url}/project-email/{project_id}/inbox",
                params={"limit": limit},
                headers=self._headers(),
            )
            resp.raise_for_status()
            return resp.json()


# Singletons
_search_client: Optional[SearchServiceClient] = None
_tpms_client: Optional[TPMSFetcherClient] = None
_init_client: Optional[ProjectInitClient] = None
_analysis_client: Optional[ProjectAnalysisClient] = None
_cmd_client: Optional[CommandGenClient] = None
_export_client: Optional[FileExportClient] = None
_eplan_client: Optional[EplanBridgeClient] = None
_mail_gateway_client: Optional[MailGatewayClient] = None


def get_search_client() -> SearchServiceClient:
    global _search_client
    if _search_client is None:
        _search_client = SearchServiceClient()
    return _search_client


def get_tpms_fetcher_client() -> TPMSFetcherClient:
    global _tpms_client
    if _tpms_client is None:
        _tpms_client = TPMSFetcherClient()
    return _tpms_client


def get_project_init_client() -> ProjectInitClient:
    global _init_client
    if _init_client is None:
        _init_client = ProjectInitClient()
    return _init_client


def get_project_analysis_client() -> ProjectAnalysisClient:
    global _analysis_client
    if _analysis_client is None:
        _analysis_client = ProjectAnalysisClient()
    return _analysis_client


def get_command_gen_client() -> CommandGenClient:
    global _cmd_client
    if _cmd_client is None:
        _cmd_client = CommandGenClient()
    return _cmd_client


def get_file_export_client() -> FileExportClient:
    global _export_client
    if _export_client is None:
        _export_client = FileExportClient()
    return _export_client


def get_eplan_bridge_client() -> EplanBridgeClient:
    global _eplan_client
    if _eplan_client is None:
        _eplan_client = EplanBridgeClient()
    return _eplan_client


def get_mail_gateway_client() -> MailGatewayClient:
    global _mail_gateway_client
    if _mail_gateway_client is None:
        _mail_gateway_client = MailGatewayClient()
    return _mail_gateway_client
