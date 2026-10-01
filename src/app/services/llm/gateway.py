from app.services.llm.providers import complete_openai_compatible
from app.services.llm.registry import catalog, resolve_model
from app.services.llm.types import LLMResult


async def complete(
    model_id: str | None, mode_id: str | None, messages: list[dict[str, str]]
) -> tuple[LLMResult, str, str, str]:
    profile = resolve_model(model_id)
    try:
        mode = profile.get_mode(mode_id)
    except ValueError as exc:
        raise ValueError("所选模型不支持该思考模式。") from exc
    result = await complete_openai_compatible(profile, mode, messages)
    return result, profile.id, mode.id, profile.profile_revision


def get_catalog() -> list[dict]:
    return catalog()
