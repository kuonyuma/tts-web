import hashlib
import asyncio
import secrets
import time
from contextlib import asynccontextmanager

from app.config import settings
from app.services.errors import LLMBusyError


_RESERVE_SCRIPT = """
local weight = tonumber(ARGV[1])
for i = 1, #KEYS do
  local current = tonumber(redis.call('GET', KEYS[i]) or '0')
  local limit = tonumber(ARGV[i + 1])
  if current + weight > limit then
    return 0
  end
end
for i = 1, #KEYS do
  redis.call('INCRBY', KEYS[i], weight)
  redis.call('EXPIRE', KEYS[i], tonumber(ARGV[i + 4]))
end
return 1
"""

_RELEASE_LOCK_SCRIPT = """
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
"""


def _redis_client():
    from redis.asyncio import Redis

    return Redis.from_url(
        settings.REDIS_URL,
        encoding="utf-8",
        decode_responses=True,
        socket_connect_timeout=2,
        socket_timeout=2,
        health_check_interval=30,
    )


def _quota_keys(identity: str, now: int) -> tuple[list[str], list[int]]:
    subject = hashlib.sha256(identity.encode("utf-8")).hexdigest()[:32]
    minute = now // 60
    day = now // 86400
    return (
        [
            f"copilot:quota:user-minute:{subject}:{minute}",
            f"copilot:quota:user-day:{subject}:{day}",
            f"copilot:quota:global-day:{day}",
        ],
        [120, 172800, 172800],
    )


async def reserve_copilot_quota(identity: str, weight: int) -> None:
    """Atomically reserve weighted quota; fail closed in configured environments."""
    if not settings.REDIS_URL:
        if settings.APP_ENV in {"development", "test"}:
            return
        raise LLMBusyError("AI 讲解额度服务不可用。")

    try:
        client = _redis_client()
        keys, expirations = _quota_keys(identity, int(time.time()))
        limits = [
            settings.COPILOT_USER_MINUTE_UNITS,
            settings.COPILOT_USER_DAILY_UNITS,
            settings.COPILOT_GLOBAL_DAILY_UNITS,
        ]
        try:
            accepted = await client.eval(
                _RESERVE_SCRIPT, len(keys), *keys, weight, *limits, *expirations
            )
        finally:
            await client.aclose()
    except Exception as exc:
        if isinstance(exc, LLMBusyError):
            raise
        raise LLMBusyError("AI 讲解额度服务不可用。") from None
    if accepted != 1:
        raise LLMBusyError("AI 讲解额度已用完，请稍后再试。")


async def quota_backend_ready() -> bool:
    if not settings.REDIS_URL:
        return settings.APP_ENV in {"development", "test"}
    client = None
    try:
        client = _redis_client()
        return bool(await client.ping())
    except Exception:
        return False
    finally:
        if client is not None:
            try:
                await client.aclose()
            except Exception:
                pass


@asynccontextmanager
async def copilot_distributed_lock(identity: str, explain_key: str):
    """Prevent cross-process duplicate provider calls for one explanation/chat session."""
    if not settings.REDIS_URL:
        if settings.APP_ENV in {"development", "test"}:
            yield
            return
        raise LLMBusyError("AI 讲解协调服务不可用。")

    digest = hashlib.sha256(f"{identity}:{explain_key}".encode("utf-8")).hexdigest()
    key = f"copilot:lock:{digest}"
    token = secrets.token_urlsafe(24)
    client = None
    acquired = False
    deadline = time.monotonic() + settings.LLM_QUEUE_TIMEOUT_SECONDS
    try:
        client = _redis_client()
        while time.monotonic() < deadline:
            acquired = bool(await client.set(
                key, token, nx=True, ex=max(30, int(settings.LLM_TIMEOUT_SECONDS) + 30)
            ))
            if acquired:
                break
            await asyncio.sleep(0.05)
        if not acquired:
            raise LLMBusyError("AI 讲解请求正在处理中，请稍后重试。")
        yield
    except LLMBusyError:
        raise
    except Exception:
        raise LLMBusyError("AI 讲解协调服务不可用。") from None
    finally:
        if acquired and client is not None:
            try:
                await client.eval(_RELEASE_LOCK_SCRIPT, 1, key, token)
            except Exception:
                pass
        if client is not None:
            try:
                await client.aclose()
            except Exception:
                pass
