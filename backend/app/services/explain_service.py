import hashlib
import json
import threading
from contextlib import contextmanager

from app.config import settings
from app.services.errors import LLMConfigError, StorageFullError
from app.services.history_service import connect_database, init_db
from app.services.llm.gateway import complete
from app.services.llm.registry import resolve_model
from app.services.llm.types import LLMResult
from app.validation import normalize_client_id


SUPPORTED_LANGS = ("zh", "ja", "en")
MAX_CONTEXT_TURNS = 20
MAX_CONTEXT_CHARS = 24000
MAX_STORED_MESSAGES = 60
_initialized = False
_init_lock = threading.Lock()


def _normalize_client_id(client_id: str | None) -> str:
    return normalize_client_id(client_id)


@contextmanager
def _get_conn():
    """Use the existing SQLite store and migrate legacy explanation rows in place."""
    global _initialized
    init_db()
    conn = connect_database()
    try:
        with _init_lock:
            if not _initialized:
                conn.execute("""
                    create table if not exists explanations (
                        id integer primary key autoincrement,
                        client_id text not null default 'default',
                        text text not null,
                        lang text not null default 'zh',
                        explain_key text not null,
                        explanation text not null,
                        messages text not null default '[]',
                        model_id text not null default 'gemini-legacy',
                        provider text not null default 'gemini',
                        upstream_model text not null default 'gemini-legacy',
                        mode_id text not null default 'medium',
                        profile_revision text not null default 'legacy-v1',
                        prompt_version text not null default 'legacy-v1',
                        created_at text not null default (datetime('now', 'localtime')),
                        updated_at text not null default (datetime('now', 'localtime')),
                        unique(client_id, explain_key)
                    )
                """)
                columns = {row[1] for row in conn.execute("pragma table_info(explanations)")}
                additions = {
                    "model_id": "text not null default 'gemini-legacy'",
                    "provider": "text not null default 'gemini'",
                    "upstream_model": "text not null default 'gemini-legacy'",
                    "mode_id": "text not null default 'medium'",
                    "profile_revision": "text not null default 'legacy-v1'",
                    "prompt_version": "text not null default 'legacy-v1'",
                }
                for name, definition in additions.items():
                    if name not in columns:
                        conn.execute(f"alter table explanations add column {name} {definition}")
                conn.execute(
                    "create index if not exists idx_explanations_client "
                    "on explanations(client_id, updated_at desc)"
                )
                conn.execute("""
                    create table if not exists copilot_usage_daily (
                        usage_day text not null,
                        client_id text not null,
                        provider text not null,
                        model_id text not null,
                        mode_id text not null,
                        calls integer not null default 0,
                        quota_units integer not null default 0,
                        prompt_tokens integer not null default 0,
                        completion_tokens integer not null default 0,
                        reasoning_tokens integer not null default 0,
                        total_tokens integer not null default 0,
                        primary key (usage_day, client_id, provider, model_id, mode_id)
                    )
                """)
                conn.commit()
                _initialized = True
        yield conn
    finally:
        conn.close()


def resolve_selection(model_id: str | None, mode_id: str | None):
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
    text: str, lang: str, model_id: str | None = None, mode_id: str | None = None
) -> str:
    profile, mode = resolve_selection(model_id, mode_id)
    material = json.dumps(
        {
            "text": text,
            "lang": _check_lang(lang),
            "model_id": profile.id,
            "upstream_model": profile.upstream_model,
            "mode_id": mode.id,
            "profile_revision": profile.profile_revision,
            "prompt_version": settings.COPILOT_PROMPT_VERSION,
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
    text: str, lang: str, model_id: str | None = None, mode_id: str | None = None
) -> tuple[LLMResult, str, str, str]:
    profile, mode = resolve_selection(model_id, mode_id)
    return await complete(profile.id, mode.id, build_explain_messages(text, lang, mode.teaching_depth))


async def generate_chat_answer(
    text: str,
    lang: str,
    messages: list[dict],
    new_message: str,
    model_id: str,
    mode_id: str | None = None,
) -> tuple[LLMResult, str, str, str]:
    return await complete(model_id, mode_id, build_chat_messages(text, lang, messages, new_message))


def _parse_messages(raw: str) -> list[dict]:
    try:
        parsed = json.loads(raw or "[]")
        return parsed if isinstance(parsed, list) else []
    except (json.JSONDecodeError, TypeError):
        return []


def get_explanation(client_id: str, explain_key: str) -> dict | None:
    cid = _normalize_client_id(client_id)
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
) -> None:
    cid = _normalize_client_id(client_id)
    with _get_conn() as conn:
        conn.execute("begin immediate")
        exists = conn.execute(
            "select 1 from explanations where client_id = ? and explain_key = ?", (cid, explain_key)
        ).fetchone()
        count = conn.execute("select count(*) from explanations").fetchone()[0]
        if not exists and count >= settings.EXPLANATION_MAX_RECORDS:
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
        conn.commit()


def append_chat_messages(
    client_id: str, explain_key: str, user_message: str, answer: str
) -> list[dict] | None:
    cid = _normalize_client_id(client_id)
    with _get_conn() as conn:
        conn.execute("begin immediate")
        row = conn.execute(
            "select messages from explanations where client_id = ? and explain_key = ?",
            (cid, explain_key),
        ).fetchone()
        if row is None:
            return None
        messages = _parse_messages(row["messages"])
        messages.extend((
            {"role": "user", "content": user_message},
            {"role": "assistant", "content": answer},
        ))
        messages = messages[-MAX_STORED_MESSAGES:]
        conn.execute(
            "update explanations set messages = ?, updated_at = datetime('now', 'localtime') "
            "where client_id = ? and explain_key = ?",
            (json.dumps(messages, ensure_ascii=False), cid, explain_key),
        )
        conn.commit()
        return messages


def record_usage(
    client_id: str,
    provider: str,
    model_id: str,
    mode_id: str,
    quota_units: int,
    usage: dict[str, int],
) -> None:
    """Store aggregate billing metadata only; prompts and reasoning are never recorded."""
    cid = _normalize_client_id(client_id)
    values = [max(0, int(usage.get(name, 0))) for name in (
        "prompt_tokens", "completion_tokens", "reasoning_tokens", "total_tokens"
    )]
    with _get_conn() as conn:
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
            (cid, provider, model_id, mode_id, quota_units, *values),
        )
        conn.commit()


__all__ = [
    "SUPPORTED_LANGS", "build_explain_key", "build_explain_messages", "build_chat_messages",
    "generate_explanation_text", "generate_chat_answer", "get_explanation", "save_explanation",
    "append_chat_messages", "record_usage", "resolve_selection",
]
