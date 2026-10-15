@echo off
rem Step 2: double-click this file (the receiver must be running).
rem Uploads ..\sample\clip.mp3, or the .mp3 file you drag onto this file.
node "%~dp0send.mjs" %*
set "RESULT=%ERRORLEVEL%"
echo.
pause
exit /b %RESULT%
