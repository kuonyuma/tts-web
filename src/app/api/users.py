from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Request, status

from app.config import settings
from app.api.auth import queue_email
from app.api.dependencies import admin_account, auth_request_guard
from app.services.mail_service import mail_enabled
from app.schemas.users import RegisterUserRequest, UserResponse, UserAdminUpdate
from app.services import auth_service as auth
from app.services.user_service import UsernameTakenError, register_user


router = APIRouter(prefix="/api/users", tags=["users"])


@router.post(
    "/register", response_model=UserResponse, status_code=status.HTTP_201_CREATED,
    summary="Create a local account",
)
def register(body: RegisterUserRequest, request: Request, background: BackgroundTasks) -> UserResponse:
    # A synchronous route keeps Argon2 and SQLite work off the event loop.
    if (settings.ACCOUNT_AUTH_REQUIRED or settings.APP_ENV == "production") and not body.email:
        raise HTTPException(422, "账号模式需要提供邮箱。")
    auth_request_guard(request)
    try:
        user = register_user(body)
    except UsernameTakenError:
        raise HTTPException(status.HTTP_409_CONFLICT, "用户名或邮箱已存在。") from None
    if user.email and mail_enabled():
        queue_email(background, user.email, "verify")
    return UserResponse.model_validate(user)


@router.get("", response_model=list[UserResponse])
def list_users(limit: int = Query(default=100, ge=1, le=200), offset: int = Query(default=0, ge=0),
               _context: auth.AuthContext = Depends(admin_account)):
    return [UserResponse.model_validate(user) for user in auth.list_users(limit, offset)]


@router.patch("/{user_id}", response_model=UserResponse)
def update_user(user_id: int, body: UserAdminUpdate, request: Request,
                context: auth.AuthContext = Depends(admin_account)):
    auth_request_guard(request)
    if not body.model_fields_set or any(getattr(body, field) is None for field in body.model_fields_set):
        raise HTTPException(422, "请提供角色或账号状态。")
    return UserResponse.model_validate(auth.update_user(context.user, user_id, body.role, body.is_active))
