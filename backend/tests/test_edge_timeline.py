import pytest
from app.services.errors import TTSUpstreamError
from unittest.mock import patch, MagicMock
from app.services.engines.edge_engine import EdgeTTSEngine
from app.services.engines.base import SentenceCue, TimedSynthesisResult


@pytest.mark.anyio
async def test_edge_timeline_success():
    """Verify audio chunks and SentenceBoundary events are properly parsed and converted."""
    engine = EdgeTTSEngine()

    async def fake_stream():
        # 1 tick = 100ns -> 10,000 tick = 1ms
        yield {"type": "SentenceBoundary", "offset": 1000000, "duration": 15000000, "text": "こんにちは。"}
        yield {"type": "audio", "data": b"chunk-1-"}
        yield {"type": "SentenceBoundary", "offset": 16500000, "duration": 20000000, "text": "今日はいい天気ですね。"}
        yield {"type": "audio", "data": b"chunk-2"}

    mock_communicate = MagicMock()
    mock_communicate.stream = fake_stream

    with patch("edge_tts.Communicate", return_value=mock_communicate):
        result = await engine.synthesize_with_timeline("こんにちは。今日はいい天気ですね。")

    assert isinstance(result, TimedSynthesisResult)
    assert result.audio_bytes == b"chunk-1-chunk-2"
    assert len(result.sentences) == 2

    assert result.sentences[0].text == "こんにちは。"
    assert result.sentences[0].start_ms == 100
    assert result.sentences[0].end_ms == 1600

    assert result.sentences[1].text == "今日はいい天気ですね。"
    assert result.sentences[1].start_ms == 1650
    assert result.sentences[1].end_ms == 3650


@pytest.mark.anyio
async def test_edge_timeline_empty_audio_raises():
    """Verify empty audio stream raises TTSUpstreamError."""
    engine = EdgeTTSEngine()

    async def fake_stream():
        yield {"type": "SentenceBoundary", "offset": 0, "duration": 1000000, "text": "テスト"}

    mock_communicate = MagicMock()
    mock_communicate.stream = fake_stream

    with patch("edge_tts.Communicate", return_value=mock_communicate):
        with pytest.raises(TTSUpstreamError):
            await engine.synthesize_with_timeline("テスト")


@pytest.mark.anyio
async def test_edge_timeline_no_sentence_boundary_fallback():
    """Verify audio is returned with empty sentences list if no SentenceBoundary events emitted."""
    engine = EdgeTTSEngine()

    async def fake_stream():
        yield {"type": "audio", "data": b"audio-only-bytes"}

    mock_communicate = MagicMock()
    mock_communicate.stream = fake_stream

    with patch("edge_tts.Communicate", return_value=mock_communicate):
        result = await engine.synthesize_with_timeline("テスト")

    assert result.audio_bytes == b"audio-only-bytes"
    assert result.sentences == []


@pytest.mark.anyio
async def test_edge_timeline_invalid_time_ignored():
    """Verify invalid or non-monotonic timestamps are filtered out."""
    engine = EdgeTTSEngine()

    async def fake_stream():
        # Valid 1: 0 - 100ms
        yield {"type": "SentenceBoundary", "offset": 0, "duration": 1000000, "text": "第1句。"}
        # Invalid 2: negative offset
        yield {"type": "SentenceBoundary", "offset": -100000, "duration": 1000000, "text": "第2句。"}
        # Invalid 3: end_ms < start_ms (duration negative)
        yield {"type": "SentenceBoundary", "offset": 2000000, "duration": -500000, "text": "第3句。"}
        # Invalid 4: non-monotonic (offset < previous valid 0ms)
        yield {"type": "SentenceBoundary", "offset": 500000, "duration": 1000000, "text": "第4句倒退。"}
        # Valid 5: 250 - 350ms
        yield {"type": "SentenceBoundary", "offset": 2500000, "duration": 1000000, "text": "第5句。"}
        yield {"type": "audio", "data": b"audio-data"}

    mock_communicate = MagicMock()
    mock_communicate.stream = fake_stream

    with patch("edge_tts.Communicate", return_value=mock_communicate):
        result = await engine.synthesize_with_timeline("テスト")

    assert len(result.sentences) == 3
    assert result.sentences[0].text == "第1句。"
    assert result.sentences[0].start_ms == 0
    assert result.sentences[0].end_ms == 100

    assert result.sentences[1].text == "第4句倒退。"
    assert result.sentences[1].start_ms == 50
    assert result.sentences[1].end_ms == 150

    assert result.sentences[2].text == "第5句。"
    assert result.sentences[2].start_ms == 250
    assert result.sentences[2].end_ms == 350


@pytest.mark.anyio
async def test_edge_engine_synthesize_delegates():
    """Verify regular synthesize method returns raw bytes."""
    engine = EdgeTTSEngine()

    async def fake_stream():
        yield {"type": "SentenceBoundary", "offset": 0, "duration": 1000000, "text": "テスト"}
        yield {"type": "audio", "data": b"mp3-bytes"}

    mock_communicate = MagicMock()
    mock_communicate.stream = fake_stream

    with patch("edge_tts.Communicate", return_value=mock_communicate):
        audio = await engine.synthesize("テスト")

    assert audio == b"mp3-bytes"
