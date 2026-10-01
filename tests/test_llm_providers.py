import asyncio
import json
from unittest.mock import patch

import httpx
import pytest
from fastapi import HTTPException

from app.config import settings
from app.services.errors import LLMTimeoutError, LLMUpstreamError, StorageFullError
from app.services.llm.providers import build_payload, complete_openai_compatible
from app.services.llm.registry import profiles


@pytest.mark.parametrize(
    ("model_id", "mode_id", "expected"),
    [
        ("deepseek-flash", "deep", {"thinking": {"type": "enabled"}, "reasoning_effort": "high"}),
        ("glm-5.3-flash", "direct", {"thinking": {"type": "disabled"}}),
        ("qwen-3.7-flash", "balanced", {"enable_thinking": True, "thinking_budget": 4096}),
    ],
)
def test_model_specific_reasoning_payloads(model_id, mode_id, expected):
    profile = profiles()[model_id]
    payload = build_payload(profile, profile.get_mode(mode_id), [{"role": "user", "content": "hi"}])
    assert payload["model"] == profile.upstream_model
    assert payload["stream"] is False
    for key, value in expected.items():
        assert payload[key] == value


def test_provider_uses_fixed_url_and_discards_reasoning(monkeypatch):
    profile = profiles()["deepseek-flash"]
    mode = profile.get_mode("deep")
    seen = {}

    async def handler(request):
        seen["url"] = str(request.url)
        seen["authorization"] = request.headers["authorization"]
        seen["payload"] = json.loads(request.content)
        return httpx.Response(200, json={
            "model": "deepseek-flash",
            "choices": [{"finish_reason": "stop", "message": {"content": " final answer ", "reasoning_content": "private chain"}}],
            "usage": {"total_tokens": 12, "completion_tokens_details": {"reasoning_tokens": 5}},
        })

    monkeypatch.setattr(settings, "DEEPSEEK_API_KEY", "server-secret")
    transport = httpx.MockTransport(handler)

    def client_factory(timeout):
        return httpx.AsyncClient(transport=transport, timeout=timeout, follow_redirects=False)

    async def run():
        with patch("app.services.llm.providers.create_http_client", side_effect=client_factory):
            return await complete_openai_compatible(
                profile, mode, [{"role": "user", "content": "hi"}]
            )

    result = asyncio.run(run())
    assert seen["url"] == "https://api.deepseek.com/chat/completions"
    assert seen["authorization"] == "Bearer server-secret"
    assert result.content == "final answer"
    assert "private chain" not in repr(result)
    assert result.usage["reasoning_tokens"] == 5


@pytest.mark.parametrize("model_id", ["deepseek-flash", "glm-5.3-flash", "qwen-3.7-flash"])
@pytest.mark.parametrize("finish_reason", [
    "length", "content_filter", "tool_calls", "insufficient_system_resource", "aborted",
    "sensitive", "model_context_window_exceeded", "network_error", "unknown", None,
])
def test_provider_rejects_non_complete_answers(monkeypatch, model_id, finish_reason):
    profile = profiles()[model_id]
    for key in ("DEEPSEEK_API_KEY", "ZHIPU_API_KEY", "QWEN_API_KEY"):
        monkeypatch.setattr(settings, key, "server-secret")
    transport = httpx.MockTransport(lambda request: httpx.Response(200, json={
        "model": profile.upstream_model,
        "choices": [{
            "finish_reason": finish_reason,
            "message": {"role": "assistant", "content": "unfinished answer"},
        }],
        "usage": {"prompt_tokens": 5, "completion_tokens": 5, "total_tokens": 10},
    }))

    def client_factory(timeout):
        return httpx.AsyncClient(transport=transport, timeout=timeout)

    async def run():
        with patch("app.services.llm.providers.create_http_client", side_effect=client_factory):
            return await complete_openai_compatible(
                profile, profile.modes[0], [{"role": "user", "content": "hi"}]
            )

    with pytest.raises(LLMUpstreamError) as caught:
        asyncio.run(run())
    assert caught.value.status_code == 502
    assert "unfinished answer" not in str(caught.value)


@pytest.mark.parametrize("model_id", ["deepseek-flash", "glm-5.3-flash", "qwen-3.7-flash"])
def test_provider_accepts_completed_answers(monkeypatch, model_id):
    profile = profiles()[model_id]
    for key in ("DEEPSEEK_API_KEY", "ZHIPU_API_KEY", "QWEN_API_KEY"):
        monkeypatch.setattr(settings, key, "server-secret")
    transport = httpx.MockTransport(lambda request: httpx.Response(200, json={
        "model": profile.upstream_model,
        "choices": [{
            "finish_reason": "stop",
            "message": {"role": "assistant", "content": "complete answer"},
        }],
        "usage": {"total_tokens": 10},
    }))

    def client_factory(timeout):
        return httpx.AsyncClient(transport=transport, timeout=timeout)

    async def run():
        with patch("app.services.llm.providers.create_http_client", side_effect=client_factory):
            return await complete_openai_compatible(
                profile, profile.modes[0], [{"role": "user", "content": "hi"}]
            )

    assert asyncio.run(run()).content == "complete answer"


@pytest.mark.parametrize("choice", [
    {"message": {"content": "answer without completion status"}},
    {"finish_reason": "stop"},
    {"finish_reason": "stop", "message": {"content": None}},
    None,
])
def test_provider_rejects_missing_completion_fields(monkeypatch, choice):
    profile = profiles()["deepseek-flash"]
    monkeypatch.setattr(settings, "DEEPSEEK_API_KEY", "server-secret")
    transport = httpx.MockTransport(lambda request: httpx.Response(200, json={"choices": [choice]}))

    def client_factory(timeout):
        return httpx.AsyncClient(transport=transport, timeout=timeout)

    async def run():
        with patch("app.services.llm.providers.create_http_client", side_effect=client_factory):
            await complete_openai_compatible(
                profile, profile.get_mode("direct"), [{"role": "user", "content": "hi"}]
            )

    with pytest.raises(LLMUpstreamError):
        asyncio.run(run())


def test_provider_response_size_is_bounded(monkeypatch):
    profile = profiles()["deepseek-flash"]
    monkeypatch.setattr(settings, "DEEPSEEK_API_KEY", "server-secret")
    monkeypatch.setattr(settings, "LLM_RESPONSE_MAX_BYTES", 16)
    transport = httpx.MockTransport(lambda request: httpx.Response(200, content=b"x" * 17))

    def client_factory(timeout):
        return httpx.AsyncClient(transport=transport, timeout=timeout)

    async def run():
        with patch("app.services.llm.providers.create_http_client", side_effect=client_factory):
            await complete_openai_compatible(
                profile, profile.get_mode("direct"), [{"role": "user", "content": "hi"}]
            )

    with pytest.raises(LLMUpstreamError):
        asyncio.run(run())


def test_redis_quota_is_atomic_and_weighted(monkeypatch):
    from app.services.errors import LLMBusyError
    from app.services.llm.quota import reserve_copilot_quota

    class FakeRedis:
        def __init__(self, accepted):
            self.accepted = accepted
            self.call = None

        async def eval(self, *args):
            self.call = args
            return self.accepted

        async def aclose(self):
            pass

    accepted = FakeRedis(1)
    monkeypatch.setattr(settings, "REDIS_URL", "redis://private")
    monkeypatch.setattr("app.services.llm.quota._redis_client", lambda: accepted)
    asyncio.run(reserve_copilot_quota("identity", 5))
    assert accepted.call[1] == 3
    assert accepted.call[5] == 5

    rejected = FakeRedis(0)
    monkeypatch.setattr("app.services.llm.quota._redis_client", lambda: rejected)
    with pytest.raises(LLMBusyError):
        asyncio.run(reserve_copilot_quota("identity", 10))


def test_distributed_lock_uses_owned_release(monkeypatch):
    from app.services.llm.quota import copilot_distributed_lock

    class FakeRedis:
        def __init__(self):
            self.set_args = None
            self.eval_args = None

        async def set(self, *args, **kwargs):
            self.set_args = (args, kwargs)
            return True

        async def eval(self, *args):
            self.eval_args = args
            return 1

        async def aclose(self):
            pass

    fake = FakeRedis()
    monkeypatch.setattr(settings, "REDIS_URL", "redis://private")
    monkeypatch.setattr("app.services.llm.quota._redis_client", lambda: fake)

    async def run():
        async with copilot_distributed_lock("identity", "a" * 64):
            assert fake.set_args[1]["nx"] is True

    asyncio.run(run())
    assert fake.eval_args[1] == 1
    assert fake.eval_args[-1] == fake.set_args[0][1]


def test_redis_client_pool_reuse_and_lifecycle(monkeypatch):
    from app.services.llm import quota

    monkeypatch.setattr(settings, "REDIS_URL", "redis://127.0.0.1:6379/0")

    async def run():
        try:
            client1 = quota._redis_client()
            pool = quota._get_redis_pool()
            assert client1.connection_pool is pool
            # Verify real connection can be created without TypeError
            conn = client1.connection_pool.make_connection()
            assert conn is not None

            client2 = quota._redis_client()
            assert client2.connection_pool is client1.connection_pool

            # Request-level aclose should not close the shared connection pool
            await client1.aclose()
            assert quota._redis_pool is pool

            conn2 = pool.make_connection()
            assert conn2 is not None
        finally:
            await quota.close_redis_pool()
            assert quota._redis_pool is None

    asyncio.run(run())


@pytest.mark.parametrize("error_factory", [
    pytest.param(lambda: HTTPException(404, "missing session"), id="404"),
    pytest.param(lambda: HTTPException(422, "invalid mode"), id="422"),
    pytest.param(lambda: StorageFullError("disk quota full"), id="507"),
    pytest.param(lambda: LLMUpstreamError(401), id="502"),
    pytest.param(lambda: LLMTimeoutError("timeout"), id="504"),
    pytest.param(lambda: asyncio.CancelledError(), id="cancelled"),
])
def test_distributed_lock_propagates_business_exceptions(monkeypatch, error_factory):
    from app.services.llm.quota import copilot_distributed_lock

    class FakeRedis:
        def __init__(self):
            self.set_args = None
            self.eval_args = None
            self.closed = False

        async def set(self, *args, **kwargs):
            self.set_args = (args, kwargs)
            return True

        async def eval(self, *args):
            self.eval_args = args
            return 1

        async def aclose(self):
            self.closed = True

    fake = FakeRedis()
    monkeypatch.setattr(settings, "REDIS_URL", "redis://mock")
    monkeypatch.setattr("app.services.llm.quota._redis_client", lambda: fake)
    error = error_factory()

    async def run():
        with pytest.raises(type(error)) as caught:
            async with copilot_distributed_lock("identity", "a" * 64):
                raise error
        assert caught.value is error

    asyncio.run(run())
    assert fake.eval_args is not None
    assert fake.eval_args[-2:] == (fake.set_args[0][0], fake.set_args[0][1])
    assert fake.closed is True


def test_distributed_lock_maps_redis_error_to_busy(monkeypatch):
    from app.services.errors import LLMBusyError
    from app.services.llm.quota import copilot_distributed_lock

    class FailingRedis:
        async def set(self, *args, **kwargs):
            raise ConnectionError("redis connection failed")

        async def aclose(self):
            pass

    monkeypatch.setattr(settings, "REDIS_URL", "redis://mock")
    monkeypatch.setattr("app.services.llm.quota._redis_client", lambda: FailingRedis())

    async def run():
        with pytest.raises(LLMBusyError, match="AI 讲解协调服务不可用"):
            async with copilot_distributed_lock("identity", "a" * 64):
                pass

    asyncio.run(run())
