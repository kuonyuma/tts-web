import httpx
import pytest

from app.api.limits import RequestLimits
from app.main import app
from app.services import cache_service, explain_service, history_service, runtime


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
def isolated_storage(tmp_path, monkeypatch):
    """Tests never write to the user's cache/history or call real providers."""
    monkeypatch.setattr(history_service, "DB_PATH", tmp_path / "history.db")
    monkeypatch.setattr(history_service, "_initialized", False)
    monkeypatch.setattr(explain_service, "_initialized", False)
    monkeypatch.setattr(cache_service, "CACHE_DIR", tmp_path / "audio")
    cache_service._memory_cache.clear()
    cache_service._flow_cache.clear()
    runtime._states.clear()
    layer = app.middleware_stack
    while layer is not None:
        if isinstance(layer, RequestLimits):
            layer.reset()
        layer = getattr(layer, "app", None)

    def no_edge_network(*args, **kwargs):
        pytest.fail("Mock edge_tts.Communicate before synthesizing in tests")

    monkeypatch.setattr("edge_tts.Communicate", no_edge_network)
    async def no_http_network(*args, **kwargs):
        pytest.fail("Use httpx.MockTransport or ASGITransport in tests")

    def no_sync_network(*args, **kwargs):
        pytest.fail("Use httpx.MockTransport in tests")

    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", no_http_network)
    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", no_sync_network)
    yield tmp_path
    cache_service._memory_cache.clear()
    cache_service._flow_cache.clear()
    runtime._states.clear()
