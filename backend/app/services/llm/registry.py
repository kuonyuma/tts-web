from app.config import settings
from app.services.errors import LLMConfigError
from app.services.llm.types import ModelProfile, ReasoningPreset


def _deepseek_profile() -> ModelProfile:
    return ModelProfile(
        id="deepseek-flash",
        display_name="DeepSeek Flash",
        provider="deepseek",
        upstream_model=settings.DEEPSEEK_TEXT_MODEL,
        profile_revision="deepseek-flash-2026-09-v1",
        modes=(
            ReasoningPreset("direct", "直接回答", "速度优先，不启用推理", "quick", {"thinking": {"type": "disabled"}}, 1),
            ReasoningPreset("low", "轻度思考", "适合日常语法讲解", "standard", {"thinking": {"type": "enabled"}, "reasoning_effort": "low"}, 2),
            ReasoningPreset("deep", "深度思考", "适合复杂长难句", "deep", {"thinking": {"type": "enabled"}, "reasoning_effort": "high"}, 5),
            ReasoningPreset("max", "极致思考", "最高推理强度，消耗较高", "deep", {"thinking": {"type": "enabled"}, "reasoning_effort": "max"}, 10),
        ),
    )


def _glm_profile() -> ModelProfile:
    return ModelProfile(
        id="glm-5.3-flash",
        display_name="GLM 5.3 Flash",
        provider="zhipu",
        upstream_model=settings.GLM_TEXT_MODEL,
        profile_revision="glm53-flash-unverified-v1",
        modes=(
            ReasoningPreset("direct", "直接回答", "速度优先，不启用推理", "quick", {"thinking": {"type": "disabled"}}, 1),
            ReasoningPreset("balanced", "均衡思考", "兼顾速度与讲解质量", "standard", {"thinking": {"type": "enabled"}, "reasoning_effort": "low"}, 3),
            ReasoningPreset("deep", "深度思考", "适合复杂长难句", "deep", {"thinking": {"type": "enabled"}, "reasoning_effort": "high"}, 6),
            ReasoningPreset("max", "极致思考", "最高推理强度，消耗较高", "deep", {"thinking": {"type": "enabled"}, "reasoning_effort": "max"}, 10),
        ),
    )


def _qwen_profile() -> ModelProfile:
    return ModelProfile(
        id="qwen-3.7-flash",
        display_name="Qwen 3.7 Flash",
        provider="qwen",
        upstream_model=settings.QWEN_TEXT_MODEL,
        profile_revision="qwen37-flash-2026-07-v1",
        modes=(
            ReasoningPreset("direct", "直接回答", "速度优先，不启用推理", "quick", {"enable_thinking": False}, 1),
            ReasoningPreset("brief", "简短思考", "适合日常语法讲解", "standard", {"enable_thinking": True, "thinking_budget": 2048}, 2),
            ReasoningPreset("balanced", "均衡思考", "适合较复杂句子", "standard", {"enable_thinking": True, "thinking_budget": 4096}, 3),
            ReasoningPreset("deep", "深度思考", "适合复杂长难句", "deep", {"enable_thinking": True, "thinking_budget": 8192}, 6),
        ),
    )


def profiles() -> dict[str, ModelProfile]:
    return {
        "deepseek-flash": _deepseek_profile(),
        "glm-5.3-flash": _glm_profile(),
        "qwen-3.7-flash": _qwen_profile(),
    }


def resolve_model(model_id: str | None = None) -> ModelProfile:
    target = (model_id or settings.COPILOT_DEFAULT_MODEL).strip().lower()
    profile = profiles().get(target)
    if profile is None or target not in settings.COPILOT_ENABLED_MODELS:
        raise LLMConfigError("所选 AI 模型未启用。")
    if target == "glm-5.3-flash" and not settings.COPILOT_ENABLE_UNVERIFIED_GLM53:
        raise LLMConfigError("GLM 5.3 Flash 尚未完成生产 API 能力验证。")
    return profile


def provider_api_key(provider: str) -> str:
    key = {
        "deepseek": settings.DEEPSEEK_API_KEY,
        "zhipu": settings.ZHIPU_API_KEY,
        "qwen": settings.QWEN_API_KEY,
    }.get(provider, "").strip()
    if not key:
        raise LLMConfigError("AI 讲解服务暂未配置。")
    return key


def catalog() -> list[dict]:
    result = []
    for model_id in settings.COPILOT_ENABLED_MODELS:
        profile = profiles().get(model_id)
        if profile is None:
            continue
        if model_id == "glm-5.3-flash" and not settings.COPILOT_ENABLE_UNVERIFIED_GLM53:
            continue
        try:
            provider_api_key(profile.provider)
        except LLMConfigError:
            continue
        result.append({
            "id": profile.id,
            "name": profile.display_name,
            "default": profile.id == settings.COPILOT_DEFAULT_MODEL,
            "modes": [
                {"id": mode.id, "name": mode.label, "description": mode.description, "quota_weight": mode.quota_weight}
                for mode in profile.modes
            ],
        })
    return result
