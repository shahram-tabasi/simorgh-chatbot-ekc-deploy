"""
Email-to-Project Gateway
=========================
Handles inbound emails routed to project-specific addresses.
Each project can have a unique email address like:
  project-{id}@simorghai.electrokavir.com

Inbound emails are parsed and forwarded to the Project Manager Agent.
"""

import email
import logging
import os
import re
import uuid
from datetime import datetime
from email import policy
from typing import Optional, Dict, Any, List

from models.project_models import MessageChannel

logger = logging.getLogger(__name__)

# Email domain for project addresses
EMAIL_DOMAIN = os.getenv("PROJECT_EMAIL_DOMAIN", "simorghai.electrokavir.com")


class InboundEmail:
    """Parsed inbound email."""

    def __init__(self):
        self.message_id: str = ""
        self.from_address: str = ""
        self.to_addresses: List[str] = []
        self.subject: str = ""
        self.body_text: str = ""
        self.body_html: str = ""
        self.attachments: List[Dict[str, Any]] = []
        self.received_at: datetime = datetime.utcnow()

    @classmethod
    def from_raw(cls, raw_email: str) -> "InboundEmail":
        """Parse a raw email string."""
        parsed = cls()
        msg = email.message_from_string(raw_email, policy=policy.default)

        parsed.message_id = msg.get("Message-ID", str(uuid.uuid4()))
        parsed.from_address = msg.get("From", "")
        parsed.subject = msg.get("Subject", "(no subject)")

        # Parse To addresses
        to_header = msg.get("To", "")
        parsed.to_addresses = [addr.strip() for addr in to_header.split(",") if addr.strip()]

        # Extract body
        if msg.is_multipart():
            for part in msg.walk():
                content_type = part.get_content_type()
                disposition = str(part.get("Content-Disposition", ""))

                if "attachment" in disposition:
                    # Handle attachment
                    filename = part.get_filename() or "attachment"
                    content = part.get_payload(decode=True)
                    parsed.attachments.append({
                        "filename": filename,
                        "content_type": content_type,
                        "size": len(content) if content else 0,
                        "content": content,
                    })
                elif content_type == "text/plain":
                    payload = part.get_payload(decode=True)
                    if payload:
                        parsed.body_text = payload.decode("utf-8", errors="replace")
                elif content_type == "text/html":
                    payload = part.get_payload(decode=True)
                    if payload:
                        parsed.body_html = payload.decode("utf-8", errors="replace")
        else:
            payload = msg.get_payload(decode=True)
            if payload:
                if msg.get_content_type() == "text/html":
                    parsed.body_html = payload.decode("utf-8", errors="replace")
                else:
                    parsed.body_text = payload.decode("utf-8", errors="replace")

        return parsed

    @classmethod
    def from_webhook(cls, data: Dict[str, Any]) -> "InboundEmail":
        """Parse from a webhook payload (SendGrid, Mailgun, etc.)."""
        parsed = cls()
        parsed.message_id = data.get("message_id", str(uuid.uuid4()))
        parsed.from_address = data.get("from", data.get("sender", ""))
        parsed.to_addresses = data.get("to", [])
        if isinstance(parsed.to_addresses, str):
            parsed.to_addresses = [parsed.to_addresses]
        parsed.subject = data.get("subject", "(no subject)")
        parsed.body_text = data.get("text", data.get("body_text", ""))
        parsed.body_html = data.get("html", data.get("body_html", ""))

        # Attachments
        for att in data.get("attachments", []):
            parsed.attachments.append({
                "filename": att.get("filename", "attachment"),
                "content_type": att.get("content_type", "application/octet-stream"),
                "size": att.get("size", 0),
                "content": att.get("content"),
            })

        return parsed


class EmailGateway:
    """
    Gateway for routing inbound emails to projects.
    Supports webhook-based email reception (SendGrid Inbound Parse, Mailgun, etc.)
    """

    def __init__(self, project_memory_service=None, project_agent=None):
        self.memory = project_memory_service
        self.agent = project_agent

    def set_services(self, memory=None, agent=None):
        if memory:
            self.memory = memory
        if agent:
            self.agent = agent

    def extract_project_id(self, email_address: str) -> Optional[str]:
        """
        Extract project ID from email address.
        Format: project-{uuid}@domain.com
        """
        match = re.match(
            r"project-([a-f0-9\-]+)@",
            email_address.lower(),
        )
        if match:
            return match.group(1)
        return None

    async def resolve_project_from_email(self, to_addresses: List[str]) -> Optional[str]:
        """Find which project an email is addressed to."""
        for addr in to_addresses:
            # Try extracting from address format
            project_id = self.extract_project_id(addr)
            if project_id:
                return project_id

            # Try database lookup
            if self.memory and self.memory.pg:
                result = await self.memory.pg.execute_one_async(
                    "SELECT project_id FROM project_email_addresses WHERE email_address = $1 AND is_active = TRUE",
                    addr.lower(),
                )
                if result:
                    return str(result["project_id"])

        return None

    async def process_inbound_email(self, email_data: InboundEmail) -> Dict[str, Any]:
        """
        Process an inbound email and route it to the appropriate project.

        Returns:
            Dict with processing result
        """
        logger.info(
            f"Processing inbound email: from={email_data.from_address}, "
            f"subject={email_data.subject}, to={email_data.to_addresses}"
        )

        # 1. Resolve target project
        project_id = await self.resolve_project_from_email(email_data.to_addresses)
        if not project_id:
            logger.warning(f"No project found for email to: {email_data.to_addresses}")
            return {
                "status": "rejected",
                "reason": "No matching project found",
                "to": email_data.to_addresses,
            }

        # 2. Build content from email
        content = email_data.body_text or email_data.body_html or "(empty email body)"
        if email_data.subject:
            content = f"Subject: {email_data.subject}\n\n{content}"

        # 3. Handle attachments
        attachment_info = []
        for att in email_data.attachments:
            attachment_info.append(f"- {att['filename']} ({att['content_type']}, {att['size']} bytes)")
        if attachment_info:
            content += f"\n\nAttachments:\n" + "\n".join(attachment_info)

        # 4. Forward to Project Manager Agent
        if self.agent:
            result = await self.agent.handle_input(
                project_id=project_id,
                user_input=content,
                channel=MessageChannel.EMAIL,
                email_from=email_data.from_address,
                email_subject=email_data.subject,
            )
            return {
                "status": "processed",
                "project_id": project_id,
                "chain_id": result.get("chain_id"),
                "tasks_created": result.get("tasks_created", 0),
            }
        else:
            # Just store the message if agent not available
            if self.memory:
                await self.memory.store_message(
                    project_id=project_id,
                    role="user",
                    content=content,
                    channel="email",
                    email_from=email_data.from_address,
                    email_subject=email_data.subject,
                    email_message_id=email_data.message_id,
                )
            return {
                "status": "stored",
                "project_id": project_id,
                "message": "Email stored but agent not available for processing",
            }

    async def generate_project_email(self, project_id: str) -> str:
        """Generate a unique email address for a project."""
        email_addr = f"project-{project_id}@{EMAIL_DOMAIN}"

        # Store in database
        if self.memory and self.memory.pg:
            try:
                await self.memory.pg.execute_one_async(
                    """INSERT INTO project_email_addresses (id, project_id, email_address)
                       VALUES ($1, $2, $3)
                       ON CONFLICT (email_address) DO NOTHING
                       RETURNING email_address""",
                    str(uuid.uuid4()), project_id, email_addr,
                )
            except Exception as e:
                logger.warning(f"Failed to store project email: {e}")

        return email_addr


# Singleton
_email_gateway: Optional[EmailGateway] = None


def get_email_gateway() -> EmailGateway:
    global _email_gateway
    if _email_gateway is None:
        _email_gateway = EmailGateway()
    return _email_gateway
