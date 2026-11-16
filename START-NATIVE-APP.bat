@echo off
setlocal
chcp 65001 >nul
title RampPulse - Запуск нативного приложения Windows
cd /d "%~dp0"

echo ========================================================
echo   RampPulse · Нативное приложение (БЕЗ браузера)
echo ========================================================
echo.

where py >nul 2>nul
if not errorlevel 1 (
    set "PY=py -3"
) else (
    set "PY=python"
)

echo [1/2] Проверка зависимостей...
%PY% -m pip install --disable-pip-version-check PySide6 requests websocket-client >nul 2>&1

echo [2/2] Запуск нативного интерфейса диспетчера...
start "" %PY% run_native.py
exit /b 0
