from app.services import database as database_service
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from threading import Barrier
from unittest.mock import patch

import pytest
from argon2 import PasswordHasher
from fastapi.testclient import TestClient

from app.main import app
from app.services import history_service as history


client = TestClient(app)
PASSWORD = "example-password"


def register(username="user123", password=PASSWORD):
    return client.post("/api/users/register", json={"username": username, "password": password})


def test_register_persists_user_and_returns_only_public_fields():
    response = register("User123")
    assert response.status_code == 201
    data = response.json()
    assert set(data) == {"id", "username", "created_at", "updated_at", "email", "email_verified", "role", "is_active", "has_password"}
    assert data["id"] > 0
    assert data["username"] == "user123"
    assert datetime.fromisoformat(data["created_at"]).utcoffset().total_seconds() == 0
    assert data["created_at"] == data["updated_at"]
    assert "no-store" in response.headers["cache-control"]
    with database_service.connect_database() as conn:
        row = conn.execute("select * from users where id = ?", (data["id"],)).fetchone()
        assert row["username"] == "user123"
        assert "password" not in row.keys()
        assert row["password_hash"] != PASSWORD
        assert row["password_hash"].startswith("$argon2id$")
        assert PasswordHasher().verify(row["password_hash"], PASSWORD)


@pytest.mark.parametrize("duplicate", ["user123", "USER123", "User123"])
def test_duplicate_username_returns_conflict_without_overwriting(duplicate):
    assert register().status_code == 201
    response = register(duplicate, "different-password")
    assert response.status_code == 409
    assert set(response.json()) == {"detail"}
    assert "password_hash" not in response.text
    with database_service.connect_database() as conn:
        rows = conn.execute("select * from users").fetchall()
        assert len(rows) == 1
        assert PasswordHasher().verify(rows[0]["password_hash"], PASSWORD)


@pytest.mark.parametrize("username", [
    "", "ab", "a" * 33, " user123", "user123 ", "user-name", "user.name",
    "用户123", "user\n", "user@example.com", "a';--", None, 123, [],
])
def test_invalid_username_is_rejected_before_storage(username):
    response = register(username)
    assert response.status_code == 422
    assert PASSWORD not in response.text
    assert "password_hash" not in response.text
    assert "input" not in response.json()["detail"][0]
    assert not database_service.DB_PATH.exists()


@pytest.mark.parametrize("password", ["", "1234567", "a" * 129, " " * 8, None, 123, []])
def test_invalid_password_is_rejected_without_echo(password):
    response = register(password=password)
    assert response.status_code == 422
    assert "input" not in response.json()["detail"][0]
    assert not database_service.DB_PATH.exists()


def test_invalid_unicode_password_is_safe_validation_error():
    response = client.post(
        "/api/users/register", content=b'{"username":"user123","password":"1234567\\ud800"}',
        headers={"Content-Type": "application/json"},
    )
    assert response.status_code == 422
    assert "input" not in response.json()["detail"][0]


@pytest.mark.parametrize("payload", [
    {}, {"username": "user123"}, {"password": PASSWORD},
    {"username": "user123", "password": PASSWORD, "nickname": "unused"},
    {"username": "user123", "password": PASSWORD, "password_hash": "supplied-hash"},
])
def test_missing_or_unknown_registration_fields_are_rejected(payload):
    response = client.post("/api/users/register", json=payload)
    assert response.status_code == 422
    assert PASSWORD not in response.text


@pytest.mark.parametrize("username,password", [
    ("abc", "12345678"), ("a" * 32, "a" * 128), ("_A1", " 密码 with spaces "),
])
def test_valid_boundaries_preserve_exact_password(username, password):
    response = register(username, password)
    assert response.status_code == 201
    with database_service.connect_database() as conn:
        row = conn.execute("select password_hash from users").fetchone()
        assert PasswordHasher().verify(row["password_hash"], password)


def test_registration_does_not_require_or_replace_legacy_identity():
    history.add_or_touch("local-client", "existing", "voice", "model", "edge", "a" * 16)
    assert register().status_code == 201
    response = client.get("/api/history", headers={"X-Client-ID": "local-client"})
    assert response.status_code == 200
    assert response.json()[0]["text"] == "existing"
    assert client.get("/api/history").status_code == 422


def test_same_password_uses_different_salts_and_secret_reprs(caplog):
    from app.schemas.users import RegisterUserRequest
    from app.services.user_service import register_user

    first = RegisterUserRequest(username="first", password=PASSWORD)
    second = RegisterUserRequest(username="second", password=PASSWORD)
    user_a, user_b = register_user(first), register_user(second)
    assert user_a.password_hash != user_b.password_hash
    assert PasswordHasher().verify(user_a.password_hash, PASSWORD)
    assert PasswordHasher().verify(user_b.password_hash, PASSWORD)
    assert PASSWORD not in repr(first)
    assert user_a.password_hash not in repr(user_a)
    assert PASSWORD not in caplog.text
    assert user_a.password_hash not in caplog.text


def test_concurrent_registrations_have_one_winner():
    from app.services import user_service

    database_service.init_db()
    barrier = Barrier(2)
    real_hash = user_service.hash_password

    def synchronized_hash(password):
        # Both real SELECT checks have completed before either real INSERT.
        barrier.wait(timeout=10)
        return real_hash(password)

    def create(username):
        return TestClient(app).post(
            "/api/users/register", json={"username": username, "password": PASSWORD},
        )

    with patch.object(user_service, "hash_password", synchronized_hash), ThreadPoolExecutor(2) as pool:
        futures = [pool.submit(create, name) for name in ("racing", "RACING")]
        responses = [future.result(timeout=15) for future in futures]
    assert sorted(response.status_code for response in responses) == [201, 409]
    with database_service.connect_database() as conn:
        assert conn.execute("select count(*) from users").fetchone()[0] == 1


def test_database_constraints_prevent_case_duplicates_and_nulls():
    assert register().status_code == 201
    with database_service.connect_database() as conn:
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "insert into users (username, password_hash, created_at, updated_at) "
                "select upper(username), password_hash, created_at, updated_at from users",
            )
        for column in ("username", "password_hash", "created_at", "updated_at"):
            with pytest.raises(sqlite3.IntegrityError):
                conn.execute(f"update users set {column} = null")


def test_storage_failure_is_safe_and_does_not_create_user(caplog):
    database_service.init_db()
    with database_service.connect_database() as conn:
        conn.execute("""
            create trigger fail_user_insert before insert on users
            begin select raise(abort, 'private SQL failure example-password'); end
        """)
        conn.commit()
    response = register()
    assert response.status_code == 503
    assert set(response.json()) == {"detail"}
    assert "private SQL" not in response.text + caplog.text
    assert PASSWORD not in response.text + caplog.text
    assert "no-store" in response.headers["cache-control"]
    with database_service.connect_database() as conn:
        assert conn.execute("select count(*) from users").fetchone()[0] == 0
        conn.execute("drop trigger fail_user_insert")
        conn.commit()
    assert register().status_code == 201


def test_commit_failure_rolls_back_without_success_response(monkeypatch):
    database_service.init_db()
    connect = database_service.connect_database

    class FailedCommit(sqlite3.Connection):
        def __exit__(self, exc_type, exc_value, traceback):
            if exc_type is None:
                raise sqlite3.OperationalError("private commit failure example-password")
            return super().__exit__(exc_type, exc_value, traceback)

    def failing_connection():
        conn = sqlite3.connect(database_service.DB_PATH, factory=FailedCommit)
        conn.row_factory = sqlite3.Row
        return conn

    with monkeypatch.context() as context:
        context.setattr(database_service, "connect_database", failing_connection)
        response = register()
    assert response.status_code == 503
    assert "private commit" not in response.text
    assert PASSWORD not in response.text
    with connect() as conn:
        assert conn.execute("select count(*) from users").fetchone()[0] == 0
    assert register().status_code == 201


def test_locked_database_returns_safe_error_and_recovers(monkeypatch):
    from app.config import settings

    database_service.init_db()
    monkeypatch.setattr(settings, "DB_BUSY_TIMEOUT_SECONDS", 0.01)
    conn = database_service.connect_database()
    try:
        conn.execute("begin immediate")
        response = register()
        assert response.status_code == 503
        assert "database is locked" not in response.text
    finally:
        conn.rollback()
        conn.close()
    assert register().status_code == 201


def test_migration_repeated_initialization_preserves_accounts_and_legacy_history(monkeypatch):
    # Simulate a pre-client_id database, including original IDs and dates.
    with sqlite3.connect(database_service.DB_PATH) as conn:
        conn.execute("""
            create table history (
                id integer primary key, text text, voice text, model text, cache_key text,
                created_at text, last_played_at text
            )
        """)
        conn.execute("""
            insert into history values (
                7, 'legacy text', 'voice', 'model', 'legacy-key',
                '2020-01-01 01:00:00', '2020-01-01 02:00:00'
            )
        """)
    assert register().status_code == 201
    with database_service.connect_database() as conn:
        account = dict(conn.execute("select * from users").fetchone())
    monkeypatch.setattr(database_service, "_initialized", False)
    database_service.init_db()
    with database_service.connect_database() as conn:
        assert dict(conn.execute("select * from users").fetchone()) == account
        legacy = conn.execute("select * from history").fetchone()
        assert legacy["id"] == 7
        assert legacy["text"] == "legacy text"
        assert legacy["client_id"] == "default"
        assert legacy["created_at"] == "2020-01-01 01:00:00"


def test_migration_failure_rolls_back_users_table_and_can_retry():
    from app.services.user_migrations import migrate_users

    def fail_after_ddl(conn):
        migrate_users(conn)
        raise sqlite3.OperationalError("injected migration failure")

    with patch.object(database_service, "migrate_users", fail_after_ddl):
        with pytest.raises(sqlite3.OperationalError):
            database_service.init_db()
    with sqlite3.connect(database_service.DB_PATH) as conn:
        assert conn.execute("select name from sqlite_master where name='users'").fetchone() is None
    assert not database_service._initialized
    assert register().status_code == 201


def test_legacy_cleanup_keeps_registered_users():
    import importlib.util
    from pathlib import Path

    assert register().status_code == 201
    history.add_or_touch("local-client", "old", "voice", "model", "edge", "a" * 16)
    path = Path(__file__).resolve().parents[1] / "scripts" / "clear_legacy_tts.py"
    spec = importlib.util.spec_from_file_location("account_cleanup_test", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module.cleanup(database_service.DB_PATH.parent, apply=True)["history_rows"] == 1
    assert register().status_code == 409
