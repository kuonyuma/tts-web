from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import TypedDict


@dataclass(frozen=True)
class SentenceCue:
    text: str
    start_ms: int
    end_ms: int


@dataclass(frozen=True)
class TimedSynthesisResult:
    audio_bytes: bytes
    sentences: list[SentenceCue]


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

    @property
    def supports_sentence_timeline(self) -> bool:
        """Whether this engine supports generating sentence-level timestamps."""
        return False

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

    async def synthesize_with_timeline(
        self,
        text: str,
        voice: str | None = None,
        api_key: str | None = None,
    ) -> TimedSynthesisResult:
        """
        Synthesize speech and return both MP3 audio bytes and sentence timestamps.
        Must be implemented by engines declaring supports_sentence_timeline=True.
        """
        raise NotImplementedError(f"Engine '{self.engine_id}' does not support sentence timeline.")

    @abstractmethod
    def get_voices(self) -> list[VoiceInfo]:
        """Return list of supported voice models with metadata."""
        pass

