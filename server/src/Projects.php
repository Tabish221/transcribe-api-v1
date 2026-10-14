<?php

declare(strict_types=1);

namespace Tapi;

/** Projects and project membership. Admins can access every project with owner rights. */
final class Projects
{
    public static function find(string $id): ?array
    {
        $row = Db::one('SELECT * FROM projects WHERE id = ?', [$id]);
        if ($row !== null) {
            $row['created_at'] = (int) $row['created_at'];
        }
        return $row;
    }

    /** Effective role of a user in a project: "owner", "member" or null (no access). */
    public static function roleOf(array $user, string $projectId): ?string
    {
        if ($user['is_admin']) {
            return 'owner';
        }
        $role = Db::value('SELECT role FROM project_members WHERE project_id = ? AND user_id = ?', [$projectId, $user['id']]);
        return is_string($role) ? $role : null;
    }

    /**
     * Loads a project the user can access. 404 when missing or not a member (does not reveal existence);
     * 403 when $ownerOnly and the user is only a member.
     * @return array{array, string} [project, role]
     */
    public static function access(array $user, string $projectId, bool $ownerOnly = false): array
    {
        $project = self::find($projectId);
        $role = $project === null ? null : self::roleOf($user, $projectId);
        if ($project === null || $role === null) {
            throw ApiException::notFound('Project not found');
        }
        if ($ownerOnly && $role !== 'owner') {
            throw ApiException::forbidden('Only project owners can do this');
        }
        return [$project, $role];
    }

    /** Projects visible to the user (all projects for admins), newest first. */
    public static function listFor(array $user): array
    {
        if ($user['is_admin']) {
            $rows = Db::all('SELECT p.*, m.role AS member_role FROM projects p
                LEFT JOIN project_members m ON m.project_id = p.id AND m.user_id = ?
                ORDER BY p.created_at DESC, p.id DESC', [$user['id']]);
        } else {
            $rows = Db::all('SELECT p.*, m.role AS member_role FROM projects p
                JOIN project_members m ON m.project_id = p.id AND m.user_id = ?
                ORDER BY p.created_at DESC, p.id DESC', [$user['id']]);
        }
        $stats = self::stats(array_column($rows, 'id'));
        $out = [];
        foreach ($rows as $row) {
            $role = $user['is_admin'] ? 'owner' : (string) $row['member_role'];
            unset($row['member_role']);
            $row['created_at'] = (int) $row['created_at'];
            $out[] = self::serialize($row, $role, $stats[$row['id']] ?? null);
        }
        return $out;
    }

    public static function create(array $user, mixed $name): array
    {
        $name = Validate::name($name, 'name');
        $id = Util::id('prj_');
        $now = time();
        $engine = (string) Config::get('default_engine', 'cloud');
        Db::transaction(static function () use ($id, $name, $user, $now, $engine): void {
            Db::insert('projects', [
                'id' => $id,
                'name' => $name,
                'owner_id' => $user['id'],
                'default_engine' => in_array($engine, Validate::ENGINES, true) ? $engine : 'cloud',
                'default_language' => null,
                'webhook_url' => null,
                'webhook_secret' => self::newSecret(),
                'created_at' => $now,
            ]);
            Db::insert('project_members', ['project_id' => $id, 'user_id' => $user['id'], 'role' => 'owner', 'created_at' => $now]);
        });
        return self::find($id);
    }

    /** PATCH: name, default_engine, default_language, webhook_url (only the keys present). */
    public static function update(array $project, array $input): array
    {
        $set = [];
        if (array_key_exists('name', $input)) {
            $set['name'] = Validate::name($input['name'], 'name');
        }
        if (array_key_exists('default_engine', $input)) {
            $set['default_engine'] = Validate::engine($input['default_engine'], 'default_engine');
        }
        if (array_key_exists('default_language', $input)) {
            $set['default_language'] = Validate::language($input['default_language'], 'default_language');
        }
        if (array_key_exists('webhook_url', $input)) {
            $set['webhook_url'] = Validate::webhookUrl($input['webhook_url']);
        }
        if ($set !== []) {
            Db::update('projects', $set, 'id = ?', [$project['id']]);
        }
        return self::find($project['id']);
    }

    /** Deletes a project with all its transcriptions (and audio files), keys and memberships. */
    public static function delete(array $project): void
    {
        foreach (Db::all('SELECT id, file_path FROM transcriptions WHERE project_id = ?', [$project['id']]) as $row) {
            Transcriptions::deleteAudio($row);
        }
        Db::transaction(static function () use ($project): void {
            Db::run('DELETE FROM transcriptions WHERE project_id = ?', [$project['id']]);
            Db::run('DELETE FROM api_keys WHERE project_id = ?', [$project['id']]);
            Db::run('DELETE FROM project_members WHERE project_id = ?', [$project['id']]);
            Db::run('DELETE FROM projects WHERE id = ?', [$project['id']]);
        });
    }

    public static function rotateSecret(array $project): string
    {
        $secret = self::newSecret();
        Db::update('projects', ['webhook_secret' => $secret], 'id = ?', [$project['id']]);
        return $secret;
    }

    /** @return array<string, array{transcriptions:int, completed:int, failed:int, queued:int}> */
    public static function stats(array $projectIds): array
    {
        if ($projectIds === []) {
            return [];
        }
        $placeholders = implode(', ', array_fill(0, count($projectIds), '?'));
        $rows = Db::all("SELECT project_id, status, COUNT(*) AS n FROM transcriptions
            WHERE project_id IN ({$placeholders}) GROUP BY project_id, status", array_values($projectIds));
        $stats = [];
        foreach ($rows as $row) {
            $s = &$stats[$row['project_id']];
            $s ??= self::emptyStats();
            $s['transcriptions'] += (int) $row['n'];
            // "queued" counts every unfinished job (queued + processing)
            $bucket = $row['status'] === 'processing' ? 'queued' : $row['status'];
            if (isset($s[$bucket])) {
                $s[$bucket] += (int) $row['n'];
            }
            unset($s);
        }
        return $stats;
    }

    public static function serialize(array $project, string $role, ?array $stats = null, bool $withSecret = false): array
    {
        $out = [
            'id' => $project['id'],
            'name' => $project['name'],
            'role' => $role,
            'default_engine' => $project['default_engine'],
            'default_language' => $project['default_language'],
            'webhook_url' => $project['webhook_url'],
            'created_at' => Util::iso($project['created_at']),
            'stats' => $stats ?? self::emptyStats(),
        ];
        if ($withSecret && $role === 'owner') {
            $out['webhook_secret'] = $project['webhook_secret'];
        }
        return $out;
    }

    // ----- members -----

    public static function members(string $projectId): array
    {
        $rows = Db::all('SELECT m.user_id, u.email, u.name, m.role, m.created_at FROM project_members m
            JOIN users u ON u.id = m.user_id WHERE m.project_id = ? ORDER BY m.created_at ASC', [$projectId]);
        return array_map([self::class, 'serializeMember'], $rows);
    }

    public static function addMember(array $project, mixed $email, mixed $role): array
    {
        $email = Users::validateEmail($email);
        $role = $role === null || $role === '' ? 'member' : $role;
        if (!in_array($role, ['owner', 'member'], true)) {
            throw ApiException::validation('role', 'role must be "member" or "owner"');
        }
        $user = Users::findByEmail($email);
        if ($user === null) {
            throw ApiException::validation('email', 'No user with this email exists. Ask an admin to create the account first.');
        }
        if (Db::value('SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?', [$project['id'], $user['id']]) !== null) {
            throw ApiException::validation('email', 'This user is already a member of the project');
        }
        $now = time();
        Db::insert('project_members', ['project_id' => $project['id'], 'user_id' => $user['id'], 'role' => $role, 'created_at' => $now]);
        return self::serializeMember([
            'user_id' => $user['id'], 'email' => $user['email'], 'name' => $user['name'], 'role' => $role, 'created_at' => $now,
        ]);
    }

    public static function removeMember(array $project, string $userId): void
    {
        $role = Db::value('SELECT role FROM project_members WHERE project_id = ? AND user_id = ?', [$project['id'], $userId]);
        if ($role === null) {
            throw ApiException::notFound('Member not found');
        }
        if ($role === 'owner') {
            $owners = (int) Db::value("SELECT COUNT(*) FROM project_members WHERE project_id = ? AND role = 'owner'", [$project['id']]);
            if ($owners <= 1) {
                throw ApiException::validation('user_id', 'Cannot remove the last owner of a project');
            }
        }
        Db::run('DELETE FROM project_members WHERE project_id = ? AND user_id = ?', [$project['id'], $userId]);
    }

    public static function serializeMember(array $row): array
    {
        return [
            'user_id' => $row['user_id'],
            'email' => $row['email'],
            'name' => $row['name'],
            'role' => $row['role'],
            'created_at' => Util::iso($row['created_at']),
        ];
    }

    private static function emptyStats(): array
    {
        return ['transcriptions' => 0, 'completed' => 0, 'failed' => 0, 'queued' => 0];
    }

    private static function newSecret(): string
    {
        return 'whsec_' . bin2hex(random_bytes(24));
    }
}
