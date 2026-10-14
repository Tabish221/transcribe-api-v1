<?php
/**
 * Transcribe API - configuration template.
 *
 * install.php writes config.php for you. To configure by hand instead, copy this file to config.php
 * (or point the TAPI_CONFIG environment variable at another location) and fill in the values.
 * Options missing from config.php fall back to the defaults shown here.
 * This file is blocked from web access by .htaccess.
 */

return [
    'app_name' => 'Transcribe API',

    // Public URL of the app, e.g. https://opraviq.com/transcribe. Auto-detected from the request when empty.
    // Used for the worker's audio_url and the dashboard's API examples.
    'base_url' => '',

    'db' => [
        'driver' => 'mysql',           // 'mysql' (MySQL/MariaDB, recommended on cPanel) or 'sqlite'
        'host' => 'localhost',
        'port' => 3306,
        'name' => '',                  // cPanel: usually "cpaneluser_dbname"
        'user' => '',
        'pass' => '',
        'sqlite_path' => __DIR__ . '/storage/app.sqlite',   // only used by the sqlite driver
    ],

    // Uploads (storage/uploads), logs (storage/logs) and sessions (storage/sessions). Must be writable
    // and never web-accessible (storage/.htaccess denies everything).
    'storage_path' => __DIR__ . '/storage',

    'allow_registration' => false,     // true = anyone can create an account from the login page
    'allowed_extensions' => ['mp3'],   // add e.g. 'm4a', 'wav' to accept more formats
    'max_upload_mb' => 100,            // keep .user.ini upload_max_filesize/post_max_size above this
    'audio_retention_days' => 7,       // delete audio this many days after a job finishes; 0 = right away
    'default_engine' => 'cloud',       // used when neither the request nor the project chooses one

    // "cloud" engine: any OpenAI-compatible speech-to-text API.
    'cloud' => [
        'enabled' => true,
        'base_url' => 'https://api.groq.com/openai/v1',   // or https://api.openai.com/v1
        'api_key' => '',                                  // empty = cloud engine unavailable
        'model' => 'whisper-large-v3-turbo',              // OpenAI: whisper-1
        'translate_model' => 'whisper-large-v3',          // used for task=translate (POST /audio/translations)
        'max_mb' => 25,                                   // provider upload limit; bigger files need engine=worker
        'timeout' => 600,                                 // seconds per API call
        'max_attempts' => 3,                              // retries for transient errors (timeouts, 429, 5xx)
    ],

    // "worker" engine: the Node.js worker on your PC (see worker/README.md).
    'worker' => [
        'enabled' => true,
        // WORKER_TOKEN values accepted by /api/worker/* (min 16 chars; this placeholder is ignored until replaced).
        // Generate one with: php -r "echo bin2hex(random_bytes(24));"
        'tokens' => ['<random 48 hex>'],
        'lease_seconds' => 900,            // a claimed job returns to the queue if no heartbeat arrives in time
        'max_attempts' => 3,               // claims per job before it is marked failed
    ],

    'webhooks' => [
        'allow_private_hosts' => false,    // true only for local testing (disables the SSRF guard)
        'timeout' => 10,                   // seconds per delivery
        'max_attempts' => 5,               // deliveries per job (cron retries with backoff)
    ],

    // CORS for the public API (/api/v1) only, e.g. ['https://myapp.com'] or ['*'].
    'cors_origins' => [],

    'session_name' => 'tapi_session',
];
