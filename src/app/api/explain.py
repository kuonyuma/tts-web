from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Path, Query, status
from starlette.concurrency import run_in_threadpool

from app.config import settings
from app.api.dependencies import require_copilot_identity
from app.schemas.explain import (
    ChatRequest,
    ChatResponse,
    CopilotCatalogResponse,
    ExplainRequest,
    ExplainResponse,
    EXPLAIN_CONTEXT_PATTERN,
)
from app.services.explain_service import (
    append_chat_messages,
    build_explain_key,
    generate_chat_answer,
    generate_explanation_text,
    get_explanation,
    record_usage,
    release_storage_slot,
    reserve_storage_slot,
    resolve_selection,
    save_explanation,
    delete_explanation,
    clear_explanations,
)
from app.services.llm.registry import catalog
from app.services.llm.quota import copilot_distributed_lock, reserve_copilot_quota
from app.services.runtime import cache_lock, llm_request_deadline
from app.validation import validate_text


router = APIRouter(prefix="/api", tags=["explain"])


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
    return {
        "models": catalog(),
        "request_timeout_seconds": settings.LLM_TIMEOUT_SECONDS,
    }


@router.post("/explain", response_model=ExplainResponse)
async def explain_sentence(
    request: ExplainRequest,
    x_client_id: str = Depends(require_copilot_identity),
):
    try:
        profile, mode = resolve_selection(request.model_id, request.mode_id)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None
    selection = (profile, mode)
    key = build_explain_key(request.text, request.lang, context_id=request.context_id, selection=selection)
    async with (
        llm_request_deadline(),
        cache_lock(f"explain:{x_client_id}:{key}"),
        copilot_distributed_lock(x_client_id, key),
    ):
        stored = await run_in_threadpool(get_explanation, x_client_id, key)
        if stored is not None:
            return _response(key, stored, True)

        token = await run_in_threadpool(
            reserve_storage_slot,
            x_client_id,
            key,
            max(60, int(settings.LLM_TIMEOUT_SECONDS) + 30),
        )
        if token == "":
            stored = await run_in_threadpool(get_explanation, x_client_id, key)
            if stored is not None:
                return _response(key, stored, True)

        try:
            await reserve_copilot_quota(x_client_id, mode.quota_weight)
            result, model_id, mode_id, revision = await generate_explanation_text(
                text=request.text, lang=request.lang, model_id=profile.id, mode_id=mode.id, selection=selection,
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
                quota_units=mode.quota_weight,
                usage=result.usage,
                reservation_token=token,
            )
            token = None
        finally:
            if token:
                await run_in_threadpool(release_storage_slot, token)

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
    context_id: str | None = Query(default=None, pattern=EXPLAIN_CONTEXT_PATTERN),
    x_client_id: str = Depends(require_copilot_identity),
):
    try:
        text = validate_text(text)
        profile, mode = resolve_selection(model_id, mode_id)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None
    key = build_explain_key(text, lang, context_id=context_id, selection=(profile, mode))
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
            and messages[-2].get("role") == "user"
            and messages[-2].get("content") == request.message
            and messages[-1].get("role") == "assistant"
            and messages[-1].get("model_id") == profile.id
            and messages[-1].get("mode_id") == mode.id
        ):
            return ChatResponse(
                explain_key=request.explain_key,
                answer=messages[-1]["content"],
                model_id=messages[-1]["model_id"],
                mode_id=messages[-1]["mode_id"],
            )
        await reserve_copilot_quota(x_client_id, mode.quota_weight)
        result, model_id, mode_id, _ = await generate_chat_answer(
            text=stored["text"],
            lang=stored["lang"],
            messages=messages,
            new_message=request.message,
            model_id=stored["model_id"],
            mode_id=mode.id,
            selection=(profile, mode),
        )
        await run_in_threadpool(
            record_usage, x_client_id, result.provider, model_id, mode_id, mode.quota_weight, result.usage
        )
        updated = await run_in_threadpool(
            append_chat_messages, x_client_id, request.explain_key, request.message, result.content,
            model_id=model_id, mode_id=mode_id,
        )
        if updated is None:
            raise HTTPException(409, "讲解会话已失效，请重新生成讲解。")
        return ChatResponse(
            explain_key=request.explain_key,
            answer=result.content,
            model_id=model_id,
            mode_id=mode_id,
        )

@router.delete(
    "/explain/{explain_key}",
    summary="Delete an explanation for current client",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def remove_explanation(
    explain_key: str = Path(min_length=1, max_length=64),
    x_client_id: str = Depends(require_copilot_identity),
):
    deleted = await run_in_threadpool(delete_explanation, x_client_id, explain_key)
    if not deleted:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="讲解不存在或无权删除。",
        )


@router.delete(
    "/explain",
    summary="Clear all explanations for current client",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def clear_all_explanations(
    x_client_id: str = Depends(require_copilot_identity),
):
    await run_in_threadpool(clear_explanations, x_client_id)

