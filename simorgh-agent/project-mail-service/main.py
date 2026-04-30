"""
Project Mail Service — sole gateway for the simorghai@electrokavir.com mailbox
==============================================================================
Per the no-direct-external-access policy (EXTERNAL_GATEWAY_POLICY.md), this
is the ONLY service that opens IMAP / SMTP connections to the corporate
mail provider. Everyone else calls this service over HTTP.

Why a single mailbox: per the user spec, all project email goes through one
canonical address (PROJECT_MAILBOX, default simorghai@electrokavir.com).
Routing inbound replies to the right project session uses three signals,
in priority order:

  1. The X-Simorgh-Session header we set on outbound (most reliable).
  2. The In-Reply-To / References headers, looked up in the sent_emails
     table to find the original session.
  3. A subject prefix [Simorgh #<chat_id>] (human-readable fallback).

If none match, the email lands in /unrouted for an admin to look at.

Pieces:
  * IMAP poller (background asyncio task, polls every IMAP_POLL_SEC) —
    fetches new mail, parses, identifies session, posts to the agent.
  * Outbound /send REST endpoint — called by project-agent-service when
    an agent turn ends with channel == "email".
  * Postgres table `sent_emails` (project_id, chat_id, message_id,
    in_reply_to, subject, recipient, sent_at) — the thread index.

Storage: postgres_auth (shared with auth + projects).

This is a SCAFFOLD: the IMAP/SMTP wiring + thread index DDL have TODO
markers. Drop your real mailbox creds into env and fill in.
"""
import asyncio
import email
import logging
import os
import smtplib
import ssl
import uuid
from contextlib import asynccontextmanager
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formatdate, make_msgid
from typing import Any, Dict, List, Optional

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, EmailStr

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("project-mail-service")

# ---- mailbox -------------------------------------------------------------
PROJECT_MAILBOX     = os.getenv("PROJECT_MAILBOX",     "simorghai@electrokavir.com")
PROJECT_FROM_NAME   = os.getenv("PROJECT_FROM_NAME",   "Simorgh AI")

# IMAP (inbound)
IMAP_HOST           = os.getenv("IMAP_HOST")
IMAP_PORT           = int(os.getenv("IMAP_PORT", "993"))
IMAP_USER           = os.getenv("IMAP_USER", PROJECT_MAILBOX)
IMAP_PASSWORD       = os.getenv("IMAP_PASSWORD")
IMAP_FOLDER         = os.getenv("IMAP_FOLDER",         "INBOX")
IMAP_POLL_SEC       = int(os.getenv("IMAP_POLL_SEC",   "30"))
IMAP_USE_TLS        = os.getenv("IMAP_USE_TLS", "true").lower() == "true"

# SMTP (outbound)
SMTP_HOST           = os.getenv("SMTP_HOST")
SMTP_PORT           = int(os.getenv("SMTP_PORT",       "587"))
SMTP_USER           = os.getenv("SMTP_USER", PROJECT_MAILBOX)
SMTP_PASSWORD       = os.getenv("SMTP_PASSWORD")
SMTP_USE_STARTTLS   = os.getenv("SMTP_USE_STARTTLS", "true").lower() == "true"

# Where to forward routed inbound mail
PROJECT_AGENT_URL   = os.getenv("PROJECT_AGENT_URL",   "http://project-agent-service:8035")
PROJECT_AGENT_PATH  = os.getenv("PROJECT_AGENT_PATH",  "/api/v2/agent/projects/{project_id}/message")

# Postgres for the thread index
PG_HOST             = os.getenv("POSTGRES_AUTH_HOST",     "postgres_auth")
PG_PORT             = int(os.getenv("POSTGRES_AUTH_PORT", "5432"))
PG_DB               = os.getenv("POSTGRES_AUTH_DATABASE", "simorgh_auth")
PG_USER             = os.getenv("POSTGRES_AUTH_USER",     "simorgh")
PG_PASSWORD         = os.getenv("POSTGRES_AUTH_PASSWORD", "")


# ---------------------------------------------------------------------------
# Storage (asyncpg) — sent_emails table acts as the thread index
# ---------------------------------------------------------------------------
SCHEMA = """
CREATE TABLE IF NOT EXISTS project_sent_emails (
    message_id   text PRIMARY KEY,
    project_id   text NOT NULL,
    chat_id      text,
    in_reply_to  text,
    subject      text,
    recipient    text NOT NULL,
    sent_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS project_sent_emails_in_reply_to_idx
    ON project_sent_emails (in_reply_to);
CREATE INDEX IF NOT EXISTS project_sent_emails_project_idx
    ON project_sent_emails (project_id);
"""


async def _pg_pool():
    import asyncpg
    return await asyncpg.create_pool(
        host=PG_HOST, port=PG_PORT, user=PG_USER, password=PG_PASSWORD,
        database=PG_DB, min_size=1, max_size=4,
    )


# ---------------------------------------------------------------------------
# Outbound — build a message and SMTP-send it
# ---------------------------------------------------------------------------
def _build_message(*, to: str, subject: str, body: str,
                   project_id: str, chat_id: Optional[str],
                   in_reply_to: Optional[str]) -> tuple[MIMEMultipart, str]:
    msg = MIMEMultipart("alternative")
    msg_id = make_msgid(domain=PROJECT_MAILBOX.split("@", 1)[-1])
    msg["Message-ID"] = msg_id
    msg["From"]       = f"{PROJECT_FROM_NAME} <{PROJECT_MAILBOX}>"
    msg["To"]         = to
    msg["Subject"]    = f"[Simorgh #{chat_id or project_id}] {subject}" \
                            if not subject.startswith("[Simorgh") else subject
    msg["Date"]       = formatdate(localtime=True)
    msg["X-Simorgh-Project"] = project_id
    if chat_id:
        msg["X-Simorgh-Session"] = chat_id
    if in_reply_to:
        msg["In-Reply-To"] = in_reply_to
        msg["References"]  = in_reply_to
    msg.attach(MIMEText(body, "plain", "utf-8"))
    return msg, msg_id


def _smtp_send(msg: MIMEMultipart, to: str) -> None:
    if not SMTP_HOST or not SMTP_PASSWORD:
        raise HTTPException(status_code=503, detail="SMTP not configured")
    if SMTP_USE_STARTTLS:
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=30) as s:
            s.ehlo()
            s.starttls(context=ssl.create_default_context())
            s.ehlo()
            s.login(SMTP_USER, SMTP_PASSWORD)
            s.send_message(msg, from_addr=PROJECT_MAILBOX, to_addrs=[to])
    else:
        with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, timeout=30,
                              context=ssl.create_default_context()) as s:
            s.login(SMTP_USER, SMTP_PASSWORD)
            s.send_message(msg, from_addr=PROJECT_MAILBOX, to_addrs=[to])


# ---------------------------------------------------------------------------
# Inbound — IMAP poller, parses + routes
# ---------------------------------------------------------------------------
async def _route_to_agent(project_id: str, *, chat_id: Optional[str],
                          email_from: str, subject: str, body: str) -> None:
    url = PROJECT_AGENT_URL.rstrip("/") + PROJECT_AGENT_PATH.format(project_id=project_id)
    payload: Dict[str, Any] = {
        "message": body,
        "channel": "email",
        "email_from": email_from,
        "email_subject": subject,
    }
    if chat_id:
        payload["chat_id"] = chat_id
    async with httpx.AsyncClient(timeout=30.0) as c:
        r = await c.post(url, json=payload)
        r.raise_for_status()


async def _resolve_session(headers: Dict[str, str], subject: str) -> Optional[Dict[str, str]]:
    """Try the three signals in priority order. Returns {project_id, chat_id} or None."""
    # 1) X-Simorgh-Session header
    chat = headers.get("X-Simorgh-Session") or headers.get("x-simorgh-session")
    proj = headers.get("X-Simorgh-Project") or headers.get("x-simorgh-project")
    if proj:
        return {"project_id": proj, "chat_id": chat or ""}

    # 2) In-Reply-To against project_sent_emails
    irt = headers.get("In-Reply-To") or headers.get("in-reply-to")
    if irt and app.state.pg:
        async with app.state.pg.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT project_id, chat_id FROM project_sent_emails WHERE message_id = $1",
                irt.strip("<>"),
            )
            if row:
                return {"project_id": row["project_id"], "chat_id": row["chat_id"] or ""}

    # 3) Subject prefix [Simorgh #<id>]
    if "[Simorgh #" in (subject or ""):
        try:
            tag = subject.split("[Simorgh #", 1)[1].split("]", 1)[0]
            # tag is whatever was put in -- could be project_id OR chat_id
            return {"project_id": tag, "chat_id": tag}
        except Exception:
            pass

    return None


async def _imap_poll_loop():
    """
    Poll IMAP_FOLDER every IMAP_POLL_SEC; for each new message, parse, resolve
    session, forward to project-agent-service. Mark seen so we don't re-deliver.

    TODO(project-mail): implement using aioimaplib or imaplib in a thread.
    The current stub just sleeps so the rest of the service still boots.
    """
    if not IMAP_HOST or not IMAP_PASSWORD:
        logger.warning("IMAP not configured (set IMAP_HOST + IMAP_PASSWORD); poller idle")
        while True:
            await asyncio.sleep(3600)

    while True:
        try:
            # TODO(project-mail): connect, SEARCH UNSEEN, FETCH, parse, route.
            #   Pseudocode:
            #     async with aioimaplib.IMAP4_SSL(IMAP_HOST, IMAP_PORT) as cli:
            #         await cli.login(IMAP_USER, IMAP_PASSWORD)
            #         await cli.select(IMAP_FOLDER)
            #         _, data = await cli.search('UNSEEN')
            #         for uid in data[0].split():
            #             _, msg_data = await cli.fetch(uid, '(RFC822)')
            #             msg = email.message_from_bytes(msg_data[1])
            #             headers = {k: v for k, v in msg.items()}
            #             subject = msg.get("Subject", "")
            #             frm     = msg.get("From", "")
            #             body    = _extract_text(msg)
            #             session = await _resolve_session(headers, subject)
            #             if session:
            #                 await _route_to_agent(session["project_id"],
            #                                       chat_id=session["chat_id"] or None,
            #                                       email_from=frm, subject=subject, body=body)
            #             else:
            #                 logger.warning("UNROUTED: %s", subject)
            #             await cli.store(uid, '+FLAGS', '\\Seen')
            await asyncio.sleep(IMAP_POLL_SEC)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("IMAP poll error")
            await asyncio.sleep(IMAP_POLL_SEC)


# ---------------------------------------------------------------------------
# FastAPI
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        app.state.pg = await _pg_pool()
        async with app.state.pg.acquire() as conn:
            await conn.execute(SCHEMA)
        logger.info("project-mail-service: pg pool + schema ready")
    except Exception as e:
        logger.warning("PG init failed (continuing without thread index): %s", e)
        app.state.pg = None

    poll_task = asyncio.create_task(_imap_poll_loop())
    logger.info("project-mail-service ready, mailbox=%s", PROJECT_MAILBOX)
    yield

    poll_task.cancel()
    if app.state.pg is not None:
        await app.state.pg.close()


app = FastAPI(title="Simorgh Project Mail Service", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ALLOW_ORIGINS", "*").split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
class SendRequest(BaseModel):
    to:           EmailStr
    subject:      str
    body:         str
    project_id:   str
    chat_id:      Optional[str] = None
    in_reply_to:  Optional[str] = None


class SendResponse(BaseModel):
    message_id: str
    sent_to:    str


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.get("/health")
def health() -> Dict[str, Any]:
    return {
        "status": "healthy",
        "service": "project-mail-service",
        "mailbox": PROJECT_MAILBOX,
        "imap_configured": bool(IMAP_HOST and IMAP_PASSWORD),
        "smtp_configured": bool(SMTP_HOST and SMTP_PASSWORD),
    }


@app.post("/send", response_model=SendResponse)
async def send(req: SendRequest) -> SendResponse:
    """
    Send an outbound email FROM PROJECT_MAILBOX. Records the message_id and
    project/chat metadata in project_sent_emails so the IMAP poller can route
    any reply (via In-Reply-To) back to the same session.
    """
    msg, msg_id = _build_message(
        to=req.to, subject=req.subject, body=req.body,
        project_id=req.project_id, chat_id=req.chat_id,
        in_reply_to=req.in_reply_to,
    )

    _smtp_send(msg, req.to)

    # Record the thread anchor (best-effort; missing PG just means routing
    # falls back to the X-Simorgh-Session header on reply).
    if app.state.pg is not None:
        try:
            async with app.state.pg.acquire() as conn:
                await conn.execute(
                    "INSERT INTO project_sent_emails "
                    "(message_id, project_id, chat_id, in_reply_to, subject, recipient) "
                    "VALUES ($1,$2,$3,$4,$5,$6)",
                    msg_id.strip("<>"), req.project_id, req.chat_id,
                    req.in_reply_to, req.subject, req.to,
                )
        except Exception:
            logger.exception("could not record sent email")

    logger.info("sent email msg_id=%s to=%s project=%s", msg_id, req.to, req.project_id)
    return SendResponse(message_id=msg_id, sent_to=req.to)


@app.get("/sent/{project_id}")
async def list_sent(project_id: str, limit: int = 50) -> Dict[str, Any]:
    """Recent outbound for a project — debug / audit."""
    if app.state.pg is None:
        return {"items": []}
    async with app.state.pg.acquire() as conn:
        rows = await conn.fetch(
            "SELECT message_id, recipient, subject, sent_at FROM project_sent_emails "
            "WHERE project_id = $1 ORDER BY sent_at DESC LIMIT $2",
            project_id, limit,
        )
    return {"items": [dict(r) for r in rows]}
