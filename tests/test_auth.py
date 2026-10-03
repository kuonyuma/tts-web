import sqlite3

import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.main import app
from app.services import history_service as db


PASSWORD = "example-password"


@pytest.fixture
def client():
    return TestClient(app)


def create_user(client, username="alice", email=None):
    payload = {"username": username, "password": PASSWORD}
    if email:
        payload["email"] = email
    response = client.post("/api/users/register", json=payload)
    assert response.status_code == 201
    return response.json()


def login(client, username="alice", password=PASSWORD):
    return client.post("/api/auth/login", json={"identity": username, "password": password})


def csrf(client):
    return {"X-CSRF-Token": client.cookies.get("tts_csrf", "")}


def test_login_creates_cookie_session_and_bearer_token(client):
    user = create_user(client)
    response = login(client)
    assert response.status_code == 200
    token = response.json()["access_token"]
    assert response.json()["token_type"] == "bearer"
    assert "HttpOnly" in response.headers["set-cookie"]
    assert "SameSite=lax" in response.headers["set-cookie"]
    assert client.get("/api/auth/me").json()["id"] == user["id"]
    bare = TestClient(app)
    assert bare.get("/api/auth/me").status_code == 401
    assert bare.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"}).json()["id"] == user["id"]
    assert "password" not in response.json()["user"]
    assert "password_hash" not in response.json()["user"]


def test_invalid_login_has_uniform_error(client):
    create_user(client)
    wrong = login(client, password="wrong-password")
    absent = login(client, username="absent")
    assert wrong.status_code == absent.status_code == 401
    assert wrong.json() == absent.json()


@pytest.mark.parametrize("identity,active,reason", [
    ("alice", True, "password_mismatch"),
    ("absent", True, "identity_not_found"),
    ("alice", False, "account_inactive"),
])
def test_login_rejection_logs_reason_without_credentials(client, caplog, identity, active, reason):
    user = create_user(client, email="alice@gmail.com")
    if not active:
        with db.connect_database() as conn:
            conn.execute("update users set is_active=0 where id=?", (user["id"],))
            conn.commit()
    caplog.clear()
    response = login(client, identity, password="private-wrong-password")
    assert response.status_code == 401
    messages = [record.getMessage() for record in caplog.records if record.name == "app.services.auth_service"]
    assert any(f"reason={reason}" in message for message in messages)
    assert "private-wrong-password" not in caplog.text
    assert "alice@gmail.com" not in caplog.text
    assert "password_hash" not in response.text


def test_cookie_logout_requires_csrf_and_revokes_bearer(client):
    create_user(client)
    token = login(client).json()["access_token"]
    assert client.post("/api/auth/logout").status_code == 403
    assert client.get("/api/auth/me").status_code == 200
    assert client.post("/api/auth/logout", headers=csrf(client)).status_code == 204
    assert client.get("/api/auth/me").status_code == 401
    assert TestClient(app).get("/api/auth/me", headers={"Authorization": f"Bearer {token}"}).status_code == 401


def test_cross_origin_login_is_rejected(client):
    create_user(client)
    response = client.post("/api/auth/login", json={"identity": "alice", "password": PASSWORD},
                           headers={"Origin": "https://attacker.example"})
    assert response.status_code == 403


@pytest.mark.parametrize("base_url", [
    "http://127.0.0.1:8000", "http://localhost:8765",
])
def test_local_browser_origin_supports_register_login_and_csrf_logout(base_url, monkeypatch):
    monkeypatch.setattr(settings, "APP_ENV", "development")
    monkeypatch.setattr(settings, "PUBLIC_BASE_URL", "http://localhost:8000")
    browser = TestClient(app, base_url=base_url)
    headers = {"Origin": base_url, "Sec-Fetch-Site": "same-origin"}
    response = browser.post("/api/users/register", json={"username": "alice", "password": PASSWORD}, headers=headers)
    assert response.status_code == 201
    response = browser.post("/api/auth/login", json={"identity": "alice", "password": PASSWORD}, headers=headers)
    assert response.status_code == 200
    assert browser.post("/api/auth/logout", headers={**headers, **csrf(browser)}).status_code == 204


def test_ipv6_loopback_browser_origin_is_accepted_in_development(monkeypatch):
    from starlette.requests import Request
    from app.services.auth_service import check_origin

    monkeypatch.setattr(settings, "APP_ENV", "development")
    monkeypatch.setattr(settings, "PUBLIC_BASE_URL", "http://localhost:8000")
    request = Request({"type": "http", "method": "POST", "scheme": "http", "path": "/api/auth/login",
                       "headers": [(b"host", b"[::1]:8000"), (b"origin", b"http://[::1]:8000")]})
    check_origin(request)


@pytest.mark.parametrize("base_url,origin,fetch_site", [
    ("http://127.0.0.1:8000", "http://127.0.0.1:8765", "same-origin"),
    ("http://127.0.0.1:8000", "https://127.0.0.1:8000", "same-origin"),
    ("http://127.0.0.1:8000", "http://localhost:8765", "same-site"),
    ("http://127.0.0.1:8000", "http://127.0.0.1.evil.example:8000", "same-origin"),
    ("http://evil.example:8000", "http://evil.example:8000", "same-origin"),
    ("http://evil.example:8000", "http://127.0.0.1:8000", "same-origin"),
    ("http://127.0.0.1", "http://127.0.0.1:0", "same-origin"),
    ("http://127.0.0.1:8000", "null", "same-origin"),
    ("http://127.0.0.1:8000", "http://127.0.0.1:not-a-port", "same-origin"),
    ("http://127.0.0.1:8000", "http://user@127.0.0.1:8000", "same-origin"),
    ("http://127.0.0.1:8000", "http://127.0.0.1:8000/path", "same-origin"),
    ("http://127.0.0.1:8000", "http://127.0.0.1:8000", "cross-site"),
])
def test_development_origin_exception_still_rejects_other_origins(base_url, origin, fetch_site, monkeypatch):
    monkeypatch.setattr(settings, "APP_ENV", "development")
    monkeypatch.setattr(settings, "PUBLIC_BASE_URL", "http://localhost:8000")
    response = TestClient(app, base_url=base_url).post("/api/auth/login", json={"identity": "absent", "password": PASSWORD},
                                                   headers={"Origin": origin, "Sec-Fetch-Site": fetch_site})
    assert response.status_code == 403


@pytest.mark.parametrize("app_env,public_url", [
    ("production", "http://localhost:8000"),
    ("development", "https://accounts.example.com"),
])
def test_explicit_public_deployment_does_not_accept_local_origin_aliases(app_env, public_url, monkeypatch):
    monkeypatch.setattr(settings, "APP_ENV", app_env)
    monkeypatch.setattr(settings, "PUBLIC_BASE_URL", public_url)
    response = TestClient(app, base_url="http://127.0.0.1:8000").post("/api/auth/login",
        json={"identity": "absent", "password": PASSWORD}, headers={"Origin": "http://127.0.0.1:8000"})
    assert response.status_code == 403


def test_email_is_canonical_unique_and_login_identifier(client):
    user = create_user(client, email="Alice@Example.com")
    assert user["email"] == "alice@example.com"
    assert user["email_verified"] is False
    duplicate = client.post("/api/users/register", json={
        "username": "other", "email": "ALICE@example.com", "password": PASSWORD,
    })
    assert duplicate.status_code == 409
    assert login(client, "alice@example.com").status_code == 200


@pytest.mark.parametrize("email", ["bad", "a@", "@example.com", "a b@example.com"])
def test_invalid_email_is_rejected(client, email):
    response = client.post("/api/users/register", json={"username": "alice", "email": email, "password": PASSWORD})
    assert response.status_code == 422


def test_regular_user_cannot_manage_users(client):
    user = create_user(client)
    assert client.get("/api/users").status_code == 401
    login(client)
    assert client.get("/api/users").status_code == 403
    assert client.patch(f'/api/users/{user["id"]}', json={"role": "admin"}, headers=csrf(client)).status_code == 403


def test_admin_permission_is_checked_live_and_disable_revokes_sessions(client):
    alice = create_user(client)
    bob_client = TestClient(app)
    bob = create_user(bob_client, "bobby")
    with db.connect_database() as conn:
        conn.execute("update users set role='admin' where id=?", (alice["id"],))
        conn.commit()
    login(client)
    bob_token = login(bob_client, "bobby").json()["access_token"]
    assert len(client.get("/api/users").json()) == 2
    response = client.patch(f'/api/users/{bob["id"]}', json={"is_active": False}, headers=csrf(client))
    assert response.status_code == 200
    assert TestClient(app).get("/api/auth/me", headers={"Authorization": f"Bearer {bob_token}"}).status_code == 401
    assert login(bob_client, "bobby").status_code == 401
    assert client.patch(f'/api/users/{alice["id"]}', json={"role": "user"}, headers=csrf(client)).status_code == 409


def test_auth_required_rejects_anonymous_business_and_spoofed_client(client, monkeypatch):
    user = create_user(client, email="alice@example.com")
    monkeypatch.setattr(settings, "ACCOUNT_AUTH_REQUIRED", True)
    assert client.get("/api/history", headers={"X-Client-ID": "browser-client"}).status_code == 401
    login(client)
    assert client.get("/api/history").status_code == 403
    with db.connect_database() as conn:
        conn.execute("update users set email_verified=1 where id=?", (user["id"],))
        conn.commit()
    assert client.get("/api/history", headers={"X-Client-ID": "victim"}).status_code == 200
    assert client.get("/api/history").status_code == 200


def test_legacy_user_migration_preserves_password(client, monkeypatch):
    # Exact table shape from stage one.
    from app.services.passwords import hash_password

    original = hash_password(PASSWORD)
    with sqlite3.connect(db.DB_PATH) as conn:
        conn.execute("create table users (id integer primary key, username text unique not null, "
                     "password_hash text not null, created_at text not null, updated_at text not null)")
        conn.execute("insert into users values (17, 'olduser', ?, '2020-01-01T00:00:00+00:00', '2020-01-01T00:00:00+00:00')", (original,))
    db.init_db()
    assert login(client, "olduser").status_code == 200
    assert client.get("/api/auth/me").json()["id"] == 17
    monkeypatch.setattr(db, "_initialized", False)
    db.init_db()
    with db.connect_database() as conn:
        assert conn.execute("select password_hash from users where id=17").fetchone()[0] == original
