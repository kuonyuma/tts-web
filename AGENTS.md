# Repository Guidelines

## Project Structure & Module Organization

The FastAPI application lives in `backend/app`. HTTP routes are grouped in `api/`, Pydantic request and response models in `schemas/`, and TTS, caching, and history logic in `services/`. Provider implementations belong in `backend/app/services/engines/` and should implement the shared base interface. Backend tests are in `backend/tests/`. The browser client is dependency-free and consists of `frontend/index.html`, `frontend/app.js`, and `frontend/style.css`. Root-level Docker files support containerized runs; `README.md` and `DEVELOPMENT.md` document usage and architecture.

## Build, Test, and Development Commands

- `uv sync --dev` installs locked runtime and test dependencies from `uv.lock`.
- `Copy-Item backend/.env.example backend/.env` creates a local configuration file.
- Run dev server:
  - With uv: `uv run uvicorn app.main:app --reload --app-dir backend --port 8000`
  - Direct fallback: `& ".\.venv\Scripts\python.exe" -m uvicorn app.main:app --reload --app-dir backend --port 8000`
- Run backend tests:
  - With uv: `uv run pytest`
  - Direct fallback: `& ".\.venv\Scripts\python.exe" -m pytest backend/tests`
- Run focused test:
  - With uv: `uv run pytest backend/tests/test_api.py -k health`
  - Direct fallback: `& ".\.venv\Scripts\python.exe" -m pytest backend/tests/test_api.py -k health`
- `docker compose up -d --build` builds and starts the containerized application.

> **Environment Note for AI Agents**: If `uv` is not found in your shell PATH or script execution is restricted, do NOT waste turns or tokens diagnosing the system environment or running activation scripts. Directly invoke Python through the existing project virtual environment: `& ".\.venv\Scripts\python.exe" -m <module>`.

## Coding Style & Naming Conventions

Use four-space indentation and PEP 8 conventions for Python. Add type hints to service boundaries and keep route handlers thin by moving provider or storage logic into `services/`. Use `snake_case` for Python functions and modules, `PascalCase` for classes, and `UPPER_SNAKE_CASE` for constants. JavaScript uses `camelCase`; CSS classes use lowercase kebab-case. Match existing formatting because no repository-wide formatter or linter is currently configured.

## Testing Guidelines

Tests use `pytest`, FastAPI `TestClient`, and `unittest.mock` for external TTS calls. Name files `test_*.py` and functions `test_<behavior>`. Cover successful responses, validation boundaries, provider failures, cache/history behavior, and client isolation. Tests must not call live Gemini or Edge services; patch network-facing synthesis functions. Run `uv run pytest` before submitting changes. No numeric coverage threshold is configured.

## Commit & Pull Request Guidelines

Follow the history's Conventional Commit pattern, such as `feat: add voice selector`, `fix: isolate client history`, or `docs: clarify setup`. Keep each commit focused. Pull requests should explain the behavior change, list verification commands, link related issues, and call out configuration changes. Include screenshots for visible frontend changes and never commit `.env`, API keys, generated audio, caches, or virtual environments.
