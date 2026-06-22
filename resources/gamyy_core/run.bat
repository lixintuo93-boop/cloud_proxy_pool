@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
title gamyy-core

echo ============================================
echo   gamyy-core
echo ============================================
echo.

REM ============================================================
REM  Step 1: Find or install Node.js
REM ============================================================
set "NODE_CMD="

REM --- Check if node works on PATH ---
node -v >nul 2>&1
if errorlevel 1 goto :node_search_dirs

REM Node is on PATH; capture version and full path
for /f "tokens=*" %%v in ('node -v 2^>nul') do set "NODE_VER=%%v"
for /f "tokens=*" %%p in ('where node 2^>nul') do (
    if "!NODE_CMD!"=="" set "NODE_CMD=%%p"
)
if "!NODE_CMD!"=="" set "NODE_CMD=node"

REM Check major version: only accept 22.x (better-sqlite3 prebuilt for 22)
set "NODE_VER_NUM=!NODE_VER:v=!"
for /f "tokens=1 delims=." %%a in ("!NODE_VER_NUM!") do set "NODE_MAJOR=%%a"
if !NODE_MAJOR! EQU 22 (
    echo [OK] Node.js !NODE_VER! ^(!NODE_CMD!^)
    goto :node_done
)
echo [SKIP] Node.js !NODE_VER! found but need v22, will install 22...

:node_search_dirs
REM --- Check common install directories for v22 ---
echo Searching for Node.js 22...
for %%d in (
    "C:\Program Files\nodejs"
    "C:\Program Files (x86)\nodejs"
) do (
    if not defined NODE_CMD (
        if exist "%%~d\node.exe" (
            for /f "tokens=*" %%v in ('"%%~d\node.exe" -v 2^>nul') do set "NODE_VER=%%v"
            set "NODE_VER_NUM=!NODE_VER:v=!"
            for /f "tokens=1 delims=." %%a in ("!NODE_VER_NUM!") do set "NODE_MAJOR=%%a"
            if !NODE_MAJOR! EQU 22 (
                set "NODE_CMD=%%~d\node.exe"
                set "NODE_DIR=%%~d"
                echo [OK] Node.js !NODE_VER! ^(%%~d^)
            ) else (
                echo [SKIP] Found Node !NODE_VER! at %%~d, need v22
            )
        )
    )
)

REM --- Not found v22? Install ---
if not defined NODE_CMD (
    echo.
    echo Node.js 22 LTS not found. Installing...
    echo.
    call :do_install
    if errorlevel 1 (
        echo.
        echo [FAIL] Installation failed.
        echo Install Node.js 22 from: https://nodejs.org/en/download
        echo Then re-run run.bat
        echo.
        pause
        exit /b 1
    )
)

:node_done
echo.
echo Node: !NODE_VER!
echo Path: !NODE_CMD!

REM ============================================================
REM  Step 2: Find npm and fix PATH
REM ============================================================

REM Derive node directory (if not already set by :node_search_dirs)
if not defined NODE_DIR (
    for %%d in ("!NODE_CMD!") do set "NODE_DIR=%%~dpd"
)

REM Add node dir to PATH NOW (before npm runs so node-gyp can find node)
if defined NODE_DIR (
    set "PATH=!NODE_DIR!;%PATH%"
    echo PATH updated: !NODE_DIR! added
)

REM Locate npm next to node.exe
if exist "!NODE_DIR!\npm.cmd" (
    set "NPM_CMD=!NODE_DIR!\npm.cmd"
) else if exist "!NODE_DIR!\npm" (
    set "NPM_CMD=!NODE_DIR!\npm"
) else (
    set "NPM_CMD=npm"
)

for /f "tokens=*" %%v in ('"!NPM_CMD!" -v 2^>nul') do set "NPM_VER=%%v"
echo [OK] npm: !NPM_VER! ^(!NPM_CMD!^)
echo.

REM ============================================================
REM  Step 3: Dependencies
REM ============================================================
echo [3/5] Dependencies...

REM If previous install was broken (better-sqlite3 crash), clean up
if exist "node_modules" (
    if exist "node_modules\.package-lock.json" (
        echo     Checking node_modules health...
        call "!NODE_CMD!" -e "try{require('better-sqlite3')}catch(e){process.exit(1)}" >nul 2>&1
        if errorlevel 1 (
            echo     [WARN] better-sqlite3 broken, cleaning node_modules...
            rmdir /s /q node_modules >nul 2>&1
        )
    )
)

if not exist "node_modules" (
    echo     Installing dependencies...
    echo.
    call "!NPM_CMD!" install --omit=dev --legacy-peer-deps
    if errorlevel 1 (
        echo.
        echo     [FAIL] npm install failed.
        echo     Try: npm config set registry https://registry.npmmirror.com
        echo     Then re-run run.bat
        echo.
        pause
        exit /b 1
    )
    echo.
    echo     [OK] Dependencies installed.
) else (
    echo     [OK] node_modules exists.
    call "!NPM_CMD!" rebuild better-sqlite3 sqlite3 >nul 2>&1
)
echo.

REM ============================================================
REM  Step 4: Port check
REM ============================================================
echo [4/5] Port 3000...
netstat -ano 2>nul | find ":3000" | find "LISTENING" >nul
if errorlevel 1 (
    echo [OK] Port 3000 available.
) else (
    echo [WARN] Port 3000 is in use:
    netstat -ano 2>nul | find ":3000" | find "LISTENING"
    echo.
    echo Stop the existing process or change port in config.
    echo.
    pause
    exit /b 1
)
echo.

REM ============================================================
REM  Step 5: Launch
REM ============================================================
echo [5/5] Starting...
echo.
echo ============================================
echo   URL: http://localhost:3000
echo   Press Ctrl+C to stop
echo ============================================
echo.

"!NODE_CMD!" web/server.js

echo.
echo Service stopped.
pause
exit /b 0


REM ============================================================
REM  Install Node.js subroutine
REM ============================================================
:do_install

REM === Always prefer MSI for guaranteed Node 22 LTS ===

:install_msi
echo Downloading Node.js 22 LTS installer...
set "MSI_URL=https://nodejs.org/dist/v22.14.0/node-v22.14.0-x64.msi"
set "MSI_FILE=%TEMP%\node-v22.14.0-x64.msi"

REM Delete old download if exists
del "%MSI_FILE%" 2>nul

REM Try PowerShell first, then curl
echo Trying PowerShell download...
powershell -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '%MSI_URL%' -OutFile '%MSI_FILE%' -UseBasicParsing" 2>nul

if not exist "%MSI_FILE%" (
    echo Trying curl...
    curl -L -o "%MSI_FILE%" "%MSI_URL%" 2>nul
)

if not exist "%MSI_FILE%" (
    echo.
    echo [FAIL] Could not download Node.js installer.
    echo Download manually from: https://nodejs.org/en/download
    echo Save to: %MSI_FILE%
    echo Then re-run run.bat
    echo.
    exit /b 1
)

echo Running installer...
msiexec /i "%MSI_FILE%" /qn /norestart 2>nul
if errorlevel 1 (
    echo Silent mode failed, launching GUI installer...
    msiexec /i "%MSI_FILE%"
    echo.
    echo After installation completes, re-run run.bat
    echo.
    pause
)

REM Clean up
del "%MSI_FILE%" 2>nul

REM Locate node.exe
for %%d in (
    "C:\Program Files\nodejs"
    "C:\Program Files (x86)\nodejs"
) do (
    if not defined NODE_CMD (
        if exist "%%~d\node.exe" (
            set "NODE_CMD=%%~d\node.exe"
            set "NODE_DIR=%%~d"
        )
    )
)

if defined NODE_CMD (
    for /f "tokens=*" %%v in ('"!NODE_CMD!" -v 2^>nul') do set "NODE_VER=%%v"
    echo [OK] Node.js !NODE_VER! installed.
    exit /b 0
)

echo [FAIL] Installed but cannot find node.exe.
echo Look in: "C:\Program Files\nodejs"
exit /b 1
