import base64
import hashlib
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.main import app
from app.services import history_service as db


@pytest.fixture
def github(monkeypatch):
    monkeypatch.setattr(settings, "GITHUB_CLIENT_ID", "test-client-id")
    monkeypatch.setattr(settings, "GITHUB_CLIENT_SECRET", "private-github-secret")
    state = {"id": 1234, "email": "github@example.com", "verified": True, "fail": False, "exchanges": []}

    def handler(request):
        if state["fail"]:
            return httpx.Response(502, text="private upstream error private-github-secret")
        if str(request.url) == "https://github.com/login/oauth/access_token":
            data = parse_qs(request.content.decode())
            assert data["client_secret"] == ["private-github-secret"]
            state["exchanges"].append(data)
            return httpx.Response(200, json={"access_token": "private-provider-token", "token_type": "bearer"})
        assert request.headers["Authorization"] == "Bearer private-provider-token"
        if str(request.url) == "https://api.github.com/user":
            return httpx.Response(200, json={"id": state["id"], "login": "octocat"})
        if str(request.url) == "https://api.github.com/user/emails":
            return httpx.Response(200, json=[{"email": state["email"], "primary": True, "verified": state["verified"]}])
        raise AssertionError(f"Unexpected URL {request.url}")

    original = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: original(transport=httpx.MockTransport(handler), **kwargs))
    return state


def start(client):
    response = client.get("/api/auth/oauth/github/start", follow_redirects=False)
    assert response.status_code == 302
    query = parse_qs(urlparse(response.headers["location"]).query)
    assert query["code_challenge_method"] == ["S256"]
    return query


def callback(client, state):
    return client.get("/api/auth/oauth/github/callback", params={"code": "test-code", "state": state}, follow_redirects=False)


def test_oauth_real_state_pkce_callback_and_repeat_login(github):
    client = TestClient(app)
    query = start(client)
    response = callback(client, query["state"][0])
    assert response.status_code == 303
    assert response.headers["location"] == "/account.html#signed-in"
    user = client.get("/api/auth/me").json()
    assert user["email"] == "github@example.com"
    assert user["email_verified"] is True
    assert user["has_password"] is False
    assert user["role"] == "user"
    verifier = github["exchanges"][0]["code_verifier"][0]
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    assert query["code_challenge"] == [challenge]
    assert callback(client, query["state"][0]).status_code == 400
    other = TestClient(app)
    callback(other, start(other)["state"][0])
    assert other.get("/api/auth/me").json()["id"] == user["id"]
    with db.connect_database() as conn:
        assert conn.execute("select count(*) from users").fetchone()[0] == 1
        assert "private-provider-token" not in str(conn.execute("select * from oauth_accounts").fetchall())


def test_oauth_browser_binding_state_tamper_and_expiry(github):
    client = TestClient(app)
    state = start(client)["state"][0]
    assert callback(TestClient(app), state).status_code == 400
    assert callback(client, "x" * 43).status_code == 400
    assert not github["exchanges"]
    with db.connect_database() as conn:
        conn.execute("update oauth_states set expires_at=0")
        conn.commit()
    assert callback(client, state).status_code == 400


def test_oauth_does_not_trust_unverified_email(github):
    github["verified"] = False
    client = TestClient(app)
    assert callback(client, start(client)["state"][0]).status_code == 303
    user = client.get("/api/auth/me").json()
    assert user["email"] is None
    assert user["email_verified"] is False


def test_oauth_never_automatically_links_email_collision(github):
    client = TestClient(app)
    local = client.post("/api/users/register", json={"username": "alice", "email": "github@example.com", "password": "example-password"}).json()
    response = callback(client, start(client)["state"][0])
    assert response.status_code == 409
    assert client.get("/api/auth/me").status_code == 401
    with db.connect_database() as conn:
        assert conn.execute("select count(*) from oauth_accounts").fetchone()[0] == 0
        assert conn.execute("select count(*) from users").fetchone()[0] == 1
    client.post("/api/auth/login", json={"identity": "alice", "password": "example-password"})
    assert client.post("/api/auth/oauth/github/link").status_code == 403
    response = client.post("/api/auth/oauth/github/link", headers={"X-CSRF-Token": client.cookies["tts_csrf"]})
    assert response.status_code == 200
    state = parse_qs(urlparse(response.json()["url"]).query)["state"][0]
    assert callback(client, state).status_code == 303
    assert client.get("/api/auth/me").json()["id"] == local["id"]


def test_oauth_upstream_errors_are_sanitized(github, caplog):
    github["fail"] = True
    client = TestClient(app)
    response = callback(client, start(client)["state"][0])
    assert response.status_code == 502
    assert "private-github-secret" not in response.text + caplog.text
    assert "private upstream" not in response.text + caplog.text


@pytest.mark.parametrize("replacement", ["other-user", "logout", "revoked"])
def test_oauth_link_requires_the_original_current_browser_session(github, replacement):
    client = TestClient(app)
    for username in ("alice", "bobby"):
        assert client.post("/api/users/register", json={"username": username, "password": "example-password"}).status_code == 201
    client.post("/api/auth/login", json={"identity": "alice", "password": "example-password"})
    response = client.post("/api/auth/oauth/github/link", headers={"X-CSRF-Token": client.cookies["tts_csrf"]})
    state = parse_qs(urlparse(response.json()["url"]).query)["state"][0]
    if replacement == "other-user":
        client.post("/api/auth/login", json={"identity": "bobby", "password": "example-password"})
    elif replacement == "logout":
        client.post("/api/auth/logout", headers={"X-CSRF-Token": client.cookies["tts_csrf"]})
    else:
        with db.connect_database() as conn:
            conn.execute("delete from auth_sessions")
            conn.commit()
    assert callback(client, state).status_code in (401, 409)
    assert not github["exchanges"]
    with db.connect_database() as conn:
        assert conn.execute("select count(*) from oauth_accounts").fetchone()[0] == 0


def test_oauth_only_recovery_email_requires_provider_proof_or_local_password(github, monkeypatch):
    monkeypatch.setattr(settings, "SMTP_HOST", "smtp.example.com")
    monkeypatch.setattr(settings, "SMTP_FROM", "service@example.com")
    monkeypatch.setattr("app.api.auth.send_account_link", lambda *args: None)
    client = TestClient(app)
    assert callback(client, start(client)["state"][0]).status_code == 303
    response = client.put("/api/auth/email", json={"email": "changed@example.com"},
                          headers={"X-CSRF-Token": client.cookies["tts_csrf"]})
    assert response.status_code == 403
    assert client.get("/api/auth/me").json()["email"] == "github@example.com"
    from app.services.account_tokens import issue_email_token

    token = issue_email_token("github@example.com", "reset")
    assert client.post("/api/auth/password/reset", json={"token": token, "password": "new-password"}).status_code == 200
    with db.connect_database() as conn:
        username = conn.execute("select username from users").fetchone()[0]
    assert client.post("/api/auth/login", json={"identity": username, "password": "new-password"}).status_code == 200


def test_existing_oauth_user_can_add_newly_verified_provider_email(github):
    github["verified"] = False
    client = TestClient(app)
    assert callback(client, start(client)["state"][0]).status_code == 303
    user_id = client.get("/api/auth/me").json()["id"]
    github["verified"] = True
    assert callback(client, start(client)["state"][0]).status_code == 303
    user = client.get("/api/auth/me").json()
    assert user["id"] == user_id
    assert user["email"] == "github@example.com"
    assert user["email_verified"] is True
