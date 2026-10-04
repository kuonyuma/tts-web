import logging

import aiohttp
import httpx

logger = logging.getLogger(__name__)


class TTSException(Exception):
    """Sanitized failure at the provider boundary."""


class TTSConfigError(TTSException):
    pass


class TTSTimeoutError(TTSException):
    pass


class TTSBusyError(TTSException):
    pass


class StorageFullError(Exception):
    pass


class TTSNotFoundError(Exception):
    """The requested audio asset is absent or does not belong to this owner."""


class AudioUnavailable(Exception):
    """A retained history record has lost its original audio."""


class TTSFlowUnsupportedError(Exception):
    """The selected engine cannot supply a sentence timeline."""


class LLMException(Exception):
    """Sanitized Copilot provider failure."""


class LLMConfigError(LLMException):
    pass


class LLMTimeoutError(LLMException):
    pass


class LLMBusyError(LLMException):
    pass


class LLMUpstreamError(LLMException):
    def __init__(self, status_code: int):
        super().__init__("Copilot provider request failed")
        self.status_code = status_code


def llm_provider_error(exc: Exception, provider: str) -> LLMException:
    """Map provider failures without exposing response bodies, URLs or credentials."""
    if isinstance(exc, LLMException):
        return exc
    timeout = isinstance(exc, (TimeoutError, httpx.TimeoutException))
    code = getattr(exc, "status_code", None) or getattr(exc, "status", None)
    if not isinstance(code, int) or not 400 <= code <= 599:
        code = None
    logger.warning("LLM provider failure provider=%s type=%s status=%s", provider, type(exc).__name__, code)
    if timeout:
        return LLMTimeoutError("AI 讲解服务请求超时，请稍后重试。")
    if code:
        return LLMUpstreamError(code)
    if isinstance(exc, (httpx.TransportError, OSError)):
        return LLMException("连接 AI 讲解服务失败，请稍后重试。")
    return LLMUpstreamError(502)


class TTSUpstreamError(TTSException):
    def __init__(self, status_code: int):
        super().__init__(f"Upstream TTS error {status_code}")
        self.status_code = status_code


class TTSAudioTooLargeError(TTSUpstreamError):
    def __init__(self):
        super().__init__(502)


def provider_error(exc: Exception, provider: str) -> TTSException:
    """Support both GenAI error families and HTTP/WebSocket transport errors.

    Never copy provider messages, URLs or credentials into logs/public errors.
    """
    if isinstance(exc, TTSException):
        return exc
    timeout = isinstance(exc, (TimeoutError, httpx.TimeoutException))
    timeout = timeout or type(exc).__name__ in {"APITimeoutError", "ServerTimeoutError"}
    code = getattr(exc, "status_code", None) or getattr(exc, "status", None) or getattr(exc, "code", None)
    if not isinstance(code, int) or not 400 <= code <= 599:
        code = None
    logger.warning("Provider failure provider=%s type=%s status=%s", provider, type(exc).__name__, code)
    if timeout:
        return TTSTimeoutError("语音或讲解服务请求超时，请稍后重试。")
    if code:
        return TTSUpstreamError(code)
    if isinstance(exc, (httpx.TransportError, aiohttp.ClientError, OSError)) or type(exc).__name__ == "APIConnectionError":
        return TTSException("连接上游服务失败，请稍后重试。")
    return TTSUpstreamError(502)
