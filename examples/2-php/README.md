# 2 - PHP (command line + small website)

Plain **PHP 8 + cURL**. No Composer, no framework. Two examples:

- `transcribe.php` - command line: upload a file, wait, print the lines, save an `.srt` file.
- `web/index.php` - a tiny website: upload form, status page, transcript and SRT download.

Both use the same small client class, `TranscribeApi.php`. Copy that file into your own project.

| File | What it is |
| --- | --- |
| `TranscribeApi.php` | Client class: `upload()`, `get()`, `download()`, `list()`, `delete()`. Errors become `TranscribeApiException`. |
| `env.php` | Reads `..\.env` (`KEY=VALUE`, `#` comments). A real environment variable wins over the file. |
| `transcribe.php` + `run.bat` | Command line demo. |
| `web/index.php` + `start-web.bat` | Website demo on http://127.0.0.1:3002 |

PHP path: the `.bat` files use `C:\xampp\php\php.exe`. Another PHP? Set `PHP` first: `set PHP=C:\php\php.exe`.

## A) Command line

**Double-click `run.bat`.** It transcribes `..\sample\clip.mp3`. Or drag an `.mp3` file onto `run.bat`. Or:

```bat
run.bat C:\calls\call-001.mp3
C:\xampp\php\php.exe transcribe.php C:\calls\call-001.mp3 --language=auto
C:\xampp\php\php.exe transcribe.php C:\calls\call-001.mp3 --engine=cloud --wait
```

| Option | Meaning |
| --- | --- |
| `--engine=worker\|cloud` | `worker` = your PC (default here). `cloud` = Groq/OpenAI (needs a cloud key on the server). |
| `--language=en` | ISO-639-1 code. `auto` = detect the language. Not set = `TRANSCRIBE_LANGUAGE` from `..\.env`, and if that is empty, the project's default. |
| `--wait` | Cloud only. The server transcribes inside the upload request. No polling. |

Expected output:

```text
Transcribe API - PHP command line demo
  Server:   http://127.0.0.1:8088
  Key:      tk_1234...
  File:     C:\...\transcribe-api-demo\sample\clip.mp3
  Engine:   worker    Language: en

Uploading...
  Created tr_4f06d73f4a2e9e99fad0ce42 (status: queued)

Waiting for the result (checking every 5 s, Ctrl+C to stop)...
  [   5 s] processing 0%
  [  35 s] completed 100%

Done. Audio length: 40.04 s, language: en

[00:00.0] Hello.
[00:02.0] Thanks for calling.
[00:04.0] This is a short test recording.
...

Saved C:\...\2-php\output\clip.srt
Transcription id: tr_4f06d73f4a2e9e99fad0ce42 (also visible in the dashboard)
```

`output\clip.srt` is one example result from a test run.
That job (`tr_4f06d73f4a2e9e99fad0ce42`) is also kept in the dashboard.

## B) Website

1. **Double-click `start-web.bat`.** It starts `php -S 127.0.0.1:3002 -t web` and opens your browser.
2. Choose an `.mp3` file and click **Transcribe**.
3. The page shows `queued`, then `processing` with a progress bar. It refreshes itself every 5 seconds.
4. When the job is `completed` you see the lines with times, the full text, and **Download SRT** / **Download TXT**.
5. Close the black window (or press Ctrl+C) to stop the website.

How it works:

```text
Browser --(form upload)--> web/index.php --(file + API key)--> Transcribe API
Browser <--(HTML page)---- web/index.php <--(JSON status)----- Transcribe API
```

- The API key stays in PHP. The browser never sees it. Downloads also go through PHP.
- Every value is printed with `e()` (`htmlspecialchars`), so a strange file name cannot break the page.
- The form has a CSRF token. Each browser can only open the jobs it uploaded (they are kept in the PHP session).
  In a real app, save the job id in your database with the user id instead.
- The temp file from PHP has no `.mp3` extension. So the code sends the original file name to the API (the API checks the extension).
- `start-web.bat` raises PHP's upload limit to 100 MB (`-d upload_max_filesize=100M -d post_max_size=110M`).
  On Apache/XAMPP, set the same two values in `php.ini`.

To run the website on a real web server, copy the `2-php` folder (with `web`, `env.php`, `TranscribeApi.php`)
and point the document root to `web`. Keep `.env` outside the document root.
