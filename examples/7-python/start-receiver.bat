@echo off
rem Double-click to start the Flask webhook receiver on http://127.0.0.1:4000/webhook
rem Test it from a second window:  py send_test_webhook.py
rem Press Ctrl+C to stop it.
setlocal
set "RESULT=1"

rem "py" is the Python launcher from python.org. Plain "python" may be the Microsoft Store stub.
set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY (where python >nul 2>nul && set "PY=python")
if not defined PY goto nopython
%PY% --version >nul 2>nul || goto nopython

%PY% -m pip install --quiet --disable-pip-version-check -r "%~dp0requirements.txt" || goto end
%PY% "%~dp0webhook_receiver.py"
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
