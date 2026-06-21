@echo off
setlocal EnableDelayedExpansion

cd /d "%~dp0"

echo ============================================
echo   gamyy-core Windows Environment Installer
echo ============================================
echo.

REM ---------- 1. Check Node.js ----------
echo [1/4] Checking Node.js...
set NODE_OK=0
where node >nul 2>&1
if not errorlevel 1 (
    for /f "tokens=*" %%i in ('node -v 2^>nul') do set NODE_VER=%%i
    set NODE_VER_NUM=!NODE_VER:v=!
    for /f "tokens=1 delims=." %%a in ("!NODE_VER_NUM!") do set NODE_MAJOR=%%a
    if !NODE_MAJOR! GEQ 18 (
        set NODE_OK=1
        echo     Found Node.js !NODE_VER! ^(OK, ^>=18^)
    ) else (
        echo     Node.js !NODE_VER! too old, need ^>=18
    )
) else (
    echo     Node.js not found
)

if "!NODE_OK!"=="0" (
    echo.
    echo [2/4] Installing Node.js 22 LTS...

    set WINGET_OK=0
    where winget >nul 2>&1
    if not errorlevel 1 (
        echo     Trying winget...
        winget install OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements
        if not errorlevel 1 set WINGET_OK=1
    )

    if "!WINGET_OK!"=="0" (
        echo     winget unavailable or failed, downloading MSI installer...
        set "MSI_URL=https://nodejs.org/dist/v22.14.0/node-v22.14.0-x64.msi"
        set "MSI_PATH=%TEMP%\nodejs-installer.msi"
        echo     URL: !MSI_URL!
        curl -L --fail -o "!MSI_PATH!" "!MSI_URL!"
        if errorlevel 1 (
            echo.
            echo     [ERROR] Download failed. Please install Node.js 22 LTS manually from:
            echo             https://nodejs.org/en/download
            echo     Then re-run this script.
            pause
            exit /b 1
        )
        echo     Running silent install...
        msiexec /i "!MSI_PATH!" /qn /norestart
        if errorlevel 1 (
            echo     Silent install failed, launching GUI installer...
            msiexec /i "!MSI_PATH!"
        )
        del "!MSI_PATH!" >nul 2>&1
    )

    echo.
    echo     Node.js installed.
    echo     IMPORTANT: PATH only refreshes in a NEW terminal window.
    echo     Please CLOSE this window and double-click this script again
    echo     to continue.
    echo.
    pause
    exit /b 0
)

echo.

REM ---------- 3. node_modules / native modules ----------
echo [3/4] Checking dependencies and native modules...
if not exist "node_modules" (
    echo     node_modules missing, running npm install...
    call npm install --omit=dev --legacy-peer-deps
    if errorlevel 1 (
        echo     [ERROR] npm install failed. Check network and retry.
        pause
        exit /b 1
    )
) else (
    echo     node_modules exists
    echo     Rebuilding native modules for current Node version...
    call npm rebuild better-sqlite3 sqlite3
    if errorlevel 1 (
        echo     [WARN] rebuild had issues. If start fails with NODE_MODULE_VERSION mismatch,
        echo            run: npm install --omit=dev --legacy-peer-deps
    )
)

echo.

REM ---------- 4. Port 3000 ----------
echo [4/4] Checking port 3000...
netstat -ano | findstr ":3000 " | findstr "LISTENING" >nul
if not errorlevel 1 (
    echo     [WARN] Port 3000 is already in use, start-windows.bat will fail.
    echo     Current occupant:
    netstat -ano | findstr ":3000 " | findstr "LISTENING"
) else (
    echo     Port 3000 is available
)

echo.
echo ============================================
echo   Install complete!
echo   Next: double-click start-windows.bat
echo   Then open browser: http://localhost:3000
echo ============================================
echo.
pause
endlocal
