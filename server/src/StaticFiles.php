<?php

declare(strict_types=1);

namespace Tapi;

/** Dashboard HTML (all servers) and dashboard assets (php -S only; Apache serves app/ files itself). */
final class StaticFiles
{
    private const TYPES = [
        'html' => 'text/html; charset=utf-8',
        'js' => 'text/javascript; charset=utf-8',
        'mjs' => 'text/javascript; charset=utf-8',
        'css' => 'text/css; charset=utf-8',
        'json' => 'application/json; charset=utf-8',
        'map' => 'application/json; charset=utf-8',
        'webmanifest' => 'application/manifest+json',
        'svg' => 'image/svg+xml',
        'png' => 'image/png',
        'jpg' => 'image/jpeg',
        'jpeg' => 'image/jpeg',
        'gif' => 'image/gif',
        'webp' => 'image/webp',
        'ico' => 'image/x-icon',
        'woff2' => 'font/woff2',
        'txt' => 'text/plain; charset=utf-8',
    ];

    /** Serves /app/... files under the built-in server. Returns true when a file was sent. */
    public static function serve(string $route): bool
    {
        if (!preg_match('#^/app/[A-Za-z0-9._\-/]+$#', $route) || str_contains($route, '..')) {
            return false;
        }
        $root = realpath(TAPI_SERVER_DIR . '/app');
        $file = realpath(TAPI_SERVER_DIR . $route);
        if ($root === false || $file === false || !is_file($file)) {
            return false;
        }
        $root = str_replace('\\', '/', $root) . '/';
        if (!str_starts_with(str_replace('\\', '/', $file), $root)) {
            return false;
        }
        $ext = strtolower(pathinfo($file, PATHINFO_EXTENSION));
        if (!isset(self::TYPES[$ext])) {
            return false;
        }
        $headers = ['Cache-Control: no-cache'];
        if ($ext === 'html') {
            $headers[] = 'Content-Security-Policy: ' . Response::DASHBOARD_CSP;
        }
        Response::file($file, self::TYPES[$ext], $headers);
        return true;
    }

    /** GET / -> app/index.html with the dashboard CSP. */
    public static function dashboard(): void
    {
        $file = TAPI_SERVER_DIR . '/app/index.html';
        $headers = ['Content-Security-Policy: ' . Response::DASHBOARD_CSP, 'Cache-Control: no-cache'];
        if (!is_file($file)) {
            Response::html("<!doctype html><meta charset=\"utf-8\"><title>Transcribe API</title>\n"
                . "<p>The dashboard files are missing (app/index.html). The API is running.</p>\n", 404, $headers);
            return;
        }
        Response::file($file, self::TYPES['html'], $headers);
    }
}
