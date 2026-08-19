from abc import ABC, abstractmethod
from typing import TypedDict


class VoiceInfo(TypedDict):
    id: str
    name: str
    gender: str
    description: str


class BaseTTSEngine(ABC):
    """Abstract base class for TTS synthesis engines."""

    @property
    @abstractmethod
    def engine_id(self) -> str:
        """Unique engine identifier (e.g. 'edge', 'gemini')."""
        pass

    @property
    @abstractmethod
    def name(self) -> str:
        """Human-readable display name for the engine."""
        pass

    @property
    @abstractmethod
    def description(self) -> str:
        """Short description of the engine."""
        pass

    @property
    @abstractmethod
    def is_free(self) -> bool:
        """Whether this engine requires an API Key."""
        pass

    @property
    @abstractmethod
    def default_voice(self) -> str:
        """Default voice identifier."""
        pass

    @abstractmethod
    async def synthesize(
        self,
        text: str,
        voice: str | None = None,
        api_key: str | None = None,
    ) -> bytes:
        """
        Synthesize speech from input text and return standard MP3 bytes.

        :param text: Input text to synthesize
        :param voice: Voice identifier (optional, fallback to default_voice)
        :param api_key: Optional custom API Key for BYOK engines
        :return: Binary MP3 audio bytes
        """
        pass

    @abstractmethod
    def get_voices(self) -> list[VoiceInfo]:
        """Return list of supported voice models with metadata."""
        pass
