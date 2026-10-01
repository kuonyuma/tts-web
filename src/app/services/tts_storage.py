"""Storage contract and composition root for TTS business operations."""

from dataclasses import dataclass, field
from typing import Protocol, TypedDict

from app.config import settings


def synthesis_identity(text: str, engine: str, voice: str, model: str, revision: str) -> list[str]:
    """Shared identity fields; storage adapters add their own playback contract."""
    return [text.strip(), engine, voice, model, "mp3", revision]


class SentenceData(TypedDict):
    index: int
    text: str
    start_ms: int
    end_ms: int


@dataclass(frozen=True)
class SynthesisSpec:
    text: str
    engine: str
    voice: str
    model: str
    supports_timeline: bool


@dataclass(frozen=True)
class SynthesisPlan:
    key: str
    spec: SynthesisSpec
    with_timeline: bool


@dataclass(frozen=True)
class AudioAsset:
    audio: bytes
    engine: str = ""
    voice: str = ""
    sentences: list[SentenceData] = field(default_factory=list)


@dataclass(frozen=True)
class TTSResult:
    key: str
    asset: AudioAsset
    cached: bool
    cache_control: str


class TTSStorage(Protocol):
    cache_control: str

    def prepare(self, owner: str, spec: SynthesisSpec, *, flow: bool) -> SynthesisPlan: ...
    def lock_key(self, owner: str, key: str) -> str: ...
    def get(self, owner: str, plan: SynthesisPlan) -> AudioAsset | None: ...
    def save(self, owner: str, plan: SynthesisPlan, asset: AudioAsset) -> None: ...
    def record_hit(self, owner: str, plan: SynthesisPlan) -> None: ...
    def replay(self, owner: str, key: str, *, flow: bool) -> AudioAsset: ...
    def audio_limit_error(self) -> Exception: ...
    def list_history(self, owner: str, limit: int = 50) -> list[dict]: ...
    def delete_history(self, owner: str, history_id: int) -> bool: ...
    def clear_history(self, owner: str) -> int: ...
    def initialize(self) -> None: ...


def get_tts_storage() -> TTSStorage:
    # Select at composition time, never in routes or synthesis coordination.
    if settings.TTS_STORAGE_MODE == "private":
        from app.services.private_tts_adapter import PrivateTTSStorage
        from app.services.private_tts_storage import get_private_store

        return PrivateTTSStorage(get_private_store())
    from app.services.legacy_tts_storage import LegacyTTSStorage

    return LegacyTTSStorage()
