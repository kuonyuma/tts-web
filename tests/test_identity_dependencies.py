import pytest
from fastapi import HTTPException

from app.api.dependencies import require_copilot_identity, require_tts_identity
from app.config import settings


@pytest.fixture(params=[
    (require_tts_identity, "需要登录后才能访问个人数据。"),
    (require_copilot_identity, "需要登录后才能使用 AI 讲解。"),
], ids=["tts", "copilot"])
def proxy_identity(request, monkeypatch):
    monkeypatch.setattr(settings, "TTS_STORAGE_MODE", "private")
    monkeypatch.setattr(settings, "COPILOT_AUTH_MODE", "trusted_proxy")
    monkeypatch.setattr(settings, "AUTH_PROXY_SECRET", "s" * 32)
    return request.param


@pytest.mark.anyio
@pytest.mark.parametrize("expected,supplied", [
    ("s" * 32, None),
    ("s" * 32, ""),
    ("s" * 32, "wrong"),
    ("", ""),
    ("short", "short"),
    ("s" * 31, "s" * 31),
], ids=["missing", "empty", "mismatch", "unconfigured", "short", "short-boundary"])
async def test_proxy_identity_rejects_invalid_secret(proxy_identity, monkeypatch, expected, supplied):
    resolve, detail = proxy_identity
    monkeypatch.setattr(settings, "AUTH_PROXY_SECRET", expected)
    with pytest.raises(HTTPException) as error:
        await resolve("browser-client", "user@example.com", supplied)
    assert error.value.status_code == 401
    assert error.value.detail == detail


@pytest.mark.anyio
@pytest.mark.parametrize("user", [None, "", "  ", "a\0b", "a\nb", "a\x7fb"])
async def test_proxy_identity_rejects_empty_or_control_identity(proxy_identity, user):
    resolve, _ = proxy_identity
    with pytest.raises(HTTPException) as error:
        await resolve("browser-client", user, "s" * 32)
    assert error.value.status_code == 401
    assert error.value.detail == "身份信息无效。"


@pytest.mark.anyio
@pytest.mark.parametrize("user,expected", [
    ("user@example.com", "15bfac7fdb4835f2742ebe656304d2269cc37e0e2d8acc905ccb2e37e48cf83e"),
    (" user@example.com ", "15bfac7fdb4835f2742ebe656304d2269cc37e0e2d8acc905ccb2e37e48cf83e"),
    ("用户@example.com", "3258237a3835f5b8057516f2d85f1dbdc907296a4e5dae511be762151db0b92b"),
    (" \t用户@example.com \n", "3258237a3835f5b8057516f2d85f1dbdc907296a4e5dae511be762151db0b92b"),
])
async def test_proxy_identity_preserves_trimmed_utf8_ownership_hash(proxy_identity, user, expected):
    resolve, _ = proxy_identity
    assert await resolve("browser-one", user, "s" * 32) == expected
    assert await resolve("browser-two", user, "s" * 32) == expected


@pytest.fixture(params=[
    (require_tts_identity, "TTS_STORAGE_MODE", "legacy"),
    (require_copilot_identity, "COPILOT_AUTH_MODE", "development"),
], ids=["legacy-tts", "development-copilot"])
def browser_identity(request, monkeypatch):
    resolve, setting, mode = request.param
    monkeypatch.setattr(settings, setting, mode)
    monkeypatch.setattr(settings, "AUTH_PROXY_SECRET", "short")
    return resolve


@pytest.mark.anyio
async def test_browser_identity_modes_normalize_client_without_proxy(browser_identity):
    assert await browser_identity(" client_42-ABC ", "different-user", "wrong") == "client_42-ABC"


@pytest.mark.anyio
@pytest.mark.parametrize("client_id", [None, "", " ", "default", "中文", "a\nb", "x" * 129])
async def test_browser_identity_modes_reject_invalid_client(browser_identity, client_id):
    with pytest.raises(HTTPException) as error:
        await browser_identity(client_id, "user@example.com", "short")
    assert error.value.status_code == 422
    assert error.value.detail == "X-Client-ID must be a non-empty client identifier (not 'default')"


@pytest.mark.anyio
async def test_private_tts_requires_proxy_even_with_development_copilot(monkeypatch):
    monkeypatch.setattr(settings, "TTS_STORAGE_MODE", "private")
    monkeypatch.setattr(settings, "COPILOT_AUTH_MODE", "development")
    monkeypatch.setattr(settings, "AUTH_PROXY_SECRET", "s" * 32)
    with pytest.raises(HTTPException) as error:
        await require_tts_identity("browser-client", None, None)
    assert error.value.status_code == 401
