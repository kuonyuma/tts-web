"""Local operator commands; passwords are read interactively, never as CLI args."""

import argparse
import getpass

from pydantic import ValidationError

from app.schemas.users import RegisterUserRequest
from app.services.database import connection as account_connection
from app.services.timestamps import utc_timestamp
from app.services.user_service import UsernameTakenError, register_user


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser("create-admin", help="Create an administrator locally")
    create.add_argument("--username", required=True)
    create.add_argument("--email", required=True)
    args = parser.parse_args(argv)
    password = getpass.getpass("管理员密码: ")
    confirmation = getpass.getpass("再次输入密码: ")
    if password != confirmation:
        parser.error("两次密码不一致")
    try:
        request = RegisterUserRequest(username=args.username, email=args.email, password=password)
    except ValidationError:
        parser.error("用户名、邮箱或密码格式无效")
    try:
        user = register_user(request)
    except UsernameTakenError:
        parser.error("用户名或邮箱已存在；请使用独立的管理员账号")
    with account_connection(write=True) as conn:
        # Local operator control is the bootstrap trust boundary.
        conn.execute("update users set role='admin', email_verified=1, updated_at=? where id=?", (utc_timestamp(), user.id))
    print(f"管理员已创建: {user.username}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
