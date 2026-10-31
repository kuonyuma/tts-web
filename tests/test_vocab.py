import json
import sqlite3
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services.llm.types import LLMResult
from app.services.vocab_migrations import migrate_vocab


def account(name: str):
    client = TestClient(app)
    assert client.post("/api/users/register", json={
        "username": name, "password": "example-password",
    }).status_code == 201
    login = client.post("/api/auth/login", json={"identity": name, "password": "example-password"})
    client.headers["X-CSRF-Token"] = client.cookies.get("tts_csrf")
    return client, login.json()["user"]["id"]


def test_vocab_crud_dedup_search_and_isolation():
    alice, alice_id = account("vocab_alice")
    bob, bob_id = account("vocab_bob")

    # 1. Create a vocab item
    res = alice.post("/api/vocab", json={
        "word": "資金調達",
        "reading": "しきんちょうたつ",
        "pos": "名詞・サ変",
        "meaning": "筹集资金、融资",
        "notes": "IPO 常见词",
        "context_sentence": "Anthropicは巨額の資金調達を計画している。",
        "source_article_id": str(uuid4()),
        "source_title": "東京の読書ノート",
    })
    assert res.status_code == 201
    item = res.json()
    assert item["word"] == "資金調達"
    assert item["reading"] == "しきんちょうたつ"
    assert item["mastered"] is False
    assert item["review_count"] == 0

    # 2. Duplicate word for same user updates existing item idempotently (200)
    dup = alice.post("/api/vocab", json={
        "word": "資金調達",
        "meaning": "融资（更新释义）",
    })
    assert dup.status_code == 200
    assert dup.json()["id"] == item["id"]
    assert dup.json()["meaning"] == "融资（更新释义）"
    assert dup.json()["reading"] == "しきんちょうたつ"

    # 3. Create second item
    res2 = alice.post("/api/vocab", json={
        "word": "上場",
        "reading": "じょうじょう",
        "pos": "名詞",
        "meaning": "上市",
        "mastered": True,
    })
    assert res2.status_code == 201

    # 4. List & Filter & Search
    all_items = alice.get("/api/vocab").json()
    assert len(all_items) == 2
    assert len(alice.get("/api/vocab?status=mastered").json()) == 1
    assert len(alice.get("/api/vocab?status=unmastered").json()) == 1
    assert len(alice.get("/api/vocab?q=しきん").json()) == 1
    assert len(alice.get("/api/vocab?q=不存在").json()) == 0

    # 5. Patch item (flashcard review increment & mastered toggle)
    patched = alice.patch(f"/api/vocab/{item['id']}", json={
        "mastered": True,
        "review_delta": 1,
        "notes": "已掌握",
    })
    assert patched.status_code == 200
    assert patched.json()["mastered"] is True
    assert patched.json()["review_count"] == 1
    assert patched.json()["notes"] == "已掌握"

    # 6. Tenant isolation: Bob cannot see, update, or delete Alice's vocab
    assert bob.get("/api/vocab").json() == []
    assert bob.patch(f"/api/vocab/{item['id']}", json={"mastered": False}).status_code == 404
    assert bob.delete(f"/api/vocab/{item['id']}").status_code == 404

    # Header mismatch guard
    bob.headers["X-Article-Account"] = str(alice_id)
    assert bob.get("/api/vocab").status_code == 409
    bob.headers["X-Article-Account"] = str(bob_id)
    assert bob.get("/api/vocab").status_code == 200

    # 7. Delete item
    assert alice.delete(f"/api/vocab/{item['id']}").status_code == 204
    assert alice.delete(f"/api/vocab/{item['id']}").status_code == 404
    assert len(alice.get("/api/vocab").json()) == 1


@pytest.mark.parametrize("method,path,body", [
    ("GET", "/api/vocab", None),
    ("POST", "/api/vocab", {"word": "テスト"}),
    ("PATCH", "/api/vocab/" + str(uuid4()), {"mastered": True}),
    ("DELETE", "/api/vocab/" + str(uuid4()), None),
])
def test_vocab_requires_login(method, path, body):
    response = TestClient(app).request(method, path, json=body, headers={"X-Client-ID": "account_1"})
    assert response.status_code == 401


def test_vocab_preserves_surface_form_through_save_search_and_update():
    client, _ = account("vocab_surface")
    created = client.post("/api/vocab", json={
        "word": "申し込む",
        "surface": " 申し込んだ ",
        "context_sentence": "昨日、新しい講座に申し込んだ。",
    })
    assert created.status_code == 201
    item = created.json()
    assert item["surface"] == "申し込んだ"
    assert client.get("/api/vocab?q=申し込んだ").json()[0]["id"] == item["id"]

    duplicate = client.post("/api/vocab", json={"word": "申し込む", "meaning": "报名"})
    assert duplicate.status_code == 200
    assert duplicate.json()["surface"] == "申し込んだ"
    updated = client.patch(f"/api/vocab/{item['id']}", json={"review_delta": 1})
    assert updated.status_code == 200
    assert updated.json()["surface"] == "申し込んだ"

    updated = client.patch(f"/api/vocab/{item['id']}", json={"surface": "申し込んで"})
    assert updated.status_code == 200
    assert client.get("/api/vocab").json()[0]["surface"] == "申し込んで"
    for invalid in ("a" * 101, "\ud800"):
        headers = {"Content-Type": "application/json"}
        assert client.post(
            "/api/vocab", content=json.dumps({"word": "test", "surface": invalid}), headers=headers,
        ).status_code == 422
        assert client.patch(
            f"/api/vocab/{item['id']}", content=json.dumps({"surface": invalid}), headers=headers,
        ).status_code == 422


def test_vocab_surface_migration_preserves_existing_records():
    with sqlite3.connect(":memory:") as conn:
        conn.execute("""
            create table vocab_items (
                id text primary key, user_id integer not null, word text not null,
                reading text not null default '', pos text not null default '',
                meaning text not null default '', notes text not null default '',
                context_sentence text not null default '', source_article_id text,
                source_title text not null default '', review_count integer not null default 0,
                mastered integer not null default 0, created_at text not null, updated_at text not null
            )
        """)
        conn.execute(
            "insert into vocab_items(id,user_id,word,created_at,updated_at) values(?,1,?,?,?)",
            ("legacy", "読書", "2026-01-01", "2026-01-01"),
        )
        migrate_vocab(conn)
        migrate_vocab(conn)
        assert conn.execute("select word, surface from vocab_items").fetchall() == [("読書", "")]


def test_explain_word_in_context_and_caching():
    client = TestClient(app, headers={"X-Client-ID": "vocab-lookup-client"})
    fake_json = '{"word":"申し込む","reading":"もうしこむ","pos":"五段動詞","meaning":"申请、报名","note":"文中申し込んだ为过去式"}'
    fake_return = (
        LLMResult(fake_json, "deepseek", "deepseek-flash", {"total_tokens": 18}),
        "deepseek-flash",
        "direct",
        "rev-1",
    )
    with patch("app.api.explain.generate_word_lookup", new_callable=AsyncMock, return_value=fake_return) as mock_gen:
        first = client.post("/api/explain/word", json={
            "word": "申し込んだ",
            "sentence": "昨日、新しい講座に申し込んだ。",
            "lang": "zh",
        })
        assert first.status_code == 200
        data = first.json()
        assert data["cached"] is False
        assert data["word"] == "申し込む"
        assert data["reading"] == "もうしこむ"
        assert data["pos"] == "五段動詞"
        assert data["meaning"] == "申请、报名"
        assert data["note"] == "文中申し込んだ为过去式"

        # Second identical lookup hits cache without calling LLM
        second = client.post("/api/explain/word", json={
            "word": "申し込んだ",
            "sentence": "昨日、新しい講座に申し込んだ。",
            "lang": "zh",
        })
        assert second.status_code == 200
        assert second.json()["cached"] is True
        assert second.json()["meaning"] == "申请、报名"
        mock_gen.assert_awaited_once()
