<?php

declare(strict_types=1);

namespace Tapi;

/** Streams a file with single-range HTTP Range support (206) so players can seek. */
final class AudioStream
{
    private const CHUNK = 65536;

    public static function send(string $path, string $mime, string $filename): void
    {
        $size = (int) filesize($path);
        $start = 0;
        $end = $size - 1;
        $status = 200;

        $range = (string) ($_SERVER['HTTP_RANGE'] ?? '');
        if ($range !== '' && $size > 0) {
            $parsed = self::parseRange($range, $size);
            if ($parsed === null) {
                Response::begin(416, ['Content-Range: bytes */' . $size, 'Accept-Ranges: bytes', 'Content-Length: 0']);
                return;
            }
            [$start, $end] = $parsed;
            $status = 206;
        }

        $headers = [
            'Content-Type: ' . $mime,
            'Accept-Ranges: bytes',
            'Content-Length: ' . ($size === 0 ? 0 : $end - $start + 1),
            'Content-Disposition: ' . Util::contentDisposition('inline', $filename),
            'Cache-Control: private, no-store',
        ];
        if ($status === 206) {
            $headers[] = "Content-Range: bytes {$start}-{$end}/{$size}";
        }
        Response::begin($status, $headers);
        if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'HEAD' || $size === 0) {
            return;
        }

        @set_time_limit(0);
        $fp = fopen($path, 'rb');
        if ($fp === false) {
            return;
        }
        fseek($fp, $start);
        $remaining = $end - $start + 1;
        while ($remaining > 0 && !feof($fp) && connection_status() === CONNECTION_NORMAL) {
            $chunk = fread($fp, min(self::CHUNK, $remaining));
            if ($chunk === false || $chunk === '') {
                break;
            }
            echo $chunk;
            $remaining -= strlen($chunk);
            @flush();
        }
        fclose($fp);
    }

    /** "bytes=a-b" | "bytes=a-" | "bytes=-n" -> [start, end] or null when unsatisfiable. Multi-range uses the first range. */
    private static function parseRange(string $header, int $size): ?array
    {
        if (!preg_match('/^bytes=\s*(\d*)\s*-\s*(\d*)/i', trim($header), $m) || ($m[1] === '' && $m[2] === '')) {
            return null;
        }
        if ($m[1] === '') {
            $length = (int) $m[2];
            if ($length === 0) {
                return null;
            }
            return [max(0, $size - $length), $size - 1];
        }
        $start = (int) $m[1];
        $end = $m[2] === '' ? $size - 1 : min((int) $m[2], $size - 1);
        return $start > $end || $start >= $size ? null : [$start, $end];
    }
}
