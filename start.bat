@echo off
chcp 65001 >nul
title TTS Web (Japanese TTS)
cd /d "%~dp0"

echo ===================================================
echo   TTS Web 本地服务正在启动...
echo   本地地址: http://127.0.0.1:8000
echo   使用完毕后，直接关闭本窗口即可停止服务。
echo ===================================================

start "" powershell -NoProfile -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:8000'"
where uv >nul 2>nul
if %errorlevel% equ 0 (
    uv run uvicorn app.main:app --app-dir backend --port 8000
) else if exist ".venv\Scripts\python.exe" (
    ".venv\Scripts\python.exe" -m uvicorn app.main:app --app-dir backend --port 8000
) else (
    echo [错误] 未找到 uv 且未找到 .venv 虚拟环境，请先初始化环境。
    pause
)
