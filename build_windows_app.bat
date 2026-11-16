@echo off
setlocal
chcp 65001 >nul
title Сборка нативного приложения RampPulse для Windows
cd /d "%~dp0"

echo =======================================================
echo   Сборка RampPulse в автономный .EXE файл для Windows
echo =======================================================
echo.

where py >nul 2>nul
if not errorlevel 1 (
    set "PY=py -3"
) else (
    set "PY=python"
)

echo [1/3] Проверка PyInstaller и зависимостей...
%PY% -m pip install --disable-pip-version-check PyInstaller PySide6 requests websocket-client

echo.
echo [2/3] Компиляция автономного приложения RampPulse.exe...
%PY% -m PyInstaller --noconfirm --clean --onefile --windowed ^
    --name "RampPulse" ^
    --icon "src-tauri/icons/icon.ico" ^
    --add-data "data;data" ^
    run_native.py

if errorlevel 1 (
    echo.
    echo [ОШИБКА] Не удалось собрать приложение.
    pause
    exit /b 1
)

echo.
echo =======================================================
echo   [ГОТОВО!] Приложение собрано:
echo   dist\RampPulse.exe
echo =======================================================
echo.
pause
