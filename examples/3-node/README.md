# 3 - Node.js (no packages)

Transcribe a file with **Node.js 20 or newer**. No `npm install`: `fetch`, `FormData` and `Blob` are built in.

What `transcribe.mjs` does:

1. It reads the settings from `..\.env` (a real environment variable wins over the file).
2. It uploads the file: `POST /api/v1/transcriptions` (multipart/form-data).
3. It asks `GET /api/v1/transcriptions/{id}` every 5 seconds and shows a progress bar.
4. It prints the text and saves `output\<name>.json` (the full object with segments) and `output\<name>.srt`.

## Run it

- **Double-click `run.bat`.** It transcribes `..\sample\clip.mp3`.
- Or **drag an .mp3 file** onto `run.bat`.
- Or in a terminal:

```bat
node transcribe.mjs
node transcribe.mjs C:\calls\call-001.mp3 --language auto
node transcribe.mjs C:\calls\call-001.mp3 --engine cloud --wait
node transcribe.mjs C:\calls\call-001.mp3 --out C:\results
```

| Option | Meaning |
| --- | --- |
| `--engine worker\|cloud` | `worker` = your PC (default here). `cloud` = Groq/OpenAI (needs a cloud key on the server). |
| `--language en` | ISO-639-1 code. `auto` = detect the language. Not set = `TRANSCRIBE_LANGUAGE` from `..\.env`, and if that is empty, the project's default. |
| `--wait` | Cloud only. The server transcribes inside the upload request and answers with the result. No polling. |
| `--out <folder>` | Where the `.json` and `.srt` go. Default: `output`. |

> This local server has no cloud key. So `--engine cloud` answers `engine_unavailable` (503) here.

## Expected output

```text
Transcribe API - Node.js demo
  Server:   http://127.0.0.1:8088
  Key:      tk_1234...
  File:     C:\...\transcribe-api-demo\sample\clip.mp3
  Engine:   worker    Language: en

Uploading...
  Created tr_7df8600c426c177b24dd0ccf (status: queued)

Waiting for the result (checking every 5 s, Ctrl+C to stop)...
  [####################] 100% completed    35 s

Done. Audio length: 40.04 s, language: en

--- Transcript ---
Hello. Thanks for calling. This is a short test recording ...
------------------

Saved C:\...\3-node\output\clip.json
Saved C:\...\3-node\output\clip.srt

Transcription id: tr_7df8600c426c177b24dd0ccf (also visible in the dashboard)
```

In a terminal the progress line updates in place. The worker does one job at a time,
so you may see `queued` for a while. Ctrl+C only stops the script; the job keeps running on the server.

`output\clip.json` and `output\clip.srt` are one example result from a test run.
That job (`tr_7df8600c426c177b24dd0ccf`) is also kept in the dashboard.

## The important part (copy this into your project)

```js
const API_URL = 'http://127.0.0.1:8088';
const headers = { Authorization: `Bearer ${process.env.TRANSCRIBE_API_KEY}` };

// 1. Upload. The third argument is the file name the API sees (it must end with .mp3).
const form = new FormData();
form.append('file', await openAsBlob('call.mp3', { type: 'audio/mpeg' }), 'call.mp3');
form.append('engine', 'worker');
let job = await (await fetch(`${API_URL}/api/v1/transcriptions`, { method: 'POST', headers, body: form })).json();

// 2. Poll until it is done.
while (job.status === 'queued' || job.status === 'processing') {
  await new Promise((r) => setTimeout(r, 5000));
  job = await (await fetch(`${API_URL}/api/v1/transcriptions/${job.id}`, { headers })).json();
}

// 3. Use the result: job.text, job.segments [{start, end, text}], or ?format=srt|vtt|txt|json
const srt = await (await fetch(`${API_URL}/api/v1/transcriptions/${job.id}?format=srt`, { headers })).text();
```

`openAsBlob` comes from `node:fs`. In a browser, use the `File` from an `<input type="file">` instead.
Do not put the API key in browser code: call the API from your server.
