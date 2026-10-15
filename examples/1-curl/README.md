# 1 - curl.exe + PowerShell

Transcribe a file with **Windows PowerShell 5.1** and **curl.exe**. Both come with Windows 10 and 11. Nothing to install.

What the script does:

1. It reads the settings from `..\.env` (URL, API key, engine, language).
2. It uploads the file with `curl.exe` (multipart/form-data).
3. It asks for the status every 5 seconds (`Invoke-RestMethod`) until the job is `completed` or `failed`.
4. It prints the text and saves `output\<name>.txt` and `output\<name>.srt`.

## Run it

- **Double-click `transcribe.bat`.** It transcribes `..\sample\clip.mp3`.
- Or **drag an .mp3 file** onto `transcribe.bat`.
- Or in a terminal:

```powershell
.\transcribe.bat C:\calls\call-001.mp3
powershell -ExecutionPolicy Bypass -File .\transcribe.ps1 C:\calls\call-001.mp3 -Language de -Engine worker
powershell -ExecutionPolicy Bypass -File .\transcribe.ps1 C:\calls\call-001.mp3 -Engine cloud -Wait
```

Options:

| Option | Meaning |
| --- | --- |
| `-Engine worker\|cloud` | `worker` = your PC (default here). `cloud` = Groq/OpenAI (needs a cloud key on the server). |
| `-Language en` | ISO-639-1 code (`en`, `de`, `ur`, ...). `auto` = detect the language. Not set = the project's default language. |
| `-Wait` | Cloud only. The server transcribes inside the upload request, so there is no polling. |
| `-OutDir <folder>` | Where `.txt` and `.srt` go. Default: `output`. |
| `-PollSeconds 5`, `-TimeoutMinutes 60` | How often to check, and when to give up. |

The defaults for engine and language come from `..\.env` (`TRANSCRIBE_ENGINE`, `TRANSCRIBE_LANGUAGE`).
A real environment variable with the same name wins over `..\.env`.

> This local server has no cloud key. So `-Engine cloud` answers `engine_unavailable` (503) here.

## Expected output

```text
Transcribe API - PowerShell + curl.exe demo
  Server:   http://127.0.0.1:8088
  Key:      tk_1234...
  File:     C:\...\transcribe-api-demo\sample\clip.mp3
  Engine:   worker    Language: en

Uploading...
  Created tr_de0630d53835d5cfb29b2672 (status: queued)

Waiting for the result (checking every 5 s, Ctrl+C to stop)...
  [   5 s] processing 0%
  [  35 s] completed 100%

Done. Audio length: 40.04 s, language: en

--- Transcript ---
Hello. Thanks for calling. This is a short test recording ...
------------------

Saved C:\...\1-curl\output\clip.txt
Saved C:\...\1-curl\output\clip.srt
```

The worker does one job at a time. If other jobs are waiting, you see `queued` for a while. That is normal.
The `output` folder has one example result (`clip.txt`, `clip.srt`) from a test run.
That job (`tr_de0630d53835d5cfb29b2672`) is also kept in the dashboard.

## Raw curl.exe commands

Open PowerShell **in this folder**. First load `..\.env` into this window (one line):

```powershell
Get-Content ..\.env | Where-Object { $_ -match '^\s*[A-Z_]+\s*=' } | ForEach-Object { $n, $v = $_ -split '=', 2; Set-Item "env:$($n.Trim())" $v.Trim() }
```

Then (replace `tr_xxx` with your id):

```powershell
# Upload (engine=worker -> answer 202, status "queued")
curl.exe -X POST "$env:TRANSCRIBE_API_URL/api/v1/transcriptions" -H "Authorization: Bearer $env:TRANSCRIBE_API_KEY" -F "file=@..\sample\clip.mp3" -F "engine=worker" -F "language=en"

# Status and result (text + segments when "completed")
curl.exe "$env:TRANSCRIBE_API_URL/api/v1/transcriptions/tr_xxx" -H "Authorization: Bearer $env:TRANSCRIBE_API_KEY"

# Subtitles as a file (also: txt, vtt, json). Answer 409 "not_ready" until completed.
curl.exe "$env:TRANSCRIBE_API_URL/api/v1/transcriptions/tr_xxx?format=srt" -H "Authorization: Bearer $env:TRANSCRIBE_API_KEY" -o clip.srt

# List (newest first). Filters: status=queued|processing|completed|failed, limit (1-100), offset
curl.exe "$env:TRANSCRIBE_API_URL/api/v1/transcriptions?status=completed&limit=5" -H "Authorization: Bearer $env:TRANSCRIBE_API_KEY"

# Delete (removes the job and its audio file)
curl.exe -X DELETE "$env:TRANSCRIBE_API_URL/api/v1/transcriptions/tr_xxx" -H "Authorization: Bearer $env:TRANSCRIBE_API_KEY"

# Health check (no key needed)
curl.exe "$env:TRANSCRIBE_API_URL/api/v1/health"
```

**cmd.exe** instead of PowerShell? Load the settings with
`for /f "usebackq eol=# tokens=1,* delims==" %a in ("..\.env") do @set "%a=%b"`
and write `%TRANSCRIBE_API_URL%` / `%TRANSCRIBE_API_KEY%` instead of `$env:...`.
(Inside a `.bat` file, write `%%a` and `%%b` instead of `%a` and `%b`.)

Notes:

- In Windows PowerShell, `curl` (without `.exe`) is a different command. Always type `curl.exe`.
- Other upload fields: `task=translate` (to English), `webhook_url=...`, `metadata={"order":123}`, `prompt=...` (cloud only).
- `wait=true` works only with `engine=cloud`. Then the upload answer is already the finished result (no polling).
  This local server has no cloud key, so the demos use `engine=worker`.
- Errors look like `{"error":{"code":"invalid_api_key","message":"..."}}`.
