import re
import sqlite3
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.main import app
from app.services import history_service as db


PASSWORD = "example-password"


@pytest.fixture
def mail(monkeypatch):
    monkeypatch.setattr(settings, "SMTP_HOST", "mail.example.com")
    monkeypatch.setattr(settings, "SMTP_FROM", "noreply@example.com")
    monkeypatch.setattr(settings, "SMTP_SECURITY", "starttls")
    messages = []

    class FakeSMTP:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def starttls(self, **kwargs):
            pass

        def login(self, *args):
            pass

        def send_message(self, message):
            messages.append(message)

    monkeypatch.setattr("smtplib.SMTP", FakeSMTP)
    return messages


def create(client, email="alice@example.com"):
    return client.post("/api/users/register", json={"username": "alice", "email": email, "password": PASSWORD})


def token_from(message, purpose):
    match = re.search(r"#" + purpose + r"=([A-Za-z0-9_-]+)", message.get_content())
    assert match
    return match.group(1)


def test_registration_sends_verification_and_token_is_hashed_single_use(mail, caplog):
    client = TestClient(app)
    assert create(client).status_code == 201
    token = token_from(mail[-1], "verify")
    with db.connect_database() as conn:
        row = conn.execute("select * from auth_tokens").fetchone()
        assert row["token_hash"] != token
        assert token not in str(dict(row))
    response = client.post("/api/auth/email/verify", json={"token": token})
    assert response.status_code == 200
    assert client.post("/api/auth/email/verify", json={"token": token}).status_code == 400
    client.post("/api/auth/login", json={"identity": "alice", "password": PASSWORD})
    assert client.get("/api/auth/me").json()["email_verified"] is True
    assert token not in caplog.text


def test_forgot_password_response_is_uniform_and_reset_revokes_all_sessions(mail):
    client = TestClient(app)
    create(client)
    client.post("/api/auth/email/verify", json={"token": token_from(mail[-1], "verify")})
    access = client.post("/api/auth/login", json={"identity": "alice", "password": PASSWORD}).json()["access_token"]
    known = client.post("/api/auth/password/forgot", json={"email": "alice@example.com"})
    token = token_from(mail[-1], "reset")
    missing = client.post("/api/auth/password/forgot", json={"email": "missing@example.com"})
    assert known.status_code == missing.status_code == 202
    assert known.json() == missing.json()
    new_password = "changed-password-with-spaces "
    assert client.post("/api/auth/password/reset", json={"token": token, "password": new_password}).status_code == 200
    assert client.post("/api/auth/password/reset", json={"token": token, "password": new_password}).status_code == 400
    assert TestClient(app).get("/api/auth/me", headers={"Authorization": f"Bearer {access}"}).status_code == 401
    assert client.post("/api/auth/login", json={"identity": "alice", "password": PASSWORD}).status_code == 401
    assert client.post("/api/auth/login", json={"identity": "alice", "password": new_password}).status_code == 200


def test_expired_token_does_not_change_user(mail):
    client = TestClient(app)
    create(client)
    token = token_from(mail[-1], "verify")
    with db.connect_database() as conn:
        conn.execute("update auth_tokens set expires_at=0")
        conn.commit()
    assert client.post("/api/auth/email/verify", json={"token": token}).status_code == 400
    with db.connect_database() as conn:
        assert conn.execute("select email_verified from users").fetchone()[0] == 0


def test_email_change_requires_password_csrf_and_invalidates_old_tokens(mail):
    client = TestClient(app)
    create(client)
    original = token_from(mail[-1], "verify")
    client.post("/api/auth/login", json={"identity": "alice", "password": PASSWORD})
    payload = {"email": "new@example.com", "password": PASSWORD}
    assert client.put("/api/auth/email", json=payload).status_code == 403
    headers = {"X-CSRF-Token": client.cookies["tts_csrf"]}
    assert client.put("/api/auth/email", json={"email": "new@example.com", "password": "wrong-password"}, headers=headers).status_code == 401
    response = client.put("/api/auth/email", json=payload, headers=headers)
    assert response.status_code == 200
    assert response.json()["email"] == "new@example.com"
    assert client.post("/api/auth/email/verify", json={"token": original}).status_code == 400
    assert client.post("/api/auth/email/verify", json={"token": token_from(mail[-1], "verify")}).status_code == 200


def test_mail_delivery_failure_does_not_echo_secrets_or_undo_registration(mail, caplog):
    with patch("smtplib.SMTP", side_effect=OSError("private SMTP password example-password")):
        response = create(TestClient(app))
    assert response.status_code == 201
    assert "private SMTP" not in caplog.text + response.text
    assert PASSWORD not in caplog.text + response.text
    with sqlite3.connect(db.DB_PATH) as conn:
        assert conn.execute("select count(*) from users").fetchone()[0] == 1
