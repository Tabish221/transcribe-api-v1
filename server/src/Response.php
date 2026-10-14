<?php

declare(strict_types=1);

namespace Tapi;

/** Response writers. Each method sends a complete response (headers + body). */
final class Response
{
    public const DASHBOARD_CSP = "default-src 'self'; img-src 'self' data:; media-src 'self' blob:; style-src 'self'; "
        . "script-src 'self'; connect-src 'self'; frame-ancestors 'none'";

    private static array $extraHeaders = [];

    /** Headers added to every response sent afterwards (e.g. CORS). */
    public static function addHeader(string $header): void
    {
        self::$extraHeaders[] = $header;
    }

    public static function securityHeaders(): void
    {
        if (headers_sent()) {
            return;
        }
        header_remove('X-Powered-By');
        header('X-Content-Type-Options: nosniff');
        header('X-Frame-Options: DENY');
        header('Referrer-Policy: no-referrer');
    }

    public static function json(mixed $data, int $status = 200, array $headers = []): void
    {
        $headers[] = 'Content-Type: application/json; charset=utf-8';
        $headers[] = 'Cache-Control: no-store';
        self::send(Util::json($data), $status, $headers);
    }

    public static function error(int $status, string $code, string $message, array $extra = []): void
    {
        self::json(['error' => array_merge(['code' => $code, 'message' => $message], $extra)], $status);
    }

    public static function noContent(): void
    {
        self::send('', 204, ['Cache-Control: no-store']);
    }

    /** A text/file download with a Content-Disposition attachment filename. */
    public static function download(string $body, string $mime, string $filename): void
    {
        self::send($body, 200, [
            'Content-Type: ' . $mime,
            'Content-Disposition: ' . Util::contentDisposition('attachment', $filename),
            'Cache-Control: no-store',
        ]);
    }

    public static function html(string $body, int $status = 200, array $headers = []): void
    {
        $headers[] = 'Content-Type: text/html; charset=utf-8';
        self::send($body, $status, $headers);
    }

    public static function redirect(string $location, int $status = 302): void
    {
        self::send('', $status, ['Location: ' . $location, 'Cache-Control: no-store']);
    }

    /** Sends a static file from disk (dashboard assets under php -S). */
    public static function file(string $path, string $mime, array $headers = []): void
    {
        self::begin(200, array_merge(['Content-Type: ' . $mime, 'Content-Length: ' . filesize($path)], $headers));
        if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'HEAD') {
            readfile($path);
        }
        self::flush();
    }

    /** Clears buffered output and sends the status line + headers (used by streaming responses too). */
    public static function begin(int $status, array $headers): void
    {
        while (ob_get_level() > 0) {
            ob_end_clean();
        }
        if (headers_sent()) {
            return;
        }
        http_response_code($status);
        foreach (array_merge(self::$extraHeaders, $headers) as $header) {
            header($header);
        }
    }

    public static function flush(): void
    {
        if (ob_get_level() > 0) {
            @ob_end_flush();
        }
        @flush();
    }

    private static function send(string $body, int $status, array $headers): void
    {
        if ($status !== 204) {
            $headers[] = 'Content-Length: ' . strlen($body);
        }
        self::begin($status, $headers);
        if ($status !== 204 && ($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'HEAD') {
            echo $body;
        }
        self::flush();
    }
}
