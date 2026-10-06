from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Query

from app.api.dependencies import current_account
from app.schemas.articles import ArticleCreate, ArticleUpdate, ArticleResponse, ArticleSummary
from app.services.auth_service import AuthContext
from app.services import article_service as articles


def article_account(
    context: AuthContext = Depends(current_account),
    x_article_account: int | None = Header(default=None),
) -> int:
    if x_article_account is not None and x_article_account != context.user.id:
        raise HTTPException(409, "登录账号已变化，请刷新文章库。")
    return context.user.id


router = APIRouter(prefix="/api/articles", tags=["articles"])


@router.get("", response_model=list[ArticleSummary])
def list_articles(q: str = Query(default="", max_length=200), user_id: int = Depends(article_account)):
    return articles.list_articles(user_id, q)


@router.post("", response_model=ArticleResponse, status_code=201)
def create_article(body: ArticleCreate, user_id: int = Depends(article_account)):
    return articles.create_article(user_id, body)


@router.get("/{article_id}", response_model=ArticleResponse)
def get_article(article_id: UUID, user_id: int = Depends(article_account)):
    return articles.get_article(user_id, str(article_id))


@router.put("/{article_id}", response_model=ArticleResponse)
def update_article(article_id: UUID, body: ArticleUpdate, user_id: int = Depends(article_account)):
    return articles.update_article(user_id, str(article_id), body)


@router.delete("/{article_id}", status_code=204)
def delete_article(article_id: UUID, user_id: int = Depends(article_account)):
    articles.delete_article(user_id, str(article_id))
