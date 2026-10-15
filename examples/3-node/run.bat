@echo off
rem Double-click to transcribe ..\sample\clip.mp3 with Node.js.
rem Or drag an .mp3 file onto this file.
rem Or in a terminal:  run.bat C:\path\to\call.mp3 --language en
rem                    run.bat C:\path\to\call.mp3 --engine cloud --wait
node "%~dp0transcribe.mjs" %*
set "RESULT=%ERRORLEVEL%"
echo.
pause
exit /b %RESULT%
