from app.services import database as database_service
from uuid import uuid4
import json

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services import history_service as db


def account(name):
    client = TestClient(app)
    assert client.post('/api/users/register', json={
        'username': name, 'password': 'example-password',
    }).status_code == 201
    login = client.post('/api/auth/login', json={'identity': name, 'password': 'example-password'})
    client.headers['X-CSRF-Token'] = client.cookies.get('tts_csrf')
    return client, login.json()['user']['id']


def create(client, **fields):
    return client.post('/api/articles', json={
        'id': str(uuid4()), 'title': '日本語の文章', 'content': '第一行\r\n第二行\n', **fields,
    })


def test_articles_crud_search_and_long_text():
    client, _ = account('alice')
    content = '日本語と😀\r\n' * 5000
    response = create(client, content=content)
    assert response.status_code == 201
    article = response.json()
    assert article['content'] == content
    assert article['character_count'] == len(content)
    assert article['revision'] == 1
    assert 'user_id' not in article
    assert client.get('/api/articles?q=第二').json() == []
    summary = client.get('/api/articles?q=日本語').json()[0]
    assert 'content' not in summary
    assert summary['id'] == article['id']
    assert client.get('/api/articles?q=%').json() == []
    path = '/api/articles/' + article['id']
    assert client.get(path).json() == article
    updated = client.put(path, json={'title': '改名', 'content': '', 'revision': 1})
    assert updated.status_code == 200
    assert updated.json()['revision'] == 2
    assert updated.json()['created_at'] == article['created_at']
    assert updated.json()['updated_at'] >= article['updated_at']
    assert client.delete(path).status_code == 204
    assert client.get(path).status_code == 404
    assert client.get('/api/articles').json() == []
    assert client.put(path, json={'title': 'late', 'content': 'late', 'revision': 2}).status_code == 404


def test_article_database_keeps_markdown_source_and_original_newlines():
    client, _ = account('markdown_reader')
    source = '# 标题\r\n\r\n**hello**\n\n[链接](https://example.com)'
    article = create(client, content=source).json()
    path = '/api/articles/' + article['id']
    assert client.get(path).json()['content'] == source
    updated = client.put(path, json={'title': '原文', 'content': '**hello**', 'revision': 1})
    assert updated.status_code == 200
    with database_service.connect_database() as conn:
        stored = conn.execute('select content from articles where id=?', (article['id'],)).fetchone()[0]
    assert stored == '**hello**'


def test_articles_account_isolation_and_expected_identity():
    alice, alice_id = account('alice')
    bob, bob_id = account('bob')
    article = create(alice).json()
    path = '/api/articles/' + article['id']
    assert bob.get('/api/articles').json() == []
    assert bob.get(path).status_code == 404
    assert bob.put(path, json={'title': 'bad', 'content': 'bad', 'revision': 1}).status_code == 404
    assert bob.delete(path).status_code == 404
    assert create(bob, id=article['id']).status_code == 409
    bob.headers['X-Article-Account'] = str(alice_id)
    assert create(bob).status_code == 409
    bob.headers['X-Article-Account'] = str(bob_id)
    assert create(bob).status_code == 201


@pytest.mark.parametrize('method,path,body', [
    ('GET', '/api/articles', None), ('POST', '/api/articles', {'id': str(uuid4())}),
    ('GET', '/api/articles/' + str(uuid4()), None),
    ('PUT', '/api/articles/' + str(uuid4()), {'title': 'a', 'content': '', 'revision': 1}),
    ('DELETE', '/api/articles/' + str(uuid4()), None),
])
def test_articles_require_login(method, path, body):
    response = TestClient(app).request(method, path, json=body, headers={'X-Client-ID': 'account_1'})
    assert response.status_code == 401


def test_articles_csrf_validation_and_no_client_owner():
    client, _ = account('alice')
    client.headers.pop('X-CSRF-Token')
    assert create(client).status_code == 403
    client.headers['X-CSRF-Token'] = client.cookies.get('tts_csrf')
    assert create(client, user_id=999).status_code == 422
    assert create(client, title='a' * 201).status_code == 422
    assert create(client, content='a' * 500001).status_code == 422
    invalid = json.dumps({'id': str(uuid4()), 'content': '\ud800'})
    assert client.post('/api/articles', content=invalid, headers={'Content-Type': 'application/json'}).status_code == 422
    assert create(client, title='', content='').status_code == 201


def test_articles_idempotency_revision_and_deleted_tombstone():
    client, _ = account('alice')
    identifier = str(uuid4())
    article = create(client, id=identifier).json()
    retry = create(client, id=identifier)
    assert retry.status_code == 201
    assert retry.json() == article
    assert len(client.get('/api/articles').json()) == 1
    path = '/api/articles/' + identifier
    update = {'title': 'new', 'content': 'from device B', 'revision': 1}
    assert client.put(path, json=update).status_code == 200
    assert client.put(path, json=update).status_code == 409
    assert client.get(path).json()['content'] == 'from device B'
    assert client.delete(path).status_code == 204
    assert create(client, id=identifier).status_code == 410


def test_delete_before_create_arrives_keeps_tombstone():
    client, _ = account('alice')
    identifier = str(uuid4())
    assert client.delete('/api/articles/' + identifier).status_code == 404
    assert create(client, id=identifier).status_code == 410
    assert client.get('/api/articles').json() == []


def test_article_migration_preserves_users_and_history():
    client, user_id = account('alice')
    db.add_or_touch('legacy', 'old text', 'voice', 'model', 'edge', 'a' * 64)
    database_service._initialized = False
    database_service.init_db()
    database_service._initialized = False
    database_service.init_db()
    assert client.get('/api/auth/me').json()['id'] == user_id
    with database_service.connect_database() as conn:
        assert conn.execute('select text from history').fetchone()[0] == 'old text'
    assert create(client).status_code == 201

def test_tombstone_inserted_without_duplicate_update():
    from app.services.article_service import delete_article, ArticleError
    client, user_id = account('alice_tombstone')
    identifier = str(uuid4())
    with pytest.raises(ArticleError) as exc_info:
        delete_article(user_id, identifier)
    assert exc_info.value.status_code == 404
    with database_service.connect_database() as conn:
        row = conn.execute("select revision, deleted, title, content from articles where id=?", (identifier,)).fetchone()
        assert row["deleted"] == 1
        assert row["revision"] == 1
        assert row["title"] == ""
        assert row["content"] == ""
