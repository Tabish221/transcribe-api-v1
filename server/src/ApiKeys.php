<?php

declare(strict_types=1);

namespace Tapi;

/**
 * Project API keys: "tk_" + 40 hex. Only the sha256 hash and a display prefix are stored;
 * the full key is returned once at creation.
 */
final class ApiKeys
{
    public static function list(string $projectId): array
    {
        $rows = Db::all('SELECT * FROM api_keys WHERE project_id = ? ORDER BY created_at DESC, id DESC', [$projectId]);
        return array_map([self::class, 'serialize'], $rows);
    }

    /** @return array key object plus "key" (the only time the secret is revealed) */
    public static function create(string $projectId, mixed $name, string $userId): array
    {
        $name = Validate::name(is_string($name) && trim($name) !== '' ? $name : 'API key', 'name');
        $key = 'tk_' . bin2hex(random_bytes(20));
        $row = [
            'id' => Util::id('key_'),
            'project_id' => $projectId,
            'name' => $name,
            'prefix' => substr($key, 0, 11),
            'key_hash' => hash('sha256', $key),
            'created_by' => $userId,
            'created_at' => time(),
            'last_used_at' => null,
            'revoked_at' => null,
        ];
        Db::insert('api_keys', $row);
        return self::serialize($row) + ['key' => $key];
    }

    public static function revoke(string $projectId, string $keyId): array
    {
        $row = Db::one('SELECT * FROM api_keys WHERE id = ? AND project_id = ?', [$keyId, $projectId]);
        if ($row === null) {
            throw ApiException::notFound('API key not found');
        }
        if ($row['revoked_at'] === null) {
            $row['revoked_at'] = time();
            Db::update('api_keys', ['revoked_at' => $row['revoked_at']], 'id = ?', [$keyId]);
        }
        return self::serialize($row);
    }

    /**
     * Resolves the request's API key (Authorization: Bearer tk_... or X-API-Key).
     * @return array{array, array} [key row, project row]
     */
    public static function authenticate(Request $request): array
    {
        $token = $request->bearerToken() ?? $request->header('X-API-Key');
        if ($token === null || trim($token) === '') {
            throw ApiException::unauthorized('Missing API key. Send "Authorization: Bearer tk_..." or "X-API-Key: tk_..."');
        }
        $token = trim($token);
        $invalid = new ApiException(401, 'invalid_api_key', 'Invalid or revoked API key');
        if (!preg_match('/^tk_[a-f0-9]{40}$/', $token)) {
            throw $invalid;
        }
        $hash = hash('sha256', $token);
        $key = Db::one('SELECT * FROM api_keys WHERE key_hash = ?', [$hash]);
        if ($key === null || !hash_equals((string) $key['key_hash'], $hash) || $key['revoked_at'] !== null) {
            throw $invalid;
        }
        $project = Projects::find((string) $key['project_id']);
        if ($project === null) {
            throw $invalid;
        }
        $now = time();
        if ($key['last_used_at'] === null || (int) $key['last_used_at'] < $now - 60) {
            Db::update('api_keys', ['last_used_at' => $now], 'id = ?', [$key['id']]);
        }
        return [$key, $project];
    }

    public static function serialize(array $row): array
    {
        return [
            'id' => $row['id'],
            'name' => $row['name'],
            'prefix' => $row['prefix'],
            'created_at' => Util::iso($row['created_at']),
            'last_used_at' => Util::iso($row['last_used_at']),
            'revoked_at' => Util::iso($row['revoked_at']),
        ];
    }
}
