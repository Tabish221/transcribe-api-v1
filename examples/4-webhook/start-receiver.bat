@echo off
rem Step 1: double-click this file. Keep the window open.
rem It receives the results on http://127.0.0.1:4000/webhook
node "%~dp0receiver.mjs"
echo.
pause
