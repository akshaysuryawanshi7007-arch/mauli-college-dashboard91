@echo off
setlocal enabledelayedexpansion
title Mauli College Dashboard Server

set SUPERADMIN_PASSWORD=SuperAdmin@123
set INITIAL_PASSWORD=Welcome@123
set PORT=3000
set DATA_DIR=%~dp0data

set "NODE_EXE=node"
where node >nul 2>nul
if %errorlevel% neq 0 (
    if exist "C:\Users\aksha\AppData\Local\Programs\cursor\resources\app\resources\helpers\node.exe" (
        set "NODE_EXE=C:\Users\aksha\AppData\Local\Programs\cursor\resources\app\resources\helpers\node.exe"
    ) else (
        echo [!] Node.js was not found. Launching with Python 3 backend instead...
        python "%~dp0server.py"
        pause
        exit /b
    )
)

echo =====================================================================
echo   MAULI COLLEGE OF ENGINEERING ^& TECHNOLOGY, SHEGAON
echo   Centralized Management Dashboard Server
echo =====================================================================
echo   Local Address:      http://localhost:%PORT%
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4 Address"') do (
    set "IP=%%a"
    set "IP=!IP: =!"
    echo   LAN / Wi-Fi Access: http://!IP!:%PORT%
)
echo =====================================================================
echo   Super Admin Demo Password : %SUPERADMIN_PASSWORD%
echo   Default Starting Password : %INITIAL_PASSWORD%
echo =====================================================================
echo.
"%NODE_EXE%" "%~dp0server.js"
pause
