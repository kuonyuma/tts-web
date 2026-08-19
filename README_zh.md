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

**TTS Web** 是一个轻量、高效、极简的现代文字转语音（Text-to-Speech）全栈 Web 应用。

项目采用开箱即用的多 TTS 引擎架构：默认提供**完全免费、免 API Key 的 Microsoft Edge TTS**（支持日语、中文、英语等多种高品质发音人）；同时支持用户以**自带密钥（BYOK - Bring Your Own Key）** 模式使用 **Google Gemini 2.5 Flash** 极高拟真度的多语言语音合成能力。

---

## ✨ 核心特性

- 🎙️ **多模型 & 多语种发音人支持**：
  - **Edge TTS（默认・完全免费）**：无需任何 API Key，即开即用。内置微软高质量神经网络音色（日语：七海 Nanami / 圭太 Keita；中文：晓晓 Xiaoxiao / 云希 Yunxi；英语：Ava / Andrew 等）。
  - **Gemini TTS（高拟真・BYOK）**：基于 Google Gemini 2.5 Flash（`gemini-2.5-flash-preview-tts`），提供 8 种高表现力发音人（`Kore`、`Aoede`、`Leda`、`Zephyr`、`Puck`、`Charon`、`Fenrir`、`Orus`）。
- 🔑 **BYOK 隐私与零信任安全架构**：
  - 用户的自定义 Gemini API Key **仅保存在浏览器本地 `localStorage` 中**。
  - 发起请求时经 Header 传入后端内存临时使用，**绝不写入数据库、绝不持久化落盘、绝不打印到服务器日志**。
- 👥 **免登录多租户隔离**：
  - 基于浏览器自动生成的 `Client-UUID` 进行租户隔离。历史记录查看与删除严格防越权（IDOR 保护）；
  - 底层共享全局 `SHA-256` 统一音频缓存，兼顾隐私安全与算力复用。
- 🛡️ **Edge 并发与防封控制**：
  - 内置 `asyncio.Semaphore` 信号量（默认并发限制为 3），自动平滑排队，彻底杜绝服务器出口 IP 被微软风控限流。
- 💾 **双层智能缓存加速**：
  - L1 内存 LRU 缓存（`cachetools`）+ L2 磁盘音频缓存（`SHA-256(text + voice + engine)`），重复合成内容毫秒级极速响应。
- ⚡ **零构建极简前端**：
  - 原生 HTML5 / CSS3 / Vanilla JavaScript 开发，无 Node.js / Webpack / Vite 复杂构建工具链。由 FastAPI 直接一体化托管提供服务。
- 🎵 **全功能现代音频播放器**：
  - 支持播放进度实时拖拽预览、循环倍速调节（0.75x ~ 2.0x）、音量滑块调节与 MP3 录音一键下载导出。
- 📜 **播放历史记录**：
  - 支持历史重听、点击文本一键回填至输入框、单条删除与全量清空。
- 📦 **现代化工程与容器化**：
  - 原生支持 Astral `uv` 极速包管理器（`pyproject.toml` + `uv.lock`），提供开箱即用的 Docker 与 Docker Compose 部署方案。

---

## 🏗️ 系统架构设计

```text
┌─────────────────────────────────────────────────────────────────────────┐
│                           Client Browser                                │
│  - 原生 Vanilla JS + CSS3 + HTML5 (无需 Node.js 编译构建)               │
│  - LocalStorage: Client-UUID, Gemini-API-Key (BYOK), 偏好音色           │
│  - 自定义播放器: 倍速 (0.75x~2.0x), 拖拽进度, 音量控制, MP3 一键下载    │
│  - 侧边抽屉: 历史回听, 文本一键回填, 客户端隔离防越权删除               │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │ HTTP (JSON / Audio Stream)
                                     │ Headers: X-Client-ID, X-Gemini-Api-Key
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                       FastAPI Application Server                        │
│  - app/main.py: CORS 跨域配置, 静态资源托管, Lifespan 周期管理          │
│  - app/api/tts.py: 引擎分发, Pydantic 校验, 缓存逻辑调度                │
│  - app/api/history.py: 多租户隔离 SQLite 历史记录接口                   │
│  - app/services/cache_service.py: L1 内存 LRU + L2 磁盘文件缓存         │
│  - app/services/history_service.py: SQLite WAL 模式无锁持久化           │
└──────────────────┬──────────────────────────────────┬───────────────────┘
                   │                                  │
                   ▼                                  ▼
┌──────────────────────────────────────┐ ┌────────────────────────────────┐
│      EdgeTTSEngine (edge-tts)        │ │  GeminiTTSEngine (google-genai)│
│ - 完全免费、免 API Key 即可使用      │ │ - Gemini 2.5 Flash Preview TTS │
│ - asyncio.Semaphore 并发防风控保护   │ │ - Interactions API 异步调用    │
│ - 输出: 直接返回 MP3 二进制流        │ │ - 输出: Base64 PCM 24kHz       │
│ - 发音人: Nanami, Keita, Xiaoxiao... │ │ - pydub + ffmpeg -> MP3 128k   │
└──────────────────────────────────────┘ └────────────────────────────────┘
```

---

## 🚀 快速上手

### 方式 A：Docker Compose 一键部署（推荐）

通过 Docker 快速启动完整服务：

```bash
docker compose up -d
```

打开浏览器访问：
```
http://localhost:8000
```

> **说明**：生成的音频缓存与 SQLite 历史数据将自动持久化挂载至本地 `./backend/app/cache` 目录。

---

### 方式 B：本地开发环境运行（使用 `uv`）

#### 环境准备
- **Python**：`>= 3.13`
- **uv**：[安装 uv 包管理器](https://docs.astral.sh/uv/getting-started/installation/)
- **ffmpeg**：本地运行 Gemini TTS 时必需（用于 PCM 转 MP3）

#### 1. 克隆代码仓库
```bash
git clone https://github.com/kuonyuma/tts-web.git
cd tts-web
```

#### 2. 同步安装依赖
```bash
uv sync
```

#### 3.（可选）配置环境变量
如需在服务端配置默认的 Gemini API Key：
```bash
cp backend/.env.example backend/.env
# 编辑 backend/.env 填入 GEMINI_API_KEY
```
*(若仅使用 Edge TTS 或计划直接在前端页面填入个人 Key，可跳过此步骤)*

#### 4. 启动服务
```bash
uv run uvicorn app.main:app --reload --app-dir backend --port 8000
```

打开浏览器访问 [http://127.0.0.1:8000](http://127.0.0.1:8000)。
API 交互式文档可访问 [http://127.0.0.1:8000/docs](http://127.0.0.1:8000/docs)。

---

## ⚙️ 环境变量与配置项

在 `backend/.env` 中支持配置以下变量：

| 变量名 | 默认值 | 描述 |
| :--- | :--- | :--- |
| `GEMINI_API_KEY` | *(空)* | 可选。服务端默认 Gemini API Key（当请求未携带 BYOK 密钥时回退使用） |
| `EDGE_TTS_MAX_CONCURRENCY` | `3` | Edge TTS 最大并发请求数，防止出口 IP 触发风控限制 |
| `MAX_TEXT_LENGTH` | `1000` | 单次语音合成支持的最大文本字符数限制 |
| `CORS_ORIGINS` | `*` | 允许的 CORS 跨域源（多个以逗号分隔） |

---

## 📡 核心 API 概览

| 路径 | 请求方式 | 说明 |
| :--- | :--- | :--- |
| `/health` | `GET` | 服务健康检查接口 |
| `/api/engines` | `GET` | 获取所有支持的 TTS 引擎及对应发音人列表 |
| `/api/tts/test-key` | `POST` | 验证 Gemini API Key 连通性 |
| `/api/tts` | `POST` | 提交文本并合成语音（返回 `audio/mpeg` MP3 音频流） |
| `/api/tts/{cache_key}` | `GET` | 获取指定缓存指纹的音频文件流 |
| `/api/history` | `GET` | 获取当前客户端的语音合成历史记录列表 |
| `/api/history/{id}` | `DELETE` | 删除当前客户端指定的一条历史记录 |
| `/api/history` | `DELETE` | 清空当前客户端的所有历史记录 |

---

## 🧪 运行测试套件

项目内置自动化端到端测试用例：

```bash
uv run pytest
```

---

## 🔒 安全与隐私保障

1. **零密钥泄露**：用户在前端输入的 API Key 仅保留在浏览器端，不入库、不落盘、不上报日志。
2. **缓存匿名化**：服务端缓存音频文件全部采用哈希指纹（`SHA-256`）命名，文件名不包含原始明文文本。
3. **租户防越权**：所有历史记录读写均强制绑定客户端 UUID，并于数据库查询层进行安全隔离校验。

---

## 📄 开源协议

本项目基于 [MIT License](LICENSE) 开源协议分发与使用。
