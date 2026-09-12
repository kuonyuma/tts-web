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
    SentenceCueResponse,
    TTSFlowResponse,
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
from app.services.tts_service import synthesize, synthesize_with_timeline
from app.services.cache_service import (
    compute_cache_key,
    compute_flow_cache_key,
    get_cached_audio,
    get_cached_flow,
    put_audio_cache,
    put_flow_cache,
)
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


@router.post(
    "/tts/flow",
    summary="Synthesize speech with synchronized sentence timeline",
    response_model=TTSFlowResponse,
)
async def text_to_speech_flow(
    request: TTSRequest,
    x_gemini_api_key: str | None = Header(default=None, alias="X-Gemini-Api-Key"),
    x_client_id: str = Header(default="default", alias="X-Client-ID"),
):
    """
    Synthesizes the provided text into a single MP3 while collecting sentence timestamps.
    Returns a manifest JSON containing the audio URL and sentence cues.
    """
    text_length = len(request.text)
    start_time = time.perf_counter()

    engine_id = (request.engine or DEFAULT_ENGINE_ID).lower().strip()
    engine = get_engine(engine_id)

    if not engine.supports_sentence_timeline:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=f"当前引擎 '{engine_id}' 暂不支持句子时间轴，请使用 Edge TTS 或原 /api/tts 接口。",
        )

    voice = request.voice or engine.default_voice
    model_name = settings.GEMINI_TTS_MODEL if engine_id == "gemini" else engine_id
    cache_key = compute_flow_cache_key(request.text, voice, engine_id)

    # 1. Check paired cache first
    cached_flow = get_cached_flow(cache_key)
    if cached_flow is not None:
        audio_bytes, timeline_data = cached_flow
        duration_ms = int((time.perf_counter() - start_time) * 1000)
        logger.info(
            "TTS flow request status=cache_hit engine=%s voice=%s text_length=%d sentences=%d duration_ms=%d cache_key=%s client_id=%s",
            engine_id, voice, text_length, len(timeline_data.get("sentences", [])), duration_ms, cache_key, x_client_id
        )
        add_or_touch(x_client_id, request.text, voice, model_name, engine_id, cache_key)
        return TTSFlowResponse(
            version=1,
            cache_key=cache_key,
            audio_url=f"/api/tts/{cache_key}",
            media_type="audio/mpeg",
            engine=engine_id,
            voice=voice,
            cached=True,
            timeline_available=True,
            sentences=timeline_data.get("sentences", []),
        )

    # 2. Cache miss: synthesize with timeline
    try:
        result = await synthesize_with_timeline(
            text=request.text,
            voice=voice,
            engine=engine_id,
            api_key=x_gemini_api_key,
        )
        duration_ms = int((time.perf_counter() - start_time) * 1000)
        timeline_available = len(result.sentences) > 0

        # Store in cache
        if timeline_available:
            put_flow_cache(cache_key, result.audio_bytes, engine_id, voice, result.sentences)
        else:
            put_audio_cache(cache_key, result.audio_bytes)

        add_or_touch(x_client_id, request.text, voice, model_name, engine_id, cache_key)

        sentence_responses = [
            SentenceCueResponse(
                index=idx,
                text=s.text,
                start_ms=s.start_ms,
                end_ms=s.end_ms,
            )
            for idx, s in enumerate(result.sentences)
        ]

        logger.info(
            "TTS flow request status=success engine=%s voice=%s text_length=%d sentences=%d duration_ms=%d cache_key=%s client_id=%s",
            engine_id, voice, text_length, len(sentence_responses), duration_ms, cache_key, x_client_id
        )

        return TTSFlowResponse(
            version=1,
            cache_key=cache_key,
            audio_url=f"/api/tts/{cache_key}",
            media_type="audio/mpeg",
            engine=engine_id,
            voice=voice,
            cached=False,
            timeline_available=timeline_available,
            sentences=sentence_responses,
        )

    except TTSConfigError as exc:
        duration_ms = int((time.perf_counter() - start_time) * 1000)
        logger.warning("TTS flow config_error engine=%s error=%s", engine_id, str(exc))
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc)
        )
    except TTSTimeoutError as exc:
        duration_ms = int((time.perf_counter() - start_time) * 1000)
        logger.error("TTS flow timeout engine=%s text_length=%d duration_ms=%d error=%s", engine_id, text_length, duration_ms, str(exc))
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="语音服务请求超时，请稍后重试。"
        )
    except TTSUpstreamError as exc:
        duration_ms = int((time.perf_counter() - start_time) * 1000)
        logger.error("TTS flow upstream_error engine=%s duration_ms=%d upstream_status=%d", engine_id, duration_ms, exc.status_code)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"语音服务暂时不可用（上游返回 {exc.status_code}），请检查配置或稍后重试。"
        )
    except TTSException as exc:
        duration_ms = int((time.perf_counter() - start_time) * 1000)
        logger.error("TTS flow network_error engine=%s duration_ms=%d error=%s", engine_id, duration_ms, type(exc).__name__)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="连接语音服务失败，请检查网络后重试。"
        )
    except Exception as exc:
        duration_ms = int((time.perf_counter() - start_time) * 1000)
        logger.exception("TTS flow server_error engine=%s duration_ms=%d error=%s", engine_id, duration_ms, type(exc).__name__)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"语音合成发生异常：{str(exc)}"
        )


@router.get(
    "/tts/flow/{cache_key}",
    summary="Get cached sentence timeline manifest",
    response_model=TTSFlowResponse,
)
async def get_flow_manifest(
    cache_key: str,
    x_client_id: str = Header(default="default", alias="X-Client-ID"),
):
    """
    Retrieves the cached timeline manifest for a given cache_key.
    Returns 404 if no cache exists for the key.
    If audio exists but timeline doesn't, returns timeline_available=False.
    """
    cached_flow = get_cached_flow(cache_key)
    if cached_flow is not None:
        touch(x_client_id, cache_key)
        _, timeline_data = cached_flow
        return TTSFlowResponse(
            version=1,
            cache_key=cache_key,
            audio_url=f"/api/tts/{cache_key}",
            media_type="audio/mpeg",
            engine=timeline_data.get("engine", "edge"),
            voice=timeline_data.get("voice", ""),
            cached=True,
            timeline_available=True,
            sentences=timeline_data.get("sentences", []),
        )

    cached_audio = get_cached_audio(cache_key)
    if cached_audio is not None:
        touch(x_client_id, cache_key)
        return TTSFlowResponse(
            version=1,
            cache_key=cache_key,
            audio_url=f"/api/tts/{cache_key}",
            media_type="audio/mpeg",
            engine="edge",
            voice="",
            cached=True,
            timeline_available=False,
            sentences=[],
        )

    raise HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail="缓存记录不存在或已过期。"
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
