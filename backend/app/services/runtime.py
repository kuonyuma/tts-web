import asyncio
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from weakref import WeakKeyDictionary

from app.config import settings
from app.services.errors import TTSBusyError, TTSTimeoutError


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
async def request_deadline():
    try:
        async with asyncio.timeout(settings.TTS_TIMEOUT_SECONDS):
            yield
    except TimeoutError:
        raise TTSTimeoutError("语音或讲解服务请求超时，请稍后重试。") from None


@asynccontextmanager
async def upstream_slot(provider: str):
    state = _state()
    limit = settings.EDGE_TTS_MAX_CONCURRENCY if provider == "edge" else settings.GEMINI_MAX_CONCURRENCY
    semaphore = state.semaphores.setdefault(provider, asyncio.Semaphore(limit))
    if state.pending.get(provider, 0) >= settings.MAX_PENDING_REQUESTS:
        raise TTSBusyError("服务繁忙，请稍后重试。")
    state.pending[provider] = state.pending.get(provider, 0) + 1
    acquired = False
    try:
        try:
            await asyncio.wait_for(semaphore.acquire(), settings.QUEUE_TIMEOUT_SECONDS)
            acquired = True
        except TimeoutError:
            raise TTSBusyError("等待语音或讲解服务超时，请稍后重试。") from None
        yield
    finally:
        if acquired:
            semaphore.release()
        state.pending[provider] -= 1


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
