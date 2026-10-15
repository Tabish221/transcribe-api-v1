@echo off
rem Builds the cPanel upload zip and the n8n node package into the dist folder.
rem Double-click this file, or run it from a command prompt.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0package-server.ps1" -IncludeN8n %*
echo.
pause
