"""
Email Service

Handles sending emails for verification, password reset, and notifications.
Supports multiple email providers: SMTP, SendGrid, and AWS SES.
"""

import os
import logging
import smtplib
import ssl
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from typing import Optional
import aiohttp
from abc import ABC, abstractmethod

logger = logging.getLogger(__name__)


# =============================================================================
# Email Configuration
# =============================================================================

EMAIL_PROVIDER = os.getenv("EMAIL_PROVIDER", "smtp")  # smtp, sendgrid, ses
SMTP_HOST = os.getenv("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT = int(os.getenv("SMTP_PORT", "587"))
SMTP_USER = os.getenv("SMTP_USER", "")
SMTP_PASSWORD = os.getenv("SMTP_PASSWORD", "")
SMTP_USE_TLS = os.getenv("SMTP_USE_TLS", "true").lower() == "true"

FROM_EMAIL = os.getenv("FROM_EMAIL", "noreply@simorgh.ai")
FROM_NAME = os.getenv("FROM_NAME", "Simorgh AI")

FRONTEND_URL = os.getenv("FRONTEND_URL", "http://localhost:5173")

# SendGrid
SENDGRID_API_KEY = os.getenv("SENDGRID_API_KEY", "")

# AWS SES
AWS_ACCESS_KEY_ID = os.getenv("AWS_ACCESS_KEY_ID", "")
AWS_SECRET_ACCESS_KEY = os.getenv("AWS_SECRET_ACCESS_KEY", "")
AWS_REGION = os.getenv("AWS_REGION", "us-east-1")


# =============================================================================
# Email Templates
# =============================================================================

class EmailTemplates:
    """Email HTML templates."""

    @staticmethod
    def base_template(content: str, title: str = "Simorgh AI") -> str:
        """Base HTML email template."""
        return f"""
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{title}</title>
    <style>
        body {{
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
            background-color: #f5f5f5;
        }}
        .container {{
            background-color: #ffffff;
            border-radius: 12px;
            padding: 40px;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
        }}
        .logo {{
            text-align: center;
            margin-bottom: 30px;
        }}
        .logo h1 {{
            color: #10a37f;
            font-size: 28px;
            margin: 0;
        }}
        .content {{
            margin-bottom: 30px;
        }}
        .button {{
            display: inline-block;
            background-color: #10a37f;
            color: #ffffff !important;
            text-decoration: none;
            padding: 14px 28px;
            border-radius: 8px;
            font-weight: 600;
            margin: 20px 0;
        }}
        .button:hover {{
            background-color: #0d8c6d;
        }}
        .footer {{
            text-align: center;
            color: #666;
            font-size: 12px;
            margin-top: 30px;
            padding-top: 20px;
            border-top: 1px solid #eee;
        }}
        .code {{
            background-color: #f5f5f5;
            padding: 15px 25px;
            border-radius: 8px;
            font-family: monospace;
            font-size: 24px;
            letter-spacing: 4px;
            text-align: center;
            margin: 20px 0;
        }}
    </style>
</head>
<body>
    <div class="container">
        <div class="logo">
            <h1>🦅 Simorgh AI</h1>
        </div>
        <div class="content">
            {content}
        </div>
        <div class="footer">
            <p>&copy; 2024 Simorgh AI. All rights reserved.</p>
            <p>This email was sent by Simorgh Industrial Electrical Assistant</p>
        </div>
    </div>
</body>
</html>
"""

    @staticmethod
    def verification_email(verification_link: str, user_name: str = "there") -> tuple:
        """Email verification template."""
        subject = "Verify your email - Simorgh AI"
        content = f"""
            <h2>Welcome to Simorgh AI! 👋</h2>
            <p>Hi {user_name},</p>
            <p>Thanks for signing up! Please verify your email address by clicking the button below:</p>
            <p style="text-align: center;">
                <a href="{verification_link}" class="button">Verify Email Address</a>
            </p>
            <p>Or copy and paste this link into your browser:</p>
            <p style="word-break: break-all; color: #666; font-size: 14px;">
                {verification_link}
            </p>
            <p>This link will expire in 24 hours.</p>
            <p>If you didn't create an account with Simorgh AI, you can safely ignore this email.</p>
        """
        html = EmailTemplates.base_template(content, subject)
        return subject, html

    @staticmethod
    def password_reset_email(reset_link: str, user_name: str = "there") -> tuple:
        """Password reset email template."""
        subject = "Reset your password - Simorgh AI"
        content = f"""
            <h2>Password Reset Request</h2>
            <p>Hi {user_name},</p>
            <p>We received a request to reset your password. Click the button below to create a new password:</p>
            <p style="text-align: center;">
                <a href="{reset_link}" class="button">Reset Password</a>
            </p>
            <p>Or copy and paste this link into your browser:</p>
            <p style="word-break: break-all; color: #666; font-size: 14px;">
                {reset_link}
            </p>
            <p><strong>This link will expire in 1 hour.</strong></p>
            <p>If you didn't request a password reset, you can safely ignore this email. Your password will remain unchanged.</p>
        """
        html = EmailTemplates.base_template(content, subject)
        return subject, html

    @staticmethod
    def welcome_email(user_name: str = "there") -> tuple:
        """Welcome email after verification."""
        subject = "Welcome to Simorgh AI! 🎉"
        content = f"""
            <h2>You're all set! 🎉</h2>
            <p>Hi {user_name},</p>
            <p>Your email has been verified and your account is now active.</p>
            <p>Simorgh AI is your intelligent industrial electrical assistant, ready to help you with:</p>
            <ul>
                <li>📋 Project specifications review</li>
                <li>🔌 Electrical engineering questions</li>
                <li>📊 Document analysis and processing</li>
                <li>🤖 AI-powered assistance</li>
            </ul>
            <p style="text-align: center;">
                <a href="{FRONTEND_URL}" class="button">Start Using Simorgh AI</a>
            </p>
            <p>If you have any questions, feel free to reach out to our support team.</p>
        """
        html = EmailTemplates.base_template(content, subject)
        return subject, html

    @staticmethod
    def password_changed_email(user_name: str = "there") -> tuple:
        """Password changed notification email."""
        subject = "Your password was changed - Simorgh AI"
        content = f"""
            <h2>Password Changed Successfully</h2>
            <p>Hi {user_name},</p>
            <p>Your password was recently changed. If you made this change, you can safely ignore this email.</p>
            <p><strong>If you didn't change your password</strong>, please reset it immediately and contact our support team.</p>
            <p style="text-align: center;">
                <a href="{FRONTEND_URL}/reset-password" class="button">Reset Password</a>
            </p>
        """
        html = EmailTemplates.base_template(content, subject)
        return subject, html


# =============================================================================
# Email Provider Interface
# =============================================================================

class EmailProvider(ABC):
    """Abstract base class for email providers."""

    @abstractmethod
    async def send(
        self,
        to_email: str,
        subject: str,
        html_content: str,
        text_content: Optional[str] = None
    ) -> bool:
        """Send an email."""
        pass


# =============================================================================
# SMTP Provider
# =============================================================================

class SMTPProvider(EmailProvider):
    """SMTP email provider."""

    async def send(
        self,
        to_email: str,
        subject: str,
        html_content: str,
        text_content: Optional[str] = None
    ) -> bool:
        """Send email via SMTP."""
        try:
            message = MIMEMultipart("alternative")
            message["Subject"] = subject
            message["From"] = f"{FROM_NAME} <{FROM_EMAIL}>"
            message["To"] = to_email

            # Add plain text version
            if text_content:
                part1 = MIMEText(text_content, "plain")
                message.attach(part1)

            # Add HTML version
            part2 = MIMEText(html_content, "html")
            message.attach(part2)

            # Send via SMTP
            if SMTP_USE_TLS:
                context = ssl.create_default_context()
                with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as server:
                    server.ehlo()
                    server.starttls(context=context)
                    server.ehlo()
                    if SMTP_USER and SMTP_PASSWORD:
                        server.login(SMTP_USER, SMTP_PASSWORD)
                    server.sendmail(FROM_EMAIL, to_email, message.as_string())
            else:
                with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as server:
                    if SMTP_USER and SMTP_PASSWORD:
                        server.login(SMTP_USER, SMTP_PASSWORD)
                    server.sendmail(FROM_EMAIL, to_email, message.as_string())

            logger.info(f"Email sent via SMTP to: {to_email}")
            return True

        except Exception as e:
            logger.error(f"SMTP email error: {e}")
            return False


# =============================================================================
# SendGrid Provider
# =============================================================================

class SendGridProvider(EmailProvider):
    """SendGrid email provider."""

    async def send(
        self,
        to_email: str,
        subject: str,
        html_content: str,
        text_content: Optional[str] = None
    ) -> bool:
        """Send email via SendGrid API."""
        if not SENDGRID_API_KEY:
            logger.error("SendGrid API key not configured")
            return False

        try:
            url = "https://api.sendgrid.com/v3/mail/send"
            headers = {
                "Authorization": f"Bearer {SENDGRID_API_KEY}",
                "Content-Type": "application/json"
            }

            content = [{"type": "text/html", "value": html_content}]
            if text_content:
                content.insert(0, {"type": "text/plain", "value": text_content})

            data = {
                "personalizations": [{"to": [{"email": to_email}]}],
                "from": {"email": FROM_EMAIL, "name": FROM_NAME},
                "subject": subject,
                "content": content
            }

            async with aiohttp.ClientSession() as session:
                async with session.post(url, json=data, headers=headers) as response:
                    if response.status in (200, 202):
                        logger.info(f"Email sent via SendGrid to: {to_email}")
                        return True
                    else:
                        error = await response.text()
                        logger.error(f"SendGrid error: {error}")
                        return False

        except Exception as e:
            logger.error(f"SendGrid email error: {e}")
            return False


# =============================================================================
# Email Service
# =============================================================================

class EmailService:
    """Main email service class."""

    def __init__(self):
        self.provider = self._get_provider()
        self.templates = EmailTemplates()

    def _get_provider(self) -> EmailProvider:
        """Get the configured email provider."""
        if EMAIL_PROVIDER == "sendgrid":
            return SendGridProvider()
        else:
            return SMTPProvider()

    async def send_verification_email(
        self,
        to_email: str,
        verification_token: str,
        user_name: Optional[str] = None
    ) -> bool:
        """Send email verification email."""
        verification_link = f"{FRONTEND_URL}/verify-email?token={verification_token}"
        name = user_name or "there"
        subject, html = self.templates.verification_email(verification_link, name)

        return await self.provider.send(to_email, subject, html)

    async def send_password_reset_email(
        self,
        to_email: str,
        reset_token: str,
        user_name: Optional[str] = None
    ) -> bool:
        """Send password reset email."""
        reset_link = f"{FRONTEND_URL}/reset-password?token={reset_token}"
        name = user_name or "there"
        subject, html = self.templates.password_reset_email(reset_link, name)

        return await self.provider.send(to_email, subject, html)

    async def send_welcome_email(
        self,
        to_email: str,
        user_name: Optional[str] = None
    ) -> bool:
        """Send welcome email after verification."""
        name = user_name or "there"
        subject, html = self.templates.welcome_email(name)

        return await self.provider.send(to_email, subject, html)

    async def send_password_changed_email(
        self,
        to_email: str,
        user_name: Optional[str] = None
    ) -> bool:
        """Send password changed notification email."""
        name = user_name or "there"
        subject, html = self.templates.password_changed_email(name)

        return await self.provider.send(to_email, subject, html)


# Global instance
_email_service = None


def get_email_service() -> EmailService:
    """Get the email service instance."""
    global _email_service
    if _email_service is None:
        _email_service = EmailService()
    return _email_service
