from app.config import settings


class SecurityHeaders:
    """Apply browser hardening headers to every response."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)

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
                        b"form-action 'self'; script-src 'self'; style-src 'self'; "
                        b"style-src-attr 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; "
                        b"connect-src 'self'; worker-src 'none'; manifest-src 'self'",
                    ),
                    (b"cross-origin-opener-policy", b"same-origin"),
                    (b"cross-origin-resource-policy", b"same-origin"),
                ))
                if settings.APP_ENV == "production":
                    headers.append((b"strict-transport-security", b"max-age=63072000; includeSubDomains; preload"))
                if scope["path"].startswith(("/api/explain", "/api/copilot")):
                    headers.extend(((b"cache-control", b"no-store"), (b"pragma", b"no-cache")))
                message["headers"] = headers
            await send(message)

        await self.app(scope, receive, send_hardened)
