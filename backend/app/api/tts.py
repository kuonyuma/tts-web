import time
import logging
from fastapi import APIRouter, HTTPException, Header, Response, status
from google import genai

from app.config import settings
from app.schemas.tts import (
    TTSRequest,
    EngineInfoResponse,
    TestKeyRequest,
    TestKeyResponse,
)
from app.services.engines import (
    get_engine,
    list_engines_meta,
    DEFAULT_ENGINE_ID,
    TTSConfigError,
    TTSTimeoutError,
    TTSUpstreamError,
    TTSException,
)
from app.services.tts_service import synthesize
from app.services.cache_service import compute_cache_key, get_cached_audio, put_audio_cache
from app.services.history_service import add_or_touch, touch

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["tts"])


@router.get(
    "/engines",
    summary="List available TTS engines and supported voices",
    response_model=list[EngineInfoResponse],
)
async def get_engines():
    """Returns metadata for all available TTS engines including their voices."""
    return list_engines_meta()


@router.post(
    "/tts/test-key",
    summary="Verify Gemini API Key connection",
    response_model=TestKeyResponse,
)
async def test_gemini_key(payload: TestKeyRequest):
    """Verifies whether the provided Gemini API Key is valid by synthesizing a test syllable."""
    key = payload.api_key.strip()
    if not key:
        return TestKeyResponse(valid=False, message="API Key 不能为空。")

    try:
        client = genai.Client(api_key=key)
        model = settings.GEMINI_TTS_MODEL or "gemini-2.5-flash-preview-tts"
        interaction = await client.aio.interactions.create(
            model=model,
            input="あ",
            response_format={"type": "audio"},
            generation_config={"speech_config": [{"voice": "Kore"}]}
        )
        if interaction.output_audio and interaction.output_audio.data:
            return TestKeyResponse(valid=True, message="Gemini API Key 验证成功！")
        return TestKeyResponse(valid=False, message="API Key 验证未返回音频数据。")
    except Exception as exc:
        err_msg = str(exc)
        logger.warning("Gemini key validation failed: %s", err_msg)
        return TestKeyResponse(valid=False, message=f"验证失败: {err_msg}")


@router.post("/tts", summary="Convert Japanese text to speech", response_class=Response)
async def text_to_speech(
    request: TTSRequest,
    x_gemini_api_key: str | None = Header(default=None, alias="X-Gemini-Api-Key"),
    x_client_id: str = Header(default="default", alias="X-Client-ID"),
):
    """
    Synthesizes the provided Japanese text into MP3 audio using the selected engine.
    Supports Edge TTS (free, default) and Gemini TTS (BYOK/server key).
    Returns cached audio on repeat requests.
    """
    text_length = len(request.text)
    start_time = time.perf_counter()

    engine_id = (request.engine or DEFAULT_ENGINE_ID).lower().strip()
    engine = get_engine(engine_id)
    voice = request.voice or engine.default_voice
    model_name = settings.GEMINI_TTS_MODEL if engine_id == "gemini" else engine_id

    cache_key = compute_cache_key(request.text, voice, engine_id)

    # Check cache first
    cached = get_cached_audio(cache_key)
    if cached is not None:
        duration_ms = int((time.perf_counter() - start_time) * 1000)
        logger.info(
            "TTS request engine=%s voice=%s text_length=%d duration_ms=%d status=cache_hit cache_key=%s client_id=%s",
            engine_id, voice, text_length, duration_ms, cache_key, x_client_id
        )
        add_or_touch(x_client_id, request.text, voice, model_name, engine_id, cache_key)
        return Response(
            content=cached,
            media_type="audio/mpeg",
            headers={
                "Cache-Control": "no-cache",
                "Content-Disposition": 'inline; filename="tts_output.mp3"',
                "X-Cache": "HIT",
                "X-Cache-Key": cache_key,
                "X-Engine": engine_id,
            }
        )

    # Cache miss: synthesize via engine
    try:
        audio_bytes = await synthesize(
            text=request.text,
            voice=voice,
            engine=engine_id,
            api_key=x_gemini_api_key,
        )
        duration_ms = int((time.perf_counter() - start_time) * 1000)

        # Store in cache and record history
        put_audio_cache(cache_key, audio_bytes)
        add_or_touch(x_client_id, request.text, voice, model_name, engine_id, cache_key)

        logger.info(
            "TTS request engine=%s voice=%s text_length=%d duration_ms=%d status=success cache_key=%s client_id=%s",
            engine_id, voice, text_length, duration_ms, cache_key, x_client_id
        )

        return Response(
            content=audio_bytes,
            media_type="audio/mpeg",
            headers={
                "Cache-Control": "no-cache",
                "Content-Disposition": 'inline; filename="tts_output.mp3"',
                "X-Cache": "MISS",
                "X-Cache-Key": cache_key,
                "X-Engine": engine_id,
            }
        )

    except TTSConfigError as exc:
        duration_ms = int((time.perf_counter() - start_time) * 1000)
        logger.warning(
            "TTS request engine=%s status=config_error error=%s",
            engine_id, str(exc)
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc)
        )

    except TTSTimeoutError as exc:
        duration_ms = int((time.perf_counter() - start_time) * 1000)
        logger.error(
            "TTS request engine=%s text_length=%d duration_ms=%d status=timeout error=%s",
            engine_id, text_length, duration_ms, str(exc)
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="语音服务请求超时，请稍后重试。"
        )

    except TTSUpstreamError as exc:
        duration_ms = int((time.perf_counter() - start_time) * 1000)
        logger.error(
            "TTS request engine=%s text_length=%d duration_ms=%d status=upstream_error upstream_status=%d",
            engine_id, text_length, duration_ms, exc.status_code
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"语音服务暂时不可用（上游返回 {exc.status_code}），请检查 Key 或稍后重试。"
        )

    except TTSException as exc:
        duration_ms = int((time.perf_counter() - start_time) * 1000)
        logger.error(
            "TTS request engine=%s text_length=%d duration_ms=%d status=network_error error=%s",
            engine_id, text_length, duration_ms, type(exc).__name__
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="连接语音服务失败，请检查网络后重试。"
        )

    except Exception as exc:
        duration_ms = int((time.perf_counter() - start_time) * 1000)
        logger.exception(
            "TTS request engine=%s text_length=%d duration_ms=%d status=server_error error=%s",
            engine_id, text_length, duration_ms, type(exc).__name__
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"语音合成发生异常：{str(exc)}"
        )


@router.get("/tts/{cache_key}", summary="Replay cached TTS audio", response_class=Response)
async def replay_cached_audio(
    cache_key: str,
    x_client_id: str = Header(default="default", alias="X-Client-ID"),
):
    """
    Retrieves cached audio by cache_key for instant replay from history.
    """
    cached = get_cached_audio(cache_key)
    if cached is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="缓存音频不存在或已过期。"
        )

    touch(x_client_id, cache_key)

    return Response(
        content=cached,
        media_type="audio/mpeg",
        headers={
            "Cache-Control": "no-cache",
            "Content-Disposition": 'inline; filename="tts_output.mp3"',
            "X-Cache": "HIT",
        }
    )
