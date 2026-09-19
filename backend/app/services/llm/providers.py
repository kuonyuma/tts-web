import json
from typing import Any

import httpx

from app.config import settings
from app.services.errors import LLMUpstreamError, llm_provider_error
from app.services.llm.registry import provider_api_key
from app.services.llm.types import LLMResult, ModelProfile, ReasoningPreset
from app.services.runtime import llm_request_deadline, llm_upstream_slot


_PROVIDER_URLS = {
    "deepseek": "https://api.deepseek.com/chat/completions",
    "zhipu": "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    "qwen-cn": "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    "qwen-intl": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions",
}


def _provider_url(provider: str) -> str:
    key = f"qwen-{settings.QWEN_API_REGION}" if provider == "qwen" else provider
    return _PROVIDER_URLS[key]


def _concurrency(provider: str) -> int:
    return {
        "deepseek": settings.DEEPSEEK_MAX_CONCURRENCY,
        "zhipu": settings.ZHIPU_MAX_CONCURRENCY,
        "qwen": settings.QWEN_MAX_CONCURRENCY,
    }[provider]


def create_http_client(timeout: httpx.Timeout) -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=timeout, follow_redirects=False)


def build_payload(
    profile: ModelProfile, mode: ReasoningPreset, messages: list[dict[str, str]]
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "model": profile.upstream_model,
        "messages": messages,
        "stream": False,
        "max_tokens": profile.max_final_tokens,
    }
    payload.update(mode.upstream_params)
    return payload


def _parse_usage(raw: Any) -> dict[str, int]:
    if not isinstance(raw, dict):
        return {}
    result = {}
    for key in ("prompt_tokens", "completion_tokens", "total_tokens"):
        value = raw.get(key)
        if isinstance(value, int) and value >= 0:
            result[key] = value
    details = raw.get("completion_tokens_details")
    if isinstance(details, dict) and isinstance(details.get("reasoning_tokens"), int):
        result["reasoning_tokens"] = max(0, details["reasoning_tokens"])
    return result


async def complete_openai_compatible(
    profile: ModelProfile, mode: ReasoningPreset, messages: list[dict[str, str]]
) -> LLMResult:
    provider = profile.provider
    try:
        headers = {
            "Authorization": f"Bearer {provider_api_key(provider)}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        timeout = httpx.Timeout(settings.LLM_TIMEOUT_SECONDS, connect=10.0, write=10.0)
        async with llm_request_deadline(), llm_upstream_slot(provider, _concurrency(provider)):
            async with create_http_client(timeout) as client:
                async with client.stream(
                    "POST", _provider_url(provider), headers=headers,
                    json=build_payload(profile, mode, messages),
                ) as response:
                    if response.status_code < 200 or response.status_code >= 300:
                        raise LLMUpstreamError(response.status_code)
                    chunks = []
                    size = 0
                    async for chunk in response.aiter_bytes():
                        size += len(chunk)
                        if size > settings.LLM_RESPONSE_MAX_BYTES:
                            raise LLMUpstreamError(502)
                        chunks.append(chunk)
        data = json.loads(b"".join(chunks))
        if not isinstance(data, dict):
            raise LLMUpstreamError(502)
        choices = data.get("choices")
        message = choices[0].get("message") if isinstance(choices, list) and choices and isinstance(choices[0], dict) else None
        content = message.get("content") if isinstance(message, dict) else None
        if not isinstance(content, str):
            raise LLMUpstreamError(502)
        content = content.strip()
        if not content or len(content) > 16000:
            raise LLMUpstreamError(502)
        upstream_model = data.get("model") if isinstance(data.get("model"), str) else profile.upstream_model
        return LLMResult(
            content=content,
            provider=provider,
            upstream_model=upstream_model[:128],
            usage=_parse_usage(data.get("usage")),
        )
    except Exception as exc:
        raise llm_provider_error(exc, provider) from None
