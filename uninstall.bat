@echo off
chcp 65001 >nul
title hermes链接浏览器助手 - 卸载
echo ============================================
echo   hermes链接浏览器助手 - 卸载
echo ============================================
echo.
cd /d "%~dp0"

where python >nul 2>nul
if %errorlevel% neq 0 (
    echo [错误] 未检测到 Python
    pause
    exit /b 1
)

python uninstall.py

echo.
pause
