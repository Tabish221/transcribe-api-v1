@echo off
rem Starts the PHP demo website on http://127.0.0.1:3002 (close this window or press Ctrl+C to stop).
rem Change PHP below if your php.exe is somewhere else.
if not defined PHP set "PHP=C:\xampp\php\php.exe"
echo Open http://127.0.0.1:3002 in your browser.
echo Press Ctrl+C to stop the website.
echo.
if not defined NO_BROWSER start "" "http://127.0.0.1:3002/"
"%PHP%" -d upload_max_filesize=100M -d post_max_size=110M -S 127.0.0.1:3002 -t "%~dp0web"
