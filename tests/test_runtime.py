import asyncio

import pytest

from app.config import settings
from app.services import runtime
from app.services.errors import TTSBusyError, TTSTimeoutError, LLMBusyError, LLMTimeoutError


@pytest.fixture(params=["tts", "llm"])
def provider_slot(request, monkeypatch):
    monkeypatch.setattr(settings, "EDGE_TTS_MAX_CONCURRENCY", 1)
    monkeypatch.setattr(settings, "QUEUE_TIMEOUT_SECONDS", 0.02)
    monkeypatch.setattr(settings, "LLM_QUEUE_TIMEOUT_SECONDS", 0.02)
    if request.param == "tts":
        return lambda: runtime.upstream_slot("edge"), "edge", TTSBusyError
    return lambda: runtime.llm_upstream_slot("edge", 1), "llm:edge", LLMBusyError


@pytest.mark.anyio
async def test_queue_timeout_does_not_consume_a_permit(provider_slot):
    slot, _, busy = provider_slot
    async with slot():
        with pytest.raises(busy):
            async with slot():
                pytest.fail("A full provider must not admit another operation")
    async with asyncio.timeout(0.2), slot():
        pass


@pytest.mark.anyio
async def test_pending_limit_rejection_does_not_leak_capacity(provider_slot, monkeypatch):
    slot, _, busy = provider_slot
    monkeypatch.setattr(settings, "MAX_PENDING_REQUESTS", 1)
    async with slot():
        with pytest.raises(busy):
            async with slot():
                pytest.fail("Pending limit must reject before queueing")
    async with slot():
        pass


@pytest.mark.anyio
async def test_cancelling_waiter_and_holder_restores_capacity(provider_slot, monkeypatch):
    slot, key, _ = provider_slot
    monkeypatch.setattr(settings, "QUEUE_TIMEOUT_SECONDS", 5)
    monkeypatch.setattr(settings, "LLM_QUEUE_TIMEOUT_SECONDS", 5)
    entered = asyncio.Event()

    async def occupy():
        async with slot():
            entered.set()
            await asyncio.Event().wait()

    tasks = []
    try:
        holder = asyncio.create_task(occupy())
        tasks.append(holder)
        await asyncio.wait_for(entered.wait(), 0.5)
        waiter = asyncio.create_task(occupy())
        tasks.append(waiter)
        async with asyncio.timeout(0.5):
            while runtime._state().pending[key] != 2:
                await asyncio.sleep(0)
        waiter.cancel()
        with pytest.raises(asyncio.CancelledError):
            await waiter
        assert runtime._state().pending[key] == 1
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
    async with asyncio.timeout(0.2), slot():
        pass
    assert runtime._state().pending[key] == 0


@pytest.mark.anyio
async def test_tts_and_llm_have_independent_provider_capacity(monkeypatch):
    monkeypatch.setattr(settings, "EDGE_TTS_MAX_CONCURRENCY", 1)
    async with asyncio.timeout(0.5), runtime.upstream_slot("edge"), runtime.llm_upstream_slot("edge", 1):
        pass


@pytest.mark.anyio
@pytest.mark.parametrize("deadline,error", [
    (runtime.request_deadline, TTSTimeoutError),
    (runtime.llm_request_deadline, LLMTimeoutError),
])
async def test_deadline_preserves_service_error_type(deadline, error, monkeypatch):
    monkeypatch.setattr(settings, "TTS_TIMEOUT_SECONDS", 0.01)
    monkeypatch.setattr(settings, "LLM_TIMEOUT_SECONDS", 0.01)
    with pytest.raises(error):
        async with deadline():
            await asyncio.Event().wait()
