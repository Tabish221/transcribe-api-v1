<?php
/**
 * Transcribe API - cron worker (CLI only). Run every minute, e.g. in cPanel "Cron Jobs":
 *
 *   * * * * * /usr/local/bin/php /home/USER/public_html/transcribe/cron/process.php --quiet
 *
 * Options: --budget=50 (seconds spent on cloud jobs/webhooks), --quiet, --config=/path/to/config.php
 * A file lock prevents overlapping runs.
 */

declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit("Forbidden: run this script with the PHP CLI (e.g. /usr/local/bin/php).\n");
}

require_once dirname(__DIR__) . '/src/bootstrap.php';

exit(\Tapi\Cron::main($argv ?? []));
