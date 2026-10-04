import sqlite3
from dataclasses import dataclass, field
from datetime import datetime

from app.schemas.users import RegisterUserRequest
from app.services import database
from app.services.timestamps import utc_timestamp
from app.services.passwords import hash_password


@dataclass(frozen=True)
class User:
    id: int
    username: str
    password_hash: str = field(repr=False)
    created_at: datetime
    updated_at: datetime
    email: str | None = None
    email_verified: bool = False
    role: str = "user"
    is_active: bool = True

    @property
    def has_password(self) -> bool:
        return self.password_hash.startswith("$argon2")


class UsernameTakenError(Exception):
    """A canonical username already belongs to an account."""


def user_from_row(row: sqlite3.Row) -> User:
    return User(
        id=row["id"], username=row["username"], password_hash=row["password_hash"],
        created_at=datetime.fromisoformat(row["created_at"]),
        updated_at=datetime.fromisoformat(row["updated_at"]), email=row["email"],
        email_verified=bool(row["email_verified"]), role=row["role"], is_active=bool(row["is_active"]),
    )


def register_user(request: RegisterUserRequest) -> User:
    """Create an account; SQL storage stays here, outside the HTTP router."""
    try:
        with database.connection() as conn:
            if conn.execute("select 1 from users where username = ? or email = ?", (request.username, request.email)).fetchone():
                raise UsernameTakenError()
            # SELECT does not start a SQLite write transaction; hash before INSERT.
            password_hash = hash_password(request.password.get_secret_value())
            now = utc_timestamp()
            cursor = conn.execute(
                "insert into users (username, password_hash, created_at, updated_at, email) "
                "values (?, ?, ?, ?, ?)",
                (request.username, password_hash, now, now, request.email),
            )
            row = conn.execute("select * from users where id = ?", (cursor.lastrowid,)).fetchone()
            return user_from_row(row)
    except sqlite3.IntegrityError as exc:
        # The UNIQUE constraint is authoritative when registrations race.
        # Do not disguise NOT NULL, trigger or other storage failures as 409.
        if getattr(exc, "sqlite_errorcode", None) == sqlite3.SQLITE_CONSTRAINT_UNIQUE:
            raise UsernameTakenError() from None
        raise
