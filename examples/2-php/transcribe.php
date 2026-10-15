<?php

declare(strict_types=1);

/**
 * Transcribe one audio file from the command line (plain PHP + cURL).
 *
 *   php transcribe.php [file.mp3] [--engine=worker|cloud] [--language=en|auto] [--wait]
 *
 * Flow: upload -> ask for the status every 5 s -> print the lines -> save output/<name>.srt
 * --wait works only with engine=cloud: the server transcribes inside the upload request.
 */

require __DIR__ . '/env.php';
require __DIR__ . '/TranscribeApi.php';

const POLL_SECONDS = 5;
const TIMEOUT_MINUTES = 60;

if (PHP_SAPI !== 'cli') {
    exit("Run this script from the command line.\n");
}

// --- 1. Arguments and settings ---------------------------------------------------------
$options = ['engine' => null, 'language' => null, 'wait' => false];
$file = null;
foreach (array_slice($argv, 1) as $arg) {
    if (preg_match('/^--(engine|language)=(.*)$/', $arg, $m)) {
        $options[$m[1]] = $m[2];
    } elseif ($arg === '--wait') {
        $options['wait'] = true;
    } elseif ($arg === '--help' || $arg === '-h') {
        exit("Usage: php transcribe.php [file.mp3] [--engine=worker|cloud] [--language=en|auto] [--wait]\n");
    } else {
        $file = $arg;
    }
}

try {
    $settings = load_env(__DIR__ . '/../.env');
} catch (RuntimeException $e) {
    fail($e->getMessage());
}

$file ??= __DIR__ . '/../sample/clip.mp3';
$engine = $options['engine'] ?? ($settings['TRANSCRIBE_ENGINE'] ?? 'worker') ?: 'worker';
// "auto" = Whisper detects the language. Empty = not sent = the project default language.
$language = $options['language'] ?? ($settings['TRANSCRIBE_LANGUAGE'] ?? '');
if ($options['wait'] && $engine !== 'cloud') {
    echo "Note: --wait only works with --engine=cloud. The script polls instead.\n";
    $options['wait'] = false;
}
if (!is_file($file)) {
    fail("File not found: $file");
}
$file = realpath($file);

$api = new TranscribeApi($settings['TRANSCRIBE_API_URL'], $settings['TRANSCRIBE_API_KEY'], 600);

echo "Transcribe API - PHP command line demo\n";
echo "  Server:   {$settings['TRANSCRIBE_API_URL']}\n";
echo '  Key:      ' . key_hint($settings['TRANSCRIBE_API_KEY']) . "\n";
echo "  File:     $file\n";
echo "  Engine:   $engine    Language: " . ($language === '' ? '(project default)' : $language)
    . ($options['wait'] ? '    wait: yes' : '') . "\n\n";

// --- 2. Upload -----------------------------------------------------------------------------
echo $options['wait'] ? "Uploading and transcribing (cloud, wait=true)...\n" : "Uploading...\n";
try {
    $job = $api->upload($file, [
        'engine' => $engine,
        'language' => $language,                      // '' is not sent
        'wait' => $options['wait'] ? 'true' : null,   // null is not sent
    ]);
} catch (TranscribeApiException $e) {
    fail("Upload failed: {$e->getMessage()} ({$e->errorCode})");
}
echo "  Created {$job['id']} (status: {$job['status']})\n\n";

// --- 3. Poll until the job is completed or failed -------------------------------------------
if (!in_array($job['status'], ['completed', 'failed'], true)) {
    echo 'Waiting for the result (checking every ' . POLL_SECONDS . " s, Ctrl+C to stop)...\n";
}
$started = time();
$lastLine = '';
$lastPrint = 0;
$errorsInRow = 0;
while (!in_array($job['status'], ['completed', 'failed'], true)) {
    sleep(POLL_SECONDS);
    $elapsed = time() - $started;
    if ($elapsed > TIMEOUT_MINUTES * 60) {
        fail('Still not done after ' . TIMEOUT_MINUTES . " minutes. The job keeps running on the server: {$job['id']}");
    }
    try {
        $job = $api->get($job['id']);
        $errorsInRow = 0;
    } catch (TranscribeApiException $e) {
        // Do not give up on one network problem; try again a few times.
        if (++$errorsInRow >= 5 || $e->httpStatus === 404 || $e->httpStatus === 401) {
            fail("Status check failed: {$e->getMessage()}");
        }
        echo "  (status check failed, trying again: {$e->getMessage()})\n";
        continue;
    }
    $line = $job['status'] . ($job['progress'] !== null ? " {$job['progress']}%" : '');
    // Print when something changed, or every 30 s so you know it is still alive.
    if ($line !== $lastLine || $elapsed - $lastPrint >= 30) {
        printf("  [%4d s] %s\n", $elapsed, $line);
        $lastLine = $line;
        $lastPrint = $elapsed;
    }
}

if ($job['status'] === 'failed') {
    fail('Transcription failed: ' . ($job['error'] ?? 'unknown error'));
}

// --- 4. Print the timestamped lines and save the SRT file -----------------------------------
printf("\nDone. Audio length: %s s, language: %s\n\n", $job['duration'] ?? '?', $job['detected_language'] ?? '?');
foreach ($job['segments'] ?? [] as $segment) {
    printf("[%s] %s\n", clock((float) $segment['start']), trim((string) $segment['text']));
}

$outDir = __DIR__ . DIRECTORY_SEPARATOR . 'output';
if (!is_dir($outDir)) {
    mkdir($outDir, 0777, true);
}
$srtFile = $outDir . DIRECTORY_SEPARATOR . pathinfo($file, PATHINFO_FILENAME) . '.srt';
file_put_contents($srtFile, $api->download($job['id'], 'srt'));

echo "\nSaved $srtFile\n";
echo "Transcription id: {$job['id']} (also visible in the dashboard)\n";
exit(0);

// --- helpers --------------------------------------------------------------------------------

/** 75.5 -> "01:15.5" */
function clock(float $seconds): string
{
    $minutes = intdiv((int) $seconds, 60);
    return sprintf('%02d:%04.1f', $minutes, $seconds - $minutes * 60);
}

function fail(string $message): never
{
    fwrite(STDERR, "\nERROR: $message\n");
    exit(1);
}
