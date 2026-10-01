@echo off
setlocal EnableExtensions DisableDelayedExpansion
title Stop TTS Web
pushd "%~dp0" || exit /b 1
set "tts_stop_status=0"
set "tts_stopped=0"

echo Checking TTS Web listeners on port 8000...
for /f "tokens=2,4,5" %%A in ('netstat -ano -p tcp ^| findstr /R /C:":8000 .*LISTENING"') do (
    if "%%B"=="LISTENING" call :stop_process %%C
)

if "%tts_stopped%"=="0" echo No verified TTS Web process was stopped.
popd
call timeout /t 2 /nobreak >nul 2>&1
exit /b %tts_stop_status%

:stop_process
rem IPv4 and IPv6 listeners can belong to the same process.
if defined tts_seen_%~1 exit /b 0
set "tts_seen_%~1=1"

rem Never terminate a listener unless its executable and app directory match.
call pwsh -NoProfile -NonInteractive -File "%~dp0scripts\verify_tts_process.ps1" -ProcessId %~1 -ProjectRoot "%~dp0." >nul 2>&1
if errorlevel 1 (
    echo Skipped PID %~1: could not verify ownership by this project.
    exit /b 0
)

call taskkill /f /pid %~1 >nul 2>&1
if errorlevel 1 (
    echo Failed to stop TTS Web PID %~1.
    set "tts_stop_status=1"
    exit /b 0
)
echo Stopped TTS Web PID %~1.
set "tts_stopped=1"
exit /b 0
