<?php
/**
 * Shared bootstrap for index.php, install.php and cron/process.php:
 * constants, a tiny PSR-4 style autoloader for the Tapi\ namespace and PHP runtime defaults.
 */

declare(strict_types=1);

if (!defined('TAPI_VERSION')) {
    define('TAPI_VERSION', '1.0.0');
    define('TAPI_SERVER_DIR', str_replace('\\', '/', dirname(__DIR__)));

    spl_autoload_register(static function (string $class): void {
        $prefix = 'Tapi\\';
        if (strncmp($class, $prefix, strlen($prefix)) !== 0) {
            return;
        }
        $file = __DIR__ . '/' . str_replace('\\', '/', substr($class, strlen($prefix))) . '.php';
        if (is_file($file)) {
            require $file;
        }
    });

    // Never leak errors into responses; everything goes to storage/logs/app.log instead.
    ini_set('display_errors', '0');
    error_reporting(E_ALL);
    date_default_timezone_set('UTC');

    // Turn warnings/notices into exceptions so they are handled (and logged) in one place.
    // Errors silenced with @ are respected; deprecations are ignored.
    set_error_handler(static function (int $severity, string $message, string $file, int $line): bool {
        if (!(error_reporting() & $severity) || in_array($severity, [E_DEPRECATED, E_USER_DEPRECATED], true)) {
            return false;
        }
        throw new ErrorException($message, 0, $severity, $file, $line);
    });
}
