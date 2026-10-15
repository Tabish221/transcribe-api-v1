<?php

declare(strict_types=1);

/**
 * Tiny PHP website for the Transcribe API.
 *
 *   Browser --(upload form)--> this page --(file + API key)--> Transcribe API
 *
 * The API key stays on the server. The browser only talks to this page.
 * Start:  php -S 127.0.0.1:3002 -t web     (or double-click start-web.bat)
 *
 * Pages:
 *   GET  /                      upload form
 *   POST /                      forward the file to the API, then redirect to ?id=...
 *   GET  /?id=tr_...            status; refreshes every 5 s until the transcript is ready
 *   GET  /?id=tr_...&download=srt|txt   transcript file (fetched by PHP with the key)
 */

require __DIR__ . '/../env.php';
require __DIR__ . '/../TranscribeApi.php';

const REFRESH_SECONDS = 5;

session_start(['cookie_httponly' => true, 'cookie_samesite' => 'Lax', 'use_strict_mode' => true]);
$_SESSION['csrf'] ??= bin2hex(random_bytes(16)); // protects the upload form
$_SESSION['jobs'] ??= [];                         // ids uploaded from this browser (newest last)

header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: no-referrer');
header("Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");

$error = null;
$job = null;
$api = null;
$settings = [];

try {
    $settings = load_env(__DIR__ . '/../../.env');
    $api = new TranscribeApi($settings['TRANSCRIBE_API_URL'], $settings['TRANSCRIBE_API_KEY'], 600);
} catch (RuntimeException $e) {
    $error = $e->getMessage();
}

// Only show jobs that this browser uploaded. In a real app, check your own database instead.
$id = get_string('id');
if ($id !== '' && !in_array($id, $_SESSION['jobs'], true)) {
    $error = 'Unknown transcription. Please upload a file.';
    $id = '';
}

// --- 1. Upload: forward the browser's file to the API ------------------------------------------
if ($api !== null && $_SERVER['REQUEST_METHOD'] === 'POST') {
    try {
        if ($_POST === [] && $_FILES === []) {
            throw new RuntimeException('The file is too big for this page (PHP post_max_size is ' . ini_get('post_max_size') . ').');
        }
        if (!hash_equals($_SESSION['csrf'], post_string('csrf'))) {
            throw new RuntimeException('The form expired. Please try again.');
        }
        $file = $_FILES['audio'] ?? [];
        $uploadError = is_int($file['error'] ?? null) ? $file['error'] : UPLOAD_ERR_NO_FILE;
        if ($uploadError !== UPLOAD_ERR_OK) {
            throw new RuntimeException(upload_error_text($uploadError));
        }
        $job = $api->upload((string) $file['tmp_name'], [
            'engine' => in_array(post_string('engine'), ['worker', 'cloud'], true) ? post_string('engine') : 'worker',
            // "en", "de", ... or "auto" (detect). Empty = not sent = project default. The API validates it.
            'language' => post_string('language'),
        ], (string) $file['name']); // the original name keeps the ".mp3" extension the API checks

        $_SESSION['jobs'] = array_slice([...$_SESSION['jobs'], $job['id']], -20);
        header('Location: ?id=' . rawurlencode($job['id']), true, 303); // Post/Redirect/Get
        exit;
    } catch (RuntimeException $e) {
        $error = 'Upload failed: ' . $e->getMessage();
        $job = null;
    }
}

// --- 2. Status (and download) of one job ------------------------------------------------------
if ($api !== null && $id !== '') {
    try {
        $job = $api->get($id);
        if (isset($_GET['download']) && $job['status'] === 'completed') {
            $format = get_string('download') === 'txt' ? 'txt' : 'srt';
            $content = $api->download($id, $format);
            $name = preg_replace('/[^A-Za-z0-9._-]+/', '_', pathinfo((string) $job['filename'], PATHINFO_FILENAME)) ?: $id;
            header('Content-Type: ' . ($format === 'srt' ? 'application/x-subrip' : 'text/plain') . '; charset=utf-8');
            header('Content-Disposition: attachment; filename="' . $name . '.' . $format . '"');
            echo $content;
            exit;
        }
    } catch (RuntimeException $e) {
        $error = $e->getMessage();
        $job = null;
    }
}

$working = $job !== null && in_array($job['status'], ['queued', 'processing'], true);
$defaultEngine = ($settings['TRANSCRIBE_ENGINE'] ?? '') === 'cloud' ? 'cloud' : 'worker';
$defaultLanguage = $settings['TRANSCRIBE_LANGUAGE'] ?? '';

// --- helpers ---------------------------------------------------------------------------------

/** Escape text for HTML. Use it for EVERY value you print. */
function e(mixed $value): string
{
    return htmlspecialchars((string) $value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

function get_string(string $name): string
{
    return isset($_GET[$name]) && is_string($_GET[$name]) ? trim($_GET[$name]) : '';
}

function post_string(string $name): string
{
    return isset($_POST[$name]) && is_string($_POST[$name]) ? trim($_POST[$name]) : '';
}

/** 75.5 -> "01:15.5" */
function clock(float $seconds): string
{
    $minutes = intdiv((int) $seconds, 60);
    return sprintf('%02d:%04.1f', $minutes, $seconds - $minutes * 60);
}

function upload_error_text(int $code): string
{
    return match ($code) {
        UPLOAD_ERR_INI_SIZE, UPLOAD_ERR_FORM_SIZE => 'The file is too big (PHP upload_max_filesize is ' . ini_get('upload_max_filesize') . ').',
        UPLOAD_ERR_PARTIAL => 'The upload was interrupted. Please try again.',
        UPLOAD_ERR_NO_FILE => 'Please choose an audio file.',
        default => "PHP could not save the upload (error $code).",
    };
}
?>
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <?php if ($working): ?><meta http-equiv="refresh" content="<?= REFRESH_SECONDS ?>"><?php endif; ?>
  <title>Transcribe - PHP demo</title>
  <style>
    :root { --bg:#f6f7f9; --card:#fff; --text:#1c2024; --muted:#5f6b76; --line:#e2e5e9; --accent:#2f6fde; --ok:#1f8a4c; --bad:#c53030; --warn:#b7791f; --on-accent:#fff; }
    @media (prefers-color-scheme: dark) {
      :root { --bg:#111418; --card:#1a1f25; --text:#e7eaee; --muted:#9aa5b1; --line:#2b323a; --accent:#6ea0ff; --ok:#4cc38a; --bad:#ff7b7b; --warn:#f0b452; --on-accent:#0b1220; }
    }
    * { box-sizing: border-box; }
    body { margin:0; background:var(--bg); color:var(--text); font:15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
    main { max-width:780px; margin:0 auto; padding:24px 16px 48px; }
    a { color:var(--accent); }
    h1 { font-size:22px; margin:0 0 4px; }
    .sub { color:var(--muted); margin:0 0 20px; }
    .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:18px; margin-bottom:16px; }
    .card h2 { font-size:16px; margin:0 0 12px; }
    label { display:block; font-weight:600; margin:10px 0 4px; }
    input[type=file], input[type=text], select { width:100%; padding:8px; border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--text); font:inherit; }
    .row { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
    button, .btn { display:inline-block; margin-top:14px; padding:9px 16px; border:0; border-radius:6px; background:var(--accent); color:var(--on-accent); font:inherit; font-weight:600; text-decoration:none; cursor:pointer; }
    .btn.light { background:transparent; color:var(--accent); border:1px solid var(--accent); }
    .error { border-color:var(--bad); color:var(--bad); }
    .badge { display:inline-block; padding:1px 8px; border-radius:99px; font-size:13px; font-weight:600; border:1px solid currentColor; }
    .queued, .processing { color:var(--warn); } .completed { color:var(--ok); } .failed { color:var(--bad); }
    .meta { color:var(--muted); font-size:13px; margin:6px 0 0; }
    progress { width:100%; height:14px; margin-top:12px; accent-color:var(--accent); }
    table { width:100%; border-collapse:collapse; margin-top:12px; }
    td { padding:6px 4px; border-top:1px solid var(--line); vertical-align:top; }
    td.t { white-space:nowrap; color:var(--muted); font-variant-numeric:tabular-nums; width:1%; padding-right:12px; }
    details { margin-top:12px; } pre { white-space:pre-wrap; margin:8px 0 0; font:inherit; }
    ul { margin:0; padding-left:18px; } code { font-size:13px; }
    @media (max-width:520px) { .row { grid-template-columns:1fr; } }
  </style>
</head>
<body>
<main>
  <h1>Transcribe API - PHP demo</h1>
  <p class="sub">Upload an audio file. PHP sends it to the API with the key. Your browser never sees the key.</p>

  <?php if ($error !== null): ?>
    <div class="card error"><?= e($error) ?></div>
  <?php endif; ?>

  <?php if ($job !== null): ?>
    <div class="card">
      <h2><?= e($job['filename']) ?> <span class="badge <?= e($job['status']) ?>"><?= e($job['status']) ?></span></h2>
      <p class="meta">
        Id <code><?= e($job['id']) ?></code> &middot; engine <?= e($job['engine']) ?>
        <?php if ($job['duration'] !== null): ?> &middot; <?= e($job['duration']) ?> s audio<?php endif; ?>
        <?php if ($job['detected_language'] !== null): ?> &middot; language <?= e($job['detected_language']) ?><?php endif; ?>
      </p>

      <?php if ($working): ?>
        <?php if ($job['status'] === 'queued'): ?>
          <p>Waiting in the queue. The worker takes one job at a time.</p>
          <progress></progress>
        <?php else: ?>
          <p>Transcribing... <?= e($job['progress'] ?? 0) ?>%</p>
          <progress max="100" value="<?= e($job['progress'] ?? 0) ?>"></progress>
        <?php endif; ?>
        <p class="meta">This page refreshes every <?= REFRESH_SECONDS ?> seconds.</p>

      <?php elseif ($job['status'] === 'completed'): ?>
        <a class="btn" href="?id=<?= e(rawurlencode($job['id'])) ?>&amp;download=srt">Download SRT</a>
        <a class="btn light" href="?id=<?= e(rawurlencode($job['id'])) ?>&amp;download=txt">Download TXT</a>
        <table>
          <?php foreach ($job['segments'] ?? [] as $segment): ?>
            <tr><td class="t"><?= e(clock((float) $segment['start'])) ?></td><td><?= e(trim((string) $segment['text'])) ?></td></tr>
          <?php endforeach; ?>
        </table>
        <details><summary>Full text</summary><pre><?= e($job['text']) ?></pre></details>

      <?php else: ?>
        <p class="failed">The transcription failed: <?= e($job['error'] ?? 'unknown error') ?></p>
      <?php endif; ?>
    </div>
  <?php endif; ?>

  <form class="card" method="post" action="./" enctype="multipart/form-data">
    <h2><?= $job !== null ? 'Upload another file' : 'Upload audio' ?></h2>
    <input type="hidden" name="csrf" value="<?= e($_SESSION['csrf']) ?>">
    <label for="audio">Audio file (.mp3, max <?= e(ini_get('upload_max_filesize')) ?>)</label>
    <input id="audio" type="file" name="audio" accept=".mp3,audio/mpeg" required>
    <div class="row">
      <div>
        <label for="engine">Engine</label>
        <select id="engine" name="engine">
          <option value="worker" <?= $defaultEngine === 'worker' ? 'selected' : '' ?>>worker (your PC)</option>
          <option value="cloud" <?= $defaultEngine === 'cloud' ? 'selected' : '' ?>>cloud (Groq / OpenAI)</option>
        </select>
      </div>
      <div>
        <label for="language">Language (en, de, ... or auto)</label>
        <input id="language" type="text" name="language" value="<?= e($defaultLanguage) ?>" maxlength="8" placeholder="empty = project default">
        <p class="meta">auto = detect the language. Empty = the project's default language.</p>
      </div>
    </div>
    <button type="submit">Transcribe</button>
  </form>

  <?php if ($_SESSION['jobs'] !== []): ?>
    <div class="card">
      <h2>Your uploads (this browser)</h2>
      <ul>
        <?php foreach (array_reverse($_SESSION['jobs']) as $jobId): ?>
          <li><a href="?id=<?= e(rawurlencode($jobId)) ?>"><code><?= e($jobId) ?></code></a></li>
        <?php endforeach; ?>
      </ul>
    </div>
  <?php endif; ?>
</main>
</body>
</html>
