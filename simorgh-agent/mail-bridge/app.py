"""
mail-bridge
===========
Replaces mail-gateway-service (custom aiosmtpd receiver) and
project-mail-service (scaffold IMAP poller). Talks to Mailcow via standard
IMAP IDLE (inbound) + SMTP submission (outbound).

Background loop:
  1. IMAP-LOGIN to Mailcow as $MAILBOX_USER
  2. SELECT $MAILBOX_FOLDER (INBOX)
  3. IDLE — wait for EXISTS notifications
  4. On notify: FETCH new messages, parse RFC822, POST to backend webhook
     with envelope + body so the project-agent can route it.

REST:
  POST /send       — outbound mail via Mailcow SMTP
  GET  /health
"""
import asyncio
import contextlib
import email
import os
from email.message import EmailMessage
from email.parser import BytesParser
from typing import Any

import aioimaplib
import aiosmtplib
import httpx
from fastapi import FastAPI, HTTPException
from mcp.server.fastmcp import FastMCP
from pydantic import BaseModel, EmailStr, Field

from simorgh_logging import configure, get_logger, request_id_middleware

configure(service="mail-bridge")
log = get_logger(__name__)

IMAP_HOST       = os.getenv("IMAP_HOST", "dovecot-mailcow")
IMAP_PORT       = int(os.getenv("IMAP_PORT", "143"))
IMAP_STARTTLS   = os.getenv("IMAP_USE_STARTTLS", "true").lower() == "true"
SMTP_HOST       = os.getenv("SMTP_HOST", "postfix-mailcow")
SMTP_PORT       = int(os.getenv("SMTP_PORT", "587"))
SMTP_STARTTLS   = os.getenv("SMTP_USE_STARTTLS", "true").lower() == "true"
MAILBOX_USER    = os.getenv("MAILBOX_USER", "simorghai@electrokavir.com")
MAILBOX_PASS    = os.environ["MAILBOX_PASSWORD"]
MAILBOX_FOLDER  = os.getenv("MAILBOX_FOLDER", "INBOX")
WEBHOOK_URL     = os.getenv("WEBHOOK_URL", "")
WEBHOOK_TOKEN   = os.getenv("WEBHOOK_TOKEN", "")


# ---------------------------------------------------------------------------
# Inbound — IMAP IDLE loop running as a background task
# ---------------------------------------------------------------------------
async def _post_webhook(envelope: dict[str, Any], raw: bytes) -> None:
    if not WEBHOOK_URL:
        log.warning("no_webhook", uid=envelope.get("uid"))
        return
    headers = {"content-type": "application/json"}
    if WEBHOOK_TOKEN:
        headers["authorization"] = f"Bearer {WEBHOOK_TOKEN}"
    body = {
        "envelope": envelope,
        "raw_b64": raw.hex(),     # hex over the wire — small enough, auditable
    }
    try:
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.post(WEBHOOK_URL, json=body, headers=headers)
            r.raise_for_status()
    except Exception as e:
        log.error("webhook_post_failed", error=str(e), uid=envelope.get("uid"))


def _parse_envelope(raw: bytes, uid: str) -> dict[str, Any]:
    msg = BytesParser().parsebytes(raw)
    body_text = ""
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_type() == "text/plain" and "attachment" not in str(part.get("Content-Disposition", "")):
                payload = part.get_payload(decode=True) or b""
                body_text = payload.decode(part.get_content_charset() or "utf-8", "replace")
                break
    else:
        payload = msg.get_payload(decode=True) or b""
        body_text = payload.decode(msg.get_content_charset() or "utf-8", "replace")

    return {
        "uid": uid,
        "message_id": msg.get("Message-ID", ""),
        "from": msg.get("From", ""),
        "to": msg.get_all("To") or [],
        "cc": msg.get_all("Cc") or [],
        "subject": msg.get("Subject", ""),
        "date": msg.get("Date", ""),
        "in_reply_to": msg.get("In-Reply-To", ""),
        "references": msg.get("References", ""),
        "x_simorgh_session": msg.get("X-Simorgh-Session", ""),
        "body_text": body_text[:50_000],
    }


async def _imap_loop() -> None:
    """Connect, IDLE, fetch new messages, retry forever."""
    backoff = 2
    while True:
        try:
            log.info("imap_connect", host=IMAP_HOST, port=IMAP_PORT)
            client = aioimaplib.IMAP4(host=IMAP_HOST, port=IMAP_PORT, timeout=30)
            await client.wait_hello_from_server()
            if IMAP_STARTTLS:
                await client.starttls()
            await client.login(MAILBOX_USER, MAILBOX_PASS)
            await client.select(MAILBOX_FOLDER)
            log.info("imap_ready", folder=MAILBOX_FOLDER)
            backoff = 2

            # Process anything UNSEEN at startup, then enter the IDLE loop.
            await _drain_unseen(client)
            while True:
                idle = await client.idle_start(timeout=29 * 60)  # < 30min RFC limit
                # Wait for any IDLE response.
                await client.wait_server_push()
                client.idle_done()
                with contextlib.suppress(Exception):
                    await idle
                await _drain_unseen(client)

        except Exception as e:
            log.error("imap_loop_error", error=str(e))
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 60)


async def _drain_unseen(client: aioimaplib.IMAP4) -> None:
    typ, data = await client.search("UNSEEN")
    if typ != "OK" or not data or not data[0]:
        return
    uids = data[0].split() if isinstance(data[0], (bytes, bytearray)) else data[0].split()
    uids = [u.decode() if isinstance(u, (bytes, bytearray)) else u for u in uids]
    for uid in uids:
        typ, fetched = await client.fetch(uid, "(RFC822)")
        if typ != "OK":
            continue
        # aioimaplib returns alternating header / payload entries.
        raw = b""
        for chunk in fetched:
            if isinstance(chunk, (bytes, bytearray)) and chunk.startswith(b"From"):
                raw = bytes(chunk)
                break
            if isinstance(chunk, (bytes, bytearray)) and len(chunk) > 200:
                raw = bytes(chunk)
                break
        if not raw:
            continue
        env = _parse_envelope(raw, uid)
        log.info("inbound", uid=uid, from_=env["from"], subject=env["subject"])
        await _post_webhook(env, raw)
        await client.store(uid, "+FLAGS", "(\\Seen)")


# ---------------------------------------------------------------------------
# Outbound — REST endpoint
# ---------------------------------------------------------------------------
class SendRequest(BaseModel):
    from_: EmailStr | None = Field(default=None, alias="from")
    to: list[EmailStr]
    cc: list[EmailStr] = []
    subject: str
    body_text: str
    body_html: str | None = None
    in_reply_to: str | None = None
    references: list[str] | None = None
    extra_headers: dict[str, str] = {}

    class Config:
        populate_by_name = True


app = FastAPI(title="mail-bridge", version="0.1.0")
app.middleware("http")(request_id_middleware)


@app.on_event("startup")
async def _startup():
    asyncio.create_task(_imap_loop())


@app.get("/health")
def health():
    return {"status": "ok", "service": "mail-bridge"}


@app.post("/send")
async def send_mail(req: SendRequest):
    msg = EmailMessage()
    msg["From"] = req.from_ or MAILBOX_USER
    msg["To"]   = ", ".join(req.to)
    if req.cc: msg["Cc"] = ", ".join(req.cc)
    msg["Subject"] = req.subject
    if req.in_reply_to: msg["In-Reply-To"] = req.in_reply_to
    if req.references:  msg["References"]  = " ".join(req.references)
    for k, v in req.extra_headers.items():
        msg[k] = v
    msg.set_content(req.body_text)
    if req.body_html:
        msg.add_alternative(req.body_html, subtype="html")

    try:
        await aiosmtplib.send(
            msg, hostname=SMTP_HOST, port=SMTP_PORT,
            username=MAILBOX_USER, password=MAILBOX_PASS,
            start_tls=SMTP_STARTTLS, timeout=30,
        )
    except Exception as e:
        log.error("smtp_send_failed", error=str(e))
        raise HTTPException(status_code=502, detail=f"smtp send failed: {e}")
    log.info("outbound", to=req.to, subject=req.subject)
    return {"status": "sent", "to": req.to}


# ---------------------------------------------------------------------------
# MCP — exposes a single send_email tool so the CoT engine can dispatch
# mail from a project turn without hand-rolling an HTTP call.
# ---------------------------------------------------------------------------
mcp = FastMCP(
    "mail-bridge",
    instructions=(
        "Send a plaintext or HTML email via Mailcow's SMTP submission "
        "endpoint. The From address defaults to the mailbox the bridge "
        "is logged in as. Recipients are a list of RFC 5322 addresses."
    ),
)


@mcp.tool()
async def send_email(to: list[str], subject: str, body_text: str,
                     body_html: str = "", cc: list[str] | None = None,
                     in_reply_to: str = "") -> dict:
    """Send an email through Mailcow. Returns {status, to}."""
    req = SendRequest(
        to=to, cc=cc or [], subject=subject, body_text=body_text,
        body_html=body_html or None,
        in_reply_to=in_reply_to or None,
    )
    return await send_mail(req)


# FastMCP's streamable_http_app exposes route /mcp internally. Mount at
# "/" so its public path is /mcp (mounting at "/mcp" would produce /mcp/mcp).
app.mount("/", mcp.streamable_http_app())
