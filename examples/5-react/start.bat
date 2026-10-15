@echo off
rem Transcribe API - React demo. Double-click this file to start it.
rem   1. "npm install" (only the first time)
rem   2. "npm run dev" = backend (port 3001) + Vite (port 5173)
rem   3. your browser opens http://localhost:5173
rem Close this window or press Ctrl+C to stop both.
setlocal
cd /d "%~dp0"
title Transcribe API - React demo

rem "||" runs the next part when the command fails (any non-zero exit code).
where node >nul 2>nul || goto :no_node

if not exist "..\.env" echo WARNING: ..\.env was not found. Add TRANSCRIBE_API_URL and TRANSCRIBE_API_KEY to it.

if exist "node_modules\vite\bin\vite.js" goto :run
echo Installing packages - first run only, this takes about a minute...
call npm install || goto :install_failed

:run
rem Vite opens the browser when it is ready.
set OPEN_BROWSER=1
echo.
echo Starting the demo. The browser opens http://localhost:5173 in a moment.
echo Press Ctrl+C to stop.
echo.
call npm run dev
pause
exit /b 0

:no_node
echo Node.js is not installed. Download it from https://nodejs.org and try again.
pause
exit /b 1

:install_failed
echo npm install failed. Check your internet connection and try again.
pause
exit /b 1
