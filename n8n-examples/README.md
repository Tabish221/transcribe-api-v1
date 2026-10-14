# n8n example workflows

Importable workflows that use only built-in n8n nodes (HTTP Request, Webhook, Code, ...). They work on **n8n Cloud** and self-hosted n8n, with or without the `n8n-nodes-transcribe-api` community node.

| File | What it does |
|---|---|
| `1-transcribe-and-wait.json` | Manual Trigger → **Config** → Read/Write Files from Disk → HTTP Request `POST /api/v1/transcriptions` (multipart, `wait=true`) → **Transcript** (id, status, text, language, duration, segments) |
| `2-webhook-receiver.json` | Webhook (POST, Raw Body) → Code: verify `X-Transcribe-Signature` → IF `event == transcription.completed` → **Transcript** / **Failure** |
| `3-transcribe-from-url.json` | Manual Trigger → **Config** → HTTP Request download (response as file) → Code: make sure the file has an extension → HTTP Request upload (`wait=true`) → **Transcript** |

Import: n8n editor → **⋯ → Import from File...** (or paste the JSON onto the canvas).

## Setup

1. **API key**: in the dashboard, open your project → **API keys** → create a key (`tk_...`, shown once).
2. **Credential**: in n8n, create a **Header Auth** credential named `Transcribe API key`:
   - Name: `Authorization`
   - Value: `Bearer tk_...`

   After import, open each **Transcribe** HTTP Request node and select this credential. The imported placeholder id `REPLACE_WITH_YOUR_CREDENTIAL` does not exist in your n8n.
3. **Config** node (examples 1 and 3): set `baseUrl` to where the server is installed, without `/api/v1`, e.g. `https://example.com/transcribe` (use `https://example.com/transcribe/index.php` if the host has no mod_rewrite). Also set `language` (empty = project default / auto-detect) and `engine` (`cloud` or `worker`).

## Notes per example

### 1 - transcribe and wait

- `filePath` must be readable by n8n. Recent n8n versions only allow `~/.n8n-files` by default, which in Docker is `/home/node/.n8n-files` (see `N8N_RESTRICT_FILE_ACCESS_TO`). On n8n Cloud, use example 3 instead.
- `wait=true` only applies to the **cloud** engine: the server transcribes inside the request and answers `200` with the finished object (`status` `completed` or `failed`). The HTTP Request timeout is 600 s; long cloud files may need more.
- With `engine=worker` the answer is `202` with `status: "queued"`. Either receive the result with example 2, or poll `GET {baseUrl}/api/v1/transcriptions/{id}` until the status is `completed` or `failed`.

### 2 - webhook receiver

1. Activate the workflow and copy the Webhook node's **Production URL** (e.g. `https://n8n.example.com/webhook/transcribe-api`).
2. Paste it as the project **Webhook URL** in the dashboard (Settings tab), or send it per upload as the `webhook_url` form field.
3. Copy the project **webhook secret** (`whsec_...`, Settings tab) into the `WEBHOOK_SECRET` constant of **Verify signature**.
4. Self-hosted n8n: the Code node uses Node's `crypto` module. Allow it with the environment variable `NODE_FUNCTION_ALLOW_BUILTIN=crypto` (n8n Cloud allows `crypto` already).

The server signs the exact request body: `X-Transcribe-Signature: sha256=<hex HMAC-SHA256(body, webhook secret)>`. That is why the Webhook option **Raw Body** is on: the Code node hashes those raw bytes (re-serialising the parsed JSON would not match). Requests with a missing or wrong signature make the execution fail. Valid ones continue as `{ event, delivered_at, ...transcription }`.

The server only calls public http(s) URLs (no localhost/private IPs, unless the server sets `webhooks.allow_private_hosts`). It treats any 2xx as delivered and retries failures from cron.

### 3 - transcribe from URL

- **Download audio** stores the response as binary property `data`. The API accepts files by extension (mp3 by default), so **Ensure file name** adds one from the MIME type when the download has none.
- The source URL is sent as `metadata` (`{"source_url": ...}`) and comes back in the result and in webhooks.

## Other calls with the HTTP Request node

All requests use the same Header Auth credential.

| Purpose | Method + URL |
|---|---|
| Job status / result | `GET {baseUrl}/api/v1/transcriptions/{id}` |
| Subtitles / text | `GET {baseUrl}/api/v1/transcriptions/{id}?format=srt` (`txt`, `vtt`, `json`). Set Response Format to *Text* or *File*. Returns `409 not_ready` until completed. |
| List | `GET {baseUrl}/api/v1/transcriptions?status=completed&limit=20&offset=0` |
| Delete | `DELETE {baseUrl}/api/v1/transcriptions/{id}` |

Upload form fields (multipart): `file` (required), `language`, `task` (`transcribe`/`translate`), `engine` (`cloud`/`worker`), `prompt` (cloud only), `webhook_url`, `metadata` (JSON object string ≤ 4 KB), `wait` (`true`, cloud only).
