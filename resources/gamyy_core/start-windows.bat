@echo off
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found. Please run install-windows.bat first.
    pause
    exit /b 1
)

echo ============================================
echo   gamyy-core Web Management Service
echo   URL: http://localhost:3000
echo   Close this window to stop the service.
echo ============================================
echo.

node web/server.js

echo.
echo Service exited.
pause
