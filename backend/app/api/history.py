import logging
from fastapi import APIRouter, HTTPException, Depends, Path, status

from app.schemas.tts import HistoryItem
from app.api.dependencies import require_client_id
from starlette.concurrency import run_in_threadpool
from app.services.history_service import list_history, delete_history, clear_all_history

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["history"])


@router.get("/history", summary="List TTS playback history", response_model=list[HistoryItem])
async def get_history(
    x_client_id: str = Depends(require_client_id),
):
    """Returns the most recent 50 history records for the current client ordered by last played time."""
    records = await run_in_threadpool(list_history, client_id=x_client_id, limit=50)
    return records


@router.delete(
    "/history",
    summary="Clear all history records for current client",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def clear_history(
    x_client_id: str = Depends(require_client_id),
):
    """Deletes all history records belonging to the current client."""
    count = await run_in_threadpool(clear_all_history, client_id=x_client_id)
    logger.info("Cleared history records=%d", count)


@router.delete(
    "/history/{history_id}",
    summary="Delete a history record for current client",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def remove_history(
    history_id: int = Path(gt=0),
    x_client_id: str = Depends(require_client_id),
):
    """Deletes a history record belonging to the current client."""
    deleted = await run_in_threadpool(delete_history, client_id=x_client_id, history_id=history_id)
    if not deleted:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="历史记录不存在或无权删除。"
        )
    logger.info("Deleted history id=%d", history_id)

