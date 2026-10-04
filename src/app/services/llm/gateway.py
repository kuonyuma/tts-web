from app.services.llm.providers import complete_openai_compatible
from app.services.llm.types import LLMResult, ModelProfile, ReasoningPreset


async def complete(
    profile: ModelProfile, mode: ReasoningPreset, messages: list[dict[str, str]]
) -> tuple[LLMResult, str, str, str]:
    result = await complete_openai_compatible(profile, mode, messages)
    return result, profile.id, mode.id, profile.profile_revision
