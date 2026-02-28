"""
Mail Gateway Service
=====================
Provides project-specific email addresses for the Simorgh Project Agent.
When a project is created, a unique email is assigned (e.g., project-<id>@domain).
Incoming emails are received via SMTP, stored, and forwarded to the COT engine
via the backend webhook.

Architecture:
- SMTP server on port 2525: Receives incoming emails
- REST API on port 8027: Manages project emails, health checks, retrieval
- Backend webhook: Notifies COT engine of incoming email
"""

import asyncio
import email
import json
import logging
import os
import re
import uuid
from datetime import datetime
from email import policy
from email.parser import BytesParser
from typing import Dict, Optional

import aiohttp
from aiosmtpd.controller import Controller
from aiosmtpd.handlers import Message
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# =============================================================================
# Configuration
# =============================================================================

BACKEND_URL = os.environ.get("BACKEND_URL", "http://backend:8890")
BACKEND_WEBHOOK_PATH = os.environ.get("BACKEND_WEBHOOK_PATH", "/api/v2/agent/email-webhook")
PROJECT_EMAIL_DOMAIN = os.environ.get("PROJECT_EMAIL_DOMAIN", "simorghai.electrokavir.com")
SMTP_PORT = int(os.environ.get("SMTP_LISTEN_PORT", "2525"))
MAIL_STORAGE_DIR = os.environ.get("MAIL_STORAGE_DIR", "/app/mail-storage")
GATEWAY_TOKEN = os.environ.get("MAIL_GATEWAY_TOKEN", "")

# In-memory registry of project email addresses
# Maps: email_local_part -> {"project_id": ..., "project_name": ..., "created_at": ...}
_email_registry: Dict[str, Dict] = {}

# Stored emails (in-memory + filesystem)
_stored_emails: Dict[str, list] = {}  # project_id -> [email_data, ...]

# =============================================================================
# FastAPI Application
# =============================================================================

app = FastAPI(title="Mail Gateway Service", version="1.0.0")


class ProjectEmailRequest(BaseModel):
    project_id: str
    project_name: str
    oenum: Optional[str] = None
    owner_id: Optional[str] = None


class ProjectEmailResponse(BaseModel):
    email_address: str
    project_id: str
    local_part: str
    domain: str
    created_at: str


class EmailListResponse(BaseModel):
    project_id: str
    emails: list
    total: int


@app.get("/health")
async def health():
    return {
        "status": "healthy",
        "service": "mail-gateway",
        "smtp_port": SMTP_PORT,
        "registered_projects": len(_email_registry),
        "domain": PROJECT_EMAIL_DOMAIN,
    }


@app.post("/project-email/create", response_model=ProjectEmailResponse)
async def create_project_email(req: ProjectEmailRequest):
    """
    Create a project-specific email address.
    Called by the backend when a new legacy project is created.
    """
    # Generate a clean local part from project info
    local_part = _generate_local_part(req.project_id, req.project_name, req.oenum)
    email_address = f"{local_part}@{PROJECT_EMAIL_DOMAIN}"

    # Check if already exists
    if local_part in _email_registry:
        existing = _email_registry[local_part]
        return ProjectEmailResponse(
            email_address=email_address,
            project_id=existing["project_id"],
            local_part=local_part,
            domain=PROJECT_EMAIL_DOMAIN,
            created_at=existing["created_at"],
        )

    # Register
    now = datetime.utcnow().isoformat()
    _email_registry[local_part] = {
        "project_id": req.project_id,
        "project_name": req.project_name,
        "oenum": req.oenum,
        "owner_id": req.owner_id,
        "created_at": now,
    }
    _stored_emails.setdefault(req.project_id, [])

    # Persist registry to disk
    _save_registry()

    logger.info(
        f"Created project email: {email_address} for project {req.project_id} "
        f"({req.project_name})"
    )

    return ProjectEmailResponse(
        email_address=email_address,
        project_id=req.project_id,
        local_part=local_part,
        domain=PROJECT_EMAIL_DOMAIN,
        created_at=now,
    )


@app.get("/project-email/{project_id}")
async def get_project_email(project_id: str):
    """Get the email address for a project."""
    for local_part, info in _email_registry.items():
        if info["project_id"] == project_id:
            return {
                "email_address": f"{local_part}@{PROJECT_EMAIL_DOMAIN}",
                "project_id": project_id,
                "local_part": local_part,
                "project_name": info.get("project_name", ""),
            }
    raise HTTPException(status_code=404, detail="No email registered for this project")


@app.get("/project-email/{project_id}/inbox", response_model=EmailListResponse)
async def get_project_inbox(project_id: str, limit: int = 50):
    """Get received emails for a project."""
    emails = _stored_emails.get(project_id, [])
    return EmailListResponse(
        project_id=project_id,
        emails=emails[-limit:],
        total=len(emails),
    )


@app.get("/registry")
async def get_registry():
    """List all registered project emails."""
    return {
        "total": len(_email_registry),
        "emails": {
            f"{lp}@{PROJECT_EMAIL_DOMAIN}": info
            for lp, info in _email_registry.items()
        },
    }


# =============================================================================
# SMTP Email Handler
# =============================================================================

class ProjectEmailHandler(Message):
    """
    Handles incoming SMTP emails. When an email arrives at a project address,
    it is stored and the backend COT engine is notified via webhook.
    """

    def handle_message(self, message):
        """Called by aiosmtpd when a complete email message is received."""
        # Run the async handler in the event loop
        loop = asyncio.get_event_loop()
        if loop.is_running():
            asyncio.ensure_future(self._async_handle(message))
        else:
            loop.run_until_complete(self._async_handle(message))

    async def _async_handle(self, message):
        """Process the incoming email asynchronously."""
        try:
            # Extract email details
            to_addrs = message.get("To", "")
            from_addr = message.get("From", "unknown")
            subject = message.get("Subject", "(no subject)")
            date = message.get("Date", datetime.utcnow().isoformat())
            message_id = message.get("Message-ID", str(uuid.uuid4()))

            # Get body
            body = ""
            if message.is_multipart():
                for part in message.walk():
                    ctype = part.get_content_type()
                    if ctype == "text/plain":
                        payload = part.get_payload(decode=True)
                        if payload:
                            body = payload.decode("utf-8", errors="replace")
                            break
                    elif ctype == "text/html" and not body:
                        payload = part.get_payload(decode=True)
                        if payload:
                            body = payload.decode("utf-8", errors="replace")
            else:
                payload = message.get_payload(decode=True)
                if payload:
                    body = payload.decode("utf-8", errors="replace")

            # Extract attachments info
            attachments = []
            if message.is_multipart():
                for part in message.walk():
                    filename = part.get_filename()
                    if filename:
                        attachments.append({
                            "filename": filename,
                            "content_type": part.get_content_type(),
                            "size": len(part.get_payload(decode=True) or b""),
                        })

            logger.info(
                f"Received email: from={from_addr}, to={to_addrs}, "
                f"subject={subject}, attachments={len(attachments)}"
            )

            # Find the matching project by parsing the To address
            project_info = self._resolve_project(to_addrs)
            if not project_info:
                logger.warning(f"No project found for recipient: {to_addrs}")
                return

            project_id = project_info["project_id"]

            # Build email data record
            email_data = {
                "id": str(uuid.uuid4()),
                "message_id": message_id,
                "from": from_addr,
                "to": to_addrs,
                "subject": subject,
                "body": body[:50000],  # Limit body size
                "date": date,
                "received_at": datetime.utcnow().isoformat(),
                "attachments": attachments,
                "project_id": project_id,
            }

            # Store email in memory and on disk
            _stored_emails.setdefault(project_id, []).append(email_data)
            _save_email(project_id, email_data)

            # Notify backend via webhook
            await self._notify_backend(project_id, email_data)

        except Exception as e:
            logger.error(f"Error handling incoming email: {e}", exc_info=True)

    def _resolve_project(self, to_addrs: str) -> Optional[Dict]:
        """Find the project associated with a recipient email address."""
        # Parse multiple recipients
        for addr in to_addrs.split(","):
            addr = addr.strip()
            # Extract email from "Name <email@domain>" format
            match = re.search(r'<([^>]+)>', addr)
            if match:
                addr = match.group(1)
            addr = addr.strip().lower()

            # Extract local part
            if "@" in addr:
                local_part = addr.split("@")[0]
            else:
                local_part = addr

            if local_part in _email_registry:
                return _email_registry[local_part]

        return None

    async def _notify_backend(self, project_id: str, email_data: Dict):
        """Send webhook to backend to notify COT of incoming email."""
        webhook_url = f"{BACKEND_URL}{BACKEND_WEBHOOK_PATH}"
        payload = {
            "project_id": project_id,
            "email_id": email_data["id"],
            "from": email_data["from"],
            "subject": email_data["subject"],
            "body_preview": email_data["body"][:500],
            "has_attachments": len(email_data.get("attachments", [])) > 0,
            "attachment_count": len(email_data.get("attachments", [])),
            "received_at": email_data["received_at"],
        }

        headers = {"Content-Type": "application/json"}
        if GATEWAY_TOKEN:
            headers["Authorization"] = f"Bearer {GATEWAY_TOKEN}"

        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    webhook_url, json=payload, headers=headers, timeout=aiohttp.ClientTimeout(total=10)
                ) as resp:
                    if resp.status == 200:
                        logger.info(
                            f"Backend notified of email for project {project_id}: "
                            f"subject={email_data['subject']}"
                        )
                    else:
                        body = await resp.text()
                        logger.warning(
                            f"Backend webhook returned {resp.status}: {body[:200]}"
                        )
        except Exception as e:
            logger.error(f"Failed to notify backend of email: {e}")


# =============================================================================
# Helpers
# =============================================================================

def _generate_local_part(project_id: str, project_name: str, oenum: str = None) -> str:
    """Generate a clean email local part for a project."""
    if oenum:
        # Use OENUM as primary identifier (e.g., project-04A12065)
        clean = re.sub(r'[^a-zA-Z0-9]', '', oenum)
        return f"project-{clean}".lower()
    else:
        # Use project name slug + short ID
        slug = re.sub(r'[^a-zA-Z0-9]+', '-', project_name.lower()).strip('-')[:30]
        short_id = project_id[:8]
        return f"project-{slug}-{short_id}"


def _save_registry():
    """Persist the email registry to disk."""
    os.makedirs(MAIL_STORAGE_DIR, exist_ok=True)
    path = os.path.join(MAIL_STORAGE_DIR, "registry.json")
    try:
        with open(path, "w") as f:
            json.dump(_email_registry, f, indent=2)
    except Exception as e:
        logger.warning(f"Failed to persist registry: {e}")


def _load_registry():
    """Load the email registry from disk on startup."""
    path = os.path.join(MAIL_STORAGE_DIR, "registry.json")
    if os.path.exists(path):
        try:
            with open(path) as f:
                data = json.load(f)
                _email_registry.update(data)
                logger.info(f"Loaded {len(data)} project emails from registry")
        except Exception as e:
            logger.warning(f"Failed to load registry: {e}")


def _save_email(project_id: str, email_data: Dict):
    """Save an email to disk in the project's mail directory."""
    project_dir = os.path.join(MAIL_STORAGE_DIR, "projects", project_id)
    os.makedirs(project_dir, exist_ok=True)
    path = os.path.join(project_dir, f"{email_data['id']}.json")
    try:
        with open(path, "w") as f:
            json.dump(email_data, f, indent=2)
    except Exception as e:
        logger.warning(f"Failed to save email to disk: {e}")


def _load_emails():
    """Load stored emails from disk on startup."""
    projects_dir = os.path.join(MAIL_STORAGE_DIR, "projects")
    if not os.path.exists(projects_dir):
        return
    for project_id in os.listdir(projects_dir):
        project_dir = os.path.join(projects_dir, project_id)
        if not os.path.isdir(project_dir):
            continue
        emails = []
        for fname in sorted(os.listdir(project_dir)):
            if fname.endswith(".json"):
                try:
                    with open(os.path.join(project_dir, fname)) as f:
                        emails.append(json.load(f))
                except Exception:
                    pass
        if emails:
            _stored_emails[project_id] = emails
    logger.info(f"Loaded emails for {len(_stored_emails)} projects from disk")


# =============================================================================
# SMTP Server Startup
# =============================================================================

_smtp_controller: Optional[Controller] = None


def start_smtp_server():
    """Start the SMTP server in a background thread."""
    global _smtp_controller
    handler = ProjectEmailHandler()
    _smtp_controller = Controller(
        handler,
        hostname="0.0.0.0",
        port=SMTP_PORT,
    )
    _smtp_controller.start()
    logger.info(f"SMTP server started on port {SMTP_PORT}")


@app.on_event("startup")
async def startup():
    """Initialize on FastAPI startup."""
    os.makedirs(MAIL_STORAGE_DIR, exist_ok=True)
    _load_registry()
    _load_emails()
    start_smtp_server()
    logger.info(
        f"Mail Gateway started: SMTP={SMTP_PORT}, "
        f"domain={PROJECT_EMAIL_DOMAIN}, "
        f"registered={len(_email_registry)} projects"
    )


@app.on_event("shutdown")
async def shutdown():
    """Cleanup on FastAPI shutdown."""
    global _smtp_controller
    if _smtp_controller:
        _smtp_controller.stop()
        logger.info("SMTP server stopped")
