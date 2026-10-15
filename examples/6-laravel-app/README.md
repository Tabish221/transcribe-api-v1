# Transcribe API — Laravel demo app

A small Laravel 12 app that uses your self-hosted **Transcribe API**.

It has two pages:

| Page | URL | What it does |
|------|-----|--------------|
| **App** | http://127.0.0.1:8000 | What a user sees. Drop an MP3, follow the status, read the text, play the audio from any line, copy the text, download SRT, delete. |
| **Backend tester** | http://127.0.0.1:8000/tester | For you, the developer. One card per API call (health, list, upload, get, format, delete, webhook test). Shows the request (key masked) and the answer side by side. Has a live "Webhooks received" table and a **Run all checks** button. |

The API key and the webhook secret stay on the server. The browser never sees them (the pages show `tk_1234…` only).

---

## 1. Start it

**Easy way:** double-click `start.bat`. It runs the server and opens the browser.

**By hand** (in this folder):

```
C:\xampp\php\php.exe artisan migrate
C:\xampp\php\php.exe artisan serve --host=127.0.0.1 --port=8000
```

Then open http://127.0.0.1:8000. Stop the server with Ctrl+C.

No `npm` is needed. CSS and JavaScript are plain files in `public/css` and `public/js`.

## 2. Settings (`.env`)

```
TRANSCRIBE_API_URL=http://127.0.0.1:8088      # your API, without /api/v1
TRANSCRIBE_API_KEY=tk_...                      # Dashboard -> project -> API keys
TRANSCRIBE_ENGINE=worker                       # worker = your PC, cloud = Groq/OpenAI
TRANSCRIBE_LANGUAGE=en                         # empty or "auto" = detect
TRANSCRIBE_WEBHOOK_SECRET=whsec_...            # Dashboard -> project -> Settings
TRANSCRIBE_WEBHOOK_URL=                        # empty = this app's own /webhooks/transcribe
TRANSCRIBE_TESTER=true                         # false = hide /tester (do this on a public server)
```

More options are in `config/services.php` (`transcribe` section): timeouts, max upload size,
keep a copy of the MP3 for the player, and how the tester sends a test webhook.

After you change `.env`, restart `php artisan serve`. (If you ran `php artisan config:cache`, run it again.)

## 3. How it works

```
Browser ──upload mp3──> Laravel (AppController) ──POST /api/v1/transcriptions──> Transcribe API
                           │  saves a local row "transcriptions" (remote_id = tr_...)
                           │
Transcribe API ──POST /webhooks/transcribe (signed)──> Laravel (TranscribeWebhookController)
                           │  checks X-Transcribe-Signature, saves text + segments
Browser <──polls /app-api/transcriptions/{id} every 4 s while "queued" or "processing"
```

* The webhook is checked like this: `sha256=` + HMAC-SHA256 of the raw body with your webhook secret,
  compared with `hash_equals`. Wrong or missing signature = **401** and the call is logged.
* If the webhook cannot reach your app, nothing breaks: the page asks the API for the status itself.
* Every webhook call (good or bad) is stored in the table `webhook_logs` and shown on the tester page.

## 4. Files you can copy into your own Laravel project

| File | What it is |
|------|------------|
| `app/Services/TranscribeClient.php` | The API client (Laravel `Http`). `health()`, `upload()`, `get()`, `list()`, `format()`, `delete()`. |
| `app/Services/TranscribeResult.php` | The answer of one call: `ok`, `status`, `data`, `body`, `error`, `durationMs`, `request`. |
| `app/Services/TranscribeException.php` | Thrown by `->throw()` / `->json()` when a call failed. |
| `app/Http/Controllers/TranscribeWebhookController.php` | Receives and checks the webhook. |
| `app/Models/Transcription.php` + its migration | Your local copy of each job (optional). |
| `config/services.php` → `transcribe` section | The settings. |

Steps:

1. Copy the files above (keep the same folders).
2. Add the `transcribe` section to your `config/services.php` and the `TRANSCRIBE_...` lines to your `.env`.
3. Add the webhook route to `routes/web.php`:
   ```php
   Route::post('/webhooks/transcribe', \App\Http\Controllers\TranscribeWebhookController::class);
   ```
4. Let the webhook skip CSRF in `bootstrap/app.php`:
   ```php
   ->withMiddleware(function (Middleware $middleware): void {
       $middleware->validateCsrfTokens(except: ['webhooks/transcribe']);
   })
   ```
5. Run `php artisan migrate` (only if you copied the model and migrations).

Use the client in your code:

```php
use App\Services\TranscribeClient;

$client = app(TranscribeClient::class);

// Start a job. ->json() throws TranscribeException when the API says no.
$job = $client->upload($path, 'call.mp3', [
    'engine' => 'worker',
    'language' => 'en',
    'webhook_url' => url('/webhooks/transcribe'),
])->json();                                   // $job['id'] = "tr_...", $job['status'] = "queued"

$job = $client->get($job['id'])->json();      // status, progress, text, segments
$srt = $client->format($job['id'], 'srt')->throw()->body;   // txt | srt | vtt | json, when completed
$client->delete($job['id'])->throw();

// Or check yourself, without exceptions:
$result = $client->get('tr_123');
if (! $result->ok) {
    logger()->warning($result->error['message']);   // e.g. "Transcription not found" (status 404)
}
```

Cloud engine, wait for the result in the same request (only when the cloud engine is set up on the API):

```php
$job = $client->upload($path, 'call.mp3', ['engine' => 'cloud', 'wait' => true])->json();
// $job['status'] is "completed" or "failed" here
```

## 5. Use the live API on your cPanel server later

1. In `.env` set `TRANSCRIBE_API_URL=https://your-domain.com/transcribe` (the folder where the API is installed,
   without `/api/v1`) and the key and webhook secret of that installation.
2. The live API must be able to reach your webhook URL:
   * If this Laravel app is also online: nothing to do, the webhook URL is `https://your-app.com/webhooks/transcribe`.
   * If this app runs only on your PC: the live API cannot call `127.0.0.1`. Use a tunnel (for example
     Cloudflare Tunnel or ngrok) and set `TRANSCRIBE_WEBHOOK_URL=https://your-tunnel-url/webhooks/transcribe`.
     Without a webhook the App page still works: it asks the API for the status every 4 seconds.
3. On a public server set `TRANSCRIBE_TESTER=false` and `APP_DEBUG=false`.
4. Restart the app (or run `php artisan config:cache` again).

## 6. Tests

```
C:\xampp\php\php.exe artisan test
```

The tests use `Http::fake()`. They never call your real API, and they use a fake key (see `phpunit.xml`).

## Good to know

* `php artisan serve` handles **one request at a time**. That is why the tester sends its test webhook
  directly inside the app, not over HTTP. On Apache or nginx it uses a real HTTP call
  (`TRANSCRIBE_SIMULATE_VIA=auto`).
* The biggest upload is the smallest of `TRANSCRIBE_MAX_UPLOAD_MB` and PHP's `upload_max_filesize`
  / `post_max_size` (XAMPP: 40 MB). The page shows the limit.
* Uploaded MP3 copies are in `storage/app/private/audio`. They are deleted with the job.
  Set `TRANSCRIBE_KEEP_AUDIO=false` to not keep them.
