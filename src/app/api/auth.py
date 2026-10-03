from fastapi import APIRouter, BackgroundTasks, Depends, Query, Request, Response
from starlette.concurrency import run_in_threadpool
from starlette.responses import RedirectResponse

from app.config import settings
from app.schemas.auth import LoginRequest, LoginResponse, EmailRequest, EmailChangeRequest, TokenRequest, ResetPasswordRequest
from app.schemas.users import UserResponse
from app.services import auth_service as auth
from app.services import account_tokens as tokens
from app.services.mail_service import require_mail, send_account_link
from app.services import oauth_service as oauth


def auth_request_guard(request: Request) -> None:
    if request.method not in auth.SAFE_METHODS:
        auth.check_origin(request)
        auth.rate_limit(request)


def current_account(request: Request) -> auth.AuthContext:
    return auth.authenticate(request)


def admin_account(context: auth.AuthContext = Depends(current_account)) -> auth.AuthContext:
    if context.user.role != "admin":
        raise auth.AuthError(403, "需要管理员权限。")
    return context


def set_login_cookies(response: Response, token: str, csrf: str) -> None:
    secure = settings.APP_ENV == "production" or settings.PUBLIC_BASE_URL.startswith("https://")
    response.set_cookie(auth.SESSION_COOKIE, token, max_age=settings.AUTH_SESSION_SECONDS,
                        httponly=True, secure=secure, samesite="lax", path="/")
    response.set_cookie(auth.CSRF_COOKIE, csrf, max_age=settings.AUTH_SESSION_SECONDS,
                        httponly=False, secure=secure, samesite="lax", path="/")


router = APIRouter(prefix="/api/auth", tags=["auth"], dependencies=[Depends(auth_request_guard)])


@router.get("/config")
def account_config():
    return {
        "auth_required": settings.ACCOUNT_AUTH_REQUIRED,
        "email_enabled": bool(settings.SMTP_HOST and settings.SMTP_FROM),
        "oauth_providers": ["github"] if settings.GITHUB_CLIENT_ID and settings.GITHUB_CLIENT_SECRET else [],
    }


@router.post("/login", response_model=LoginResponse)
def login(request: LoginRequest, response: Response):
    user, token, csrf = auth.login(request.identity, request.password.get_secret_value())
    set_login_cookies(response, token, csrf)
    return LoginResponse(access_token=token, expires_in=settings.AUTH_SESSION_SECONDS, user=UserResponse.model_validate(user))


@router.get("/me", response_model=UserResponse)
def me(context: auth.AuthContext = Depends(current_account)):
    return UserResponse.model_validate(context.user)


@router.post("/logout", status_code=204)
def logout(response: Response, context: auth.AuthContext = Depends(current_account)):
    auth.logout(context)
    response.delete_cookie(auth.SESSION_COOKIE, path="/")
    response.delete_cookie(auth.CSRF_COOKIE, path="/")


def queue_email(background: BackgroundTasks, email: str, purpose: str) -> None:
    token = tokens.issue_email_token(email, purpose)
    if token:
        background.add_task(send_account_link, email, token, purpose)


@router.post("/email/verification", status_code=202)
def request_verification(body: EmailRequest, background: BackgroundTasks):
    require_mail()
    queue_email(background, body.email, "verify")
    return {"detail": "如果邮箱可以接收验证邮件，我们将发送链接，请稍候并检查垃圾邮件。"}


@router.post("/email/verify")
def verify_email(body: TokenRequest):
    tokens.verify_email(body.token.get_secret_value())
    return {"detail": "邮箱已验证。"}


@router.put("/email", response_model=UserResponse)
def change_email(body: EmailChangeRequest, background: BackgroundTasks,
                 context: auth.AuthContext = Depends(current_account)):
    require_mail()
    user = tokens.change_email(context.user, body.email, body.password.get_secret_value() if body.password else None)
    queue_email(background, body.email, "verify")
    return UserResponse.model_validate(user)


@router.post("/password/forgot", status_code=202)
def forgot_password(body: EmailRequest, background: BackgroundTasks):
    require_mail()
    queue_email(background, body.email, "reset")
    return {"detail": "如果邮箱对应可恢复的账号，我们将发送重置链接，请稍候并检查垃圾邮件。"}


@router.post("/password/reset")
def reset_password(body: ResetPasswordRequest, response: Response):
    tokens.reset_password(body.token.get_secret_value(), body.password.get_secret_value())
    response.delete_cookie(auth.SESSION_COOKIE, path="/")
    response.delete_cookie(auth.CSRF_COOKIE, path="/")
    return {"detail": "密码已重置，请重新登录。"}


def set_oauth_cookie(response: Response, browser: str) -> None:
    response.set_cookie(oauth.OAUTH_COOKIE, browser, max_age=600, httponly=True, samesite="lax",
                        secure=settings.APP_ENV == "production" or settings.PUBLIC_BASE_URL.startswith("https://"),
                        path="/api/auth/oauth/github")


@router.get("/oauth/github/start")
def github_start(request: Request):
    auth.rate_limit(request)
    url, browser = oauth.start_github()
    response = RedirectResponse(url, status_code=302)
    set_oauth_cookie(response, browser)
    return response


@router.post("/oauth/github/link")
def github_link(response: Response, context: auth.AuthContext = Depends(current_account)):
    if not context.cookie_authenticated:
        raise auth.AuthError(400, "请在浏览器登录后关联 GitHub。")
    url, browser = oauth.start_github(context)
    set_oauth_cookie(response, browser)
    return {"url": url}


@router.get("/oauth/github/callback")
async def github_callback(request: Request, state: str = Query(min_length=16, max_length=256, pattern=r"^[A-Za-z0-9_-]+$"),
                          code: str | None = Query(default=None, min_length=1, max_length=1024),
                          error: str | None = Query(default=None, max_length=128)):
    oauth.require_github()
    await run_in_threadpool(auth.rate_limit, request)
    flow = await run_in_threadpool(oauth.consume_state, state, request.cookies.get(oauth.OAUTH_COOKIE))
    if flow["user_id"] is not None:
        context = await run_in_threadpool(auth.authenticate, request)
        if not context.cookie_authenticated or context.sid_hash != flow["session_hash"]:
            raise auth.AuthError(409, "关联期间登录账号已改变，请重新发起关联。")
    if error or not code:
        raise auth.AuthError(400, "第三方授权已取消，请重新发起登录。")
    identity = await oauth.github_identity(code, flow["verifier"])
    user, linked = await run_in_threadpool(oauth.resolve_account, identity, flow)
    response = RedirectResponse("/account.html#signed-in", status_code=303)
    response.delete_cookie(oauth.OAUTH_COOKIE, path="/api/auth/oauth/github")
    if not linked:
        user, token, csrf = await run_in_threadpool(auth.create_session, user.id)
        set_login_cookies(response, token, csrf)
    return response
