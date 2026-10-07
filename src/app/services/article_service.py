from app.services.database import connection as account_connection
from app.services.timestamps import utc_timestamp
from app.schemas.articles import ArticleCreate, ArticleUpdate


class ArticleError(Exception):
    def __init__(self, status_code: int, detail: str):
        self.status_code = status_code
        self.detail = detail


def article_result(row, *, summary: bool = False) -> dict:
    result = {key: row[key] for key in (
        "id", "title", "created_at", "updated_at", "revision",
    )}
    result["character_count"] = len(row["content"])
    if not summary:
        result["content"] = row["content"]
    return result


def owned_article(conn, user_id: int, article_id: str):
    row = conn.execute(
        "select * from articles where id=? and user_id=? and deleted=0",
        (article_id, user_id),
    ).fetchone()
    if row is None:
        raise ArticleError(404, "文章不存在或已删除。")
    return row


def list_articles(user_id: int, query: str = "") -> list[dict]:
    with account_connection() as conn:
        # instr treats % and _ literally and never interpolates search text into SQL.
        rows = conn.execute(
            "select * from articles where user_id=? and deleted=0 "
            "and (?='' or instr(lower(title), lower(?))>0 or instr(lower(content), lower(?))>0) "
            "order by created_at desc, id", (user_id, query, query, query),
        ).fetchall()
        return [article_result(row, summary=True) for row in rows]


def get_article(user_id: int, article_id: str) -> dict:
    with account_connection() as conn:
        return article_result(owned_article(conn, user_id, article_id))


def create_article(user_id: int, body: ArticleCreate) -> dict:
    article_id = str(body.id)
    with account_connection(write=True) as conn:
        row = conn.execute("select * from articles where id=?", (article_id,)).fetchone()
        if row:
            if row["user_id"] != user_id:
                raise ArticleError(409, "创建标识已使用，请重新新建。")
            if row["deleted"]:
                raise ArticleError(410, "文章已删除，不能重试创建。")
            return article_result(row)
        now = utc_timestamp()
        conn.execute(
            "insert into articles(id,user_id,title,content,created_at,updated_at) values(?,?,?,?,?,?)",
            (article_id, user_id, body.title, body.content, now, now),
        )
        return article_result(owned_article(conn, user_id, article_id))


def update_article(user_id: int, article_id: str, body: ArticleUpdate) -> dict:
    with account_connection(write=True) as conn:
        row = owned_article(conn, user_id, article_id)
        if row["revision"] != body.revision:
            raise ArticleError(409, "服务器已有更新。请比较本地草稿和服务器版本后再保存。")
        conn.execute(
            "update articles set title=?,content=?,updated_at=?,revision=revision+1 "
            "where id=? and user_id=? and revision=? and deleted=0",
            (body.title, body.content, utc_timestamp(), article_id, user_id, body.revision),
        )
        return article_result(owned_article(conn, user_id, article_id))


def delete_article(user_id: int, article_id: str) -> None:
    with account_connection(write=True) as conn:
        existing = conn.execute("select user_id,deleted from articles where id=?", (article_id,)).fetchone()
        now = utc_timestamp()
        if existing is None:
            # DELETE can arrive before an aborted POST finishes. Commit a tombstone
            # even for a missing UUID so that the late POST cannot create it.
            # Insert directly in final tombstone state, avoiding redundant immediate UPDATE.
            conn.execute(
                "insert into articles(id,user_id,title,content,created_at,updated_at,deleted,revision) "
                "values(?,?,'','',?,?,1,1)", (article_id, user_id, now, now),
            )
        else:
            owned_article(conn, user_id, article_id)
            # Keep the UUID tombstone, but discard text; late updates cannot recreate it.
            conn.execute(
                "update articles set deleted=1,title='',content='',revision=revision+1,updated_at=? "
                "where id=? and user_id=?", (now, article_id, user_id),
            )
    if existing is None:
        raise ArticleError(404, "文章不存在或已删除。")
