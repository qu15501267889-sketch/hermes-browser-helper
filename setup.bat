@echo off
chcp 65001 >nul
title hermes链接浏览器助手 - 一键安装
echo ============================================
echo   hermes链接浏览器助手 - 一键安装
echo ============================================
echo.

cd /d "%~dp0"

REM 检查 Python
where python >nul 2>nul
if %errorlevel% neq 0 (
    echo [错误] 未检测到 Python，请先安装 Python 3.8+ 并勾选 "Add to PATH"
    pause
    exit /b 1
)

REM 调用部署脚本
python install.py %*

echo.
pause
