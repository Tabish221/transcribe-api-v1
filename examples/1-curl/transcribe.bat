@echo off
rem Double-click this file to transcribe ..\sample\clip.mp3
rem Or drag an .mp3 file onto this file.
rem Or run it in a terminal:  transcribe.bat C:\path\to\call.mp3 -Language en
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0transcribe.ps1" %*
set "RESULT=%ERRORLEVEL%"
echo.
pause
exit /b %RESULT%
