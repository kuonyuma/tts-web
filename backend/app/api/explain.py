import logging
from fastapi import APIRouter, HTTPException, Header, Query, status

from app.schemas.explain import (
    ChatMessage,
    ChatRequest,
    ChatResponse,
    ExplainRequest,
    ExplainResponse,
)
from app.services.explain_service import (
    append_chat_messages,
    build_explain_key,
    generate_chat_answer,
    generate_explanation_text,
    get_explanation,
    save_explanation,
    TTSConfigError,
    TTSTimeoutError,
    TTSUpstreamError,
    TTSException,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["explain"])


@router.post("/explain", summary="Explain a sentence with the LLM", response_model=ExplainResponse)
async def explain_sentence(
    request: ExplainRequest,
    x_gemini_api_key: str | None = Header(default=None, alias="X-Gemini-Api-Key"),
    x_client_id: str = Header(default="default", alias="X-Client-ID"),
):
    """
    Explains the given sentence in the requested language.
    Returns the stored explanation on repeat requests without calling the model.
    """
    explain_key = build_explain_key(request.text, request.lang, request.thinking_level)

    stored = get_explanation(x_client_id, explain_key)
    if stored is not None:
        logger.info("Explain request lang=%s status=cache_hit explain_key=%s", request.lang, explain_key)
        return ExplainResponse(
            explain_key=explain_key,
            explanation=stored["explanation"],
            lang=stored["lang"],
            cached=True,
            messages=[ChatMessage(**m) for m in stored["messages"]],
        )

    try:
        explanation = await generate_explanation_text(
            text=request.text,
            lang=request.lang,
            api_key=x_gemini_api_key,
            thinking_level=request.thinking_level,
        )
        save_explanation(x_client_id, request.text, request.lang, explain_key, explanation)
        logger.info("Explain request lang=%s status=success explain_key=%s", request.lang, explain_key)
        return ExplainResponse(
            explain_key=explain_key,
            explanation=explanation,
            lang=request.lang,
            cached=False,
            messages=[],
        )
    except TTSConfigError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    except TTSTimeoutError:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="AI 讲解服务请求超时，请稍后重试。",
        )
    except TTSUpstreamError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"AI 讲解服务暂时不可用（上游返回 {exc.status_code}），请检查 Key 或稍后重试。",
        )
    except TTSException:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="连接 AI 讲解服务失败，请检查网络后重试。",
        )
    except Exception as exc:
        logger.exception("Explain request status=server_error error=%s", type(exc).__name__)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"AI 讲解发生异常：{str(exc)}",
        )


@router.get("/explain", summary="Fetch stored explanation", response_model=ExplainResponse)
async def fetch_explanation(
    text: str = Query(..., min_length=1, max_length=1000),
    lang: str = Query(default="zh", max_length=8),
    thinking: str = Query(default="medium", max_length=8),
    x_client_id: str = Header(default="default", alias="X-Client-ID"),
):
    """
    Read-only lookup of a stored explanation (used when replaying a sentence).
    Never calls the model; returns 404 when nothing is stored.
    """
    lang = lang.lower().strip()
    if lang not in ("zh", "ja", "en"):
        lang = "zh"
    thinking = thinking.lower().strip()
    if thinking not in ("low", "medium", "high"):
        thinking = "medium"
    explain_key = build_explain_key(text.strip(), lang, thinking)
    stored = get_explanation(x_client_id, explain_key)
    if stored is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="该句子的讲解存档不存在。",
        )
    return ExplainResponse(
        explain_key=explain_key,
        explanation=stored["explanation"],
        lang=stored["lang"],
        cached=True,
        messages=[ChatMessage(**m) for m in stored["messages"]],
    )


@router.post("/explain/chat", summary="Ask a follow-up question", response_model=ChatResponse)
async def chat_about_sentence(
    request: ChatRequest,
    x_gemini_api_key: str | None = Header(default=None, alias="X-Gemini-Api-Key"),
    x_client_id: str = Header(default="default", alias="X-Client-ID"),
):
    """
    Answers a follow-up question about a previously explained sentence,
    using the stored sentence and conversation history as context.
    """
    stored = get_explanation(x_client_id, request.explain_key)
    if stored is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="讲解会话不存在，请先生成该句子的讲解。",
        )

    try:
        answer = await generate_chat_answer(
            text=stored["text"],
            lang=stored["lang"],
            messages=stored["messages"],
            new_message=request.message,
            api_key=x_gemini_api_key,
            thinking_level=request.thinking_level,
        )
        append_chat_messages(x_client_id, request.explain_key, request.message.strip(), answer)
        return ChatResponse(explain_key=request.explain_key, answer=answer)
    except TTSConfigError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    except TTSTimeoutError:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="AI 讲解服务请求超时，请稍后重试。",
        )
    except TTSUpstreamError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"AI 讲解服务暂时不可用（上游返回 {exc.status_code}），请检查 Key 或稍后重试。",
        )
    except TTSException:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="连接 AI 讲解服务失败，请检查网络后重试。",
        )
    except Exception as exc:
        logger.exception("Explain chat status=server_error error=%s", type(exc).__name__)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"AI 讲解发生异常：{str(exc)}",
        )
