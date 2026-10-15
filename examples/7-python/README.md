# 7 - Python example (requests + Flask)

> **Not run on this PC.** This PC has no Python, so these scripts were never executed here.
> They were checked line by line against `SPEC.md` §7 and the server code
> (`PublicApi.php`, `Transcriptions.php`, `Webhooks.php`). Please run them once on a PC with Python
> before you give them to customers.

## What it shows

| File | What it does |
|---|---|
| `transcribe.py` | Uploads an audio file, checks the status every 3 s (max 15 min), prints the text with timestamps, saves `output\<name>.srt`. Contains a small `TranscribeClient` class you can copy. |
| `webhook_receiver.py` | Flask app that receives webhooks and checks the `X-Transcribe-Signature` header. |
| `send_test_webhook.py` | Sends a signed test webhook to the receiver, so you can test it without a public URL. |
| `env.py` | Reads the shared settings file `..\.env` (no extra package needed). |
| `run.bat` / `start-receiver.bat` | Double-click helpers. They install the packages and start the script. |
| `requirements.txt` | `requests` and `flask`. |

## Run it on Windows

1. Install Python 3.8 or newer from <https://www.python.org/downloads/>.
   In the installer, tick **"Add python.exe to PATH"**.
2. Open PowerShell in this folder and run:

   ```
   pip install -r requirements.txt
   python transcribe.py
   ```

   Or just double-click **`run.bat`**. It does both steps.

If `python` opens the Microsoft Store, use `py` instead:
`py -m pip install -r requirements.txt` and `py transcribe.py`.

### Expected output (ids and times will differ)

The default engine is `worker` (your PC worker). A 40 s clip takes about 1-3 minutes.

```
Transcribe API - Python demo
  Server:   http://127.0.0.1:8088
  Key:      tk_1a2b...
  File:     C:\Users\...\transcribe-api-demo\sample\clip.mp3 (0.3 MB)
  Engine:   worker    Language: en

Uploading...
  Created tr_3f9a...  (status: queued)

Waiting for the result (checking every 3 s, Ctrl+C to stop)...
  [   3 s] queued
  [  21 s] processing 10%
  [  48 s] processing 60%
  [  75 s] completed 100%

Done. Audio length: 40.04 s, language: en

[00:00.0] Hello.
[00:02.0] Thanks for calling.
[00:04.0] This is a short test recording.
...

Saved C:\Users\...\transcribe-api-demo\7-python\output\clip.srt
Transcription id: tr_3f9a... (you can also see it in the dashboard)
```

### Options

```
python transcribe.py C:\calls\call.mp3                 your own file (default: ..\sample\clip.mp3)
python transcribe.py --language auto                   let Whisper detect the language
python transcribe.py --engine cloud --wait             cloud engine, no polling (see below)
python transcribe.py --webhook-url https://.../webhook  the server also POSTs the result there
python transcribe.py --out C:\subtitles                 save the .srt file in another folder
```

- **worker** (default): the upload answers `202` with `status: "queued"`. The script polls
  `GET /api/v1/transcriptions/{id}` until the status is `completed` or `failed`.
- **cloud + `--wait`**: the server transcribes inside the upload request and answers `200` with the
  finished job, so there is no polling. This needs a cloud key on the server. The local server on
  this PC has no cloud key: it answers `503 engine_unavailable`.
- **language**: empty = the project's default language. `auto` = Whisper detects it.

## Settings

All demos share `..\.env`. A real environment variable with the same name wins over the file.
The scripts never print the API key (only the first 7 characters) or the webhook secret.

| Name | Used by | Example |
|---|---|---|
| `TRANSCRIBE_API_URL` | transcribe.py | `http://127.0.0.1:8088` (the base URL, **without** `/api/v1`) |
| `TRANSCRIBE_API_KEY` | transcribe.py | `tk_...` (Dashboard → project → API keys) |
| `TRANSCRIBE_ENGINE` | transcribe.py | `worker` or `cloud` |
| `TRANSCRIBE_LANGUAGE` | transcribe.py | `en`, `auto`, or empty |
| `TRANSCRIBE_WEBHOOK_SECRET` | webhook_receiver.py | `whsec_...` (Dashboard → project → Settings) |
| `WEBHOOK_PORT` | webhook_receiver.py | optional, default `4000` |

If the web host has no URL rewriting, use `https://example.com/transcribe/index.php` as the base URL.

## Webhooks

1. Start the receiver: `python webhook_receiver.py` (or double-click **`start-receiver.bat`**).
   It listens on `http://127.0.0.1:4000/webhook`.
2. Test it from a second window:

   ```
   python send_test_webhook.py                  ->  HTTP 200 {"ok":true}
   python send_test_webhook.py --bad-signature  ->  HTTP 401 {"error":"invalid signature"}
   ```

   The receiver prints the text and saves `results\tr_000000000000000000000000.json`.
3. Real webhooks: the server only calls **public** URLs. Make the receiver public with a tunnel,
   for example `ngrok http 4000`. Then use the tunnel URL:
   `python transcribe.py --webhook-url https://<your-tunnel>/webhook`
   (or set it as the project Webhook URL in the dashboard).

How the signature check works (the server signs the exact body bytes):

```python
raw_body = request.get_data()   # raw bytes, NOT re-encoded JSON
expected = "sha256=" + hmac.new(secret, raw_body, hashlib.sha256).hexdigest()
ok = hmac.compare_digest(expected.encode(), request.headers.get("X-Transcribe-Signature", "").encode())
```

Answer with any 2xx status quickly (the server waits 10 s). Other answers are retried later,
so the same event can arrive twice: save results by transcription id.

## Use the client in your own project

Copy `TranscribeError` and `TranscribeClient` from `transcribe.py`. Keep the key out of the code:

```python
import os
from transcribe import TranscribeClient

api = TranscribeClient(os.environ["TRANSCRIBE_API_URL"], os.environ["TRANSCRIBE_API_KEY"])
job = api.create("call.mp3", engine="worker", language="en", metadata={"order_id": 123})
job = api.get(job["id"])                  # poll until job["status"] is "completed" or "failed"
srt = api.download(job["id"], "srt")      # bytes; also "txt", "vtt", "json"
page = api.list(status="completed", limit=20)
api.delete(job["id"])
```

Errors raise `TranscribeError` with `.status` (HTTP code) and `.code`:

| Code | HTTP | Meaning |
|---|---|---|
| `unauthorized` / `invalid_api_key` | 401 | Key missing, wrong or revoked. |
| `validation_error` | 422 | A field is wrong (for example `engine`, `language`, `metadata`). |
| `file_too_large` | 413 | File too big. Cloud has a lower limit: use `engine=worker`. |
| `unsupported_file_type` | 415 | Extension not allowed (only `.mp3` by default). |
| `engine_unavailable` | 503 | That engine is not enabled on the server. |
| `not_ready` | 409 | `download()` before the job is completed. |
| `not_found` | 404 | Unknown id, or a job of another project. |
