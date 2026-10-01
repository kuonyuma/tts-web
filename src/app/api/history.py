import logging
from fastapi import APIRouter, HTTPException, Depends, Path, status

from app.schemas.tts import HistoryItem
from app.api.dependencies import require_tts_identity
from app.services.tts_service import TTSService, get_tts_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["history"])


@router.get("/history", summary="List TTS playback history", response_model=list[HistoryItem])
async def get_history(
    x_client_id: str = Depends(require_tts_identity),
    service: TTSService = Depends(get_tts_service),
):
    """Returns the most recent 50 history records for the current client ordered by last played time."""
    return await service.list_history(x_client_id)


@router.delete(
    "/history",
    summary="Clear all history records for current client",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def clear_history(
    x_client_id: str = Depends(require_tts_identity),
    service: TTSService = Depends(get_tts_service),
):
    """Deletes all history records belonging to the current client."""
    count = await service.clear_history(x_client_id)
    logger.info("Cleared history records=%d", count)


@router.delete(
    "/history/{history_id}",
    summary="Delete a history record for current client",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def remove_history(
    history_id: int = Path(gt=0),
    x_client_id: str = Depends(require_tts_identity),
    service: TTSService = Depends(get_tts_service),
):
    """Deletes a history record belonging to the current client."""
    deleted = await service.delete_history(x_client_id, history_id)
    if not deleted:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="历史记录不存在或无权删除。"
        )
    logger.info("Deleted history id=%d", history_id)

