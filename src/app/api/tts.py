from fastapi import APIRouter, Depends, Path, Response

from app.api.dependencies import gemini_request_key, require_tts_identity
from app.config import settings
from app.schemas.tts import TTSRequest, EngineInfoResponse, TestKeyRequest, TestKeyResponse, TTSFlowResponse
from app.services.engines import get_engine, list_engines_meta
from app.services.errors import TTSException, TTSUpstreamError, provider_error
from app.services.gemini_client import create_client, managed_client
from app.services.runtime import request_deadline, upstream_slot
from app.services.tts_service import TTSService, get_tts_service
from app.services.tts_storage import TTSResult
from app.validation import REPLAY_KEY_PATTERN

router = APIRouter(prefix="/api", tags=["tts"])


@router.get("/engines", response_model=list[EngineInfoResponse])
async def get_engines():
    return [dict(meta, storage_mode=settings.TTS_STORAGE_MODE) for meta in list_engines_meta()]


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
                raise TTSUpstreamError(502)
    except TTSException:
        raise
    except Exception as exc:
        raise provider_error(exc, "gemini-key-check") from None


def _audio_response(result: TTSResult) -> Response:
    headers = {
        "Cache-Control": result.cache_control,
        "Content-Disposition": 'inline; filename="tts_output.mp3"',
        "X-Cache": "HIT" if result.cached else "MISS",
        "X-Cache-Key": result.key,
    }
    if result.asset.engine:
        headers["X-Engine"] = result.asset.engine
    return Response(content=result.asset.audio, media_type="audio/mpeg", headers=headers)


def _manifest(result: TTSResult) -> TTSFlowResponse:
    return TTSFlowResponse(
        version=1, cache_key=result.key, audio_url=f"/api/tts/{result.key}", media_type="audio/mpeg",
        engine=result.asset.engine or "edge", voice=result.asset.voice, cached=result.cached,
        timeline_available=bool(result.asset.sentences), sentences=result.asset.sentences,
    )


@router.post("/tts", summary="Convert text to speech", response_class=Response)
async def text_to_speech(
    request: TTSRequest,
    x_gemini_api_key: str | None = Depends(gemini_request_key),
    x_client_id: str = Depends(require_tts_identity),
    service: TTSService = Depends(get_tts_service),
):
    return _audio_response(await service.generate(x_client_id, request, x_gemini_api_key))


@router.post("/tts/flow", response_model=TTSFlowResponse)
async def text_to_speech_flow(
    request: TTSRequest,
    x_gemini_api_key: str | None = Depends(gemini_request_key),
    x_client_id: str = Depends(require_tts_identity),
    service: TTSService = Depends(get_tts_service),
):
    return _manifest(await service.generate(x_client_id, request, x_gemini_api_key, flow=True))


@router.get("/tts/flow/{cache_key}", response_model=TTSFlowResponse)
async def get_flow_manifest(
    cache_key: str = Path(pattern=REPLAY_KEY_PATTERN),
    x_client_id: str = Depends(require_tts_identity),
    service: TTSService = Depends(get_tts_service),
):
    return _manifest(await service.replay(x_client_id, cache_key, flow=True))


@router.get("/tts/{cache_key}", response_class=Response)
async def replay_cached_audio(
    cache_key: str = Path(pattern=REPLAY_KEY_PATTERN),
    x_client_id: str = Depends(require_tts_identity),
    service: TTSService = Depends(get_tts_service),
):
    return _audio_response(await service.replay(x_client_id, cache_key))
