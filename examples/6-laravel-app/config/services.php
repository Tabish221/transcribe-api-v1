<?php

return [

    /*
    |--------------------------------------------------------------------------
    | Third Party Services
    |--------------------------------------------------------------------------
    |
    | This file is for storing the credentials for third party services such
    | as Mailgun, Postmark, AWS and more. This file provides the de facto
    | location for this type of information, allowing packages to have
    | a conventional file to locate the various service credentials.
    |
    */

    'postmark' => [
        'key' => env('POSTMARK_API_KEY'),
    ],

    'resend' => [
        'key' => env('RESEND_API_KEY'),
    ],

    'ses' => [
        'key' => env('AWS_ACCESS_KEY_ID'),
        'secret' => env('AWS_SECRET_ACCESS_KEY'),
        'region' => env('AWS_DEFAULT_REGION', 'us-east-1'),
    ],

    'slack' => [
        'notifications' => [
            'bot_user_oauth_token' => env('SLACK_BOT_USER_OAUTH_TOKEN'),
            'channel' => env('SLACK_BOT_USER_DEFAULT_CHANNEL'),
        ],
    ],

    /*
    | Transcribe API (self-hosted). Values come from .env, never from the browser.
    */
    'transcribe' => [
        // Base URL WITHOUT /api/v1, e.g. https://example.com/transcribe
        'url' => rtrim((string) env('TRANSCRIBE_API_URL', ''), '/'),
        // tk_... (Dashboard -> project -> API keys). Server side only.
        'key' => (string) env('TRANSCRIBE_API_KEY', ''),
        // worker = your PC, cloud = Groq/OpenAI
        'engine' => env('TRANSCRIBE_ENGINE') ?: 'worker',
        // ISO-639-1 code like "en"; empty = auto-detect
        'language' => (string) env('TRANSCRIBE_LANGUAGE', ''),
        // Checks the X-Transcribe-Signature header of incoming webhooks
        'webhook_secret' => (string) env('TRANSCRIBE_WEBHOOK_SECRET', ''),
        // Full URL the API should call when a job is done. Empty = url('/webhooks/transcribe')
        'webhook_url' => env('TRANSCRIBE_WEBHOOK_URL') ?: null,
        // Seconds for uploads (and the default for everything else)
        'timeout' => (int) (env('TRANSCRIBE_TIMEOUT') ?: 120),
        // Seconds for quick calls (status, list, srt, delete). Keep it below 10.
        'read_timeout' => (int) (env('TRANSCRIBE_READ_TIMEOUT') ?: 8),
        // Biggest upload this app accepts (MB). PHP's upload_max_filesize can make it smaller.
        'max_upload_mb' => (int) (env('TRANSCRIBE_MAX_UPLOAD_MB') ?: 100),
        // Keep a copy of the uploaded mp3 so the App page can play it later
        'keep_audio' => (bool) env('TRANSCRIBE_KEEP_AUDIO', true),
        // Show the /tester page. Turn it off on a public server.
        'tester' => (bool) env('TRANSCRIBE_TESTER', true),
        // How the tester sends a simulated webhook to this app: auto | http | direct
        // auto = direct when running on "php artisan serve" (it handles one request at a time)
        'simulate_via' => env('TRANSCRIBE_SIMULATE_VIA') ?: 'auto',
    ],

];
