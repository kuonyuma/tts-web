import asyncio
import json
from unittest.mock import patch

import httpx
import pytest

from app.config import settings
from app.services.errors import LLMUpstreamError
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
            "choices": [{"message": {"content": " final answer ", "reasoning_content": "private chain"}}],
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
    monkeypatch.setattr("redis.asyncio.Redis.from_url", lambda *args, **kwargs: accepted)
    asyncio.run(reserve_copilot_quota("identity", 5))
    assert accepted.call[1] == 3
    assert accepted.call[5] == 5

    rejected = FakeRedis(0)
    monkeypatch.setattr("redis.asyncio.Redis.from_url", lambda *args, **kwargs: rejected)
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
