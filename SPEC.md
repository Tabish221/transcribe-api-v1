# Transcribe API — build specification (source of truth)

All components (PHP server, dashboard, PC worker, n8n node) MUST follow this contract exactly.
If something here is ambiguous, choose the simplest behaviour that fits it and note it in the component README.

## 0. Goal & constraints

A self-hosted speech-to-text service the owner uses from their own projects:
accounts → projects → API keys → upload audio → JSON transcript (+ TXT/SRT/VTT), webhooks, n8n node.

Hosting target: **cPanel shared hosting** (Apache or LiteSpeed, PHP-FPM/CGI, MySQL/MariaDB, cron, no root,
no Docker, no long-running daemons, no GPU, CPU/RAM limits). Therefore:
- Server = **plain PHP 8.1+** (no Composer, no framework, no build step; runs from an uploaded folder).
  Must also run locally on Windows XAMPP PHP 8.2 via `php -S` for testing.
- Database = **MySQL/MariaDB** in production; **SQLite** supported too (local tests / tiny installs). Same code, PDO.
- Transcription is never done by PHP itself. Two engines:
  - `cloud`: PHP calls an **OpenAI-compatible** `/audio/transcriptions` endpoint (Groq, OpenAI, etc.) with cURL.
  - `worker`: a **Node.js worker on the owner's PC** polls the server, downloads the audio, runs Whisper locally
    (transformers.js, same approach as `browser-app/transcriber.html`), and posts the result back.
- Dashboard = static HTML/CSS/vanilla JS (no build step), served by the PHP app, hash-based routing (`#/projects/...`).
- Accepted audio by default: **mp3 only** (`allowed_extensions` config; owner may add m4a, wav, ...).

## 1. Folder layout

```
transcribe-api/
  SPEC.md                     this file
  README.md                   overview + local quick start (written last)
  docs/                       DEPLOY-CPANEL.md, API.md, N8N.md, WORKER.md (written last)
  browser-app/                existing in-browser transcriber (leave as is)
  samples/                    sample transcript (leave as is)
  server/                     ← the folder the owner uploads to cPanel
    index.php                 front controller (all routes), also the router script for `php -S`
    .htaccess                 rewrites + deny rules + Authorization passthrough
    .user.ini                 upload_max_filesize=100M, post_max_size=110M, max_execution_time=300, memory_limit=256M
    install.php               web + CLI installer (writes config.php, creates tables, first admin)
    config.sample.php         documented config template (installer writes config.php from it)
    src/                      PHP classes/functions (deny web access)
    cron/process.php          CLI only: process queued cloud jobs, reclaim stale worker jobs, retry webhooks, delete old audio
    storage/                  uploads/, logs/, .htaccess "Require all denied" (+ "Deny from all" for Apache 2.2)
    app/                      dashboard: index.html, app.js, app.css, favicon.svg
  worker/                     Node.js PC worker (package.json, worker.js, .env.example, start-worker.bat, README.md)
  n8n-nodes-transcribe-api/   n8n community node package (plain JS, no build step required)
  n8n-examples/               importable n8n workflow JSON files using the standard HTTP Request node
  tests/                      test scripts/fixtures used during development (not deployed)
```

## 2. Routing (server/index.php)

- Base path = directory of the executing `index.php` relative to the web root (app may live at `/` or `/transcribe/`).
  Route path = request path minus base path. Also accept `PATH_INFO` (`index.php/api/v1/...`) and `?route=/api/v1/...`
  as fallbacks when mod_rewrite is unavailable.
- Under `php -S host:port server/index.php` (cli-server): if the request maps to an existing file in `server/app/`
  (or other public static file), serve it (return false or readfile with correct MIME); never serve `src/`, `storage/`,
  `cron/`, `config*.php`, `install.php` source.
- `GET /` (and `/index.html`) → dashboard `app/index.html`. Static assets referenced RELATIVELY (`app/app.js`).
- Every `/api/...` response is JSON (`Content-Type: application/json; charset=utf-8`) except format downloads/audio.
- Unknown route → 404 `{"error":{"code":"not_found","message":"..."}}`.
- Security headers on all responses: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`; dashboard HTML also `Content-Security-Policy: default-src 'self'; img-src 'self' data:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'`.
- `.htaccess`: `RewriteEngine On`; pass `Authorization` header (`RewriteRule .* - [E=HTTP_AUTHORIZATION:%{HTTP:Authorization}]`
  and `CGIPassAuth On` inside `<IfModule>`-safe form); route non-files to `index.php`; deny `src/`, `storage/`, `cron/`,
  `config.php`, `config.sample.php`, `*.md`, dotfiles. Do NOT use `php_value` (breaks PHP-FPM).
  Read the API key from `HTTP_AUTHORIZATION`, `REDIRECT_HTTP_AUTHORIZATION`, `getallheaders()`, or `X-API-Key`.

## 3. Errors

HTTP status + body `{"error":{"code":"<snake_case>","message":"<human readable>"}}`.
Codes used: `unauthorized` 401, `invalid_api_key` 401, `forbidden` 403, `not_found` 404, `method_not_allowed` 405,
`validation_error` 422 (add `"field":"<name>"`), `file_too_large` 413, `unsupported_file_type` 415,
`rate_limited` 429, `engine_unavailable` 503, `csrf_failed` 403, `server_error` 500 (never leak stack traces;
log to `storage/logs/app.log`).

## 4. IDs, time, formats

- IDs: prefix + 24 lowercase hex from `random_bytes(12)`: `usr_`, `prj_`, `key_`, `tr_`.
- API keys: `tk_` + 40 hex (`random_bytes(20)`). Store only `sha256` hex hash + display prefix (first 11 chars, e.g. `tk_1a2b3c4d`).
  The full key is returned exactly once at creation.
- DB stores unix seconds (INT). API returns ISO-8601 UTC strings (`2026-10-14T09:30:00Z`) or null.
- Segment times are seconds (float, 2 decimals).

## 5. Database schema (portable: MySQL utf8mb4 InnoDB + SQLite)

All primary keys are VARCHAR(40) strings (no auto-increment). Use `MEDIUMTEXT` in MySQL / `TEXT` in SQLite for big text.

- `meta(name VARCHAR(64) PK, value TEXT)` — `schema_version` = `1`.
- `users(id PK, email VARCHAR(190) UNIQUE, name VARCHAR(190), password_hash VARCHAR(255), is_admin INT default 0,
  disabled_at INT NULL, created_at INT, last_login_at INT NULL)`.
- `projects(id PK, name VARCHAR(190), owner_id → users.id, default_engine VARCHAR(16) default 'cloud',
  default_language VARCHAR(16) NULL, webhook_url VARCHAR(2048) NULL, webhook_secret VARCHAR(80), created_at INT)`.
- `project_members(project_id, user_id, role VARCHAR(16) 'owner'|'member', created_at INT, PK(project_id,user_id))`.
- `api_keys(id PK, project_id, name VARCHAR(190), prefix VARCHAR(16), key_hash CHAR(64) UNIQUE, created_by,
  created_at INT, last_used_at INT NULL, revoked_at INT NULL)`.
- `transcriptions(id PK, project_id, api_key_id NULL, created_by NULL, status VARCHAR(16), engine VARCHAR(16),
  language VARCHAR(16) NULL, task VARCHAR(16) default 'transcribe', prompt TEXT NULL, filename VARCHAR(255),
  file_path VARCHAR(255) NULL, file_size INT, mime VARCHAR(100) NULL, duration REAL NULL, text MEDIUMTEXT NULL,
  segments MEDIUMTEXT NULL (JSON), detected_language VARCHAR(16) NULL, error TEXT NULL, metadata TEXT NULL (JSON),
  webhook_url VARCHAR(2048) NULL, webhook_status VARCHAR(32) NULL, webhook_attempts INT default 0,
  worker_name VARCHAR(100) NULL, attempts INT default 0, locked_until INT NULL, progress INT NULL,
  created_at INT, started_at INT NULL, completed_at INT NULL)`; indexes on (project_id, created_at), (status, engine, created_at).
- `login_attempts(id PK, ip VARCHAR(64), email VARCHAR(190), created_at INT)`.

Status values: `queued` → `processing` → `completed` | `failed`.

## 6. Config (`server/config.php`, returns a PHP array; installer writes it)

```php
return [
  'app_name' => 'Transcribe API',
  'base_url' => '',                // optional absolute URL, e.g. https://opraviq.com/transcribe (auto-detected if empty)
  'db' => ['driver' => 'mysql', 'host' => 'localhost', 'port' => 3306, 'name' => '', 'user' => '', 'pass' => '',
           'sqlite_path' => __DIR__ . '/storage/app.sqlite'],   // driver 'mysql' | 'sqlite'
  'storage_path' => __DIR__ . '/storage',
  'allow_registration' => false,
  'allowed_extensions' => ['mp3'],
  'max_upload_mb' => 100,
  'audio_retention_days' => 7,     // 0 = delete audio right after completion
  'default_engine' => 'cloud',     // used when project/request does not choose
  'cloud' => [
    'enabled' => true,
    'base_url' => 'https://api.groq.com/openai/v1',   // or https://api.openai.com/v1
    'api_key' => '',
    'model' => 'whisper-large-v3-turbo',              // OpenAI: whisper-1
    'translate_model' => 'whisper-large-v3',          // used for task=translate (POST /audio/translations)
    'max_mb' => 25,
    'timeout' => 600,
  ],
  'worker' => ['enabled' => true, 'tokens' => ['<random 48 hex>'], 'lease_seconds' => 900, 'max_attempts' => 3],
  'webhooks' => ['allow_private_hosts' => false, 'timeout' => 10, 'max_attempts' => 5],
  'cors_origins' => [],            // e.g. ['https://myapp.com'] or ['*'] for the public API only
  'session_name' => 'tapi_session',
];
```

## 7. Public REST API (API-key auth, scoped to the key's project)

Auth: `Authorization: Bearer tk_...` or `X-API-Key: tk_...`. Revoked/unknown → 401 `invalid_api_key`.
Update `api_keys.last_used_at` (at most once per minute is fine).

### Transcription object (shared by all components)
```json
{
  "id": "tr_...", "object": "transcription", "project_id": "prj_...",
  "status": "queued|processing|completed|failed", "engine": "cloud|worker",
  "language": "en", "detected_language": "en", "task": "transcribe|translate",
  "filename": "call.mp3", "file_size": 6553600, "duration": 819.4, "progress": 42,
  "text": "full transcript or null",
  "segments": [ {"id": 0, "start": 4.0, "end": 6.12, "text": "Thanks for taking the call."} ],
  "error": null, "metadata": {"any": "json object or null"},
  "webhook_status": "delivered|failed:<http code or reason>|pending|null",
  "created_at": "...", "started_at": "...", "completed_at": "..."
}
```
`segments`/`text` are `null` until completed. `progress` 0-100 or null.

### Endpoints
- `GET /api/v1/health` (no auth) → `{"ok":true,"version":"1.0.0","engines":{"cloud":bool,"worker":bool}}`.
- `POST /api/v1/transcriptions` — `multipart/form-data`:
  `file` (required), `language` (ISO-639-1, optional; default project default_language; null = auto),
  `task` (`transcribe`|`translate`), `engine` (`cloud`|`worker`; default project default_engine → config default),
  `prompt` (optional, ≤ 1000 chars, cloud only — vocabulary hints), `webhook_url` (optional; default project webhook_url),
  `metadata` (optional JSON object string ≤ 4 KB), `wait` (`true|1`: cloud only — process inside the request and return
  the finished object with 200; ignored for worker).
  Validations: extension in `allowed_extensions` (else 415), size ≤ `max_upload_mb` (else 413) and for cloud ≤ `cloud.max_mb`
  (413 with message suggesting engine=worker), engine enabled (else 503 `engine_unavailable`), cloud requires api_key set.
  Store file as `storage/uploads/<tr_id>.<ext>` (never trust client filename for the path; keep sanitized original name in `filename`).
  Response `202` with the transcription object (status `queued`), or `200` completed/failed when `wait` processed it.
  For cloud without `wait`: send the 202 response first, then if `fastcgi_finish_request()` or `litespeed_finish_request()`
  exists, flush and process in the same PHP process (`ignore_user_abort(true)`, `set_time_limit(0)`); otherwise cron picks it up.
- `GET /api/v1/transcriptions?status=&limit=20&offset=0` → `{"object":"list","data":[...],"total":N,"limit":20,"offset":0}`
  (newest first; list items omit `segments` and truncate nothing else).
- `GET /api/v1/transcriptions/{id}` → transcription object. `?format=txt|srt|vtt|json` → download (`text/plain` / `application/x-subrip` /
  `text/vtt`) when completed; 409 `not_ready` if not completed.
- `DELETE /api/v1/transcriptions/{id}` → `{"id":"tr_...","deleted":true}` (removes row + audio file).

### Webhooks
When a job completes or fails and it has a webhook_url: `POST` JSON
`{"event":"transcription.completed"|"transcription.failed","created_at":"...","data":<transcription object>}`
headers `Content-Type: application/json`, `User-Agent: TranscribeAPI/1.0`, `X-Transcribe-Event`, `X-Transcribe-Delivery: <tr_id>`,
`X-Transcribe-Signature: sha256=<hex HMAC-SHA256 of raw body with project webhook_secret>`.
2xx → `webhook_status=delivered`; else `failed:<code>`; cron retries failed deliveries (backoff, up to `webhooks.max_attempts`).
Only http/https; unless `allow_private_hosts`, reject URLs resolving to loopback/private/link-local/reserved IPs (SSRF guard)
both when accepted (422) and at delivery time.

## 8. Worker API (for the PC worker; auth `Authorization: Bearer <worker token from config.worker.tokens>`)

- `POST /api/worker/claim` body `{"worker":"my-pc"}` → `200 {"job":{"id","filename","language","task","engine":"worker",
  "file_size","audio_url":"<absolute or base-relative url of GET audio endpoint>","lease_seconds":900}}` or `204` (no content) when none.
  Claims the oldest `queued` job with engine `worker`, OR a `processing` worker job whose `locked_until < now` and
  `attempts < worker.max_attempts` (jobs over max attempts → failed). Atomic: `UPDATE ... WHERE id=? AND (status/lock condition)`
  and check affected rows. Sets status processing, started_at (if null), attempts+1, worker_name, locked_until=now+lease.
- `GET /api/worker/jobs/{id}/audio` → raw audio bytes (only for jobs currently claimed/processing, engine worker).
- `POST /api/worker/jobs/{id}/heartbeat` body `{"progress":0-100}` → extends lease, stores progress. `{"ok":true}`.
- `POST /api/worker/jobs/{id}/complete` body `{"text":"...","segments":[{start,end,text}],"duration":12.3,"detected_language":"en"}`
  → status completed, completed_at, ids assigned to segments (0..n-1), audio deleted if `audio_retention_days == 0`, fire webhook. `{"ok":true}`.
- `POST /api/worker/jobs/{id}/fail` body `{"error":"message","retry":false}` → `retry:true` puts it back to `queued` (if attempts < max)
  else `failed` + webhook. `{"ok":true}`.
All worker endpoints 404 for jobs not in `processing` state claimed by a worker.

## 9. Dashboard API (session cookie + CSRF; same-origin only; JSON bodies)

Session: PHP session named `config.session_name`, cookie `HttpOnly`, `SameSite=Lax`, `Secure` when HTTPS, path = base path.
`session_regenerate_id(true)` on login. CSRF: every non-GET `/api/dash/*` request except `login`/`register` must send header
`X-CSRF-Token` equal to the session token (returned by `/api/dash/me` and `/api/dash/login`). Missing/invalid → 403 `csrf_failed`.
Unauthenticated → 401 `unauthorized`. Login throttling: >10 failed attempts per IP per 15 min → 429.

- `POST /api/dash/login` `{email,password}` → `{"user":User,"csrf_token":"..."}`; `POST /api/dash/logout` → `{"ok":true}`.
- `POST /api/dash/register` `{name,email,password}` (only if `allow_registration`, else 403) → same as login.
- `GET /api/dash/me` → `{"user":User,"csrf_token":"...","config":{"allow_registration":bool,"engines":{"cloud":bool,"worker":bool},
  "allowed_extensions":[...],"max_upload_mb":N,"cloud_max_mb":N,"base_url":"https://.../","version":"1.0.0"}}`.
  User = `{"id","email","name","is_admin":bool,"created_at"}`.
- `POST /api/dash/password` `{current_password,new_password}` (min 8 chars).
- Projects (membership required; admins can access all):
  - `GET /api/dash/projects` → `{"data":[Project]}`; Project = `{"id","name","role":"owner|member","default_engine","default_language",
    "webhook_url","created_at","stats":{"transcriptions":N,"completed":N,"failed":N,"queued":N}}`.
  - `POST /api/dash/projects` `{name}` → Project (creator = owner); `GET/PATCH/DELETE /api/dash/projects/{id}`
    (PATCH: name, default_engine, default_language, webhook_url; owner only; DELETE owner only, removes jobs/files/keys).
  - `GET /api/dash/projects/{id}` also includes `"webhook_secret"` for owners.
  - `POST /api/dash/projects/{id}/webhook-secret` → `{"webhook_secret":"whsec_..."}` (rotate, owner only).
  - Keys (owner only): `GET /api/dash/projects/{id}/keys` → `{"data":[{"id","name","prefix","created_at","last_used_at","revoked_at"}]}`;
    `POST` `{name}` → key object + `"key":"tk_..."` (shown once); `DELETE /api/dash/projects/{id}/keys/{keyId}` → revoke.
  - Members: `GET /api/dash/projects/{id}/members` → `{"data":[{"user_id","email","name","role","created_at"}]}`;
    `POST` `{email, role:"member"}` (owner only; user must exist) ; `DELETE /api/dash/projects/{id}/members/{userId}` (owner only; cannot remove last owner).
  - Transcriptions: `GET /api/dash/projects/{id}/transcriptions?status=&limit=&offset=` (same list shape as public API);
    `POST /api/dash/projects/{id}/transcriptions` (same multipart fields/behaviour as the public API, created_by=user).
  - `GET /api/dash/transcriptions/{id}` (+ `?format=`), `DELETE /api/dash/transcriptions/{id}`,
    `GET /api/dash/transcriptions/{id}/audio` → audio with HTTP Range support (206) for seeking; 404 if file already deleted.
- Admin only: `GET /api/dash/users` → `{"data":[User + "disabled": bool]}`; `POST /api/dash/users` `{name,email,password,is_admin}`;
  `PATCH /api/dash/users/{id}` `{name?, password?, is_admin?, disabled?}` (cannot disable/demote yourself).

## 10. Dashboard UI (server/app)

Vanilla JS SPA (no frameworks, no CDN — CSP is self-only), light/dark via `prefers-color-scheme`, responsive (phone width works).
Visual style follows `browser-app/transcriber.html` (purple accent, cards, rounded corners).
Views: Login (+ Register if allowed) · Projects list (create) · Project page with tabs:
**Transcriptions** (drag-drop upload with language/task/engine/prompt options; list with status badges, auto-refresh while
queued/processing, progress %) · **Viewer** (Vibe-style: audio player, timestamped lines, click time to seek, active-line highlight,
copy, download TXT/SRT/VTT/JSON, delete) · **API keys** (create → show key once with copy button, revoke) · **Members** · **Settings**
(name, default engine/language, webhook URL + secret with rotate, delete project) · **Docs** (live curl examples using this
server's base URL; n8n instructions) · Account (change password, logout) · Admin → Users (create, disable, admin toggle).
Every mutating fetch sends `X-CSRF-Token`. Escape all user-provided text (no innerHTML with untrusted data).

## 11. PC worker (worker/)

Node.js ≥ 20, ESM. Deps: `@huggingface/transformers`, `ffmpeg-static`. Config via `.env` (parse it yourself; no dotenv dep needed):
`API_BASE` (e.g. https://opraviq.com/transcribe), `WORKER_TOKEN`, `WORKER_NAME` (default hostname), `MODEL`
(default `onnx-community/whisper-large-v3-turbo`), `DEVICE` (`cpu` default; `dml`/`cuda` optional), `DTYPE` (default `q8`),
`POLL_SECONDS` (default 10), `CACHE_DIR` (default `./models`).
Loop: claim → download audio to temp → ffmpeg-static → 16 kHz mono f32le → loudness normalise (same as browser app) →
seek-based 30 s windows (each window starts at end of last COMPLETE segment; same algorithm as browser app) →
heartbeat every ≤ 60 s with progress → complete (or fail with retry:true on transient errors). Graceful Ctrl+C.
`--once` flag (process at most one job then exit) for testing. Logs to console with timestamps. Never log the token.

## 12. n8n node (n8n-nodes-transcribe-api/)

Plain CommonJS JS in `dist/` (no TypeScript build needed), `package.json` with `"n8n": {"n8nNodesApiVersion":1,
"credentials":["dist/credentials/TranscribeApi.credentials.js"],"nodes":["dist/nodes/TranscribeApi/TranscribeApi.node.js"]}`,
keyword `n8n-community-node-package`.
Credential `transcribeApi`: `baseUrl`, `apiKey` (password field); generic auth header `Authorization: Bearer`; credential test
`GET {baseUrl}/api/v1/transcriptions?limit=1`.
Node "Transcribe API" resource Transcription, operations: **Transcribe** (binary property name default `data`, language, task,
engine, prompt, metadata JSON, webhook URL, `wait for completion` (default true) with poll interval + timeout — uses `wait=true`
for cloud, polls GET for worker), **Get** (id, output format json|txt|srt|vtt), **List** (status, limit), **Delete**.
Multipart body built manually as a Buffer with a boundary (works across n8n versions). Returns the transcription object as JSON.
Icon `transcribeApi.svg`.

## 13. n8n examples (n8n-examples/)

Importable workflow JSON using only built-in nodes (Manual Trigger, Read/Write Files from Disk or HTTP download,
HTTP Request with multipart form-data + header auth, Webhook). At least:
`1-transcribe-and-wait.json` (upload with wait=true → result), `2-webhook-receiver.json` (receive transcription.completed).
