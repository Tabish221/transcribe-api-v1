<?php

declare(strict_types=1);

namespace Tapi;

/**
 * Installation logic shared by the web wizard and the CLI (install.php):
 * requirement checks, storage folders, tables, first admin, config.php and the lock file.
 */
final class Installer
{
    /** Default storage folder for a config path: <config dir>/storage (server/storage for server/config.php). */
    public static function defaultStoragePath(string $configPath): string
    {
        return str_replace('\\', '/', dirname($configPath)) . '/storage';
    }

    public static function lockFile(string $storagePath): string
    {
        return rtrim(str_replace('\\', '/', $storagePath), '/') . '/installed.lock';
    }

    public static function isLocked(string $storagePath): bool
    {
        return is_file(self::lockFile($storagePath));
    }

    /** @return array<int, array{label:string, ok:bool, detail:string}> */
    public static function requirements(string $storagePath): array
    {
        $drivers = class_exists('PDO') ? \PDO::getAvailableDrivers() : [];
        $pdo = array_values(array_intersect(['mysql', 'sqlite'], $drivers));
        return [
            ['label' => 'PHP 8.1 or newer', 'ok' => version_compare(PHP_VERSION, '8.1.0', '>='), 'detail' => 'PHP ' . PHP_VERSION],
            ['label' => 'PDO driver (pdo_mysql or pdo_sqlite)', 'ok' => $pdo !== [], 'detail' => $pdo ? implode(', ', $pdo) : 'none'],
            ['label' => 'cURL extension', 'ok' => extension_loaded('curl'), 'detail' => extension_loaded('curl') ? 'loaded' : 'missing'],
            ['label' => 'fileinfo extension', 'ok' => extension_loaded('fileinfo'), 'detail' => extension_loaded('fileinfo') ? 'loaded' : 'missing'],
            ['label' => 'Storage folder writable', 'ok' => self::ensureDir($storagePath), 'detail' => $storagePath],
        ];
    }

    public static function requirementsMet(string $storagePath): bool
    {
        foreach (self::requirements($storagePath) as $check) {
            if (!$check['ok']) {
                return false;
            }
        }
        return true;
    }

    /**
     * Runs the installation.
     * @param array $o config_path, storage_path, db{driver,host,port,name,user,pass,sqlite_path},
     *                 admin{name,email,password}, cloud{base_url,api_key,model}, base_url,
     *                 allow_private_webhooks, allow_registration, worker_token, default_engine
     * @return array{config_path:string, config_written:bool, config_php:string, worker_token:string, storage_path:string}
     */
    public static function install(array $o): array
    {
        $configPath = str_replace('\\', '/', (string) $o['config_path']);
        $configDir = dirname($configPath);
        $storage = rtrim(str_replace('\\', '/', (string) ($o['storage_path'] ?: self::defaultStoragePath($configPath))), '/');
        if (self::isLocked($storage)) {
            throw new \RuntimeException('Already installed (' . self::lockFile($storage) . ' exists). Delete it to run the installer again.');
        }

        // Validate input before touching anything.
        $admin = (array) ($o['admin'] ?? []);
        $email = Users::validateEmail($admin['email'] ?? '');
        $password = Users::validatePassword($admin['password'] ?? '', 'admin_password');
        $name = Users::validateName($admin['name'] ?? 'Admin', $email);
        $db = self::dbConfig((array) ($o['db'] ?? []), $storage);
        if (!in_array($db['driver'], \PDO::getAvailableDrivers(), true)) {
            throw new \RuntimeException('The PDO driver pdo_' . $db['driver'] . ' is not available on this server');
        }
        $engine = (string) ($o['default_engine'] ?? '');
        $cloud = array_filter((array) ($o['cloud'] ?? []), static fn ($v): bool => is_string($v) && trim($v) !== '');
        $cloud = array_map('trim', $cloud);
        if ($engine === '') {
            $engine = isset($cloud['api_key']) ? 'cloud' : 'worker';
        }
        if (!in_array($engine, Validate::ENGINES, true)) {
            throw new \RuntimeException('default_engine must be cloud or worker');
        }
        $token = (string) ($o['worker_token'] ?? '');
        if ($token === '') {
            $token = bin2hex(random_bytes(24));
        } elseif (strlen($token) < 16) {
            throw new \RuntimeException('The worker token must be at least 16 characters');
        }

        foreach (['', '/uploads', '/logs', '/sessions'] as $sub) {
            if (!self::ensureDir($storage . $sub)) {
                throw new \RuntimeException('Cannot create or write to ' . $storage . $sub);
            }
        }
        self::protectStorage($storage);

        // Database: tables + first admin (idempotent: an existing admin email gets its password reset).
        try {
            $pdo = Db::connect($db);
            Schema::install($pdo, $db['driver']);
        } catch (\PDOException $e) {
            throw new \RuntimeException('Database error: ' . $e->getMessage());
        }
        Db::setConnection($pdo, $db['driver']);
        $existing = Users::findByEmail($email);
        if ($existing !== null) {
            Db::update('users', [
                'name' => $name,
                'password_hash' => password_hash($password, PASSWORD_DEFAULT),
                'is_admin' => 1,
                'disabled_at' => null,
            ], 'id = ?', [$existing['id']]);
        } else {
            Users::create($name, $email, $password, true);
        }

        $config = Config::merge(Config::defaults($configDir), [
            'base_url' => trim((string) ($o['base_url'] ?? '')),
            'db' => $db,
            'storage_path' => $storage,
            'allow_registration' => (bool) ($o['allow_registration'] ?? false),
            'default_engine' => $engine,
            'cloud' => $cloud,
            'worker' => ['tokens' => [$token]],
            'webhooks' => ['allow_private_hosts' => (bool) ($o['allow_private_webhooks'] ?? false)],
        ]);
        $php = self::exportConfig($config, $configDir);
        $written = self::writeFile($configPath, $php);
        if ($written) {
            @chmod($configPath, 0640);
            file_put_contents(self::lockFile($storage), 'Installed ' . gmdate('c') . "\n");
        }
        return [
            'config_path' => $configPath,
            'config_written' => $written,
            'config_php' => $php,
            'worker_token' => $token,
            'storage_path' => $storage,
        ];
    }

    /** config.php source. Paths inside the config's folder are written relative to __DIR__ (portable). */
    public static function exportConfig(array $config, string $configDir): string
    {
        return "<?php\n"
            . "// Transcribe API configuration - generated by install.php on " . gmdate('Y-m-d H:i') . " UTC.\n"
            . "// Every option is documented in config.sample.php. Keep this file private.\n\n"
            . 'return ' . self::export($config, 0, rtrim(str_replace('\\', '/', $configDir), '/')) . ";\n";
    }

    private static function export(mixed $value, int $depth, string $dir): string
    {
        if (is_array($value)) {
            if ($value === []) {
                return '[]';
            }
            $pad = str_repeat('    ', $depth + 1);
            $list = array_is_list($value);
            $out = "[\n";
            foreach ($value as $key => $item) {
                $out .= $pad . ($list ? '' : var_export($key, true) . ' => ') . self::export($item, $depth + 1, $dir) . ",\n";
            }
            return $out . str_repeat('    ', $depth) . ']';
        }
        if (is_string($value) && $dir !== '' && str_starts_with(str_replace('\\', '/', $value), $dir . '/')) {
            return '__DIR__ . ' . var_export(substr(str_replace('\\', '/', $value), strlen($dir)), true);
        }
        return $value === null ? 'null' : var_export($value, true);
    }

    private static function dbConfig(array $db, string $storage): array
    {
        $driver = strtolower(trim((string) ($db['driver'] ?? '')));
        if (!in_array($driver, ['mysql', 'sqlite'], true)) {
            throw new \RuntimeException('Database driver must be mysql or sqlite');
        }
        $sqlite = trim((string) ($db['sqlite_path'] ?? ''));
        $out = [
            'driver' => $driver,
            'host' => trim((string) ($db['host'] ?? '')) ?: 'localhost',
            'port' => (int) (($db['port'] ?? '') ?: 3306),
            'name' => trim((string) ($db['name'] ?? '')),
            'user' => trim((string) ($db['user'] ?? '')),
            'pass' => (string) ($db['pass'] ?? ''),
            'sqlite_path' => str_replace('\\', '/', $sqlite !== '' ? $sqlite : $storage . '/app.sqlite'),
        ];
        if ($driver === 'mysql' && ($out['name'] === '' || $out['user'] === '')) {
            throw new \RuntimeException('MySQL needs a database name and user');
        }
        return $out;
    }

    private static function ensureDir(string $dir): bool
    {
        if (!is_dir($dir)) {
            @mkdir($dir, 0775, true);
        }
        return is_dir($dir) && is_writable($dir);
    }

    /** Writes deny-all .htaccess files so storage is never web-accessible (also when stored elsewhere). */
    private static function protectStorage(string $storage): void
    {
        $rules = "# Never serve anything from storage/\n"
            . "<IfModule mod_authz_core.c>\n    Require all denied\n</IfModule>\n"
            . "<IfModule !mod_authz_core.c>\n    Order allow,deny\n    Deny from all\n</IfModule>\n";
        if (!is_file($storage . '/.htaccess')) {
            @file_put_contents($storage . '/.htaccess', $rules);
        }
    }

    /** Atomic write (temp file + rename). */
    private static function writeFile(string $path, string $contents): bool
    {
        $dir = dirname($path);
        if (!is_dir($dir) && !@mkdir($dir, 0775, true)) {
            return false;
        }
        $tmp = $path . '.tmp' . bin2hex(random_bytes(4));
        if (@file_put_contents($tmp, $contents) === false) {
            return false;
        }
        if (!@rename($tmp, $path)) {
            @unlink($tmp);
            return false;
        }
        if (function_exists('opcache_invalidate')) {
            @opcache_invalidate($path, true);
        }
        return true;
    }
}
