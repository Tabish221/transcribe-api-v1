<?php

declare(strict_types=1);

namespace Tapi;

/** Small stateless helpers shared across the app. */
final class Util
{
    /** Prefixed random id, e.g. tr_0123456789abcdef01234567 (prefix + 24 hex). */
    public static function id(string $prefix): string
    {
        return $prefix . bin2hex(random_bytes(12));
    }

    /** Unix seconds -> ISO-8601 UTC ("2026-10-14T09:30:00Z"), null stays null. */
    public static function iso(mixed $ts): ?string
    {
        if ($ts === null || $ts === '') {
            return null;
        }
        return gmdate('Y-m-d\TH:i:s\Z', (int) $ts);
    }

    public static function intOrNull(mixed $value): ?int
    {
        return $value === null || $value === '' ? null : (int) $value;
    }

    public static function floatOrNull(mixed $value): ?float
    {
        return $value === null || $value === '' ? null : (float) $value;
    }

    /** Multibyte-safe truncation (falls back to bytes when mbstring is missing). */
    public static function cut(string $value, int $max): string
    {
        if (function_exists('mb_substr')) {
            return mb_strlen($value, 'UTF-8') > $max ? mb_substr($value, 0, $max, 'UTF-8') : $value;
        }
        return strlen($value) > $max ? substr($value, 0, $max) : $value;
    }

    public static function length(string $value): int
    {
        return function_exists('mb_strlen') ? mb_strlen($value, 'UTF-8') : strlen($value);
    }

    /** Collapses whitespace/control characters and trims. */
    public static function cleanLine(string $value): string
    {
        $value = preg_replace('/[\x00-\x1F\x7F]+/u', ' ', $value) ?? '';
        return trim(preg_replace('/\s{2,}/u', ' ', $value) ?? '');
    }

    /**
     * Sanitised display filename (never used as a filesystem path), at most 200 characters and always
     * ending in ".$ext": cloud providers detect the audio format from the uploaded name's extension.
     */
    public static function sanitizeFilename(string $name, string $ext): string
    {
        if (preg_match('//u', $name) !== 1) {
            $name = ''; // invalid UTF-8
        }
        $name = str_replace('\\', '/', $name);
        $name = substr($name, (int) strrpos('/' . $name, '/')); // basename() is locale dependent
        $name = preg_replace('/[\x00-\x1F\x7F"<>|:*?]+/u', '', $name) ?? '';
        $name = self::cleanLine($name);
        $suffix = $ext === '' ? '' : '.' . $ext;
        if ($suffix !== '' && strcasecmp(substr($name, -strlen($suffix)), $suffix) === 0) {
            $suffix = substr($name, -strlen($suffix)); // keep the original spelling, e.g. ".MP3"
            $name = substr($name, 0, -strlen($suffix));
        }
        $base = trim(ltrim($name, '.'));
        return ($base === '' ? 'audio' : self::cut($base, 200 - strlen($suffix))) . $suffix;
    }

    /** ASCII-only filename for Content-Disposition headers. */
    public static function asciiFilename(string $name): string
    {
        $ascii = preg_replace('/[^A-Za-z0-9._ -]+/', '_', $name) ?? 'download';
        $ascii = trim($ascii, ' ._');
        return $ascii === '' ? 'download' : $ascii;
    }

    /** Content-Disposition header value with an RFC 5987 UTF-8 filename. */
    public static function contentDisposition(string $type, string $filename): string
    {
        return sprintf('%s; filename="%s"; filename*=UTF-8\'\'%s', $type, self::asciiFilename($filename), rawurlencode($filename));
    }

    public static function json(mixed $value, bool $pretty = false): string
    {
        $flags = JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE
            | JSON_PRESERVE_ZERO_FRACTION | JSON_THROW_ON_ERROR;
        return json_encode($value, $pretty ? $flags | JSON_PRETTY_PRINT : $flags);
    }

    public static function clientIp(): string
    {
        return substr((string) ($_SERVER['REMOTE_ADDR'] ?? '0.0.0.0'), 0, 64);
    }

    public static function isHttps(): bool
    {
        $https = strtolower((string) ($_SERVER['HTTPS'] ?? ''));
        if ($https !== '' && $https !== 'off') {
            return true;
        }
        if ((string) ($_SERVER['SERVER_PORT'] ?? '') === '443') {
            return true;
        }
        return strtolower((string) ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '')) === 'https';
    }

    /** Parses php.ini sizes like "110M" into bytes (ini_parse_quantity is PHP 8.2+ only). */
    public static function iniBytes(string $value): int
    {
        $value = trim($value);
        if ($value === '') {
            return 0;
        }
        $number = (int) $value;
        switch (strtolower(substr($value, -1))) {
            case 'g': return $number * 1024 * 1024 * 1024;
            case 'm': return $number * 1024 * 1024;
            case 'k': return $number * 1024;
            default: return $number;
        }
    }

    /** MIME type for an audio extension (used when streaming / uploading to the cloud engine). */
    public static function audioMime(string $ext): string
    {
        $map = [
            'mp3' => 'audio/mpeg', 'mpga' => 'audio/mpeg', 'mpeg' => 'audio/mpeg',
            'm4a' => 'audio/mp4', 'mp4' => 'audio/mp4', 'aac' => 'audio/aac',
            'wav' => 'audio/wav', 'ogg' => 'audio/ogg', 'oga' => 'audio/ogg', 'opus' => 'audio/ogg',
            'webm' => 'audio/webm', 'flac' => 'audio/flac', 'amr' => 'audio/amr', 'wma' => 'audio/x-ms-wma',
        ];
        return $map[strtolower($ext)] ?? 'application/octet-stream';
    }

    /** Deletes a file if it exists; never throws. */
    public static function unlinkQuietly(?string $path): void
    {
        if ($path !== null && $path !== '' && is_file($path)) {
            @unlink($path);
        }
    }
}
