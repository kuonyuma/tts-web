import logging
import smtplib
import ssl
from email.message import EmailMessage

from app.config import settings
from app.services.auth_service import AuthError


logger = logging.getLogger(__name__)


def mail_enabled() -> bool:
    return bool(settings.SMTP_HOST and settings.SMTP_FROM)


def require_mail() -> None:
    if not mail_enabled():
        raise AuthError(503, "邮件服务尚未配置，请联系管理员。")


def send_account_link(email: str, token: str, purpose: str) -> None:
    """Run after the HTTP response. SMTP secrets and link tokens never enter logs."""
    try:
        require_mail()
        message = EmailMessage()
        message["From"] = settings.SMTP_FROM
        message["To"] = email
        label = "验证邮箱" if purpose == "verify" else "重置密码"
        message["Subject"] = f"KOTO · {label}"
        link = f"{settings.PUBLIC_BASE_URL}/account.html#{purpose}={token}"
        message.set_content(f"请打开以下链接{label}：\n\n{link}\n\n链接仅能使用一次。若不是你发起的请求，请忽略此邮件。\n")
        context = ssl.create_default_context()
        if settings.SMTP_SECURITY == "ssl":
            connection = smtplib.SMTP_SSL(settings.SMTP_HOST, settings.SMTP_PORT, timeout=10, context=context)
        else:
            connection = smtplib.SMTP(settings.SMTP_HOST, settings.SMTP_PORT, timeout=10)
        with connection as smtp:
            if settings.SMTP_SECURITY == "starttls":
                smtp.starttls(context=context)
            if settings.SMTP_USERNAME:
                smtp.login(settings.SMTP_USERNAME, settings.SMTP_PASSWORD)
            smtp.send_message(message)
    except Exception as exc:
        # Delivery can be retried through the resend endpoint; never turn an
        # already committed registration into a misleading failed response.
        logger.warning("account_mail_delivery_failed type=%s", type(exc).__name__)
