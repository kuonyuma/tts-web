# TTS Web (v0.2) 🎙️

<p align="center">
  <a href="README.md">English</a> | <a href="README_zh.md">简体中文</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Python-3.13+-3776AB?style=flat-square&logo=python&logoColor=white" alt="Python Version" />
  <img src="https://img.shields.io/badge/FastAPI-0.115+-009688?style=flat-square&logo=fastapi&logoColor=white" alt="FastAPI" />
  <img src="https://img.shields.io/badge/Package%20Manager-uv-DE5FE9?style=flat-square" alt="uv" />
  <img src="https://img.shields.io/badge/Docker-Ready-2496ED?style=flat-square&logo=docker&logoColor=white" alt="Docker" />
  <img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="License" />
</p>

**TTS Web** is a modern, lightweight, and high-performance Text-to-Speech web application. 

It provides an out-of-the-box dual-engine architecture: completely free and keyless **Microsoft Edge TTS** (supporting Japanese, Chinese, English, etc.), alongside high-fidelity **Google Gemini 2.5 Flash TTS** with a client-side **Bring Your Own Key (BYOK)** security design.

---

## ✨ Key Features

- 🎙️ **Dual-Engine & Multi-Voice Support**:
  - **Edge TTS (Default & Free)**: Zero configuration, no API key required. Built-in neural voices (Japanese: Nanami / Keita; Chinese: Xiaoxiao / Yunxi; English: Ava / Andrew).
  - **Gemini TTS (High Fidelity & BYOK)**: Powered by Google Gemini 2.5 Flash (`gemini-2.5-flash-preview-tts`), offering 8 expressive natural voices (`Kore`, `Aoede`, `Leda`, `Zephyr`, `Puck`, `Charon`, `Fenrir`, `Orus`).
- 🔑 **BYOK Privacy & Zero-Trust Security**:
  - User API keys are stored exclusively in the browser's `localStorage`.
  - Keys are sent via request headers and held in server memory only during the ongoing request. **Never written to databases, never persisted to disk, and never logged**.
- 👥 **Multi-Tenant Isolation without Login**:
  - Automatically generates a `Client-UUID` per browser session.
  - History viewing and deletion are tenant-isolated to separate browser records (client UUIDs are not account authentication), while sharing a global `SHA-256` audio cache across users for optimal performance.
- 🛡️ **Edge Concurrency & Anti-Rate-Limit Protection**:
  - Built-in `asyncio.Semaphore` (default concurrency: 3) queues requests smoothly, protecting your server IP from being throttled by Microsoft Edge services.
- 💾 **Double-Layer Smart Caching**:
  - L1 In-Memory LRU (`cachetools`) + L2 Disk File Cache (`SHA-256(text + voice + engine)`). Identical text requests return in milliseconds.
- ⚡ **Zero-Build Minimalist Frontend**:
  - Built with pure HTML5 / CSS3 / Vanilla JavaScript. No Node.js / Webpack / Vite build steps required. Fully packaged and statically served by FastAPI.
- 🎵 **Full-Featured Custom Audio Player**:
  - Interactive playback bar with seek preview, playback speed toggle (0.75x ~ 2.0x), volume control, and one-click MP3 download.
- 📜 **History Management**:
  - Replay past syntheses, click text to refill into the editor, and delete individual records or clear all.
- 📦 **Modern Tooling & Containerization**:
  - Powered by Astral's `uv` package manager (`pyproject.toml` + `uv.lock`) and ready-to-run Docker / Docker Compose configurations.

---

## 🏗️ Architecture

```text
┌─────────────────────────────────────────────────────────────────────────┐
│                           Client Browser                                │
│  - Vanilla JS + CSS3 + HTML5 (Zero Node.js build step)                  │
│  - LocalStorage: Client-UUID, Gemini-API-Key (BYOK), Selected Voice     │
│  - Custom Audio Player: Speed (0.75x~2.0x), Seek, Volume, MP3 Download  │
│  - History Drawer: Replay, text refill, isolated deletion               │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │ HTTP (JSON / Audio Stream)
                                     │ Headers: X-Client-ID, X-Gemini-Api-Key
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                       FastAPI Application Server                        │
│  - app/main.py: CORS, Lifespan, StaticFiles Mount                       │
│  - app/api/tts.py: Engine dispatch, Pydantic validation, Cache Flow     │
│  - app/api/history.py: Tenant-isolated SQLite history endpoints         │
│  - app/services/cache_service.py: L1 Memory LRU + L2 Disk Cache         │
│  - app/services/history_service.py: SQLite DB (WAL Mode)                │
└──────────────────┬──────────────────────────────────┬───────────────────┘
                   │                                  │
                   ▼                                  ▼
┌──────────────────────────────────────┐ ┌────────────────────────────────┐
│      EdgeTTSEngine (edge-tts)        │ │  GeminiTTSEngine (google-genai)│
│ - Free, No Key Required              │ │ - Gemini 2.5 Flash Preview TTS │
│ - asyncio.Semaphore concurrency queue│ │ - Interactions API             │
│ - Output: Direct MP3 Stream          │ │ - Output: Base64 PCM 24kHz     │
│ - Voices: Nanami, Keita, Xiaoxiao... │ │ - async ffmpeg -> MP3 128k   │
└──────────────────────────────────────┘ └────────────────────────────────┘
```

---

For public deployment, limits and recovery, read [Stable release deployment](docs/STABLE_RELEASE.md).

## 🚀 Quick Start

### Option A: Docker Compose (Recommended)

Run the service with a single command:

```bash
docker compose up -d
```

Open your browser and navigate to:
```
http://localhost:8000
```

> **Note**: Audio caches and SQLite history records are automatically persisted in `./backend/app/cache`.

---

### Option B: Local Setup (Using `uv`)

#### Prerequisites
- **Python**: `>= 3.13`
- **uv**: [Install uv](https://docs.astral.sh/uv/getting-started/installation/)
- **ffmpeg**: Required if you use Gemini TTS (for PCM to MP3 conversion)

#### 1. Clone the repository
```bash
git clone https://github.com/kuonyuma/tts-web.git
cd tts-web
```

#### 2. Install dependencies
```bash
uv sync --frozen
```

#### 3. (Optional) Configure environment variables
If you need server-side Gemini credentials, also configure SERVER_KEY_ACCESS_TOKEN as described in the deployment guide:
```bash
cp backend/.env.example backend/.env
# Edit backend/.env and set GEMINI_API_KEY
```
*(If you only use Edge TTS or prefer providing the API Key via the web UI, you can skip this step.)*

#### 4. Run the server
```bash
uv run uvicorn app.main:app --reload --app-dir backend --port 8000
```

Open [http://127.0.0.1:8000](http://127.0.0.1:8000) in your browser. Interactive API documentation is available at [http://127.0.0.1:8000/docs](http://127.0.0.1:8000/docs).

---

## ⚙️ Configuration & Environment Variables

Create or edit `backend/.env`:

| Variable | Default | Description |
| :--- | :--- | :--- |
| `GEMINI_API_KEY` | *(empty)* | Server Gemini key; requires an authorized X-Server-Key-Token |
| `EDGE_TTS_MAX_CONCURRENCY` | `3` | Maximum simultaneous concurrent requests for Edge TTS |
| `MAX_TEXT_LENGTH` | `1000` | Maximum character limit per synthesis request |
| `CORS_ORIGINS` | *(empty; same-origin)* | Allowed CORS origins (comma-separated) |

---

## 📡 API Overview

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/health` | `GET` | Service health status check |
| `/api/engines` | `GET` | List all available TTS engines and voices |
| `/api/tts/test-key` | `POST` | Test Gemini API Key connectivity |
| `/api/tts` | `POST` | Synthesize speech from text (returns `audio/mpeg`) |
| `/api/tts/{cache_key}` | `GET` | Fetch or replay cached audio |
| `/api/history` | `GET` | Retrieve synthesis history for the current client |
| `/api/history/{id}` | `DELETE` | Delete a single history entry |
| `/api/history` | `DELETE` | Clear all history entries for the current client |

---

## 🧪 Testing

Run the automated test suite:

```bash
uv run pytest
```

---

## 🔒 Security & Privacy

1. **No Data Leakage**: User-supplied API keys remain in client browser storage and are never persisted to disk or database.
2. **Audio Cache Privacy**: Generated audio cache keys are derived from hashes (`SHA-256`) and do not expose raw text in filenames.
3. **Multi-Tenant Protection**: Client IDs are passed via request headers and enforced at the database query level to prevent IDOR attacks.

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
