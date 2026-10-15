@echo off
rem Double-click to transcribe ..\sample\clip.mp3 with Python.
rem Or drag an .mp3 file onto this file.
rem Or in a terminal:  run.bat C:\path\to\call.mp3 --language en
rem The first run installs the packages from requirements.txt (requests, flask).
setlocal
set "RESULT=1"

rem "py" is the Python launcher from python.org. Plain "python" may be the Microsoft Store stub.
set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY (where python >nul 2>nul && set "PY=python")
if not defined PY goto nopython
%PY% --version >nul 2>nul || goto nopython

%PY% -m pip install --quiet --disable-pip-version-check -r "%~dp0requirements.txt" || goto end
%PY% "%~dp0transcribe.py" %*
set "RESULT=%ERRORLEVEL%"
goto end

:nopython
echo Python was not found.
echo Install it from https://www.python.org/downloads/ (tick "Add python.exe to PATH"),
echo then run this file again.

:end
echo.
pause
exit /b %RESULT%
