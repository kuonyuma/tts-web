import asyncio
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from weakref import WeakKeyDictionary

from app.config import settings
from app.services.errors import TTSBusyError, TTSTimeoutError, LLMBusyError, LLMTimeoutError


@dataclass
class LoopState:
    semaphores: dict = field(default_factory=dict)
    locks: dict = field(default_factory=dict)
    pending: dict = field(default_factory=dict)


_states: WeakKeyDictionary = WeakKeyDictionary()


def _state() -> LoopState:
    loop = asyncio.get_running_loop()
    if loop not in _states:
        _states[loop] = LoopState()
    return _states[loop]


@asynccontextmanager
async def _deadline(timeout_seconds: float, error: Exception):
    try:
        async with asyncio.timeout(timeout_seconds):
            yield
    except TimeoutError:
        raise error from None


def request_deadline():
    return _deadline(settings.TTS_TIMEOUT_SECONDS, TTSTimeoutError("语音或讲解服务请求超时，请稍后重试。"))


def llm_request_deadline(timeout_seconds: float | None = None):
    return _deadline(timeout_seconds or settings.LLM_TIMEOUT_SECONDS, LLMTimeoutError("AI 讲解服务请求超时，请稍后重试。"))


@asynccontextmanager
async def _upstream_slot(key: str, limit: int, queue_timeout: float, busy_error: Exception, wait_error: Exception):
    state = _state()
    semaphore = state.semaphores.setdefault(key, asyncio.Semaphore(limit))
    if state.pending.get(key, 0) >= settings.MAX_PENDING_REQUESTS:
        raise busy_error
    state.pending[key] = state.pending.get(key, 0) + 1
    acquired = False
    try:
        try:
            await asyncio.wait_for(semaphore.acquire(), queue_timeout)
            acquired = True
        except TimeoutError:
            raise wait_error from None
        yield
    finally:
        if acquired:
            semaphore.release()
        state.pending[key] -= 1


def upstream_slot(provider: str):
    limit = settings.EDGE_TTS_MAX_CONCURRENCY if provider == "edge" else settings.GEMINI_MAX_CONCURRENCY
    return _upstream_slot(provider, limit, settings.QUEUE_TIMEOUT_SECONDS,
                          TTSBusyError("服务繁忙，请稍后重试。"), TTSBusyError("等待语音或讲解服务超时，请稍后重试。"))


def llm_upstream_slot(provider: str, limit: int):
    return _upstream_slot(f"llm:{provider}", limit, settings.LLM_QUEUE_TIMEOUT_SECONDS,
                          LLMBusyError("AI 讲解服务繁忙，请稍后重试。"), LLMBusyError("等待 AI 讲解服务超时，请稍后重试。"))


@asynccontextmanager
async def cache_lock(key: str):
    """Single-worker, per-key coordination; entries disappear after the last waiter."""
    locks = _state().locks
    entry = locks.setdefault(key, [asyncio.Lock(), 0])
    entry[1] += 1
    try:
        async with entry[0]:
            yield
    finally:
        entry[1] -= 1
        if not entry[1]:
            del locks[key]
