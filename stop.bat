@echo off
chcp 65001 >nul
title 停止 TTS Web
cd /d "%~dp0"
echo 正在停止占用 8000 端口的 TTS Web 进程...
for /f "tokens=5" %%a in ('netstat -aon ^^| findstr ":8000" ^^| findstr "LISTENING"') do (
    taskkill /f /pid %%a >nul 2>&1
)
echo 已停止服务。
timeout /t 2 >nul
