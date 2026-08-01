@echo off
setlocal
cd /d "%~dp0"
title Colo Image Ref

echo.
echo ========================================
echo            COLO IMAGE REF
echo ========================================
echo.

where node >nul 2>&1
if errorlevel 1 goto node_missing

node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)"
if errorlevel 1 goto node_old

where ffmpeg >nul 2>&1
if errorlevel 1 goto ffmpeg_missing

echo Starting Colo Image Ref...
echo Your browser will open automatically.
echo.
echo Keep this window open while you use the application.
echo To stop the application, close this window or press Ctrl+C.
echo.

start "" powershell.exe -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:4780'"
node server.js

if errorlevel 1 goto start_failed
goto end

:node_missing
echo ERROR: Node.js is not installed.
echo.
echo Open USER-GUIDE.md and follow section 4.1.
echo Install the LTS version of Node.js.
echo Then double-click this file again.
goto wait

:node_old
echo ERROR: Your Node.js version is too old.
echo.
echo Colo Image Ref requires Node.js version 22 or later.
echo Open USER-GUIDE.md and follow section 4.1.
echo Then double-click this file again.
goto wait

:ffmpeg_missing
echo ERROR: FFmpeg is not installed or Windows cannot find it.
echo.
echo Open USER-GUIDE.md and follow section 4.3.
echo Then double-click this file again.
goto wait

:start_failed
echo.
echo ERROR: Colo Image Ref could not start.
echo.
echo Another application can be using port 4780.
echo Read section 10 of USER-GUIDE.md for help.
goto wait

:wait
echo.
pause

:end
endlocal
