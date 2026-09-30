@echo off
setlocal enabledelayedexpansion
title Nubra Trading Terminal - Launcher

REM ============================================================
REM  Nubra Trading Terminal launcher
REM  Start / Stop the dev server (tsx server.ts, port 3000)
REM ============================================================

cd /d "%~dp0"

set "PORT=3000"

:menu
cls
echo.
echo  ==============================================
echo    NUBRA TRADING TERMINAL - LAUNCHER
echo  ==============================================
echo.
call :server_status
echo.
echo  ----------------------------------------------
echo    [1] Start server   (open http://localhost:%PORT%)
echo    [2] Stop server
echo    [3] Restart server
echo    [4] Open dashboard in browser
echo    [5] Exit
echo  ----------------------------------------------
echo.
set /p choice="Select option [1-5]: "
if defined choice set "choice=%choice:~0,1%"

if "%choice%"=="1" goto start
if "%choice%"=="2" goto stop
if "%choice%"=="3" goto restart
if "%choice%"=="4" goto openbrowser
if "%choice%"=="5" exit /b 0
echo Invalid option. Press any key...
pause >nul
goto menu

:start
call :kill_server quiet
echo Starting server...
echo (A new window will open. Keep it open while trading.)
start "Nubra Terminal Server" cmd /k "cd /d ""%~dp0"" && npm run dev"
echo Waiting for server to come up...
call :wait_ready
echo Server is UP.
echo.
start "" http://localhost:%PORT%
echo Press any key to return to menu...
pause >nul
goto menu

:restart
call :kill_server quiet
echo Server stopped. Starting again...
ping -n 3 127.0.0.1 >nul
goto start

:stop
call :kill_server
echo Press any key to return to menu...
pause >nul
goto menu

:openbrowser
start "" http://localhost:%PORT%
goto menu

REM ---- helpers ----

:kill_server
REM Kill anything listening on our port via netstat first, then match npm/node
set "killed=0"
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%PORT% .*LISTENING"') do (
    taskkill /F /PID %%p >nul 2>&1 && set "killed=1"
)
if not "%killed%"=="1" (
    for /f %%p in ('wmic process where "name='node.exe'" get processid 2^>nul ^| findstr /r "[0-9]"') do (
        taskkill /F /PID %%p >nul 2>&1
    )
)
if /i not "%~1"=="quiet" (
    if "%killed%"=="1" (
        echo Server stopped.
    ) else (
        echo No running server found.
    )
)
ping -n 2 127.0.0.1 >nul
exit /b 0

:server_status
set "up=0"
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%PORT% .*LISTENING"') do set "up=1"
if "%up%"=="1" (
    echo    STATUS : RUNNING  ^(port %PORT%^)
) else (
    echo    STATUS : STOPPED
)
exit /b 0

:wait_ready
set /a tries=0
:waitloop
set "up=0"
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%PORT% .*LISTENING"') do set "up=1"
if "%up%"=="1" exit /b 0
set /a tries+=1
if %tries% geq 30 (
    echo Server failed to start within ~30s. Check the server window for errors.
    exit /b 1
)
ping -n 2 127.0.0.1 >nul
goto waitloop