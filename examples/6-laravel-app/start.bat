@echo off
rem Starts the Laravel demo on http://127.0.0.1:8000 and opens it in the browser.
rem Close this window (or press Ctrl+C) to stop the server.
cd /d "%~dp0"

set "PHP=C:\xampp\php\php.exe"
if not exist "%PHP%" set "PHP=php"

if not exist "vendor\autoload.php" (
    echo The "vendor" folder is missing. Run "composer install" in this folder first.
    pause
    exit /b 1
)

if not exist ".env" (
    echo No .env file found: copying .env.example. Fill in TRANSCRIBE_API_KEY and TRANSCRIBE_WEBHOOK_SECRET.
    copy ".env.example" ".env" >nul
    "%PHP%" artisan key:generate
)

if not exist "database\database.sqlite" type nul > "database\database.sqlite"
"%PHP%" artisan migrate --force

echo.
echo Opening http://127.0.0.1:8000  (App)  and  http://127.0.0.1:8000/tester  (Backend tester)
start "" cmd /c "timeout /t 2 /nobreak >nul & start http://127.0.0.1:8000"
"%PHP%" artisan serve --host=127.0.0.1 --port=8000
pause
