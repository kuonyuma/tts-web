"""Temporary compatibility adapter; remove after the private rollout exit gate."""

import re

from app.services import cache_service as cache, history_service as history
from app.services.errors import TTSNotFoundError, TTSAudioTooLargeError
from app.services.tts_storage import AudioAsset, SynthesisPlan, SynthesisSpec
from app.validation import CACHE_KEY_PATTERN


class LegacyTTSStorage:
    cache_control = "no-cache"

    def prepare(self, owner: str, spec: SynthesisSpec, *, flow: bool) -> SynthesisPlan:
        make_key = cache.compute_flow_cache_key if flow else cache.compute_cache_key
        return SynthesisPlan(make_key(spec.text, spec.voice, spec.engine, spec.model), spec, flow)

    def lock_key(self, owner: str, key: str) -> str:
        return key

    def get(self, owner: str, plan: SynthesisPlan) -> AudioAsset | None:
        if plan.with_timeline:
            stored = cache.get_cached_flow(plan.key)
            if stored is None:
                return None
            audio, data = stored
            return AudioAsset(audio, data.get("engine", "edge"), data.get("voice", ""), data.get("sentences", []))
        audio = cache.get_cached_audio(plan.key)
        return None if audio is None else AudioAsset(audio, plan.spec.engine, plan.spec.voice)

    def save(self, owner: str, plan: SynthesisPlan, asset: AudioAsset) -> None:
        if plan.with_timeline:
            cache.put_flow_cache(plan.key, asset.audio, asset.engine, asset.voice, asset.sentences)
        else:
            cache.put_audio_cache(plan.key, asset.audio)
        self.record_hit(owner, plan)

    def record_hit(self, owner: str, plan: SynthesisPlan) -> None:
        spec = plan.spec
        history.add_or_touch(owner, spec.text, spec.voice, spec.model, spec.engine, plan.key)

    def replay(self, owner: str, key: str, *, flow: bool) -> AudioAsset:
        if not re.fullmatch(CACHE_KEY_PATTERN, key):
            raise TTSNotFoundError("缓存记录不存在。")
        if flow:
            stored = cache.get_cached_flow(key)
            if stored is not None:
                audio, data = stored
                asset = AudioAsset(audio, data.get("engine", "edge"), data.get("voice", ""), data.get("sentences", []))
            else:
                audio = cache.get_cached_audio(key)
                if audio is None:
                    raise TTSNotFoundError("缓存记录不存在或已过期。")
                asset = AudioAsset(audio)
        else:
            audio = cache.get_cached_audio(key)
            if audio is None:
                raise TTSNotFoundError("缓存音频不存在或已过期。")
            asset = AudioAsset(audio)
        history.touch(owner, key)
        return asset

    def audio_limit_error(self) -> Exception:
        return TTSAudioTooLargeError()

    def list_history(self, owner: str, limit: int = 50) -> list[dict]:
        return history.list_history(client_id=owner, limit=limit)

    def delete_history(self, owner: str, history_id: int) -> bool:
        return history.delete_history(client_id=owner, history_id=history_id)

    def clear_history(self, owner: str) -> int:
        return history.clear_all_history(client_id=owner)

    def initialize(self) -> None:
        history.init_db()
        cache.cleanup_cache()
