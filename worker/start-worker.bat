@echo off
title Transcribe API worker
cd /d "%~dp0"

where node >nul 2>nul || (echo Node.js 20 or newer is required: https://nodejs.org & goto end)

if not exist node_modules (
  echo Installing dependencies, this happens only once...
  call npm install --omit=dev || goto end
)

if not exist .env (
  copy .env.example .env >nul
  echo Created .env from .env.example - open it, set API_BASE and WORKER_TOKEN, then run this again.
  goto end
)

node worker.js %*

:end
echo.
pause
