from app.services.engines.base import BaseTTSEngine, VoiceInfo
from app.services.engines.edge_engine import EdgeTTSEngine
from app.services.engines.gemini_engine import (
    GeminiTTSEngine,
    TTSException,
    TTSConfigError,
    TTSTimeoutError,
    TTSUpstreamError,
)

# Registry of supported engines
_ENGINES: dict[str, BaseTTSEngine] = {
    "edge": EdgeTTSEngine(),
    "gemini": GeminiTTSEngine(),
}

DEFAULT_ENGINE_ID = "edge"


def get_engine(engine_id: str | None = None) -> BaseTTSEngine:
    """
    Retrieve TTS engine instance by id. Defaults to Edge TTS if unspecified or unknown.
    """
    target_id = (engine_id or DEFAULT_ENGINE_ID).lower().strip()
    if target_id not in _ENGINES:
        return _ENGINES[DEFAULT_ENGINE_ID]
    return _ENGINES[target_id]


def list_engines_meta() -> list[dict]:
    """
    Return metadata for all registered engines, including voice lists.
    """
    result = []
    for engine_id, engine in _ENGINES.items():
        meta = {
            "id": engine.engine_id,
            "name": engine.name,
            "description": engine.description,
            "is_free": engine.is_free,
            "default_voice": engine.default_voice,
            "voices": engine.get_voices(),
        }
        if engine_id == "gemini":
            meta["server_has_key"] = getattr(engine, "server_has_key", False)
        result.append(meta)
    return result


__all__ = [
    "BaseTTSEngine",
    "VoiceInfo",
    "EdgeTTSEngine",
    "GeminiTTSEngine",
    "get_engine",
    "list_engines_meta",
    "DEFAULT_ENGINE_ID",
    "TTSException",
    "TTSConfigError",
    "TTSTimeoutError",
    "TTSUpstreamError",
]
