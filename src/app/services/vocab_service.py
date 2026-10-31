from uuid import uuid4

from app.schemas.vocab import VocabCreate, VocabUpdate
from app.services.database import connection as account_connection
from app.services.timestamps import utc_timestamp


class VocabError(Exception):
    def __init__(self, status_code: int, detail: str):
        self.status_code = status_code
        self.detail = detail


def vocab_result(row) -> dict:
    return {
        "id": row["id"],
        "word": row["word"],
        "surface": row["surface"],
        "reading": row["reading"],
        "pos": row["pos"],
        "meaning": row["meaning"],
        "notes": row["notes"],
        "context_sentence": row["context_sentence"],
        "source_article_id": row["source_article_id"],
        "source_title": row["source_title"],
        "review_count": int(row["review_count"]),
        "mastered": bool(row["mastered"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def owned_vocab(conn, user_id: int, vocab_id: str):
    row = conn.execute(
        "select * from vocab_items where id=? and user_id=?",
        (vocab_id, user_id),
    ).fetchone()
    if row is None:
        raise VocabError(404, "生词记录不存在或已删除。")
    return row


def list_vocab(user_id: int, query: str = "", status_filter: str = "all") -> list[dict]:
    q = (query or "").strip()
    clauses = ["user_id=?"]
    params: list[object] = [user_id]
    if status_filter == "mastered":
        clauses.append("mastered=1")
    elif status_filter == "unmastered":
        clauses.append("mastered=0")
    if q:
        clauses.append(
            "(instr(lower(word), lower(?))>0 "
            "or instr(lower(surface), lower(?))>0 "
            "or instr(lower(reading), lower(?))>0 "
            "or instr(lower(meaning), lower(?))>0 "
            "or instr(lower(notes), lower(?))>0 "
            "or instr(lower(context_sentence), lower(?))>0)"
        )
        params.extend([q, q, q, q, q, q])
    sql = f"select * from vocab_items where {' and '.join(clauses)} order by created_at desc, id"
    with account_connection() as conn:
        rows = conn.execute(sql, tuple(params)).fetchall()
        return [vocab_result(row) for row in rows]


def upsert_vocab(user_id: int, body: VocabCreate) -> tuple[dict, bool]:
    now = utc_timestamp()
    with account_connection(write=True) as conn:
        existing = conn.execute(
            "select * from vocab_items where user_id=? and lower(word)=lower(?)",
            (user_id, body.word),
        ).fetchone()
        if existing is not None:
            surface = body.surface if body.surface else existing["surface"]
            reading = body.reading if body.reading else existing["reading"]
            pos = body.pos if body.pos else existing["pos"]
            meaning = body.meaning if body.meaning else existing["meaning"]
            notes = body.notes if body.notes else existing["notes"]
            sentence = body.context_sentence if body.context_sentence else existing["context_sentence"]
            article_id = body.source_article_id if body.source_article_id is not None else existing["source_article_id"]
            title = body.source_title if body.source_title else existing["source_title"]
            mastered = 1 if body.mastered else int(existing["mastered"])
            conn.execute(
                "update vocab_items set word=?,surface=?,reading=?,pos=?,meaning=?,notes=?,"
                "context_sentence=?,source_article_id=?,source_title=?,mastered=?,updated_at=? "
                "where id=? and user_id=?",
                (
                    body.word, surface, reading, pos, meaning, notes,
                    sentence, article_id, title, mastered, now,
                    existing["id"], user_id,
                ),
            )
            return vocab_result(owned_vocab(conn, user_id, existing["id"])), False

        vocab_id = str(body.id or uuid4())
        id_collision = conn.execute("select user_id from vocab_items where id=?", (vocab_id,)).fetchone()
        if id_collision is not None:
            if id_collision["user_id"] != user_id:
                raise VocabError(409, "生词标识已使用，请重试。")
            return vocab_result(owned_vocab(conn, user_id, vocab_id)), False

        conn.execute(
            "insert into vocab_items("
            "id,user_id,word,surface,reading,pos,meaning,notes,context_sentence,"
            "source_article_id,source_title,review_count,mastered,created_at,updated_at"
            ") values(?,?,?,?,?,?,?,?,?,?,?,0,?,?,?)",
            (
                vocab_id, user_id, body.word, body.surface, body.reading, body.pos, body.meaning,
                body.notes, body.context_sentence, body.source_article_id,
                body.source_title, 1 if body.mastered else 0, now, now,
            ),
        )
        return vocab_result(owned_vocab(conn, user_id, vocab_id)), True


def update_vocab(user_id: int, vocab_id: str, body: VocabUpdate) -> dict:
    now = utc_timestamp()
    with account_connection(write=True) as conn:
        row = owned_vocab(conn, user_id, vocab_id)
        new_word = body.word if body.word is not None else row["word"]
        if body.word is not None:
            duplicate = conn.execute(
                "select id from vocab_items where user_id=? and lower(word)=lower(?) and id!=?",
                (user_id, new_word, vocab_id),
            ).fetchone()
            if duplicate is not None:
                raise VocabError(409, "生词本中已存在相同词条。")

        surface = body.surface if body.surface is not None else row["surface"]
        reading = body.reading if body.reading is not None else row["reading"]
        pos = body.pos if body.pos is not None else row["pos"]
        meaning = body.meaning if body.meaning is not None else row["meaning"]
        notes = body.notes if body.notes is not None else row["notes"]
        sentence = body.context_sentence if body.context_sentence is not None else row["context_sentence"]
        article_id = body.source_article_id if body.source_article_id is not None else row["source_article_id"]
        title = body.source_title if body.source_title is not None else row["source_title"]
        mastered = (1 if body.mastered else 0) if body.mastered is not None else int(row["mastered"])
        review_count = int(row["review_count"]) + int(body.review_delta or 0)

        conn.execute(
            "update vocab_items set word=?,surface=?,reading=?,pos=?,meaning=?,notes=?,"
            "context_sentence=?,source_article_id=?,source_title=?,review_count=?,mastered=?,updated_at=? "
            "where id=? and user_id=?",
            (
                new_word, surface, reading, pos, meaning, notes,
                sentence, article_id, title, review_count, mastered, now,
                vocab_id, user_id,
            ),
        )
        return vocab_result(owned_vocab(conn, user_id, vocab_id))


def delete_vocab(user_id: int, vocab_id: str) -> None:
    with account_connection(write=True) as conn:
        owned_vocab(conn, user_id, vocab_id)
        conn.execute("delete from vocab_items where id=? and user_id=?", (vocab_id, user_id))
