import hashlib
import json
import secrets
import sqlite3
import time
from contextlib import contextmanager

from app.config import settings
from app.services.errors import LLMConfigError, StorageFullError
from app.services import database
from app.services.llm.gateway import complete
from app.services.llm.registry import resolve_model
from app.services.llm.types import LLMResult, ModelProfile, ReasoningPreset
from app.validation import normalize_client_id


SUPPORTED_LANGS = ("zh", "ja", "en")
MAX_CONTEXT_TURNS = 20
MAX_CONTEXT_CHARS = 24000
MAX_STORED_MESSAGES = 60


@contextmanager
def _get_conn():
    """Use the shared SQLite store and migrations."""
    with database.connection(foreign_keys=False) as conn:
        yield conn


def resolve_selection(model_id: str | None, mode_id: str | None) -> tuple[ModelProfile, ReasoningPreset]:
    try:
        profile = resolve_model(model_id)
    except LLMConfigError as exc:
        raise ValueError(str(exc)) from None
    try:
        mode = profile.get_mode(mode_id)
    except ValueError as exc:
        raise ValueError("所选模型不支持该思考模式。") from exc
    return profile, mode


def build_explain_key(
    text: str, lang: str, model_id: str | None = None, mode_id: str | None = None,
    *, context_id: str | None = None, selection: tuple[ModelProfile, ReasoningPreset] | None = None,
) -> str:
    profile, mode = selection or resolve_selection(model_id, mode_id)
    material = json.dumps(
        {
            "text": text,
            "lang": _check_lang(lang),
            "model_id": profile.id,
            "upstream_model": profile.upstream_model,
            "mode_id": mode.id,
            "profile_revision": profile.profile_revision,
            "prompt_version": settings.COPILOT_PROMPT_VERSION,
            # Omit for legacy callers so existing keys and saved explanations remain valid.
            **({"context_id": context_id} if context_id is not None else {}),
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


_SYSTEM_PROMPTS = {
    "zh": "你是一位严谨、耐心的语言老师。请用简体中文回答。",
    "ja": "あなたは厳密で丁寧な語学教師です。日本語で答えてください。",
    "en": "You are a rigorous and patient language teacher. Answer in English.",
}

_DEPTH_PROMPTS = {
    "zh": {
        "quick": "给出自然翻译和最关键的一条语法提示，务必简洁。",
        "standard": "依次给出自然翻译、语法结构、最多5个重点词汇和必要的易错提示。",
        "deep": "依次给出自然翻译、完整句法拆解、语义细节、最多5个重点词汇和易错提示。",
    },
    "ja": {
        "quick": "自然な訳と、最重要の文法ポイントを一つだけ簡潔に示してください。",
        "standard": "自然な訳、文法構造、重要語彙を最大5個、必要な注意点の順に説明してください。",
        "deep": "自然な訳、詳しい構文分析、意味のニュアンス、重要語彙を最大5個、注意点を説明してください。",
    },
    "en": {
        "quick": "Give a natural translation and one essential grammar note. Be concise.",
        "standard": "Give a natural translation, grammar structure, up to five key terms, and any essential caution.",
        "deep": "Give a natural translation, full syntax analysis, semantic nuance, up to five key terms, and cautions.",
    },
}

_OUTPUT_RULES = {
    "zh": "不要输出内部推理过程，不要使用 Markdown 表格；只输出最终讲解。",
    "ja": "内部の推論過程やMarkdown表は出力せず、最終的な解説だけを示してください。",
    "en": "Do not reveal internal reasoning or use Markdown tables; output only the final explanation.",
}

_CHAT_RULES = {
    "zh": "围绕给定原句回答追问，简洁、直接、准确。不要输出内部推理过程，也不要声称执行了外部操作。",
    "ja": "元の文に関する質問へ簡潔かつ正確に答えてください。内部の推論過程を示したり、外部操作を実行したと主張したりしないでください。",
    "en": "Answer follow-ups about the source sentence concisely and accurately. Do not reveal internal reasoning or claim external actions.",
}


def _check_lang(lang: str) -> str:
    normalized = (lang or "zh").lower().strip()
    return normalized if normalized in SUPPORTED_LANGS else "zh"


def build_explain_messages(text: str, lang: str, teaching_depth: str) -> list[dict[str, str]]:
    language = _check_lang(lang)
    system = (
        f"{_SYSTEM_PROMPTS[language]} {_DEPTH_PROMPTS[language][teaching_depth]} "
        f"{_OUTPUT_RULES[language]}"
    )
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": f"请讲解下面这句话：\n{text.strip()}"},
    ]


def build_chat_messages(
    text: str, lang: str, messages: list[dict], new_message: str
) -> list[dict[str, str]]:
    language = _check_lang(lang)
    result = [
        {
            "role": "system",
            "content": f"{_SYSTEM_PROMPTS[language]} {_CHAT_RULES[language]}",
        },
        {"role": "user", "content": f"原句：\n{text.strip()}"},
    ]
    recent = []
    remaining = MAX_CONTEXT_CHARS
    for message in reversed(messages[-(MAX_CONTEXT_TURNS * 2):]):
        role = message.get("role")
        content = message.get("content")
        if role in {"user", "assistant"} and isinstance(content, str) and remaining > 0:
            bounded = content[:min(4000, remaining)]
            recent.append({"role": role, "content": bounded})
            remaining -= len(bounded)
    result.extend(reversed(recent))
    result.append({"role": "user", "content": new_message.strip()})
    return result


async def generate_explanation_text(
    text: str, lang: str, model_id: str | None = None, mode_id: str | None = None,
    *, selection: tuple[ModelProfile, ReasoningPreset] | None = None,
) -> tuple[LLMResult, str, str, str]:
    profile, mode = selection or resolve_selection(model_id, mode_id)
    return await complete(profile, mode, build_explain_messages(text, lang, mode.teaching_depth))


async def generate_chat_answer(
    text: str,
    lang: str,
    messages: list[dict],
    new_message: str,
    model_id: str,
    mode_id: str | None = None,
    *, selection: tuple[ModelProfile, ReasoningPreset] | None = None,
) -> tuple[LLMResult, str, str, str]:
    profile, mode = selection or resolve_selection(model_id, mode_id)
    return await complete(profile, mode, build_chat_messages(text, lang, messages, new_message))


def _parse_messages(raw: str) -> list[dict]:
    try:
        parsed = json.loads(raw or "[]")
        return parsed if isinstance(parsed, list) else []
    except (json.JSONDecodeError, TypeError):
        return []


def get_explanation(client_id: str, explain_key: str) -> dict | None:
    cid = normalize_client_id(client_id)
    with _get_conn() as conn:
        row = conn.execute(
            "select text, lang, explain_key, explanation, messages, model_id, provider, "
            "upstream_model, mode_id, profile_revision, prompt_version, created_at, updated_at "
            "from explanations where client_id = ? and explain_key = ?",
            (cid, explain_key),
        ).fetchone()
        if row is None:
            return None
        record = dict(row)
        record["messages"] = _parse_messages(record["messages"])
        return record


def reserve_storage_slot(
    client_id: str, explain_key: str, ttl_seconds: float = 210.0
) -> str:
    cid = normalize_client_id(client_id)
    with _get_conn() as conn:
        conn.execute("begin immediate")
        now = time.time()
        conn.execute(
            "delete from explanation_storage_reservations where expires_at <= ?",
            (now,)
        )
        exists = conn.execute(
            "select 1 from explanations where client_id = ? and explain_key = ?",
            (cid, explain_key)
        ).fetchone()
        if exists:
            return ""

        saved_count = conn.execute("select count(*) from explanations").fetchone()[0]
        active_reservations = conn.execute(
            "select count(*) from explanation_storage_reservations where expires_at > ?",
            (now,)
        ).fetchone()[0]

        if saved_count + active_reservations >= settings.EXPLANATION_MAX_RECORDS:
            conn.rollback()
            raise StorageFullError("Explanation record quota reached")

        token = secrets.token_urlsafe(24)
        expires_at = now + ttl_seconds
        conn.execute(
            "insert into explanation_storage_reservations (token, client_id, explain_key, expires_at) "
            "values (?, ?, ?, ?)",
            (token, cid, explain_key, expires_at)
        )
        return token


def release_storage_slot(token: str | None) -> None:
    if not token:
        return
    with _get_conn() as conn:
        conn.execute("begin immediate")
        conn.execute(
            "delete from explanation_storage_reservations where token = ?",
            (token,)
        )


def save_explanation(
    client_id: str,
    text: str,
    lang: str,
    explain_key: str,
    explanation: str,
    *,
    model_id: str = "gemini-legacy",
    provider: str = "gemini",
    upstream_model: str = "gemini-legacy",
    mode_id: str = "medium",
    profile_revision: str = "legacy-v1",
    quota_units: int = 0,
    usage: dict[str, int] | None = None,
    reservation_token: str | None = None,
    max_retries: int = 5,
) -> None:
    cid = normalize_client_id(client_id)

    def _save():
        with _get_conn() as conn:
            conn.execute("begin immediate")
            exists = conn.execute(
                "select 1 from explanations where client_id = ? and explain_key = ?", (cid, explain_key)
            ).fetchone()
            if exists:
                if reservation_token:
                    conn.execute(
                        "delete from explanation_storage_reservations where token = ?",
                        (reservation_token,)
                    )
            else:
                consumed_reservation = False
                if reservation_token:
                    now = time.time()
                    row = conn.execute(
                        "select client_id, explain_key, expires_at "
                        "from explanation_storage_reservations where token = ?",
                        (reservation_token,)
                    ).fetchone()
                    if row and row[0] == cid and row[1] == explain_key and row[2] > now:
                        conn.execute(
                            "delete from explanation_storage_reservations where token = ?",
                            (reservation_token,)
                        )
                        consumed_reservation = True

                if not consumed_reservation:
                    count = conn.execute("select count(*) from explanations").fetchone()[0]
                    if count >= settings.EXPLANATION_MAX_RECORDS:
                        raise StorageFullError("Explanation record quota reached")

            conn.execute(
                "insert into explanations "
                "(client_id, text, lang, explain_key, explanation, messages, model_id, provider, "
                "upstream_model, mode_id, profile_revision, prompt_version) "
                "values (?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?) "
                "on conflict(client_id, explain_key) do update set "
                "explanation=excluded.explanation, model_id=excluded.model_id, provider=excluded.provider, "
                "upstream_model=excluded.upstream_model, mode_id=excluded.mode_id, "
                "profile_revision=excluded.profile_revision, prompt_version=excluded.prompt_version, "
                "updated_at=datetime('now', 'localtime')",
                (
                    cid, text, lang, explain_key, explanation, model_id, provider, upstream_model,
                    mode_id, profile_revision, settings.COPILOT_PROMPT_VERSION,
                ),
            )
            if usage is not None or quota_units > 0:
                _upsert_daily_usage(conn, cid, provider, model_id, mode_id, quota_units, usage or {})

    database.run_with_retry(_save, max_retries=max_retries - 1, delay=0.05)


def append_chat_messages(
    client_id: str, explain_key: str, user_message: str, answer: str,
    *, model_id: str | None = None, mode_id: str | None = None,
    provider: str | None = None, quota_units: int = 0, usage: dict[str, int] | None = None,
) -> list[dict] | None:
    cid = normalize_client_id(client_id)
    with _get_conn() as conn:
        conn.execute("begin immediate")
        row = conn.execute(
            "select messages from explanations where client_id = ? and explain_key = ?",
            (cid, explain_key),
        ).fetchone()
        if row is None:
            return None
        messages = _parse_messages(row["messages"])
        assistant_message = {"role": "assistant", "content": answer}
        if model_id is not None and mode_id is not None:
            assistant_message.update(model_id=model_id, mode_id=mode_id)
        messages.extend((
            {"role": "user", "content": user_message},
            assistant_message,
        ))
        messages = messages[-MAX_STORED_MESSAGES:]
        conn.execute(
            "update explanations set messages = ?, updated_at = datetime('now', 'localtime') "
            "where client_id = ? and explain_key = ?",
            (json.dumps(messages, ensure_ascii=False), cid, explain_key),
        )
        if provider is not None and (usage is not None or quota_units > 0):
            _upsert_daily_usage(
                conn, cid, provider, model_id or "", mode_id or "", quota_units, usage or {},
            )
        return messages


def _upsert_daily_usage(
    conn: sqlite3.Connection, client_id: str, provider: str, model_id: str,
    mode_id: str, quota_units: int, usage: dict[str, int],
) -> None:
    """Update the ledger within the caller's transaction."""
    values = [max(0, int(usage.get(name, 0))) for name in (
        "prompt_tokens", "completion_tokens", "reasoning_tokens", "total_tokens"
    )]
    conn.execute(
        "insert into copilot_usage_daily "
        "(usage_day, client_id, provider, model_id, mode_id, calls, quota_units, "
        "prompt_tokens, completion_tokens, reasoning_tokens, total_tokens) "
        "values (date('now'), ?, ?, ?, ?, 1, ?, ?, ?, ?, ?) "
        "on conflict(usage_day, client_id, provider, model_id, mode_id) do update set "
        "calls=calls+1, quota_units=quota_units+excluded.quota_units, "
        "prompt_tokens=prompt_tokens+excluded.prompt_tokens, "
        "completion_tokens=completion_tokens+excluded.completion_tokens, "
        "reasoning_tokens=reasoning_tokens+excluded.reasoning_tokens, "
        "total_tokens=total_tokens+excluded.total_tokens",
        (client_id, provider, model_id, mode_id, quota_units, *values),
    )


def delete_explanation(client_id: str, explain_key: str) -> bool:
    """Delete an explanation record for a client. Returns True if deleted, False otherwise."""
    cid = normalize_client_id(client_id)
    with _get_conn() as conn:
        conn.execute("begin immediate")
        cursor = conn.execute(
            "delete from explanations where client_id = ? and explain_key = ?",
            (cid, explain_key),
        )
        return cursor.rowcount > 0


def clear_explanations(client_id: str) -> int:
    """Delete all explanation records for a client. Returns number of deleted records."""
    cid = normalize_client_id(client_id)
    with _get_conn() as conn:
        conn.execute("begin immediate")
        cursor = conn.execute(
            "delete from explanations where client_id = ?",
            (cid,),
        )
        return cursor.rowcount



__all__ = [
    "SUPPORTED_LANGS", "build_explain_key", "build_explain_messages", "build_chat_messages",
    "generate_explanation_text", "generate_chat_answer", "get_explanation", "save_explanation",
    "append_chat_messages", "release_storage_slot", "reserve_storage_slot", "resolve_selection", "delete_explanation", "clear_explanations",
]
