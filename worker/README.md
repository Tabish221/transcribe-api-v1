# Transcribe API — PC worker

Runs Whisper on your own computer for jobs submitted with `engine=worker`. The worker asks the server
for a job, downloads the audio, transcribes it locally and posts the transcript back. Nothing has to be
opened on your router: the PC only makes outgoing HTTPS requests to the server.

The transcription pipeline is the one from `browser-app/transcriber.html`:
ffmpeg → 16 kHz mono → loudness normalisation → Whisper in 30-second windows, where each window starts
where the last *complete* sentence ended, so sentences crossing a window edge are never cut or lost.

## Requirements

- Node.js **20.3 or newer** (`node -v`).
- Disk space for the model (≈ 725 MB for the recommended large-v3-turbo q4) and 2–3 GB of free RAM.
- No ffmpeg install needed: a copy comes with the `ffmpeg-static` package.

## Setup on Windows

1. Copy this `worker` folder to the PC (for example `C:\TranscribeWorker`).
2. Double-click **`start-worker.bat`**. The first time it installs the dependencies and creates `.env`.
3. Open `.env` in Notepad and set:
   - `API_BASE` — the address of your server, e.g. `https://opraviq.com/transcribe` (no trailing slash)
   - `WORKER_TOKEN` — one of the tokens in `server/config.php` → `'worker' => ['tokens' => [...]]`
4. Double-click `start-worker.bat` again. The first start downloads the model (progress is shown),
   later starts take a few seconds. Leave the window open; it shows every job it handles.

Stop it with **Ctrl+C**: a job in progress is handed back to the queue right away (without using up one of
its attempts) so it is picked up again later; the worker then exits after the current 30-second window.
Closing the window does the same, except that the worker exits as soon as the job is handed back (Windows
ends the process about 10 s after the window closes). Press Ctrl+C twice to quit immediately. (Windows then
asks "Terminate batch job (Y/N)?" — either answer is fine.)

To start it automatically, put a shortcut to `start-worker.bat` in the Startup folder
(`Win+R` → `shell:startup`).

On macOS/Linux: `npm install`, `cp .env.example .env`, edit it, then `npm start`.

## Settings (`.env`)

Real environment variables override `.env`; command-line flags override both. Relative paths are relative
to this folder.

| Setting | Default | Meaning |
|---|---|---|
| `API_BASE` | — | Server URL (required) |
| `WORKER_TOKEN` | — | Worker token from `config.php` (required, never printed) |
| `WORKER_NAME` | computer name | Shown on jobs in the dashboard |
| `MODEL` | `onnx-community/whisper-large-v3-turbo` | Any `onnx-community/whisper-*` model |
| `TRANSLATE_MODEL` | — | Model for `task=translate` jobs when `MODEL` cannot translate (large-v3-turbo, `*.en`), e.g. `onnx-community/whisper-small`. Loaded on first use. Without it such jobs fail with a clear error instead of returning untranslated text |
| `DEVICE` | `cpu` | `dml` (DirectML GPU, Windows) or `cuda` (Linux); falls back to `cpu` if it fails |
| `DTYPE` | `q8` | Weight precision: `q4`, `q8`, `fp16`, `fp32`, … or per file: `encoder_model=fp32,decoder_model_merged=q8`. **`.env.example` sets `q4`, see below** |
| `POLL_SECONDS` | `10` | Pause between checks when the queue is empty |
| `CACHE_DIR` | `./models` | Where models are downloaded |
| `HEARTBEAT_SECONDS` | `60` | How often a running job reports progress and extends its lease (5–60; never more than a third of the lease) |
| `TEMP_DIR` | `./tmp` | Audio being processed (deleted after each job; leftovers from a crash are removed at start) |
| `FFMPEG_PATH` | bundled | Use another ffmpeg binary |
| `LOG_LEVEL` | `info` | `debug` shows heartbeats and retries in detail |

### Choosing model and precision

Measured on this project's sample (8 kHz phone call, 40 s clip) on a 4-core Xeon E5-1630 v4 without GPU:

| Model / DTYPE | Download | 40 s clip takes | Quality |
|---|---|---|---|
| large-v3-turbo / `q4` | 725 MB | ≈ 50 s (≈ 36 s with a fixed `language`) | Same text as the browser app's reference transcript |
| large-v3-turbo / `q8` | 1 GB | ≈ 76 s | Drops the first sentences, repeats one line — avoid |
| base / `fp32` | 280 MB | ≈ 6 s | Fair, names misheard |
| base / `q8` | 75 MB | ≈ 9 s | Fair |
| tiny / `fp32` | 145 MB | ≈ 4.5 s | Rough, but readable |
| tiny / `q8` | 40 MB | — | Unusable (its quantised encoder produces nonsense) |

The whole 13:39 sample call took **9 min 37 s with large-v3-turbo q4** (1.4× real time, transcript practically
identical to `samples/Sample Call_ENG_MA - transcript.txt`) and 2 min 05 s with base fp32.

Hence `.env.example` uses `MODEL=…large-v3-turbo` with `DTYPE=q4`. The spec default `q8` is still what the
worker uses when `DTYPE` is not set at all.

**GPU (DirectML):** `DEVICE=dml` works on this PC's Radeon RX 550 but is slower than the CPU
(base fp32: 21 s vs 6 s; large-v3-turbo q4: 95 s vs 36 s for the clip), because Whisper decodes token by token
and a small GPU spends more time on transfers than it saves. It may pay off on a stronger GPU; try it with
the local mode below and compare. If the GPU cannot load the model the worker logs a warning and uses the CPU.

## Local mode (no server needed)

Transcribe a file with exactly the same pipeline and get the transcript as JSON:

```
node worker.js --file "C:\calls\call.mp3"                       # JSON on stdout, logs on stderr
node worker.js --file call.mp3 --language en --out result.json  # save to a file
node worker.js --file call.mp3 --task translate                 # translate to English (uses TRANSLATE_MODEL with turbo)
node worker.js --file call.mp3 --model onnx-community/whisper-base --dtype fp32
```

Output (same shape as the API's transcription text/segments):

```json
{
  "text": "Hello. Hello. Thanks for taking the call. ...",
  "segments": [ { "id": 0, "start": 0, "end": 2, "text": "Hello." } ],
  "duration": 40.04,
  "detected_language": "en"
}
```

Other flags: `--once` (server mode: handle at most one job, then exit), `--env <file|none>`, `--device`,
`--verbose`, `--help`.

## How a job is handled

1. `POST /api/worker/claim` every `POLL_SECONDS` until a job is returned (204 = nothing to do).
2. The audio (`audio_url`, absolute or relative to `API_BASE`) is streamed to `TEMP_DIR`. The token is only
   ever sent to the `API_BASE` host.
3. ffmpeg decodes it to 16 kHz mono float samples (streamed from ffmpeg's stdout), then loudness is normalised.
4. If the job has no language, it is detected from the first 30 s (one extra encoder pass).
5. 30 s windows are transcribed as described above. A window whose text is a repetition loop
   (gzip ratio > 2.4, e.g. "going to be going to be …") is decoded again with sampling at rising temperatures,
   like openai-whisper does.
6. During the job a heartbeat (`progress` 0–100) is sent at least every 60 s, which also extends the lease.
7. `POST …/complete` with `{text, segments:[{start,end,text}], duration, detected_language}`.

Failures:

| What went wrong | Reported as |
|---|---|
| Network error, timeout, HTTP 5xx/429 | Retried with backoff (2 s, 4 s, 8 s …); if it keeps failing: `fail` with `retry:true` |
| Audio cannot be decoded, unsupported language, translate job without a model that can translate | `fail` with `retry:false` (permanent) |
| Ctrl+C / window closed | `fail` with `retry:true, release:true`: back to the queue at once, the attempt is not counted |
| ffmpeg cannot be started | Checked at start-up (the worker refuses to start). During a job: handed back like Ctrl+C, then the worker exits |
| Any other error on this PC | `fail` with `retry:true`, then a pause before the next job (doubling each time); after 3 such jobs in a row the worker stops, so one broken PC cannot use up the attempts of the whole queue |
| Server answers 404 for the job (lease taken over, job deleted) | Job dropped silently |
| Wrong token / wrong `API_BASE` at start-up | Clear error and exit (no endless retrying) |

Error messages sent to the server never contain local paths (they are replaced by `<local>`).

The temp audio file is deleted after every job, including failures and forced exits.

Exit codes: 0 = normal (also after Ctrl+C in server mode), 1 = error, a `--once` job that failed, or the worker
stopped itself because this PC cannot run jobs, 2 = bad command line, 130 = local mode cancelled with Ctrl+C,
console window closed, or a forced quit.

The worker lets Node exit on its own after releasing the model instead of calling `process.exit()` right
away: with ONNX Runtime on Windows an immediate exit can abort with a libuv assertion (exit code 0xC0000409).

## Testing

```
npm test            # = node ../tests/worker-mock-server.mjs
```

starts a fake worker API on `http://127.0.0.1:8096/transcribe` (set `MOCK_PORT` if that port is busy) and
runs `worker.js` against it: happy path (with a simulated 503 and language auto-detection), undecodable
audio, graceful stop during transcription, and a wrong token. It uses `whisper-tiny` (`fp32`) by default;
set `MODEL`/`DTYPE` to test others. `node ../tests/worker-mock-server.mjs --serve` only runs the fake server
with one queued job, for trying the worker by hand.

## Troubleshooting

- **"The server rejected WORKER_TOKEN (HTTP 401)"** — the token in `.env` is not in `config.php`'s
  `worker.tokens` list (watch for spaces).
- **"The worker API was not found at API_BASE"** — `API_BASE` must be the folder that contains the server's
  `index.php`, e.g. `https://example.com/transcribe`.
- **Model download fails** — check the PC can reach `huggingface.co`; delete `models/` to start over.
- **Slow** — use a smaller model, or set the job's language so detection is skipped.

## Notes on spec choices

- `text` is the segment texts joined with spaces; local-mode segments include `id` (the server assigns ids itself).
- When the job has a language, `detected_language` is that language; otherwise the detected ISO code.
- English-only models (`*.en`) ignore `language`/`task` (they cannot translate).
- `task=translate`: the large-v3 turbo models were not trained for translation (openai/whisper: they return
  the original language), so they never handle it. Such jobs use `TRANSLATE_MODEL`, or fail with `retry:false`
  and a message saying so when it is not set.
- Language codes: the server uses ISO-639-1. Whisper calls Javanese `jw` instead of `jv`; the worker maps it
  both ways.
- `release:true` on `fail` is an addition to SPEC 8: the server re-queues the job and gives the claim's attempt
  back, so stopping a worker during long jobs can never use up `worker.max_attempts`.
- Up to 224 new tokens per 30 s window (openai-whisper's limit). transformers.js's own in-window seek is
  bypassed this way so each window is decoded once, as in the browser app.
- If a window has no usable sentence end (silence, or a sentence longer than the window), the worker moves on by
  29 s like the browser app, but keeps the text heard so far instead of dropping it.
