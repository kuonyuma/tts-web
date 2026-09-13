import asyncio
import logging
import time
import uuid
import traceback

from starlette.responses import JSONResponse

from app.config import settings

logger = logging.getLogger(__name__)


class RequestLimits:
    """Bounded admission and request buffering for the supported single worker."""

    def __init__(self, app):
        self.app = app
        self.reset()

    def reset(self):
        self.window = 0
        self.counts = {}
        self.total = 0
        self.active = 0

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not scope["path"].startswith("/api/"):
            return await self.app(scope, receive, send)
        request_id = uuid.uuid4().hex
        scope.setdefault("state", {})["request_id"] = request_id
        response_status = 500
        response_started = False

        async def send_with_id(message):
            nonlocal response_status, response_started
            if message["type"] == "http.response.start":
                response_started = True
                response_status = message["status"]
                message["headers"] = [*message.get("headers", []), (b"x-request-id", request_id.encode())]
            await send(message)

        async def reject(code, detail):
            headers = {"Retry-After": "60"} if code == 429 else None
            await JSONResponse({"detail": detail}, status_code=code, headers=headers)(scope, receive, send_with_id)

        window = int(time.monotonic() // 60)
        if self.window != window:
            self.window, self.counts, self.total = window, {}, 0
        # Never trust client-controlled UUIDs or forwarded headers for rate limits.
        peer = (scope.get("client") or ("unknown", 0))[0]
        if self.total >= settings.GLOBAL_REQUESTS_PER_MINUTE or self.counts.get(peer, 0) >= settings.REQUESTS_PER_MINUTE:
            return await reject(429, "请求过于频繁，请稍后重试。")
        self.total += 1
        self.counts[peer] = self.counts.get(peer, 0) + 1
        if self.active >= settings.MAX_PENDING_REQUESTS:
            return await reject(503, "服务繁忙，请稍后重试。")
        self.active += 1
        started = time.monotonic()
        try:
            headers = dict(scope.get("headers", []))
            if headers.get(b"content-encoding", b"identity").lower() != b"identity":
                return await reject(415, "不支持压缩请求体。")
            declared = headers.get(b"content-length")
            if declared:
                try:
                    length = int(declared)
                except ValueError:
                    return await reject(400, "Content-Length 无效。")
                if length < 0:
                    return await reject(400, "Content-Length 无效。")
                if length > settings.MAX_REQUEST_BODY_BYTES:
                    return await reject(413, "请求体超过大小限制。")
            chunks = []
            size = 0
            try:
                async with asyncio.timeout(settings.REQUEST_BODY_TIMEOUT_SECONDS):
                    while True:
                        message = await receive()
                        if message["type"] == "http.disconnect":
                            return
                        data = message.get("body", b"")
                        size += len(data)
                        if size > settings.MAX_REQUEST_BODY_BYTES:
                            return await reject(413, "请求体超过大小限制。")
                        chunks.append(data)
                        if not message.get("more_body", False):
                            break
            except TimeoutError:
                return await reject(408, "读取请求体超时。")
            delivered = False

            async def buffered_receive():
                nonlocal delivered
                if not delivered:
                    delivered = True
                    return {"type": "http.request", "body": b"".join(chunks), "more_body": False}
                return await receive()

            try:
                await self.app(scope, buffered_receive, send_with_id)
            except Exception as exc:
                # Handle here so the server does not log an upstream exception's
                # potentially sensitive message after producing a safe response.
                logger.error("request_id=%s unexpected_error type=%s stack=%s", request_id, type(exc).__name__, "".join(traceback.format_tb(exc.__traceback__)))
                if not response_started:
                    await reject(500, "服务器内部错误，请稍后重试。")
        finally:
            self.active -= 1
            logger.info("request_id=%s method=%s path=%s status=%d duration_ms=%d", request_id, scope["method"], scope["path"], response_status, int((time.monotonic() - started) * 1000))
