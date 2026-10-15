# 4 - Webhook (no polling)

Upload a file and **do not wait**. When the job is done, the API sends the result to your server (a webhook).
Node.js 20+, no packages.

```text
send.mjs ---(1) upload + webhook_url---> Transcribe API ---(2) job for the worker---> PC worker
   |                                                                                     |
   +-- exits at once                                                (3) worker finishes the job
                                                                                         |
receiver.mjs <---(4) POST /webhook, signed with your webhook secret--- Transcribe API <--+
   |
   +-- checks the signature, saves results/<id>.json, prints the text
```

| File | What it does |
| --- | --- |
| `receiver.mjs` + `start-receiver.bat` | Small server on http://127.0.0.1:4000/webhook. Checks the signature. Saves each completed job to `results\<id>.json`. |
| `send.mjs` + `send.bat` | Uploads `..\sample\clip.mp3` with `webhook_url=http://127.0.0.1:4000/webhook`, then exits. No polling. |
| `env.mjs` | Reads `..\.env`. A real environment variable wins over the file. |

## Run it

1. **Double-click `start-receiver.bat`.** Keep this window open.
2. **Double-click `send.bat`** (or drag an `.mp3` file onto it). It prints the job id and stops at once.
3. Wait. When the worker is done (about 30-60 s for the sample, longer if other jobs are waiting),
   the result appears in the receiver window and in `results\<id>.json`.

Terminal version:

```bat
node receiver.mjs
node send.mjs C:\calls\call-001.mp3 --language auto
node send.mjs C:\calls\call-001.mp3 --webhook-url https://my-app.example.com/webhook
```

Expected output of `send.bat`:

```text
Transcribe API - send with webhook
  Server:   http://127.0.0.1:8088   Key: tk_1234...
  File:     C:\...\transcribe-api-demo\sample\clip.mp3
  Engine:   worker    Language: en
  Webhook:  http://127.0.0.1:4000/webhook

Uploaded. Job tr_825ca0535f084c702e264edf is queued.
This script stops now. Watch the receiver window: the result arrives there when the job is done.
```

Expected output in the receiver window:

```text
Transcribe API - webhook receiver
  Listening on http://127.0.0.1:4000/webhook
  Secret:      whsec_d... (from ../.env)
  ...
[6:48:08 PM] transcription.completed  tr_825ca0535f084c702e264edf  (clip.mp3, 40.04 s, en)
  metadata: {"demo":"4-webhook","file":"clip.mp3"}
  Hello. Thanks for calling. This is a short test recording ...
  Saved C:\...\4-webhook\results\tr_825ca0535f084c702e264edf.json
```

`results\tr_825ca0535f084c702e264edf.json` is one example result from a test run. This job is also kept in the dashboard
(webhook status `delivered`).

## What the API sends

```text
POST /webhook
Content-Type: application/json
X-Transcribe-Event: transcription.completed        (or transcription.failed)
X-Transcribe-Delivery: tr_...
X-Transcribe-Signature: sha256=<hex HMAC-SHA256 of the raw body, key = project webhook secret>

{"event":"transcription.completed","created_at":"...","data":{ ...the transcription object... }}
```

## Check the signature (always!)

Anybody can send a POST to your webhook URL. The signature proves that the message comes from your Transcribe API.

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function isValidSignature(rawBody, header) {          // rawBody = the exact bytes you received
  const expected = Buffer.from('sha256=' + createHmac('sha256', SECRET).update(rawBody).digest('hex'));
  const received = Buffer.from(String(header ?? ''));
  return received.length === expected.length && timingSafeEqual(received, expected);
}
```

- Use the **raw body**. Do not parse the JSON and stringify it again: the bytes change and the signature fails.
- Wrong or missing signature: answer `401` and do nothing. Try it:

```powershell
curl.exe -i -X POST http://127.0.0.1:4000/webhook -H "Content-Type: application/json" -H "X-Transcribe-Signature: sha256=0000" -d "{}"
```

  The answer is `401 {"error":"invalid_signature"}` and the receiver prints `REJECTED ...`.

## Good to know

- **The secret** is `TRANSCRIBE_WEBHOOK_SECRET` in `..\.env`. It must be the webhook secret of the project that owns the API key
  (Dashboard -> project -> Settings). Wrong secret = every real delivery is rejected with 401.
- **Answer fast with 2xx.** Any 2xx means `delivered`. Anything else (or a timeout) means `failed:<code>`,
  and the server tries again later (cron, with backoff, up to `webhooks.max_attempts` times, default 5). So a short receiver downtime is OK.
- **The same job can arrive twice** (a retry after a timeout). The receiver writes `results\<id>.json`, so the second time just overwrites the file.
- **metadata** comes back unchanged. `send.mjs` sends `{"demo":"4-webhook","file":"clip.mp3"}`. Use it for your own ids (order id, user id, ...).
- **Status in the dashboard / API:** `webhook_status` is `delivered`, `failed:<code>` or `pending`.
- **Private addresses:** this local server allows webhooks to `127.0.0.1` (`webhooks.allow_private_hosts = true`).
  A normal installation blocks private and local addresses (SSRF protection) and answers `422` for such a `webhook_url`.
  In production, use a public `https://` URL.
- A project can also have a **default webhook URL** (Dashboard -> project -> Settings). Then you do not need `webhook_url` in each upload.
