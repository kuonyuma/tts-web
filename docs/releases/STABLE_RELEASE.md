# Stable release deployment

This release preserves the existing TTS, history, explanation and chat features. Deploy one application process and one replica per cache/database directory. The in-process concurrency, request limits and same-key coordination assume that model. Redis is not required.

## Installation and configuration

- Install the locked dependencies: `uv sync --frozen --dev` for development; the Docker image installs runtime dependencies at build time.
- Compose binds to `127.0.0.1:8000`. Put an HTTPS reverse proxy in front when making it public. Do not expose the container directly while relying on proxy authentication.
- All environment names use uppercase. Local Python reads `backend/.env`. Compose reads the root `.env`; to use the backend file, run `docker compose --env-file backend/.env up -d --build`.
- `HOST` and `PORT` were never read by the app. Use uvicorn `--host` / `--port` or Compose's port mapping.
- Public users supply their own Gemini key through the existing settings dialog. A configured `GEMINI_API_KEY` is only used when the request also supplies a valid `X-Server-Key-Token`, matching `SERVER_KEY_ACCESS_TOKEN` (at least 32 characters). Keep this token at an authenticated reverse proxy, strip incoming copies before adding it, and restrict access there. Do not put it in frontend JavaScript or distribute it to anonymous users. BYOK takes priority.
- Every history, synthesis, replay and explanation request must carry a valid `X-Client-ID` (1–128 ASCII letters, digits, `_` or `-`; `default` is forbidden). The existing browser generates this automatically. This is browser-scoped storage, not an account authentication system. Do not use it to store confidential content. Audio cache keys remain shared and deterministic.

## Resource limits and error behavior

Defaults are in `backend/.env.example`; Compose passes all supported settings through.

| Protection | Default / behavior |
| --- | --- |
| Text | 1–1000 Unicode characters; configured limits also reach the browser |
| Whole synthesis / explanation / key-check deadline | 30 seconds, including provider queueing; browser deadline adds 15 seconds for transport |
| Provider concurrency | Edge 3, Gemini 3 (TTS, explanation and key-check share this pool) |
| Queue / admitted API requests | 5 second queue deadline; at most 16 admitted requests |
| API body | 16 KiB, including unknown fields and chunked bodies; 10 second receive deadline |
| Request rate | 120 per connected IP per minute; 600 globally; changing client ID does not bypass it |
| Audio cache | 512 MiB / 1000 entries / 7 days; oldest files evicted; 64 MiB disk reserve |
| Single audio / memory cache | 16 MiB MP3; audio and timeline LRUs each have a 32 MiB ceiling |
| Persistent SQLite data | 128 MiB main database; 10,000 history rows and 1,000 explanations; existing records are preserved at quota |
| SQLite write lock | 0.5 second wait; storage work runs outside the event loop |
| Container logs / shutdown | 3 × 10 MiB rotation; 40 seconds stop grace (35 seconds in uvicorn) |

The IP limiter uses the connecting peer, not client-supplied forwarded headers. Behind a proxy, set an appropriate proxy-side per-user/IP limit; the app's global and peer caps still protect resources. Do not configure uvicorn to trust arbitrary Internet `X-Forwarded-For` headers.

Errors retain a JSON `detail` field. Validation is 422; invalid/missing Gemini configuration is 400; unauthorized server-key use is 403; expired cache is 404; oversized body is 413; rate limit is 429; provider failure/timeout is 502; overload or locked storage is 503; full storage/quota is 507. API responses and application logs carry `X-Request-ID` / `request_id`. Raw upstream exception messages, keys and query strings are not logged by the production command. Configure the reverse proxy to redact sensitive headers and query strings too.

There is no automatic retry of Gemini interactions. Repeated concurrent synthesis/explanation requests use one result; repeated submission of the last completed chat question reuses the stored answer. Failed calls can be retried manually. Killing a request locally cannot guarantee that an upstream service has not already charged for it.

At quota, inspect `storage_error` logs, back up the data, and either increase the corresponding capacity or remove records through the existing history UI / an administrator-approved SQLite maintenance operation. Explanation messages remain capped at 60 per record. Cache expiry can make old history audio unavailable; refilling the editor and generating again restores it.

## Upgrade, rollback and recovery

1. Stop the old process/container so there are no concurrent writers. Copy the entire `backend/app/cache` directory (including any SQLite WAL/SHM files) to a separate backup. Record the old image ID/tag and environment configuration.
2. Build the new image and start a single instance. Check `/health`, `/`, `/api/engines`, synthesis with an authorized test key if Gemini is enabled, history replay and an error response. Verify a restart with the persistent volume attached.
3. The new cache hash encoding avoids delimiter collisions. Existing 16-hex cache URLs still replay; new synthesis may generate a new entry. Legacy rows with `client_id='default'` remain in SQLite but are no longer exposed to anonymous requests. Restore their ownership only through an explicit administrator migration with the correct browser ID.
4. On release failure, stop the new container, restore the backed-up data directory and previous image/configuration, then start one instance and repeat the smoke checks. Do not copy a live SQLite database file without its WAL or SQLite's backup API.

## Repeatable checks

```powershell
uv run pytest
node --check frontend/app.js
node scripts/test_frontend.cjs
docker build -t tts-web:stable-candidate .
docker run -d --name tts-offline-check --network none tts-web:stable-candidate
# Once ready, run the health check from inside the network-isolated container:
docker exec tts-offline-check /app/.venv/bin/python -c "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=2).read())"
docker restart tts-offline-check
# Repeat the health check after startup, then remove this disposable container.
docker rm -f tts-offline-check
```

Backend tests use temporary storage and prohibit real provider calls. The browser script needs Node 22+ and Chrome/Chromium (`CHROME_PATH` can select it), uses fixture API responses and deletes only its own fresh browser profile. Install ffmpeg for the real PCM conversion regression test. There is no configured Python lint/type-check job; the frontend has no compilation step.
