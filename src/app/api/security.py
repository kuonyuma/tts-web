import secrets

from app.config import settings


class SecurityHeaders:
    """Apply browser hardening headers to every response."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)

        nonce = secrets.token_urlsafe(24) if scope["path"] in ("/", "/index.html") else ""
        if nonce:
            scope.setdefault("state", {})["editor_style_nonce"] = nonce
        style_policy = "style-src 'self'" + (f" 'nonce-{nonce}'" if nonce else "") + "; "

        async def send_hardened(message):
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                headers.extend((
                    (b"x-content-type-options", b"nosniff"),
                    (b"x-frame-options", b"DENY"),
                    (b"referrer-policy", b"no-referrer"),
                    (b"permissions-policy", b"camera=(), microphone=(), geolocation=(), payment=()"),
                    (
                        b"content-security-policy",
                        b"default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; "
                        b"form-action 'self'; script-src 'self'; " + style_policy.encode("ascii") +
                        b"style-src-attr 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; "
                        b"connect-src 'self'; worker-src 'none'; manifest-src 'self'",
                    ),
                    (b"cross-origin-opener-policy", b"same-origin"),
                    (b"cross-origin-resource-policy", b"same-origin"),
                ))
                if settings.APP_ENV == "production":
                    headers.append((b"strict-transport-security", b"max-age=63072000; includeSubDomains; preload"))
                if scope["path"].startswith(("/api/explain", "/api/copilot", "/api/users", "/api/auth")):
                    headers.extend(((b"cache-control", b"no-store"), (b"pragma", b"no-cache")))
                if settings.TTS_STORAGE_MODE == "private" and scope["path"].startswith(("/api/tts", "/api/history")):
                    headers = [(key, value) for key, value in headers if key.lower() != b"cache-control"]
                    headers.append((b"cache-control", b"private, no-store"))
                message["headers"] = headers
            await send(message)

        await self.app(scope, receive, send_hardened)
