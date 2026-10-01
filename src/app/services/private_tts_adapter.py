"""Expose the retained, owner-scoped store through the common TTS contract."""

from app.config import settings
from app.services.errors import StorageFullError, TTSNotFoundError
from app.services.private_tts_storage import KEY_PATTERN, PrivateTTSStore, compute_private_key
from app.services.tts_storage import AudioAsset, SynthesisPlan, SynthesisSpec


class PrivateTTSStorage:
    cache_control = "private, no-store"

    def __init__(self, store: PrivateTTSStore) -> None:
        self.store = store

    def prepare(self, owner: str, spec: SynthesisSpec, *, flow: bool) -> SynthesisPlan:
        key = compute_private_key(spec.text, spec.engine, spec.voice, spec.model, settings.TTS_CACHE_REVISION)
        return SynthesisPlan(key, spec, spec.supports_timeline)

    def lock_key(self, owner: str, key: str) -> str:
        return f"private:{owner}:{key}"

    def get(self, owner: str, plan: SynthesisPlan) -> AudioAsset | None:
        stored = self.store.get(owner, plan.key, touch=False)
        return None if stored is None else self._asset(stored)

    @staticmethod
    def _asset(stored: tuple[bytes, dict]) -> AudioAsset:
        audio, data = stored
        return AudioAsset(audio, data["engine"], data["voice"], data["sentences"])

    def save(self, owner: str, plan: SynthesisPlan, asset: AudioAsset) -> None:
        spec = plan.spec
        self.store.put(owner, plan.key, spec.text, spec.voice, spec.model, spec.engine, asset.audio, asset.sentences)

    def record_hit(self, owner: str, plan: SynthesisPlan) -> None:
        self.store.touch(owner, plan.key)

    def replay(self, owner: str, key: str, *, flow: bool) -> AudioAsset:
        if not KEY_PATTERN.fullmatch(key):
            raise TTSNotFoundError("音频记录不存在。")
        stored = self.store.get(owner, key, touch=not flow)
        if stored is None:
            raise TTSNotFoundError("音频记录不存在或已清理。")
        return self._asset(stored)

    def audio_limit_error(self) -> Exception:
        return StorageFullError("音频超过单文件存储上限。")

    def list_history(self, owner: str, limit: int = 50) -> list[dict]:
        return self.store.list_history(owner, limit)

    def delete_history(self, owner: str, history_id: int) -> bool:
        return self.store.delete(owner, history_id)

    def clear_history(self, owner: str) -> int:
        return self.store.clear(owner)

    def initialize(self) -> None:
        self.store.reconcile()
