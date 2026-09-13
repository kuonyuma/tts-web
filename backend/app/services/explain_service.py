import hashlib
import json
import logging
import threading
from contextlib import contextmanager

from app.config import settings
from app.services.engines import (
    TTSException,
    TTSConfigError,
    TTSTimeoutError,
    TTSUpstreamError,
)
from app.services.history_service import init_db, connect_database
from app.services.errors import StorageFullError, provider_error
from app.services.gemini_client import create_client, managed_client
from app.services.runtime import request_deadline, upstream_slot
from app.validation import normalize_client_id

logger = logging.getLogger(__name__)

SUPPORTED_LANGS = ("zh", "ja", "en")

# Max follow-up turns sent to the model as context (user+assistant pairs).
MAX_CONTEXT_TURNS = 20
# Hard cap on stored messages per explanation to bound DB growth.
MAX_STORED_MESSAGES = 60

_initialized = False
_init_lock = threading.Lock()


def _normalize_client_id(client_id: str | None) -> str:
    return normalize_client_id(client_id)


@contextmanager
def _get_conn():
    """SQLite connection sharing history.db, with lazy explanations-table init."""
    global _initialized
    init_db()
    conn = connect_database()
    try:
        with _init_lock:
            if not _initialized:
                conn.execute("""
                    create table if not exists explanations (
                        id           integer primary key autoincrement,
                        client_id    text    not null default 'default',
                        text         text    not null,
                        lang         text    not null default 'zh',
                        explain_key  text    not null,
                        explanation  text    not null,
                        messages     text    not null default '[]',
                        created_at   text    not null default (datetime('now', 'localtime')),
                        updated_at   text    not null default (datetime('now', 'localtime')),
                        unique(client_id, explain_key)
                    )
                """)
                conn.execute(
                    "create index if not exists idx_explanations_client "
                    "on explanations(client_id, updated_at desc)"
                )
                conn.commit()
                _initialized = True
        yield conn
    finally:
        conn.close()


def build_explain_key(text: str, lang: str, thinking: str = "medium") -> str:
    """Short hash identifying one sentence + output-language + thinking-level combination."""
    raw = f"{text}|{lang}|{thinking}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


_SYSTEM_PROMPTS: dict[str, str] = {
    "zh": (
        "你是一位耐心细致的英语/日语语言老师，正在帮助一名中国学生理解一个外语句子。"
        "请用简体中文讲解，结构如下：\n"
        "1. 中文翻译：给出自然准确的翻译。\n"
        "2. 语法结构：拆解句子成分和关键语法点。\n"
        "3. 重点词汇：挑选最多5个值得学习的词/短语，简要释义。\n"
        "4. 易错提示：如有常见误解或发音注意点，补充一句；没有则省略。\n"
        "全文控制在400字以内，不要使用 Markdown 表格。"
    ),
    "ja": (
        "あなたは丁寧で優秀な英語・日本語の先生です。生徒が外国語の文を理解できるよう、"
        "日本語で解説してください。構成は次の通りです：\n"
        "1. 和訳：自然で正確な訳を付ける。\n"
        "2. 文法：文の構造と重要な文法ポイントを解説する。\n"
        "3. 重要語彙：学ぶ価値のある語句を最大5つ選び、簡潔に説明する。\n"
        "4. 注意点：誤解しやすい点や発音上の注意があれば一言添える。なければ省略。\n"
        "全体は400字以内に収め、Markdownの表は使わないこと。"
    ),
    "en": (
        "You are a patient language teacher helping a student understand a foreign-language sentence. "
        "Explain in English with this structure:\n"
        "1. Translation/Paraphrase: give a natural, accurate rendering.\n"
        "2. Grammar: break down the sentence structure and key grammar points.\n"
        "3. Key vocabulary: pick up to 5 words/phrases worth learning, with brief glosses.\n"
        "4. Watch out: add one note on common misunderstandings or pronunciation if relevant, otherwise skip.\n"
        "Keep it under 250 words and do not use Markdown tables."
    ),
}

_LANG_NAMES: dict[str, str] = {"zh": "简体中文", "ja": "日本語", "en": "English"}


def _check_lang(lang: str) -> str:
    normalized = (lang or "zh").lower().strip()
    return normalized if normalized in SUPPORTED_LANGS else "zh"


def resolve_text_client(api_key: str | None = None):
    return create_client(api_key)


def build_explain_contents(text: str, lang: str) -> str:
    """Compose the one-shot explanation prompt for the given sentence."""
    lang = _check_lang(lang)
    return f"{_SYSTEM_PROMPTS[lang]}\n\n讲解对象的句子：\n{text.strip()}"


def build_chat_contents(text: str, lang: str, messages: list[dict], new_message: str) -> str:
    """Compose a follow-up prompt with capped conversation history."""
    lang = _check_lang(lang)
    lang_name = _LANG_NAMES[lang]
    recent = messages[-(MAX_CONTEXT_TURNS * 2):]
    lines = []
    for msg in recent:
        role = "学生" if msg.get("role") == "user" else "老师"
        lines.append(f"{role}：{msg.get('content', '')}")
    history_block = "\n".join(lines) if lines else "（无）"
    return (
        f"你是一位耐心细致的语言老师，请用{lang_name}简洁地回答学生关于下面句子的追问"
        f"（100字以内，直接回答，不要重复整句讲解）。\n\n"
        f"原句：\n{text.strip()}\n\n"
        f"历史对话：\n{history_block}\n\n"
        f"学生的新问题：\n{new_message.strip()}"
    )


SUPPORTED_THINKING_LEVELS = ("low", "medium", "high")


def _normalize_thinking_level(thinking: str | None) -> str:
    level = (thinking or "medium").lower().strip()
    return level if level in SUPPORTED_THINKING_LEVELS else "medium"


async def _call_text_model(
    contents: str, api_key: str | None, thinking_level: str = "medium"
) -> str:
    """
    Call the Gemini text model via the Interactions API and return stripped text output.
    Uses the same call shape as the proven TTS/test-key paths.
    """
    try:
        async with request_deadline(), upstream_slot("gemini"):
            async with managed_client(resolve_text_client(api_key=api_key)) as client:
                interaction = await client.aio.interactions.create(
                    model=settings.GEMINI_TEXT_MODEL,
                    input=contents,
                    generation_config={"thinking_level": _normalize_thinking_level(thinking_level)},
                )
                output = (interaction.output_text or "").strip()
                if not output or len(output) > 16000:
                    raise TTSUpstreamError(502, "Invalid text response")
                return output
    except TTSException:
        raise
    except Exception as exc:
        raise provider_error(exc, "gemini-text") from None


async def generate_explanation_text(
    text: str, lang: str, api_key: str | None = None, thinking_level: str = "medium"
) -> str:
    """Generate a one-shot explanation for a sentence via the Gemini text model."""
    return await _call_text_model(build_explain_contents(text, lang), api_key, thinking_level)


async def generate_chat_answer(
    text: str,
    lang: str,
    messages: list[dict],
    new_message: str,
    api_key: str | None = None,
    thinking_level: str = "medium",
) -> str:
    """Answer a follow-up question with conversation history as context."""
    return await _call_text_model(
        build_chat_contents(text, lang, messages, new_message), api_key, thinking_level
    )


def _parse_messages(raw: str) -> list[dict]:
    try:
        parsed = json.loads(raw or "[]")
        return parsed if isinstance(parsed, list) else []
    except (json.JSONDecodeError, TypeError):
        return []


def get_explanation(client_id: str, explain_key: str) -> dict | None:
    """Fetch a stored explanation (with follow-up messages) for a client."""
    cid = _normalize_client_id(client_id)
    with _get_conn() as conn:
        row = conn.execute(
            "select text, lang, explain_key, explanation, messages, created_at, updated_at "
            "from explanations where client_id = ? and explain_key = ?",
            (cid, explain_key),
        ).fetchone()
        if row is None:
            return None
        record = dict(row)
        record["messages"] = _parse_messages(record["messages"])
        return record


def save_explanation(
    client_id: str, text: str, lang: str, explain_key: str, explanation: str
) -> None:
    """Insert or replace a one-shot explanation for a client."""
    cid = _normalize_client_id(client_id)
    with _get_conn() as conn:
        conn.execute("begin immediate")
        exists = conn.execute(
            "select 1 from explanations where client_id = ? and explain_key = ?", (cid, explain_key)
        ).fetchone()
        if not exists and conn.execute("select count(*) from explanations").fetchone()[0] >= settings.EXPLANATION_MAX_RECORDS:
            raise StorageFullError("Explanation record quota reached")
        conn.execute(
            "insert into explanations (client_id, text, lang, explain_key, explanation, messages) "
            "values (?, ?, ?, ?, ?, '[]') "
            "on conflict(client_id, explain_key) do update set "
            "explanation = excluded.explanation, updated_at = datetime('now', 'localtime')",
            (cid, text, lang, explain_key, explanation),
        )
        conn.commit()


def append_chat_messages(
    client_id: str, explain_key: str, user_message: str, answer: str
) -> list[dict] | None:
    """Append one Q&A turn to a stored explanation. Returns updated messages, None if missing."""
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
        messages.append({"role": "user", "content": user_message})
        messages.append({"role": "assistant", "content": answer})
        messages = messages[-MAX_STORED_MESSAGES:]
        conn.execute(
            "update explanations set messages = ?, updated_at = datetime('now', 'localtime') "
            "where client_id = ? and explain_key = ?",
            (json.dumps(messages, ensure_ascii=False), cid, explain_key),
        )
        conn.commit()
        return messages


__all__ = [
    "SUPPORTED_LANGS",
    "SUPPORTED_THINKING_LEVELS",
    "build_explain_key",
    "build_explain_contents",
    "build_chat_contents",
    "generate_explanation_text",
    "generate_chat_answer",
    "get_explanation",
    "save_explanation",
    "append_chat_messages",
    "TTSException",
    "TTSConfigError",
    "TTSTimeoutError",
    "TTSUpstreamError",
]
