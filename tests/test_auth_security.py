from app.services import database as database_service
from unittest.mock import AsyncMock, patch

import jwt
import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.main import app
from app.services import auth_service as auth, private_tts_storage


PASSWORD = "example-password"


def registered(username="alice", email=None):
    client = TestClient(app)
    payload = {"username": username, "password": PASSWORD}
    if email:
        payload["email"] = email
    user = client.post("/api/users/register", json=payload).json()
    token = client.post("/api/auth/login", json={"identity": username, "password": PASSWORD}).json()["access_token"]
    return client, user, token


@pytest.mark.parametrize("change", [
    {"exp": 0}, {"nbf": 9999999999}, {"iat": 9999999999}, {"aud": "wrong"},
    {"iss": "wrong"}, {"sub": "invalid"}, {"jti": "x" * 43}, {"type": "reset"},
])
def test_invalid_jwt_claims_cannot_use_a_session(change):
    client, _, token = registered()
    claims = jwt.decode(token, options={"verify_signature": False})
    claims.update(change)
    altered = jwt.encode(claims, auth.signing_key(), algorithm="HS256")
    response = client.get("/api/auth/me", headers={"Authorization": f"Bearer {altered}"})
    assert response.status_code == 401


def test_unsigned_tampered_and_expired_database_session_tokens_are_rejected():
    client, _, token = registered()
    claims = jwt.decode(token, options={"verify_signature": False})
    unsigned = jwt.encode(claims, key="", algorithm="none")
    assert client.get("/api/auth/me", headers={"Authorization": f"Bearer {unsigned}"}).status_code == 401
    wrong_key = jwt.encode(claims, "a" * 40, algorithm="HS256")
    assert client.get("/api/auth/me", headers={"Authorization": f"Bearer {wrong_key}"}).status_code == 401
    with database_service.connect_database() as conn:
        conn.execute("update auth_sessions set expires_at=0")
        conn.commit()
    assert client.get("/api/auth/me").status_code == 401


def test_jwt_role_does_not_override_current_database_permissions():
    client, _, token = registered()
    claims = jwt.decode(token, options={"verify_signature": False})
    claims["role"] = "admin"
    forged_role = jwt.encode(claims, auth.signing_key(), algorithm="HS256")
    assert client.get("/api/users", headers={"Authorization": f"Bearer {forged_role}"}).status_code == 403


def test_failed_login_is_rate_limited(monkeypatch):
    client, _, _ = registered()
    monkeypatch.setattr(settings, "AUTH_ATTEMPTS_PER_MINUTE", 2)
    assert client.post("/api/auth/login", json={"identity": "alice", "password": "bad"}).status_code == 401
    response = client.post("/api/auth/login", json={"identity": "alice", "password": "bad"})
    assert response.status_code == 429
    assert response.headers["retry-after"] == "60"


def test_reserved_account_identity_cannot_be_spoofed_anonymously():
    client, user, _ = registered()
    headers = {"X-Client-ID": f'account_{user["id"]}'}
    assert TestClient(app).get("/api/history", headers=headers).status_code == 401
    response = client.post("/api/auth/logout", headers={"X-CSRF-Token": "wrong"})
    assert response.status_code == 403
    assert client.get("/api/auth/me").status_code == 200


def test_account_private_audio_and_history_are_isolated(monkeypatch, tmp_path):
    alice, a, _ = registered("alice", "alice@example.com")
    bob, b, _ = registered("bobby", "bob@example.com")
    with database_service.connect_database() as conn:
        conn.execute("update users set email_verified=1")
        conn.commit()
    monkeypatch.setattr(settings, "ACCOUNT_AUTH_REQUIRED", True)
    monkeypatch.setattr(settings, "TTS_STORAGE_MODE", "private")
    store = private_tts_storage.PrivateTTSStore(database_service.DB_PATH, tmp_path / "private_audio")
    monkeypatch.setattr(private_tts_storage, "_store", store)
    from app.services.engines.base import TimedSynthesisResult, SentenceCue

    timed = TimedSynthesisResult(b"private audio", [SentenceCue("private text", 0, 100)])
    with patch("app.services.engines.edge_engine.EdgeTTSEngine.synthesize_with_timeline", new_callable=AsyncMock, return_value=timed):
        response = alice.post("/api/tts", json={"text": "private text"}, headers={"X-CSRF-Token": alice.cookies["tts_csrf"]})
    assert response.status_code == 200
    key = response.headers["x-cache-key"]
    assert alice.get(f"/api/tts/{key}").content == b"private audio"
    assert bob.get(f"/api/tts/{key}", headers={"X-Client-ID": f'account_{a["id"]}'}).status_code == 404
    assert len(alice.get("/api/history").json()) == 1
    assert bob.get("/api/history").json() == []
    history_id = alice.get("/api/history").json()[0]["id"]
    assert bob.delete(f"/api/history/{history_id}", headers={"X-CSRF-Token": bob.cookies["tts_csrf"]}).status_code == 404


def test_administrator_bootstrap_uses_interactive_password(monkeypatch, capsys):
    from app.manage import main

    answers = iter([PASSWORD, PASSWORD])
    monkeypatch.setattr("getpass.getpass", lambda prompt: next(answers))
    assert main(["create-admin", "--username", "operator", "--email", "operator@example.com"]) == 0
    client = TestClient(app)
    assert client.post("/api/auth/login", json={"identity": "operator", "password": PASSWORD}).status_code == 200
    assert client.get("/api/auth/me").json()["role"] == "admin"
    assert client.get("/api/users").status_code == 200
    assert PASSWORD not in capsys.readouterr().out


def test_link_token_invalid_unicode_is_safe_422():
    response = TestClient(app).post("/api/auth/email/verify", content=b'{"token":"aaaaaaaaaaaaaaa\\ud800"}',
                                   headers={"Content-Type": "application/json"})
    assert response.status_code == 422
    assert "input" not in response.json()["detail"][0]


def test_email_change_invalid_unicode_password_is_safe_422():
    client, _, _ = registered()
    response = client.put("/api/auth/email", content=b'{"email":"other@example.com","password":"aaaaaaaa\\ud800"}',
                          headers={"Content-Type": "application/json", "X-CSRF-Token": client.cookies["tts_csrf"]})
    assert response.status_code == 422
    assert "input" not in response.json()["detail"][0]


def test_revoked_cookie_is_cleared_before_returning_to_anonymous_mode():
    client, _, _ = registered()
    with database_service.connect_database() as conn:
        conn.execute("delete from auth_sessions")
        conn.commit()
    assert client.get("/api/auth/me").status_code == 401
    assert "tts_session" not in client.cookies
    assert "tts_csrf" not in client.cookies
    assert client.get("/api/history", headers={"X-Client-ID": "anonymous-client"}).status_code == 200


@pytest.mark.parametrize("authorization", ["Basic dXNlcjpwYXNz", "Bearer upstream-token"])
def test_existing_trusted_proxy_contract_is_preserved(authorization, monkeypatch):
    from app.api.dependencies import trusted_identity

    client, _, _ = registered()
    monkeypatch.setattr(settings, "COPILOT_AUTH_MODE", "trusted_proxy")
    monkeypatch.setattr(settings, "TTS_STORAGE_MODE", "private")
    monkeypatch.setattr(settings, "AUTH_PROXY_SECRET", "p" * 40)
    headers = {"Authorization": authorization, "X-Authenticated-User": "proxy-user", "X-Auth-Proxy-Secret": "p" * 40}
    assert client.get("/api/history", headers=headers).status_code == 200
    assert client.get("/api/history").status_code == 401
    from app.api.dependencies import require_copilot_identity
    from starlette.requests import Request
    import asyncio

    request = Request({"type": "http", "method": "GET", "headers": [(b"authorization", authorization.encode())]})
    assert asyncio.run(require_copilot_identity(None, "proxy-user", "p" * 40, request)) == trusted_identity("proxy-user", "p" * 40)


def test_signing_key_does_not_require_write_lock_when_already_persisted(monkeypatch):
    """Test F06: Reading an already created signing_key uses read connection."""
    monkeypatch.setattr(settings, "AUTH_JWT_SECRET", "")
    key1 = auth.signing_key()
    assert len(key1) > 20

    # Ensure concurrent read connection does not block signing_key read
    with database_service.connection(write=False) as conn:
        key2 = auth.signing_key()
        assert key1 == key2

