<?php

declare(strict_types=1);

namespace Tapi;

use PDO;

/**
 * Portable schema for MySQL/MariaDB (utf8mb4, InnoDB) and SQLite.
 * Column definitions are shared; only big-text types, table options and index syntax differ.
 */
final class Schema
{
    public const VERSION = '1';

    /** table => [columns..., constraints...] ; {BIGTEXT} = MEDIUMTEXT (MySQL) / TEXT (SQLite) */
    private const TABLES = [
        'meta' => [
            'name VARCHAR(64) NOT NULL',
            'value TEXT NULL',
            'PRIMARY KEY (name)',
        ],
        'users' => [
            'id VARCHAR(40) NOT NULL',
            'email VARCHAR(190) NOT NULL',
            "name VARCHAR(190) NOT NULL DEFAULT ''",
            'password_hash VARCHAR(255) NOT NULL',
            'is_admin INT NOT NULL DEFAULT 0',
            'disabled_at INT NULL',
            'created_at INT NOT NULL',
            'last_login_at INT NULL',
            'PRIMARY KEY (id)',
            'UNIQUE (email)',
        ],
        'projects' => [
            'id VARCHAR(40) NOT NULL',
            'name VARCHAR(190) NOT NULL',
            'owner_id VARCHAR(40) NOT NULL',
            "default_engine VARCHAR(16) NOT NULL DEFAULT 'cloud'",
            'default_language VARCHAR(16) NULL',
            'webhook_url VARCHAR(2048) NULL',
            'webhook_secret VARCHAR(80) NOT NULL',
            'created_at INT NOT NULL',
            'PRIMARY KEY (id)',
        ],
        'project_members' => [
            'project_id VARCHAR(40) NOT NULL',
            'user_id VARCHAR(40) NOT NULL',
            "role VARCHAR(16) NOT NULL DEFAULT 'member'",
            'created_at INT NOT NULL',
            'PRIMARY KEY (project_id, user_id)',
        ],
        'api_keys' => [
            'id VARCHAR(40) NOT NULL',
            'project_id VARCHAR(40) NOT NULL',
            "name VARCHAR(190) NOT NULL DEFAULT ''",
            'prefix VARCHAR(16) NOT NULL',
            'key_hash CHAR(64) NOT NULL',
            'created_by VARCHAR(40) NULL',
            'created_at INT NOT NULL',
            'last_used_at INT NULL',
            'revoked_at INT NULL',
            'PRIMARY KEY (id)',
            'UNIQUE (key_hash)',
        ],
        'transcriptions' => [
            'id VARCHAR(40) NOT NULL',
            'project_id VARCHAR(40) NOT NULL',
            'api_key_id VARCHAR(40) NULL',
            'created_by VARCHAR(40) NULL',
            'status VARCHAR(16) NOT NULL',
            'engine VARCHAR(16) NOT NULL',
            'language VARCHAR(16) NULL',
            "task VARCHAR(16) NOT NULL DEFAULT 'transcribe'",
            'prompt TEXT NULL',
            'filename VARCHAR(255) NOT NULL',
            'file_path VARCHAR(255) NULL',
            'file_size INT NOT NULL DEFAULT 0',
            'mime VARCHAR(100) NULL',
            'duration REAL NULL',
            'text {BIGTEXT} NULL',
            'segments {BIGTEXT} NULL',
            'detected_language VARCHAR(16) NULL',
            'error TEXT NULL',
            'metadata TEXT NULL',
            'webhook_url VARCHAR(2048) NULL',
            'webhook_status VARCHAR(32) NULL',
            'webhook_attempts INT NOT NULL DEFAULT 0',
            'worker_name VARCHAR(100) NULL',
            'attempts INT NOT NULL DEFAULT 0',
            'locked_until INT NULL',
            'progress INT NULL',
            'created_at INT NOT NULL',
            'started_at INT NULL',
            'completed_at INT NULL',
            'PRIMARY KEY (id)',
        ],
        'login_attempts' => [
            'id VARCHAR(40) NOT NULL',
            'ip VARCHAR(64) NOT NULL',
            'email VARCHAR(190) NULL',
            'created_at INT NOT NULL',
            'PRIMARY KEY (id)',
        ],
    ];

    /** index name => [table, columns] */
    private const INDEXES = [
        'idx_projects_owner' => ['projects', 'owner_id'],
        'idx_members_user' => ['project_members', 'user_id'],
        'idx_keys_project' => ['api_keys', 'project_id'],
        'idx_tr_project_created' => ['transcriptions', 'project_id, created_at'],
        'idx_tr_status_engine_created' => ['transcriptions', 'status, engine, created_at'],
        'idx_login_ip_created' => ['login_attempts', 'ip, created_at'],
    ];

    /** @return string[] SQL statements creating every table and index (idempotent). */
    public static function statements(string $driver): array
    {
        $mysql = $driver === 'mysql';
        $sql = [];
        foreach (self::TABLES as $table => $definitions) {
            $lines = array_map(
                static fn (string $d): string => str_replace('{BIGTEXT}', $mysql ? 'MEDIUMTEXT' : 'TEXT', $d),
                $definitions
            );
            if ($mysql) {
                // MySQL has no CREATE INDEX IF NOT EXISTS, so indexes are declared inline.
                foreach (self::INDEXES as $name => [$indexTable, $columns]) {
                    if ($indexTable === $table) {
                        $lines[] = "KEY {$name} ({$columns})";
                    }
                }
            }
            $sql[] = "CREATE TABLE IF NOT EXISTS {$table} (\n  " . implode(",\n  ", $lines) . "\n)"
                . ($mysql ? ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci' : '');
        }
        if (!$mysql) {
            foreach (self::INDEXES as $name => [$table, $columns]) {
                $sql[] = "CREATE INDEX IF NOT EXISTS {$name} ON {$table} ({$columns})";
            }
        }
        return $sql;
    }

    /** Creates all tables on the given connection and records the schema version. */
    public static function install(PDO $pdo, string $driver): void
    {
        foreach (self::statements($driver) as $statement) {
            $pdo->exec($statement);
        }
        $pdo->prepare('DELETE FROM meta WHERE name = ?')->execute(['schema_version']);
        $pdo->prepare('INSERT INTO meta (name, value) VALUES (?, ?)')->execute(['schema_version', self::VERSION]);
    }
}
