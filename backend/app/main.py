import logging
import errno
import sqlite3
import traceback
from pathlib import Path
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.exceptions import RequestValidationError
from starlette.concurrency import run_in_threadpool
from starlette.responses import JSONResponse

from app.api.tts import router as tts_router
from app.api.explain import router as explain_router
from app.api.history import router as history_router
from app.services.history_service import init_db
from app.config import settings
from app.api.limits import RequestLimits
from app.services.cache_service import cleanup_cache
from app.services.errors import TTSException, TTSConfigError, TTSTimeoutError, TTSUpstreamError, TTSBusyError, StorageFullError

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger("japanese-tts-web")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan: initialize resources on startup."""
    await run_in_threadpool(init_db)
    await run_in_threadpool(cleanup_cache)
    logger.info("Application startup complete.")
    yield
    logger.info("Application shutdown.")


app = FastAPI(
    title="TTS Web",
    description="Simple, high-quality multi-engine Text-to-Speech Web application",
    version="0.2.0",
    lifespan=lifespan
)

# CORS wraps API limit errors as well as route responses.
app.add_middleware(RequestLimits)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Cache", "X-Cache-Key", "X-Engine", "X-Request-ID"],
)


@app.exception_handler(RequestValidationError)
async def invalid_request(request, exc):
    # Pydantic error.input can contain unpaired surrogates or an API key.
    errors = [{"type": e["type"], "loc": e["loc"], "msg": e["msg"]} for e in exc.errors()]
    return JSONResponse({"detail": errors}, status_code=422)


@app.exception_handler(TTSException)
async def provider_failure(request, exc):
    code, detail = 502, "连接语音或讲解服务失败，请稍后重试。"
    if isinstance(exc, TTSConfigError):
        code, detail = 400, str(exc)
    elif isinstance(exc, TTSBusyError):
        code, detail = 503, "服务繁忙，请稍后重试。"
    elif isinstance(exc, TTSTimeoutError):
        detail = "语音或讲解服务请求超时，请稍后重试。"
    elif isinstance(exc, TTSUpstreamError):
        detail = f"上游服务暂时不可用（上游返回 {exc.status_code}），请检查 API Key 或稍后重试。"
    logger.warning("request_id=%s service_error path=%s type=%s upstream_status=%s", getattr(request.state, "request_id", "-"), request.url.path, type(exc).__name__, getattr(exc, "status_code", None))
    return JSONResponse({"detail": detail}, status_code=code)


async def storage_failure(request, exc):
    full = isinstance(exc, StorageFullError) or getattr(exc, "errno", None) == errno.ENOSPC or getattr(exc, "sqlite_errorcode", None) == sqlite3.SQLITE_FULL
    reason = str(exc) if isinstance(exc, StorageFullError) else None
    logger.error("request_id=%s storage_error path=%s type=%s errno=%s sqlite_code=%s reason=%s", getattr(request.state, "request_id", "-"), request.url.path, type(exc).__name__, getattr(exc, "errno", None), getattr(exc, "sqlite_errorcode", None), reason)
    return JSONResponse({"detail": "存储空间不足，请联系管理员。" if full else "存储服务暂时不可用，请稍后重试。"}, status_code=507 if full else 503)


app.add_exception_handler(sqlite3.Error, storage_failure)
app.add_exception_handler(OSError, storage_failure)
app.add_exception_handler(StorageFullError, storage_failure)


@app.exception_handler(Exception)
async def unexpected_failure(request, exc):
    # Log code locations, not exception strings that may contain upstream secrets.
    logger.error("unexpected_error path=%s type=%s stack=%s", request.url.path, type(exc).__name__, "".join(traceback.format_tb(exc.__traceback__)))
    return JSONResponse({"detail": "服务器内部错误，请稍后重试。"}, status_code=500)

# Health check route
@app.get("/health", summary="Health check endpoint", tags=["system"])
async def health_check():
    return {"status": "ok"}

# Register API routes
app.include_router(tts_router)
app.include_router(explain_router)
app.include_router(history_router)

# Mount frontend static files
frontend_dir = Path(__file__).resolve().parent.parent.parent / "frontend"
if frontend_dir.exists():
    app.mount("/", StaticFiles(directory=str(frontend_dir), html=True), name="frontend")
    logger.info("Mounted frontend static files from %s", frontend_dir)
else:
    logger.warning("Frontend directory not found at %s", frontend_dir)
