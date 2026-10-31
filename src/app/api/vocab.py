from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response

from app.api.dependencies import current_account
from app.schemas.vocab import VocabCreate, VocabResponse, VocabUpdate
from app.services import vocab_service as vocab
from app.services.auth_service import AuthContext


def vocab_account(
    context: AuthContext = Depends(current_account),
    x_article_account: int | None = Header(default=None),
) -> int:
    if x_article_account is not None and x_article_account != context.user.id:
        raise HTTPException(409, "登录账号已变化，请刷新工作台。")
    return context.user.id


router = APIRouter(prefix="/api/vocab", tags=["vocab"])


@router.get("", response_model=list[VocabResponse])
def list_vocab_items(
    q: str = Query(default="", max_length=200),
    status: Literal["all", "unmastered", "mastered"] = Query(default="all"),
    user_id: int = Depends(vocab_account),
):
    return vocab.list_vocab(user_id, q, status)


@router.post("", response_model=VocabResponse, status_code=201)
def create_or_update_vocab_item(
    body: VocabCreate,
    response: Response,
    user_id: int = Depends(vocab_account),
):
    item, created = vocab.upsert_vocab(user_id, body)
    response.status_code = 201 if created else 200
    return item


@router.patch("/{vocab_id}", response_model=VocabResponse)
def update_vocab_item(
    vocab_id: UUID,
    body: VocabUpdate,
    user_id: int = Depends(vocab_account),
):
    return vocab.update_vocab(user_id, str(vocab_id), body)


@router.delete("/{vocab_id}", status_code=204)
def delete_vocab_item(
    vocab_id: UUID,
    user_id: int = Depends(vocab_account),
):
    vocab.delete_vocab(user_id, str(vocab_id))
