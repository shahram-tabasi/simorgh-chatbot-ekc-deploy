"""
Document Processor Client
==========================
Client for communicating with the doc-processor microservice.
Sends files to doc-processor and receives markdown content.

Author: Simorgh Industrial Assistant
"""

import os
import logging
import httpx
from pathlib import Path
from typing import Dict, Any, Optional

logger = logging.getLogger(__name__)


class DocProcessorClient:
    """
    Client for doc-processor microservice
    Handles document to markdown conversion
    """

    def __init__(self, base_url: str = None):
        """
        Initialize document processor client

        Args:
            base_url: URL of doc-processor service (default from env)
        """
        self.base_url = base_url or os.getenv("DOC_PROCESSOR_URL", "http://doc-processor:8000")
        self.timeout = 300.0  # 5 minutes for large files
        logger.info(f"📄 DocProcessor client initialized: {self.base_url}")

    async def health_check(self) -> bool:
        """Check if doc-processor service is healthy"""
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                response = await client.get(f"{self.base_url}/health")
                return response.status_code == 200
        except Exception as e:
            logger.error(f"❌ Doc-processor health check failed: {e}")
            return False

    async def process_document(
        self,
        file_path: Path,
        user_id: str,
        save_path: Optional[Path] = None
    ) -> Dict[str, Any]:
        """
        Process document to markdown via doc-processor service

        Args:
            file_path: Path to file to process
            user_id: User ID for tracking
            save_path: Optional custom path to save markdown

        Returns:
            Dict with:
                - success: bool
                - content: markdown content (if successful)
                - output_path: path to saved markdown file
                - doc_type: detected document type
                - error: error message (if failed)
        """
        try:
            # Validate file exists
            if not file_path.exists():
                raise FileNotFoundError(f"File not found: {file_path}")

            # Open file and send to doc-processor
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                with open(file_path, 'rb') as f:
                    files = {'file': (file_path.name, f, self._get_mime_type(file_path))}
                    data = {'user_id': user_id}

                    logger.info(f"📤 Sending to doc-processor: {file_path.name}")
                    response = await client.post(
                        f"{self.base_url}/upload",
                        files=files,
                        data=data
                    )

                # Check response
                if response.status_code != 200:
                    error_detail = response.json().get('detail', 'Unknown error')
                    raise Exception(f"Doc-processor error: {error_detail}")

                result = response.json()

                # If custom save path provided, copy the file
                if save_path and result.get('success'):
                    save_path = Path(save_path)
                    save_path.parent.mkdir(parents=True, exist_ok=True)
                    save_path.write_text(result['content'], encoding='utf-8')
                    result['custom_output_path'] = str(save_path)
                    logger.info(f"✅ Saved to custom path: {save_path}")

                logger.info(f"✅ Document processed: {file_path.name} ({result.get('doc_type')})")
                return result

        except httpx.TimeoutException:
            error_msg = f"Timeout processing document: {file_path.name}"
            logger.error(f"❌ {error_msg}")
            return {
                "success": False,
                "error": error_msg,
                "file": str(file_path)
            }
        except Exception as e:
            error_msg = f"Error processing document: {str(e)}"
            logger.error(f"❌ {error_msg}")
            return {
                "success": False,
                "error": error_msg,
                "file": str(file_path)
            }

    def _get_mime_type(self, file_path: Path) -> str:
        """Get MIME type based on file extension"""
        suffix = file_path.suffix.lower()
        mime_types = {
            '.pdf': 'application/pdf',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.png': 'image/png',
            '.bmp': 'image/bmp',
            '.tiff': 'image/tiff',
            '.tif': 'image/tiff',
            '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            '.doc': 'application/msword',
            '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            '.xls': 'application/vnd.ms-excel',
            '.csv': 'text/csv',
            '.txt': 'text/plain',
            '.md': 'text/markdown'
        }
        return mime_types.get(suffix, 'application/octet-stream')

    async def get_stats(self) -> Dict[str, Any]:
        """Get processing statistics from doc-processor service"""
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                response = await client.get(f"{self.base_url}/stats")
                return response.json()
        except Exception as e:
            logger.error(f"❌ Failed to get doc-processor stats: {e}")
            return {"error": str(e)}
