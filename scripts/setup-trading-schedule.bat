@echo off
REM setup-trading-schedule.bat — Create Windows Task Scheduler tasks
REM for daily auto-trading (8:55 AM start, 3:40 PM stop, Mon-Fri)
REM Run as Administrator: right-click > Run as administrator

echo ============================================
echo  Nubra Trading Terminal - Schedule Setup
echo ============================================
echo.

REM Get the project directory
set "PROJECT_DIR=%~dp0.."
set "NODE_EXE=node"

echo Project: %PROJECT_DIR%
echo.

REM Create START task (8:55 AM IST, Mon-Fri)
echo Creating START task (8:55 AM Mon-Fri)...
schtasks /create /tn "Nubra-Trading-Start" ^
  /tr "cmd /c cd /d \"%PROJECT_DIR%\" && %NODE_EXE% scripts/start-trading.js" ^
  /sc weekly /d MON,TUE,WED,THU,FRI ^
  /st 08:55 ^
  /f
if %ERRORLEVEL% neq 0 (
    echo ERROR: Failed to create START task. Run as Administrator.
    pause
    exit /b 1
)

REM Create STOP task (3:40 PM IST, Mon-Fri)
echo Creating STOP task (3:40 PM Mon-Fri)...
schtasks /create /tn "Nubra-Trading-Stop" ^
  /tr "cmd /c cd /d \"%PROJECT_DIR%\" && %NODE_EXE% scripts/stop-trading.js" ^
  /sc weekly /d MON,TUE,WED,THU,FRI ^
  /st 15:40 ^
  /f
if %ERRORLEVEL% neq 0 (
    echo ERROR: Failed to create STOP task. Run as Administrator.
    pause
    exit /b 1
)

echo.
echo ============================================
echo  Schedule created successfully!
echo ============================================
echo.
echo  START: 8:55 AM Mon-Fri (Nubra-Trading-Start)
echo  STOP:  3:40 PM Mon-Fri (Nubra-Trading-Stop)
echo.
echo  Strategy: bollinger_band_reversal (PGHO validated)
echo  Mode: PAPER (change paperMode in start-trading.js for live)
echo.
echo  To verify:  schtasks /query /tn "Nubra-Trading-Start"
echo  To remove:  schtasks /delete /tn "Nubra-Trading-Start" /f
echo              schtasks /delete /tn "Nubra-Trading-Stop" /f
echo  Logs at:    %%TEMP%%\mvf-trading.log
echo.
pause
