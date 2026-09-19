from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class ReasoningPreset:
    id: str
    label: str
    description: str
    teaching_depth: str
    upstream_params: dict[str, Any]
    quota_weight: int


@dataclass(frozen=True)
class ModelProfile:
    id: str
    display_name: str
    provider: str
    upstream_model: str
    profile_revision: str
    modes: tuple[ReasoningPreset, ...]
    max_final_tokens: int = 1200

    def get_mode(self, mode_id: str | None) -> ReasoningPreset:
        target = mode_id or self.modes[0].id
        for mode in self.modes:
            if mode.id == target:
                return mode
        raise ValueError("Unsupported reasoning mode")


@dataclass(frozen=True)
class LLMResult:
    content: str
    provider: str
    upstream_model: str
    usage: dict[str, int]
