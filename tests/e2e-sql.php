<?php
/**
 * Test helper for tests/e2e.mjs: runs ONE SQL statement and prints {"rows":[...],"affected":N} as JSON.
 *
 * App database (the config named by TAPI_CONFIG, SQLite or MySQL):
 *   echo '{"sql":"SELECT * FROM transcriptions WHERE id = ?","params":["tr_..."]}' | php tests/e2e-sql.php
 *
 * MySQL server without a database (create/drop the test database; no TAPI_CONFIG needed):
 *   echo '{"server":{"host":"127.0.0.1","port":3306,"user":"root","pass":""},"sql":"CREATE DATABASE x"}' | php tests/e2e-sql.php
 *
 * Used to simulate time passing (expired leases, old completed_at) and to inspect cascades.
 */

declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    exit(1);
}

require dirname(__DIR__) . '/server/src/bootstrap.php';

$input = json_decode((string) stream_get_contents(STDIN), true);
if (!is_array($input) || !is_string($input['sql'] ?? null)) {
    fwrite(STDERR, "Expected JSON on stdin: {\"sql\": \"...\", \"params\": [...]}\n");
    exit(2);
}

if (is_array($input['server'] ?? null)) {
    $s = $input['server'];
    $pdo = new PDO(
        sprintf('mysql:host=%s;port=%d;charset=utf8mb4', (string) ($s['host'] ?? '127.0.0.1'), (int) ($s['port'] ?? 3306)),
        (string) ($s['user'] ?? 'root'),
        (string) ($s['pass'] ?? ''),
        [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]
    );
    echo json_encode(['rows' => [], 'affected' => $pdo->exec($input['sql'])]), "\n";
    exit(0);
}

if (!\Tapi\Config::load()) {
    fwrite(STDERR, 'Config not found: ' . \Tapi\Config::path() . "\n");
    exit(1);
}
$stmt = \Tapi\Db::run($input['sql'], array_values((array) ($input['params'] ?? [])));
echo json_encode([
    'rows' => $stmt->columnCount() > 0 ? $stmt->fetchAll() : [],
    'affected' => $stmt->rowCount(),
], JSON_UNESCAPED_SLASHES), "\n";
