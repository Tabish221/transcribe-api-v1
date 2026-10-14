<?php

declare(strict_types=1);

namespace Tapi;

/** Append-only log at storage/logs/app.log (rotated at 5 MB). Never pass secrets in $context. */
final class Logger
{
    private const MAX_BYTES = 5 * 1024 * 1024;

    public static function error(string $message, array $context = []): void
    {
        self::write('ERROR', $message, $context);
    }

    public static function warning(string $message, array $context = []): void
    {
        self::write('WARN', $message, $context);
    }

    public static function info(string $message, array $context = []): void
    {
        self::write('INFO', $message, $context);
    }

    public static function exception(\Throwable $e, string $message = 'Unhandled exception'): void
    {
        self::error($message, [
            'type' => get_class($e),
            'message' => $e->getMessage(),
            'at' => basename($e->getFile()) . ':' . $e->getLine(),
            'trace' => array_slice(explode("\n", $e->getTraceAsString()), 0, 12),
        ]);
    }

    private static function write(string $level, string $message, array $context): void
    {
        try {
            $dir = Config::storagePath('logs');
        } catch (\Throwable $e) {
            $dir = TAPI_SERVER_DIR . '/storage/logs'; // not installed yet
        }
        if (!is_dir($dir) && !@mkdir($dir, 0775, true) && !is_dir($dir)) {
            error_log('[tapi] ' . $message);
            return;
        }
        $file = $dir . '/app.log';
        if (@filesize($file) > self::MAX_BYTES) {
            @rename($file, $file . '.1');
        }
        $line = sprintf("[%s] %s %s%s\n", gmdate('Y-m-d H:i:s'), $level, $message,
            $context ? ' ' . json_encode($context, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE) : '');
        if (@file_put_contents($file, $line, FILE_APPEND | LOCK_EX) === false) {
            error_log('[tapi] ' . trim($line));
        }
    }
}
