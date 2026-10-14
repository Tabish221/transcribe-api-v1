<?php

declare(strict_types=1);

namespace Tapi;

/** Input validators shared by the public and dashboard APIs. Each throws a 422 ApiException. */
final class Validate
{
    public const ENGINES = ['cloud', 'worker'];
    public const TASKS = ['transcribe', 'translate'];
    public const STATUSES = ['queued', 'processing', 'completed', 'failed'];

    public static function engine(mixed $value, string $field = 'engine'): string
    {
        $value = strtolower(trim(is_string($value) ? $value : ''));
        if (!in_array($value, self::ENGINES, true)) {
            throw ApiException::validation($field, 'engine must be "cloud" or "worker"');
        }
        return $value;
    }

    public static function task(mixed $value): string
    {
        $value = strtolower(trim(is_string($value) ? $value : ''));
        if ($value === '') {
            return 'transcribe';
        }
        if (!in_array($value, self::TASKS, true)) {
            throw ApiException::validation('task', 'task must be "transcribe" or "translate"');
        }
        return $value;
    }

    /** ISO-639-1 code (names like "english" are mapped). Returns null for empty/"auto". */
    public static function language(mixed $value, string $field = 'language'): ?string
    {
        if ($value !== null && !is_string($value)) {
            throw ApiException::validation($field, 'language must be a string');
        }
        $code = Languages::normalize($value);
        if ($code === false) {
            throw ApiException::validation($field, 'Unknown language; use an ISO-639-1 code such as "en"');
        }
        return $code;
    }

    /** Optional http(s) webhook URL; enforces the SSRF guard. Returns null for empty. */
    public static function webhookUrl(mixed $value, string $field = 'webhook_url'): ?string
    {
        if ($value === null) {
            return null;
        }
        if (!is_string($value)) {
            throw ApiException::validation($field, 'webhook_url must be a string');
        }
        $value = trim($value);
        if ($value === '') {
            return null;
        }
        $error = Webhooks::checkUrl($value);
        if ($error !== null) {
            throw ApiException::validation($field, $error);
        }
        return $value;
    }

    public static function status(?string $value): ?string
    {
        if ($value === null || $value === '') {
            return null;
        }
        if (!in_array($value, self::STATUSES, true)) {
            throw ApiException::validation('status', 'status must be one of: ' . implode(', ', self::STATUSES));
        }
        return $value;
    }

    /** @return array{int, int} [limit, offset] from ?limit=&offset= (limit 1-100, default 20). */
    public static function paging(Request $request): array
    {
        $limit = $request->query('limit');
        $offset = $request->query('offset');
        $limit = ($limit === null || $limit === '') ? 20 : $limit;
        $offset = ($offset === null || $offset === '') ? 0 : $offset;
        if (!ctype_digit((string) $limit) || (int) $limit < 1) {
            throw ApiException::validation('limit', 'limit must be a positive integer');
        }
        if (!ctype_digit((string) $offset)) {
            throw ApiException::validation('offset', 'offset must be a non-negative integer');
        }
        return [min(100, (int) $limit), (int) $offset];
    }

    public static function bool(mixed $value): bool
    {
        if (is_bool($value)) {
            return $value;
        }
        if (!is_scalar($value)) {
            return false;
        }
        return in_array(strtolower(trim((string) $value)), ['1', 'true', 'yes', 'on'], true);
    }

    /** Required non-empty single-line string with a max length. */
    public static function name(mixed $value, string $field, int $max = 190): string
    {
        $value = Util::cleanLine(is_string($value) ? $value : '');
        if ($value === '') {
            throw ApiException::validation($field, $field . ' is required');
        }
        if (Util::length($value) > $max) {
            throw ApiException::validation($field, $field . ' must be at most ' . $max . ' characters');
        }
        return $value;
    }
}
