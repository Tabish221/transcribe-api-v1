<?php

namespace App\Services;

/**
 * The biggest file this app can accept: the smallest of TRANSCRIBE_MAX_UPLOAD_MB and PHP's
 * upload_max_filesize / post_max_size (php.ini). The API has its own limit too.
 */
class UploadLimit
{
    public static function bytes(): int
    {
        $limits = [max(1, (int) config('services.transcribe.max_upload_mb', 100)) * 1048576];
        foreach (['upload_max_filesize', 'post_max_size'] as $name) {
            $value = self::iniBytes((string) ini_get($name));
            if ($value > 0) {
                $limits[] = $name === 'post_max_size' ? max(1, $value - 65536) : $value; // room for the other fields
            }
        }

        return min($limits);
    }

    /** For the "max" validation rule (kilobytes). */
    public static function kilobytes(): int
    {
        return intdiv(self::bytes(), 1024);
    }

    public static function human(): string
    {
        return TranscribeClient::humanSize(self::bytes());
    }

    private static function iniBytes(string $value): int
    {
        $value = trim($value);
        if ($value === '' || $value === '-1' || $value === '0') {
            return 0; // no limit
        }
        $number = (float) $value;

        return (int) match (strtolower(substr($value, -1))) {
            'g' => $number * 1073741824,
            'm' => $number * 1048576,
            'k' => $number * 1024,
            default => $number,
        };
    }
}
