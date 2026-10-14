<?php

declare(strict_types=1);

namespace Tapi;

use PDO;
use PDOStatement;

/** Thin PDO wrapper (MySQL/MariaDB or SQLite). Every query uses prepared statements. */
final class Db
{
    private static ?PDO $pdo = null;
    private static string $driver = '';

    /** Opens a connection from a config "db" array (also used by the installer to test credentials). */
    public static function connect(array $db): PDO
    {
        $driver = (string) ($db['driver'] ?? 'mysql');
        $options = [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_STRINGIFY_FETCHES => false,
        ];
        if ($driver === 'sqlite') {
            $path = str_replace('\\', '/', (string) ($db['sqlite_path'] ?? ''));
            if ($path === '') {
                throw new \RuntimeException('db.sqlite_path is not set');
            }
            $dir = dirname($path);
            if (!is_dir($dir) && !@mkdir($dir, 0775, true) && !is_dir($dir)) {
                throw new \RuntimeException('Cannot create SQLite directory');
            }
            $options[PDO::ATTR_TIMEOUT] = 15;
            $pdo = new PDO('sqlite:' . $path, null, null, $options);
            $pdo->exec('PRAGMA busy_timeout = 15000');
            $pdo->exec('PRAGMA journal_mode = WAL');
            $pdo->exec('PRAGMA synchronous = NORMAL');
            return $pdo;
        }
        if ($driver !== 'mysql') {
            throw new \RuntimeException('Unsupported db.driver (use mysql or sqlite)');
        }
        $options[PDO::ATTR_EMULATE_PREPARES] = false;
        $options[PDO::MYSQL_ATTR_FOUND_ROWS] = true; // rowCount() = matched rows (claims rely on it)
        $dsn = sprintf('mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4',
            (string) ($db['host'] ?? 'localhost'), (int) ($db['port'] ?? 3306), (string) ($db['name'] ?? ''));
        return new PDO($dsn, (string) ($db['user'] ?? ''), (string) ($db['pass'] ?? ''), $options);
    }

    public static function pdo(): PDO
    {
        if (self::$pdo === null) {
            $db = (array) Config::get('db');
            self::$pdo = self::connect($db);
            self::$driver = (string) ($db['driver'] ?? 'mysql');
        }
        return self::$pdo;
    }

    /** Uses an existing connection (installer). */
    public static function setConnection(PDO $pdo, string $driver): void
    {
        self::$pdo = $pdo;
        self::$driver = $driver;
    }

    /**
     * Re-opens the MySQL connection if the server dropped it, e.g. because wait_timeout expired
     * during a long cloud transcription. Cheap no-op for SQLite or when no connection is open.
     */
    public static function reconnectIfGone(): void
    {
        if (self::$pdo === null || self::$driver !== 'mysql') {
            return;
        }
        try {
            @self::$pdo->query('SELECT 1');
        } catch (\Throwable $e) {
            self::$pdo = null; // the next query connects again
        }
    }

    public static function driver(): string
    {
        self::pdo();
        return self::$driver;
    }

    public static function run(string $sql, array $params = []): PDOStatement
    {
        $stmt = self::pdo()->prepare($sql);
        $i = 1;
        foreach ($params as $value) {
            if (is_int($value) || is_bool($value)) {
                $stmt->bindValue($i++, (int) $value, PDO::PARAM_INT);
            } elseif ($value === null) {
                $stmt->bindValue($i++, null, PDO::PARAM_NULL);
            } else {
                $stmt->bindValue($i++, (string) $value, PDO::PARAM_STR);
            }
        }
        $stmt->execute();
        return $stmt;
    }

    public static function one(string $sql, array $params = []): ?array
    {
        $row = self::run($sql, $params)->fetch();
        return is_array($row) ? $row : null;
    }

    public static function all(string $sql, array $params = []): array
    {
        return self::run($sql, $params)->fetchAll();
    }

    public static function value(string $sql, array $params = []): mixed
    {
        $value = self::run($sql, $params)->fetchColumn();
        return $value === false ? null : $value;
    }

    /** INSERT from an associative array (column names are internal constants, never user input). */
    public static function insert(string $table, array $row): void
    {
        $columns = array_keys($row);
        $sql = sprintf('INSERT INTO %s (%s) VALUES (%s)', $table, implode(', ', $columns),
            implode(', ', array_fill(0, count($columns), '?')));
        self::run($sql, array_values($row));
    }

    /** UPDATE ... SET (assoc array) WHERE (sql with ? placeholders). Returns affected rows. */
    public static function update(string $table, array $set, string $where, array $whereParams = []): int
    {
        $assignments = implode(', ', array_map(static fn (string $c): string => $c . ' = ?', array_keys($set)));
        $stmt = self::run(sprintf('UPDATE %s SET %s WHERE %s', $table, $assignments, $where),
            array_merge(array_values($set), $whereParams));
        return $stmt->rowCount();
    }

    public static function transaction(callable $fn): mixed
    {
        $pdo = self::pdo();
        $pdo->beginTransaction();
        try {
            $result = $fn();
            $pdo->commit();
            return $result;
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
    }
}
