# Transcribe API - examples (demo clients)

Small example programs that use your own **Transcribe API**.
Each folder is one example. Copy the parts you need into your own project.

All examples read the same settings file: **`.env`** in this folder.
Create it first: copy `.env.example` to `.env` and fill in your API URL, key and webhook secret.

## Before you start

1. **Start the API and the PC worker.** See the main [README](../README.md).
   In these examples the API runs at http://127.0.0.1:8088. Change `TRANSCRIBE_API_URL` if yours is different.
2. **Check the API.** Open http://127.0.0.1:8088/api/v1/health (or your own URL + `/api/v1/health`). You should see `{"ok":true, ...}`.
3. **Check `.env`.** It needs `TRANSCRIBE_API_URL` and `TRANSCRIBE_API_KEY` (see [Settings](#settings-env)).
4. **Double-click the `.bat` file** of a demo (see the table).

The worker does **one job at a time**. The 40 s sample (`sample\clip.mp3`) takes about 35-60 s.
If other jobs are waiting, a job stays `queued` for a while. That is normal.
If a job stays `queued` for a long time, the worker window is probably closed.

## The demos

| Folder | Language / framework | What it shows | How to run | Tested on this PC |
| --- | --- | --- | --- | --- |
| [`1-curl`](1-curl/README.md) | PowerShell 5.1 + `curl.exe` (nothing to install) | Upload, check the status every 5 s, save `.txt` and `.srt`. Also raw `curl.exe` commands for every endpoint. | Double-click `transcribe.bat` | Yes |
| [`2-php`](2-php/README.md) | PHP 8 + cURL (no Composer) | A) Command line: upload, wait, print lines with times, save `.srt`. B) Small website: upload form, status page that refreshes itself, SRT/TXT download. A small client class you can copy. | A) `run.bat` B) `start-web.bat` → http://127.0.0.1:3002 | Yes |
| [`3-node`](3-node/README.md) | Node.js 20+ (no npm packages) | Upload, progress bar, save the full result `.json` and `.srt`. | Double-click `run.bat` | Yes |
| [`4-webhook`](4-webhook/README.md) | Node.js 20+ (no npm packages) | No polling: upload with `webhook_url`. A small receiver checks the signature and saves the result. | 1) `start-receiver.bat` 2) `send.bat` (port 4000) | Yes |
| [`5-react`](5-react/README.md) | React 18 + Vite + a small Node backend | Web app: drag & drop, status with %, transcript with an audio player (click a line to jump there), copy text, SRT download. Plus an **API Tester** page (every call, request next to response, "Run all checks"). | `start.bat` → http://localhost:5173 | Yes |
| [`6-laravel-app`](6-laravel-app/README.md) | Laravel 12 (PHP), SQLite | A real Laravel app. Page `/`: upload, status, transcript, audio player, SRT, delete. Page `/tester`: one card per API call, received webhooks, "Run all checks". Webhook controller with signature check. | `start.bat` → http://127.0.0.1:8000 | Yes, by its builder (it also has `php artisan test`) |
| [`7-python`](7-python/README.md) | Python 3.8+ (`requests`, Flask) | Same as `3-node`, plus a Flask webhook receiver and a signed test webhook. | `run.bat` (needs Python) | **No** - this PC has no Python |

"Tested" means: run on 2026-10-15 against the local API (http://127.0.0.1:8088) with `engine=worker`
and `sample\clip.mp3`, until the job was `completed`.
`engine=cloud` was **not** tested end to end: this local server has no cloud key (it answers `503 engine_unavailable`).

Each demo folder has its own `README.md` with the steps, the options and the expected output.

## Golden rule: never put the API key in frontend code

The API key (`tk_...`) can upload, read **and delete** every transcription of your project.
Everything that runs in the browser (HTML, JavaScript, React, Vue) or in a mobile app can be read by anyone.

So the browser never talks to the Transcribe API directly. It talks to **your** backend. Your backend adds the key.

```text
Browser (React, plain JS, ...)  --->  your backend (PHP, Node, Laravel, ...)  --->  Transcribe API
        no key here                    reads the key from .env                      checks the key
```

- `2-php` (website), `5-react` and `6-laravel-app` work like this. Look at them for examples.
- Next.js: never use the `NEXT_PUBLIC_` prefix for the key. Vite: never use the `VITE_` prefix.
- The webhook secret (`whsec_...`) is also a server-only value.
- The demos print at most the first 7 characters of the key (`tk_1234...`).

## Settings (`.env`)

One file for all demos: `examples\.env` (copy it from `examples\.env.example`). Format: `KEY=VALUE`, one per line. Lines starting with `#` are comments.
A real environment variable with the same name wins over the file (for example `set TRANSCRIBE_ENGINE=cloud`).

| Name | Example | Meaning |
| --- | --- | --- |
| `TRANSCRIBE_API_URL` | `http://127.0.0.1:8088` | Where the API is installed. **Without** `/api/v1`. |
| `TRANSCRIBE_API_KEY` | `tk_...` | Project API key. Dashboard → project → **API keys**. |
| `TRANSCRIBE_ENGINE` | `worker` | `worker` = your PC (free, slower). `cloud` = Groq/OpenAI (fast, needs a key on the server). |
| `TRANSCRIBE_LANGUAGE` | `en` | ISO-639-1 code (`en`, `de`, `ur`, ...). `auto` = detect the language. Empty = the project's default language. |
| `TRANSCRIBE_WEBHOOK_SECRET` | `whsec_...` | Dashboard → project → **Settings**. Used by `4-webhook`, `7-python` and the testers. |

Good to know:

- `6-laravel-app` reads **its own** `6-laravel-app\.env` (normal for Laravel). It has a copy of the same values.
  If you change the key or the secret, change it in both files.
- `.env` files are private. They are in `.gitignore`. Never send them by e-mail or chat.

## Worker or cloud?

| | `engine=worker` (default here) | `engine=cloud` |
| --- | --- | --- |
| Who transcribes | Your PC (Whisper large-v3-turbo) | Groq or OpenAI |
| Cost | Free | The provider's price |
| Upload answer | `202` with `status: "queued"` | `202 queued`, or with `wait=true`: `200` with the finished result |
| How you get the result | Poll `GET /api/v1/transcriptions/{id}` until `completed`/`failed`, or use a webhook | With `wait=true`: already in the upload answer |
| File size | Up to `max_upload_mb` (100 MB) | Up to `cloud.max_mb` (25 MB). Bigger: `413`, use worker |

### Switch to cloud + `wait=true`

1. **On the API server**, open `config.php`
   (this PC: `transcribe-api\local\config.php`; cPanel: `config.php` in the install folder).
   In the `cloud` section set the key:

   ```php
   'cloud' => [
       'enabled'  => true,
       'base_url' => 'https://api.groq.com/openai/v1',   // OpenAI: https://api.openai.com/v1
       'api_key'  => 'gsk_...',                          // your Groq (or OpenAI) key
       'model'    => 'whisper-large-v3-turbo',           // OpenAI: whisper-1
       // ...
   ],
   ```

2. **Check:** http://127.0.0.1:8088/api/v1/health must show `"cloud":true`.
3. **Use it in the demos:**

   | Demo | How |
   | --- | --- |
   | All | Set `TRANSCRIBE_ENGINE=cloud` in `.env` |
   | `1-curl` | `powershell -ExecutionPolicy Bypass -File .\transcribe.ps1 -Engine cloud -Wait` |
   | `2-php` | `C:\xampp\php\php.exe transcribe.php --engine=cloud --wait` |
   | `3-node` | `node transcribe.mjs --engine cloud --wait` |
   | `5-react` | Choose **cloud** in the page. The backend sends `wait=true` for you. |
   | `6-laravel-app` | `TRANSCRIBE_ENGINE=cloud` in `6-laravel-app\.env`, or `'wait' => true` in `upload()` |
   | `7-python` | `python transcribe.py --engine cloud --wait` |
   | Raw curl | add `-F "engine=cloud" -F "wait=true"` |

   With `wait=true` the upload request stays open until the text is ready (a few seconds for the sample).
   Keep the client timeout long (the demos use 600 s).

Without `wait`, a cloud job answers `202 queued` like the worker:

- On cPanel (LiteSpeed or PHP-FPM) the server transcribes it right after the answer. Poll or use a webhook.
- On this local test server (`php -S`) the job waits for the cron script: `C:\xampp\php\php.exe transcribe-api\server\cron\process.php`.
  So locally, use `wait=true`.

`prompt` (word hints, for example names or product words) works with cloud only.

## Use the live cPanel server later

1. Log in to the dashboard of the **live** server. Open your project → **API keys** → create a key. Copy it (it is shown only once).
2. In `examples\.env` change two lines:

   ```text
   TRANSCRIBE_API_URL=https://your-domain.com/transcribe
   TRANSCRIBE_API_KEY=tk_...the key from the live dashboard...
   ```

   Use the folder where the API is installed, without `/api/v1`.
   If the host has no URL rewriting, use `https://your-domain.com/transcribe/index.php`.
3. Copy the live project's webhook secret (project → **Settings**) into `TRANSCRIBE_WEBHOOK_SECRET`.
4. For `6-laravel-app`, change the same lines in `6-laravel-app\.env` and restart it.
5. Test: run `1-curl\transcribe.bat`. The job appears in the live dashboard.

Good to know for the live server:

- **Engine:** `worker` on the live server needs a PC worker that talks to the live server
  (`API_BASE` and `WORKER_TOKEN` in the worker's `.env`). Without a running worker, jobs stay `queued`. Otherwise use `cloud`.
- **Webhooks:** the live server cannot reach `127.0.0.1` on your PC, and it refuses private addresses (`422`).
  Use a public `https://` URL: your online app, or a tunnel (Cloudflare Tunnel, ngrok) to your PC.
  Without a webhook, polling still works.
- **Laravel tester:** on a public server set `TRANSCRIBE_TESTER=false` and `APP_DEBUG=false`.

## Polling or webhook?

- **Polling** (`1-curl`, `2-php`, `3-node`, `5-react`, `7-python`): ask `GET /api/v1/transcriptions/{id}` every few seconds
  until `status` is `completed` or `failed`. Simple. Works everywhere, also behind a firewall.
- **Webhook** (`4-webhook`, `6-laravel-app`, `7-python`): the API sends the result to your URL when it is done.
  No waiting loop. Your URL must be reachable by the API server. **Always check the `X-Transcribe-Signature` header.**
  `6-laravel-app` uses both: a webhook, and polling as a backup.

## n8n

Ready-made n8n workflows (transcribe and wait, webhook receiver with signature check, transcribe from a URL) are here:
[`n8n-examples`](../n8n-examples/README.md) in this repository.

## Ports

| Port | Used by |
| --- | --- |
| 8088 | The Transcribe API on this PC (do not use it for anything else) |
| 3002 | `2-php` website |
| 4000 | `4-webhook` receiver and `7-python` receiver (run only one at a time) |
| 3001 + 5173 | `5-react` (backend + Vite) |
| 8000 | `6-laravel-app` |

## Errors you may see

Errors always look like `{"error":{"code":"...","message":"..."}}`.

| HTTP | Code | What to do |
| --- | --- | --- |
| 401 | `invalid_api_key` / `unauthorized` | Wrong, revoked or missing key. Check `TRANSCRIBE_API_KEY`. |
| 404 | `not_found` | Wrong id, or the job was deleted, or it belongs to another project. |
| 409 | `not_ready` | `?format=srt` (or txt/vtt/json) before the job is `completed`. Wait and try again. |
| 413 | `file_too_large` | File too big. For cloud: use `engine=worker`. |
| 415 | `unsupported_file_type` | Only `.mp3` is allowed (server setting `allowed_extensions`). |
| 422 | `validation_error` | A bad field, for example a wrong language code or a private `webhook_url`. |
| 503 | `engine_unavailable` | The engine is off. Cloud: no cloud key on the server (see above). |

## Git

`.gitignore` keeps these out of git: `.env` files, `node_modules`, `vendor`, `dist`, the `output` and `results` folders,
and all `.mp3` files (they can contain private calls). After a fresh clone:

- copy `.env.example` to `.env` and fill it in (see [Settings](#settings-env)), copy `6-laravel-app\.env.example` to `6-laravel-app\.env`,
- put a short `.mp3` file at `sample\clip.mp3`,
- run `npm install` in `5-react` (its `start.bat` does this for you),
- run `composer install` in `6-laravel-app` before its `start.bat`. Composer: https://getcomposer.org/download/ (or `php composer.phar install` with the downloaded `composer.phar`).
