# 5 - React app + a small backend that keeps the key secret

A small React app (Vite + React 18, plain JavaScript, no UI library) and a tiny Node backend.

It has two pages:

1. **Transcribe** (`http://localhost:5173/#/`)
   - Drag & drop an MP3, or click **"Use the sample clip"**.
   - Choose the engine (worker is the default) and the language. Click **Upload & transcribe**.
   - You see the status: Upload → Queue → Transcribe (with progress %) → Done.
   - Then you see the transcript as lines with timestamps, and an audio player with **your local file**.
     Click a timestamp: the player jumps there and plays. The line that plays now is highlighted.
   - Buttons: **Copy text** and **Download SRT**.
2. **API Tester** (`http://localhost:5173/#/tester`)
   - One card for each API call: Health, List, Upload, Get, Download as file (txt/srt/vtt/json), Delete, Webhook info.
   - Each card shows the real **request** (the key is masked: `Bearer tk_1234…`) next to the real **response**
     (status, time in ms, headers, pretty JSON).
   - **History**: every call, newest first. Click one to see it again.
   - **Run all checks**: health → list → upload → wait until done → SRT → delete → check it is gone.
     You get a PASS / FAIL list.
   - Click any `tr_…` id in a JSON answer to put it into the ID field.

Light and dark mode follow Windows. The button at the top right switches Auto / Light / Dark.

## How it works

```
 Browser (React)                Your backend (server.mjs)               Transcribe API
 http://localhost:5173          http://127.0.0.1:3001                   TRANSCRIBE_API_URL
 ─────────────────────          ─────────────────────────               ──────────────────
 POST /api/transcribe     ───►  adds  Authorization: Bearer tk_…  ───►  POST /api/v1/transcriptions
 GET  /api/transcriptions/:id ► adds the key                      ───►  GET  /api/v1/transcriptions/:id
 GET  /api/transcriptions/:id/srt                                 ───►  GET  …/:id?format=srt
 POST /api/tester/:action ───►  adds the key, measures the time   ───►  any endpoint
        (no key here)                (the key lives here only)
```

- In development, Vite (port 5173) forwards every `/api/...` request to the backend (port 3001).
  See `vite.config.js`.
- The browser only knows `/api/...`. It never sees the API key.
- The worker engine needs time, so the page asks `GET /api/transcriptions/:id` every 2 seconds
  until the status is `completed` or `failed`.
- `engine=cloud` sends `wait=true`: the API answers when the text is ready (no polling).
  The cloud engine must be set up on the API server ("needs cloud key on server").
  On this test server only the worker engine is on, so cloud answers `503 engine_unavailable`.

### Why the key must stay in the backend

- Everything you send to the browser can be read by anyone: "View source", DevTools, the network tab.
- With your key, a stranger can upload files to **your** project, read **all** your transcripts and delete them.
- So the key is only in `..\.env` and only `server.mjs` reads it. The browser talks to `server.mjs`.
- In your own app, `server.mjs` is also the place to check **who** is logged in, and that this user may see this
  transcription id (see the comment in `handleShow`).

## Run it on Windows

**Double-click `start.bat`.** The first time it runs `npm install` (about a minute).
Then it starts the backend and Vite, and opens http://localhost:5173.

Or in a terminal:

```powershell
cd 5-react
npm install
npm run dev
```

Then open http://localhost:5173. Press **Ctrl+C** to stop both programs.

Needs Node.js 20.19 or newer (you have Node 24).

### Settings

The backend reads the shared file `..\.env` (the demo folder). Real environment variables win.

| Name | Used for |
|---|---|
| `TRANSCRIBE_API_URL` | Where the Transcribe API runs, e.g. `http://127.0.0.1:8088` |
| `TRANSCRIBE_API_KEY` | Your project API key `tk_…`. Stays in the backend. |
| `TRANSCRIBE_ENGINE` | Default engine in the UI (`worker` or `cloud`) |
| `TRANSCRIBE_LANGUAGE` | Default language in the UI (`en`, `de`, … or `auto`) |
| `TRANSCRIBE_WEBHOOK_SECRET` | Only for the tester's "Webhook info" card (signed example). Never sent to the browser. |

Other ports: `set PORT=3002` (backend) and `set VITE_PORT=5174` (Vite) before `npm run dev`.

### Expected output

In the terminal:

```
[dev] Starting the backend (http://127.0.0.1:3001) and Vite (http://localhost:5173) ...

  Transcribe API demo backend is running
  - Backend:        http://127.0.0.1:3001
  - Transcribe API: http://127.0.0.1:8088  (key tk_1234...)
  - Defaults:       engine=worker, language=en
  - React app:      http://localhost:5173 (Vite dev server)

  VITE v8.3.4  ready in 350 ms
  ➜  Local:   http://localhost:5173/

[upload] clip.mp3 (314 KB) engine=worker language=en
[job] tr_a84bafebcb204063cb737562 queued
[job] tr_a84bafebcb204063cb737562 processing 0%
[job] tr_a84bafebcb204063cb737562 completed
```

In the browser, with `..\sample\clip.mp3` (40 seconds): after about 30–90 seconds you see 15 lines,
starting with "0:00 Hello.".
On the tester page, **Run all checks** shows "All 7 checks passed".

### Production-like (one server, no Vite)

```powershell
npm run build     # creates dist\
npm start         # backend serves dist\ AND /api on http://127.0.0.1:3001
```

### Test the backend with curl

```powershell
curl.exe -F "file=@..\sample\clip.mp3" -F engine=worker -F language=en http://127.0.0.1:3001/api/transcribe
curl.exe http://127.0.0.1:3001/api/transcriptions/tr_xxxxxxxxxxxxxxxxxxxxxxxx
curl.exe -OJ http://127.0.0.1:3001/api/transcriptions/tr_xxxxxxxxxxxxxxxxxxxxxxxx/srt
curl.exe -X POST http://127.0.0.1:3001/api/tester/health
```

## Backend routes (`server.mjs`)

| Route | What it does |
|---|---|
| `POST /api/transcribe` | multipart `file` + optional `engine`, `language`. Adds the defaults from `.env` and the key, forwards to `POST /api/v1/transcriptions`. Cloud also gets `wait=true`. |
| `GET /api/transcriptions/:id` | Forwards to `GET /api/v1/transcriptions/:id` (status, progress, text, segments). |
| `GET /api/transcriptions/:id/srt` | Forwards `?format=srt` as a download (`409 not_ready` until completed). |
| `POST /api/tester/:action` | Tester actions: `health`, `list` (status, limit, offset), `upload` (multipart: file, engine, language, task, prompt, wait), `get` (id), `format` (id, format), `delete` (id), `webhook-info`. Answers `{request, response, duration_ms}`. |
| `GET /api/config` | Defaults for the UI (engine, language, which engines are on). No secrets. |
| `GET /api/sample` | `..\sample\clip.mp3`, for the "Use sample" buttons. |
| `GET /*` | The built React app from `dist\` (after `npm run build`). |

Safety rules in the backend:

- The id must match `^tr_[0-9a-f]{24}$` before it goes into a URL (else `422 validation_error`).
- Errors from the API (status + `{"error":{...}}` JSON) go to the browser unchanged.
- POST requests from other websites are refused (Origin check), the backend listens on 127.0.0.1 only,
  and uploads are limited to 100 MB.

## Files

```
5-react/
├─ start.bat              double-click: install + run + open the browser
├─ dev.mjs                "npm run dev": starts server.mjs and Vite, stops both on Ctrl+C
├─ server.mjs             the backend (node:http only). The key is used only here.
├─ vite.config.js         React plugin + proxy /api → http://127.0.0.1:3001
├─ index.html
└─ src/
   ├─ main.jsx, App.jsx   page frame + tabs (#/ and #/tester)
   ├─ api.js              every fetch the browser makes (only /api/...)
   ├─ pages/              TranscribePage.jsx, TesterPage.jsx
   ├─ components/         DropZone, JobStatus, Transcript (player + lines), ThemeToggle, Icons
   ├─ tester/             RunAllChecks, Exchange (request | response), History, JsonView, FilePicker, Badges
   └─ styles.css          all styles, light + dark
```

## Use the same idea in your own backend

The React code stays the same. Only the backend changes. The rules are always:
read the key from the server environment, add `Authorization: Bearer <key>`, check the id, and return the
API's status and JSON.

### Express

```js
// npm install express multer
import express from 'express';
import multer from 'multer';

const app = express();
const upload = multer({ limits: { fileSize: 100 * 1024 * 1024 } }); // keeps the file in memory
const API_URL = process.env.TRANSCRIBE_API_URL;
const auth = { Authorization: `Bearer ${process.env.TRANSCRIBE_API_KEY}` };

app.post('/api/transcribe', upload.single('file'), async (req, res) => {
  const form = new FormData();
  form.append('file', new Blob([req.file.buffer]), req.file.originalname);
  form.append('engine', req.body.engine || 'worker');
  if (req.body.language) form.append('language', req.body.language);
  const r = await fetch(`${API_URL}/api/v1/transcriptions`, { method: 'POST', headers: auth, body: form });
  res.status(r.status).json(await r.json());
});

app.get('/api/transcriptions/:id', async (req, res) => {
  if (!/^tr_[0-9a-f]{24}$/.test(req.params.id)) return res.status(422).json({ error: { code: 'validation_error', message: 'Invalid id' } });
  const r = await fetch(`${API_URL}/api/v1/transcriptions/${req.params.id}`, { headers: auth });
  res.status(r.status).json(await r.json());
});

app.listen(3001, '127.0.0.1');
```

### Next.js (App Router)

Put the key in `.env.local` **without** the `NEXT_PUBLIC_` prefix (with that prefix it goes to the browser).

```js
// app/api/transcribe/route.js
export async function POST(request) {
  const incoming = await request.formData();
  const form = new FormData();
  form.append('file', incoming.get('file'));
  form.append('engine', incoming.get('engine') || 'worker');
  if (incoming.get('language')) form.append('language', incoming.get('language'));
  const r = await fetch(`${process.env.TRANSCRIBE_API_URL}/api/v1/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.TRANSCRIBE_API_KEY}` },
    body: form,
  });
  return Response.json(await r.json(), { status: r.status });
}

// app/api/transcriptions/[id]/route.js
export async function GET(request, { params }) {
  const { id } = await params;
  if (!/^tr_[0-9a-f]{24}$/.test(id)) return Response.json({ error: { code: 'validation_error', message: 'Invalid id' } }, { status: 422 });
  const r = await fetch(`${process.env.TRANSCRIBE_API_URL}/api/v1/transcriptions/${id}`, {
    headers: { Authorization: `Bearer ${process.env.TRANSCRIBE_API_KEY}` },
    cache: 'no-store',
  });
  return Response.json(await r.json(), { status: r.status });
}
```

Note: some hosts limit the request size (Vercel: about 4.5 MB). For big MP3 files use your own server.

### Laravel

Put `TRANSCRIBE_API_URL` and `TRANSCRIBE_API_KEY` in Laravel's `.env` and map them in `config/services.php`
(`'transcribe' => ['url' => env('TRANSCRIBE_API_URL'), 'key' => env('TRANSCRIBE_API_KEY')]`).
In `routes/api.php` (Laravel adds the `/api` prefix; on Laravel 11+ run `php artisan install:api` once):

```php
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Route;

Route::post('/transcribe', function (Request $request) {
    $request->validate(['file' => 'required|file|max:102400']); // KB = 100 MB
    $file = $request->file('file');
    $response = Http::withToken(config('services.transcribe.key'))
        ->timeout(120)
        ->attach('file', fopen($file->getRealPath(), 'r'), $file->getClientOriginalName())
        ->post(config('services.transcribe.url') . '/api/v1/transcriptions', [
            'engine' => $request->input('engine', 'worker'),
            'language' => $request->input('language', 'en'),
        ]);
    return response()->json($response->json(), $response->status());
});

Route::get('/transcriptions/{id}', function (string $id) {
    $response = Http::withToken(config('services.transcribe.key'))
        ->get(config('services.transcribe.url') . "/api/v1/transcriptions/{$id}");
    return response()->json($response->json(), $response->status());
})->where('id', 'tr_[0-9a-f]{24}');
```

See also the `6-laravel-app` folder for a complete Laravel example.
