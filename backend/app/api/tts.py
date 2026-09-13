from fastapi import APIRouter, Depends, HTTPException, Path, Response
from starlette.concurrency import run_in_threadpool

from app.api.dependencies import gemini_request_key, require_client_id
from app.config import settings
from app.schemas.tts import TTSRequest, EngineInfoResponse, TestKeyRequest, TestKeyResponse, TTSFlowResponse
from app.services.engines import get_engine, list_engines_meta
from app.services.errors import TTSException, TTSUpstreamError, provider_error
from app.services.gemini_client import create_client, managed_client
from app.services.runtime import cache_lock, request_deadline, upstream_slot
from app.services.tts_service import synthesize, synthesize_with_timeline
from app.services.cache_service import (
    compute_cache_key, compute_flow_cache_key, get_cached_audio, get_cached_flow,
    put_audio_cache, put_flow_cache,
)
from app.services.history_service import add_or_touch, touch
from app.validation import CACHE_KEY_PATTERN

router = APIRouter(prefix="/api", tags=["tts"])


@router.get("/engines", response_model=list[EngineInfoResponse])
async def get_engines():
    return list_engines_meta()


@router.post("/tts/test-key", response_model=TestKeyResponse)
async def test_gemini_key(payload: TestKeyRequest):
    if not payload.api_key.strip():
        return TestKeyResponse(valid=False, message="API Key 不能为空。")
    try:
        async with request_deadline(), upstream_slot("gemini"):
            async with managed_client(create_client(payload.api_key)) as client:
                interaction = await client.aio.interactions.create(
                    model=settings.GEMINI_TTS_MODEL, input="あ",
                    response_format={"type": "audio"},
                    generation_config={"speech_config": [{"voice": get_engine("gemini").default_voice}]},
                )
                if interaction.output_audio and interaction.output_audio.data:
                    return TestKeyResponse(valid=True, message="Gemini API Key 验证成功！")
                raise TTSUpstreamError(502, "Empty audio response")
    except TTSException:
        raise
    except Exception as exc:
        raise provider_error(exc, "gemini-key-check") from None


def _audio_response(audio: bytes, cache: str, key: str | None = None, engine: str | None = None):
    headers = {
        "Cache-Control": "no-cache", "Content-Disposition": 'inline; filename="tts_output.mp3"',
        "X-Cache": cache,
    }
    if key:
        headers["X-Cache-Key"] = key
    if engine:
        headers["X-Engine"] = engine
    return Response(content=audio, media_type="audio/mpeg", headers=headers)


@router.post("/tts", summary="Convert text to speech", response_class=Response)
async def text_to_speech(
    request: TTSRequest,
    x_gemini_api_key: str | None = Depends(gemini_request_key),
    x_client_id: str = Depends(require_client_id),
):
    engine = get_engine(request.engine)
    voice = request.voice or engine.default_voice
    key = compute_cache_key(request.text, voice, engine.engine_id)
    model = settings.GEMINI_TTS_MODEL if engine.engine_id == "gemini" else engine.engine_id
    async with request_deadline(), cache_lock(key):
        audio = await run_in_threadpool(get_cached_audio, key)
        cached = audio is not None
        if not cached:
            audio = await synthesize(text=request.text, voice=voice, engine=engine.engine_id, api_key=x_gemini_api_key)
            await run_in_threadpool(put_audio_cache, key, audio)
        await run_in_threadpool(add_or_touch, x_client_id, request.text, voice, model, engine.engine_id, key)
        return _audio_response(audio, "HIT" if cached else "MISS", key, engine.engine_id)


def _manifest(key: str, data: dict, cached: bool) -> TTSFlowResponse:
    sentences = data.get("sentences", [])
    return TTSFlowResponse(
        version=1, cache_key=key, audio_url=f"/api/tts/{key}", media_type="audio/mpeg",
        engine=data.get("engine", "edge"), voice=data.get("voice", ""), cached=cached,
        timeline_available=bool(sentences), sentences=sentences,
    )


@router.post("/tts/flow", response_model=TTSFlowResponse)
async def text_to_speech_flow(
    request: TTSRequest,
    x_gemini_api_key: str | None = Depends(gemini_request_key),
    x_client_id: str = Depends(require_client_id),
):
    engine = get_engine(request.engine)
    if not engine.supports_sentence_timeline:
        raise HTTPException(422, "当前引擎暂不支持句子时间轴，请使用 Edge TTS 或原 /api/tts 接口。")
    voice = request.voice or engine.default_voice
    key = compute_flow_cache_key(request.text, voice, engine.engine_id)
    async with request_deadline(), cache_lock(key):
        stored = await run_in_threadpool(get_cached_flow, key)
        cached = stored is not None
        if cached:
            _, data = stored
        else:
            result = await synthesize_with_timeline(
                text=request.text, voice=voice, engine=engine.engine_id, api_key=x_gemini_api_key,
            )
            # Empty timelines are also stored as a pair so retries can reuse audio.
            await run_in_threadpool(put_flow_cache, key, result.audio_bytes, engine.engine_id, voice, result.sentences)
            data = {
                "engine": engine.engine_id, "voice": voice,
                "sentences": [{"index": i, **vars(cue)} for i, cue in enumerate(result.sentences)],
            }
        await run_in_threadpool(add_or_touch, x_client_id, request.text, voice, engine.engine_id, engine.engine_id, key)
        return _manifest(key, data, cached)


@router.get("/tts/flow/{cache_key}", response_model=TTSFlowResponse)
async def get_flow_manifest(
    cache_key: str = Path(pattern=CACHE_KEY_PATTERN),
    x_client_id: str = Depends(require_client_id),
):
    async with request_deadline(), cache_lock(cache_key):
        stored = await run_in_threadpool(get_cached_flow, cache_key)
        if stored is not None:
            await run_in_threadpool(touch, x_client_id, cache_key)
            return _manifest(cache_key, stored[1], True)
        audio = await run_in_threadpool(get_cached_audio, cache_key)
        if audio is None:
            raise HTTPException(404, "缓存记录不存在或已过期。")
        await run_in_threadpool(touch, x_client_id, cache_key)
        return _manifest(cache_key, {}, True)


@router.get("/tts/{cache_key}", response_class=Response)
async def replay_cached_audio(
    cache_key: str = Path(pattern=CACHE_KEY_PATTERN),
    x_client_id: str = Depends(require_client_id),
):
    async with request_deadline(), cache_lock(cache_key):
        audio = await run_in_threadpool(get_cached_audio, cache_key)
        if audio is None:
            raise HTTPException(404, "缓存音频不存在或已过期。")
        await run_in_threadpool(touch, x_client_id, cache_key)
        return _audio_response(audio, "HIT", cache_key)
