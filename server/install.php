<?php
/**
 * Transcribe API - installer.
 *
 * Browser: open https://your-site/path/install.php and follow the wizard.
 * CLI:     php install.php --driver=sqlite --admin-email=you@example.com --admin-password=secret123
 *          (php install.php --help lists every option)
 *
 * Writes config.php ($TAPI_CONFIG or server/config.php), creates the tables and the first admin,
 * then locks itself with storage/installed.lock.
 */

declare(strict_types=1);

require_once __DIR__ . '/src/bootstrap.php';

if (PHP_SAPI === 'cli') {
    exit(\Tapi\InstallerCli::main($argv ?? []));
}

\Tapi\Response::securityHeaders();
try {
    \Tapi\InstallerWeb::handle();
} catch (\Throwable $e) {
    \Tapi\Logger::exception($e, 'Installer crashed');
    \Tapi\Response::html('<!doctype html><meta charset="utf-8"><title>Installer error</title><p>The installer hit an unexpected error. '
        . 'Details were written to storage/logs/app.log.</p>', 500);
}
