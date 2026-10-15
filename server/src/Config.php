<?php

declare(strict_types=1);

namespace Tapi;

/**
 * Application configuration (config.php returns a PHP array).
 *
 * Location: the TAPI_CONFIG environment variable (absolute path to a config.php) when set,
 * otherwise server/config.php. Missing keys fall back to defaults() so older config files keep working.
 */
final class Config
{
    private static ?array $data = null;

    /** Documented defaults; config.sample.php mirrors these values. */
    public static function defaults(string $baseDir = TAPI_SERVER_DIR): array
    {
        return [
            'app_name' => 'Transcribe API',
            'base_url' => '',
            'db' => [
                'driver' => 'mysql',
                'host' => 'localhost',
                'port' => 3306,
                'name' => '',
                'user' => '',
                'pass' => '',
                'sqlite_path' => $baseDir . '/storage/app.sqlite',
            ],
            'storage_path' => $baseDir . '/storage',
            'allow_registration' => false,
            'allowed_extensions' => ['mp3'],
            'max_upload_mb' => 100,
            'audio_retention_days' => 7,
            'default_engine' => 'cloud',
            'cloud' => [
                'enabled' => true,
                'base_url' => 'https://api.groq.com/openai/v1',
                'api_key' => '',
                'model' => 'whisper-large-v3-turbo',
                'translate_model' => 'whisper-large-v3',
                'max_mb' => 25,
                'timeout' => 600,
                'max_attempts' => 3,
            ],
            'worker' => [
                'enabled' => true,
                'tokens' => [],
                'lease_seconds' => 900,
                'max_attempts' => 3,
            ],
            'webhooks' => [
                'allow_private_hosts' => false,
                'timeout' => 10,
                'max_attempts' => 5,
            ],
            'cors_origins' => [],
            'session_name' => 'tapi_session',
        ];
    }

    /** Absolute path of the active config.php (it may not exist yet). */
    public static function path(): string
    {
        foreach ([getenv('TAPI_CONFIG'), $_SERVER['TAPI_CONFIG'] ?? null, $_SERVER['REDIRECT_TAPI_CONFIG'] ?? null] as $candidate) {
            if (is_string($candidate) && $candidate !== '') {
                return str_replace('\\', '/', $candidate);
            }
        }
        return TAPI_SERVER_DIR . '/config.php';
    }

    /** Loads config.php once. Returns false when the app is not installed yet. */
    public static function load(): bool
    {
        if (self::$data !== null) {
            return true;
        }
        $path = self::path();
        if (!is_file($path)) {
            return false;
        }
        $loaded = require $path;
        if (!is_array($loaded)) {
            throw new \RuntimeException('config.php must return an array');
        }
        self::$data = self::merge(self::defaults(str_replace('\\', '/', dirname($path))), $loaded);
        return true;
    }

    /** Replaces the active configuration (used by the installer and CLI tools). */
    public static function set(array $config): void
    {
        self::$data = self::merge(self::defaults(), $config);
    }

    public static function all(): array
    {
        if (self::$data === null && !self::load()) {
            throw new \RuntimeException('Not installed: config.php is missing');
        }
        return self::$data;
    }

    /** Reads a value by dot path, e.g. Config::get('cloud.api_key'). */
    public static function get(string $key, mixed $default = null): mixed
    {
        $value = self::all();
        foreach (explode('.', $key) as $part) {
            if (!is_array($value) || !array_key_exists($part, $value)) {
                return $default;
            }
            $value = $value[$part];
        }
        return $value;
    }

    public static function storagePath(string $sub = ''): string
    {
        $base = rtrim(str_replace('\\', '/', (string) self::get('storage_path')), '/');
        return $sub === '' ? $base : $base . '/' . ltrim($sub, '/');
    }

    public static function cloudEnabled(): bool
    {
        return (bool) self::get('cloud.enabled') && trim((string) self::get('cloud.api_key', '')) !== '';
    }

    public static function workerEnabled(): bool
    {
        return (bool) self::get('worker.enabled') && self::workerTokens() !== [];
    }

    /**
     * Usable worker tokens: at least 16 characters, and never the "<random 48 hex>" placeholder
     * from config.sample.php (a copied sample must not accept a publicly known token).
     * @return string[]
     */
    public static function workerTokens(): array
    {
        $tokens = self::get('worker.tokens', []);
        if (!is_array($tokens)) {
            $tokens = [$tokens];
        }
        return array_values(array_filter(array_map('strval', $tokens),
            static fn (string $t): bool => strlen($t) >= 16 && !str_contains($t, '<')));
    }

    /** @return string[] lowercase allowed upload extensions */
    public static function allowedExtensions(): array
    {
        $list = [];
        foreach ((array) self::get('allowed_extensions', ['mp3']) as $ext) {
            $ext = strtolower(ltrim(trim((string) $ext), '.'));
            if (preg_match('/^[a-z0-9]{1,8}$/', $ext)) {
                $list[] = $ext;
            }
        }
        return array_values(array_unique($list));
    }

    /** Recursive merge: associative arrays merge key by key, lists are replaced wholesale. */
    public static function merge(array $base, array $override): array
    {
        foreach ($override as $key => $value) {
            if ($value === [] && isset($base[$key]) && is_array($base[$key]) && !array_is_list($base[$key])) {
                continue; // an empty array overrides nothing in an associative section
            }
            if (is_array($value) && isset($base[$key]) && is_array($base[$key])
                && !array_is_list($value) && !array_is_list($base[$key])) {
                $base[$key] = self::merge($base[$key], $value);
            } else {
                $base[$key] = $value;
            }
        }
        return $base;
    }
}
