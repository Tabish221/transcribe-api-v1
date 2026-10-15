@echo off
rem Double-click to transcribe ..\sample\clip.mp3 with PHP.
rem Or drag an .mp3 file onto this file.
rem Or in a terminal:  run.bat C:\path\to\call.mp3 --language=en
rem Change PHP below if your php.exe is somewhere else.
if not defined PHP set "PHP=C:\xampp\php\php.exe"
"%PHP%" "%~dp0transcribe.php" %*
set "RESULT=%ERRORLEVEL%"
echo.
pause
exit /b %RESULT%
