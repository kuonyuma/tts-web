from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from starlette.concurrency import run_in_threadpool

from app.api.dependencies import gemini_request_key, require_client_id
from app.schemas.explain import ChatRequest, ChatResponse, ExplainRequest, ExplainResponse
from app.services.explain_service import (
    append_chat_messages, build_explain_key, generate_chat_answer,
    generate_explanation_text, get_explanation, save_explanation,
)
from app.services.runtime import cache_lock, request_deadline
from app.validation import validate_text

router = APIRouter(prefix="/api", tags=["explain"])


def _response(key: str, stored: dict, cached: bool):
    return ExplainResponse(
        explain_key=key, explanation=stored["explanation"], lang=stored["lang"],
        cached=cached, messages=stored["messages"],
    )


@router.post("/explain", response_model=ExplainResponse)
async def explain_sentence(
    request: ExplainRequest,
    x_gemini_api_key: str | None = Depends(gemini_request_key),
    x_client_id: str = Depends(require_client_id),
):
    key = build_explain_key(request.text, request.lang, request.thinking_level)
    async with request_deadline(), cache_lock(f"explain:{x_client_id}:{key}"):
        stored = await run_in_threadpool(get_explanation, x_client_id, key)
        if stored is not None:
            return _response(key, stored, True)
        explanation = await generate_explanation_text(
            text=request.text, lang=request.lang, api_key=x_gemini_api_key, thinking_level=request.thinking_level,
        )
        await run_in_threadpool(save_explanation, x_client_id, request.text, request.lang, key, explanation)
        return _response(key, {"explanation": explanation, "lang": request.lang, "messages": []}, False)


@router.get("/explain", response_model=ExplainResponse)
async def fetch_explanation(
    text: str = Query(min_length=1, max_length=1000),
    lang: Literal["zh", "ja", "en"] = "zh",
    thinking: Literal["low", "medium", "high"] = "medium",
    x_client_id: str = Depends(require_client_id),
):
    try:
        text = validate_text(text)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None
    key = build_explain_key(text, lang, thinking)
    stored = await run_in_threadpool(get_explanation, x_client_id, key)
    if stored is None:
        raise HTTPException(404, "该句子的讲解存档不存在。")
    return _response(key, stored, True)


@router.post("/explain/chat", response_model=ChatResponse)
async def chat_about_sentence(
    request: ChatRequest,
    x_gemini_api_key: str | None = Depends(gemini_request_key),
    x_client_id: str = Depends(require_client_id),
):
    async with request_deadline(), cache_lock(f"explain:{x_client_id}:{request.explain_key}"):
        stored = await run_in_threadpool(get_explanation, x_client_id, request.explain_key)
        if stored is None:
            raise HTTPException(404, "讲解会话不存在，请先生成该句子的讲解。")
        messages = stored["messages"]
        # Repeated submission of the last question reuses the completed answer.
        if len(messages) >= 2 and messages[-2] == {"role": "user", "content": request.message} and messages[-1].get("role") == "assistant":
            return ChatResponse(explain_key=request.explain_key, answer=messages[-1]["content"])
        answer = await generate_chat_answer(
            text=stored["text"], lang=stored["lang"], messages=messages,
            new_message=request.message, api_key=x_gemini_api_key, thinking_level=request.thinking_level,
        )
        updated = await run_in_threadpool(append_chat_messages, x_client_id, request.explain_key, request.message, answer)
        if updated is None:
            raise HTTPException(409, "讲解会话已失效，请重新生成讲解。")
        return ChatResponse(explain_key=request.explain_key, answer=answer)
