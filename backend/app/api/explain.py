from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from starlette.concurrency import run_in_threadpool

from app.api.dependencies import require_copilot_identity
from app.schemas.explain import (
    ChatRequest,
    ChatResponse,
    CopilotCatalogResponse,
    ExplainRequest,
    ExplainResponse,
)
from app.services.explain_service import (
    append_chat_messages,
    build_explain_key,
    generate_chat_answer,
    generate_explanation_text,
    get_explanation,
    record_usage,
    resolve_selection,
    save_explanation,
)
from app.services.llm.gateway import get_catalog
from app.services.llm.types import LLMResult
from app.services.llm.quota import copilot_distributed_lock, reserve_copilot_quota
from app.services.runtime import cache_lock, llm_request_deadline
from app.validation import validate_text


router = APIRouter(prefix="/api", tags=["explain"])


def _generation_parts(value, profile, mode):
    """Accept a plain string from tests/legacy extensions during the migration."""
    if isinstance(value, str):
        result = LLMResult(value, profile.provider, profile.upstream_model, {})
        return result, profile.id, mode.id, profile.profile_revision
    return value


def _response(key: str, stored: dict, cached: bool) -> ExplainResponse:
    return ExplainResponse(
        explain_key=key,
        explanation=stored["explanation"],
        lang=stored["lang"],
        model_id=stored["model_id"],
        mode_id=stored["mode_id"],
        upstream_model=stored["upstream_model"],
        cached=cached,
        messages=stored["messages"],
    )


@router.get("/copilot/models", response_model=CopilotCatalogResponse)
async def copilot_models(_identity: str = Depends(require_copilot_identity)):
    """Expose only configured products and public capability metadata."""
    return {"models": get_catalog()}


@router.post("/explain", response_model=ExplainResponse)
async def explain_sentence(
    request: ExplainRequest,
    x_client_id: str = Depends(require_copilot_identity),
):
    try:
        profile, mode = resolve_selection(request.model_id, request.mode_id)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None
    key = build_explain_key(request.text, request.lang, profile.id, mode.id)
    async with (
        llm_request_deadline(),
        cache_lock(f"explain:{x_client_id}:{key}"),
        copilot_distributed_lock(x_client_id, key),
    ):
        stored = await run_in_threadpool(get_explanation, x_client_id, key)
        if stored is not None:
            return _response(key, stored, True)
        await reserve_copilot_quota(x_client_id, mode.quota_weight)
        generated = await generate_explanation_text(
            text=request.text, lang=request.lang, model_id=profile.id, mode_id=mode.id,
        )
        result, model_id, mode_id, revision = _generation_parts(generated, profile, mode)
        await run_in_threadpool(
            record_usage, x_client_id, result.provider, model_id, mode_id, mode.quota_weight, result.usage
        )
        await run_in_threadpool(
            save_explanation,
            x_client_id,
            request.text,
            request.lang,
            key,
            result.content,
            model_id=model_id,
            provider=result.provider,
            upstream_model=result.upstream_model,
            mode_id=mode_id,
            profile_revision=revision,
        )
        return _response(key, {
            "explanation": result.content,
            "lang": request.lang,
            "model_id": model_id,
            "mode_id": mode_id,
            "upstream_model": result.upstream_model,
            "messages": [],
        }, False)


@router.get("/explain", response_model=ExplainResponse)
async def fetch_explanation(
    text: str = Query(min_length=1, max_length=1000),
    lang: Literal["zh", "ja", "en"] = "zh",
    model_id: str | None = Query(default=None, min_length=1, max_length=64),
    mode_id: str | None = Query(default=None, min_length=1, max_length=32),
    x_client_id: str = Depends(require_copilot_identity),
):
    try:
        text = validate_text(text)
        profile, mode = resolve_selection(model_id, mode_id)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None
    key = build_explain_key(text, lang, profile.id, mode.id)
    stored = await run_in_threadpool(get_explanation, x_client_id, key)
    if stored is None:
        raise HTTPException(404, "该句子的讲解存档不存在。")
    return _response(key, stored, True)


@router.post("/explain/chat", response_model=ChatResponse)
async def chat_about_sentence(
    request: ChatRequest,
    x_client_id: str = Depends(require_copilot_identity),
):
    async with (
        llm_request_deadline(),
        cache_lock(f"explain:{x_client_id}:{request.explain_key}"),
        copilot_distributed_lock(x_client_id, request.explain_key),
    ):
        stored = await run_in_threadpool(get_explanation, x_client_id, request.explain_key)
        if stored is None:
            raise HTTPException(404, "讲解会话不存在，请先生成该句子的讲解。")
        try:
            profile, mode = resolve_selection(stored["model_id"], request.mode_id or stored["mode_id"])
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from None
        messages = stored["messages"]
        if (
            len(messages) >= 2
            and messages[-2] == {"role": "user", "content": request.message}
            and messages[-1].get("role") == "assistant"
        ):
            return ChatResponse(
                explain_key=request.explain_key,
                answer=messages[-1]["content"],
                model_id=stored["model_id"],
                mode_id=mode.id,
            )
        await reserve_copilot_quota(x_client_id, mode.quota_weight)
        generated = await generate_chat_answer(
            text=stored["text"],
            lang=stored["lang"],
            messages=messages,
            new_message=request.message,
            model_id=stored["model_id"],
            mode_id=mode.id,
        )
        result, model_id, mode_id, _ = _generation_parts(generated, profile, mode)
        await run_in_threadpool(
            record_usage, x_client_id, result.provider, model_id, mode_id, mode.quota_weight, result.usage
        )
        updated = await run_in_threadpool(
            append_chat_messages, x_client_id, request.explain_key, request.message, result.content
        )
        if updated is None:
            raise HTTPException(409, "讲解会话已失效，请重新生成讲解。")
        return ChatResponse(
            explain_key=request.explain_key,
            answer=result.content,
            model_id=model_id,
            mode_id=mode_id,
        )
