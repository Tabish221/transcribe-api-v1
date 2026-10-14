<?php

declare(strict_types=1);

namespace Tapi;

/** Command-line installer: php install.php --driver=sqlite --admin-email=... --admin-password=... */
final class InstallerCli
{
    private const USAGE = <<<'TXT'
Transcribe API installer

Usage:
  php install.php --driver=sqlite|mysql --admin-email=EMAIL --admin-password=PASSWORD [options]

Database:
  --driver=sqlite|mysql      required
  --db-host=HOST             MySQL host (default localhost)
  --db-port=PORT             MySQL port (default 3306)
  --db-name=NAME             MySQL database name
  --db-user=USER             MySQL user
  --db-pass=PASS             MySQL password
  --sqlite-path=FILE         SQLite file (default <storage>/app.sqlite)

Admin account:
  --admin-email=EMAIL        required
  --admin-password=PASSWORD  required, at least 8 characters
  --admin-name=NAME          default "Admin"

Cloud engine (OpenAI-compatible, optional):
  --cloud-base-url=URL       default https://api.groq.com/openai/v1
  --cloud-api-key=KEY        without a key the cloud engine stays disabled
  --cloud-model=MODEL        default whisper-large-v3-turbo

Other:
  --config-path=FILE         where to write config.php (default: $TAPI_CONFIG or server/config.php)
  --storage-path=DIR         default: <config dir>/storage
  --base-url=URL             public URL of the app, e.g. https://example.com/transcribe (auto-detected if empty)
  --worker-token=TOKEN       use this worker token instead of generating one (min 16 chars)
  --default-engine=cloud|worker   default: cloud when a cloud key is given, else worker
  --allow-private-webhooks   allow webhooks to private/loopback hosts (local testing only)
  --allow-registration       let anyone create an account from the login page
  --help

TXT;

    public static function main(array $argv): int
    {
        try {
            $args = self::parse($argv);
        } catch (\InvalidArgumentException $e) {
            fwrite(STDERR, 'Error: ' . $e->getMessage() . "\n\n" . self::USAGE);
            return 2;
        }
        if (isset($args['help']) || $args === []) {
            echo self::USAGE;
            return isset($args['help']) ? 0 : 2;
        }
        foreach (['driver', 'admin-email', 'admin-password'] as $required) {
            if (!isset($args[$required]) || $args[$required] === true || $args[$required] === '') {
                fwrite(STDERR, "Error: --{$required} is required\n\n" . self::USAGE);
                return 2;
            }
        }

        $configPath = self::str($args, 'config-path') ?: Config::path();
        $configPath = self::absolute($configPath);
        $storage = self::str($args, 'storage-path');
        $storage = $storage !== '' ? self::absolute($storage) : Installer::defaultStoragePath($configPath);
        if (Installer::isLocked($storage)) {
            fwrite(STDERR, 'Error: already installed (' . Installer::lockFile($storage) . " exists). Delete it to reinstall.\n");
            return 1;
        }
        $failed = array_filter(Installer::requirements($storage), static fn (array $c): bool => !$c['ok']);
        foreach ($failed as $check) {
            fwrite(STDERR, "Requirement not met: {$check['label']} ({$check['detail']})\n");
        }
        if ($failed !== []) {
            return 1;
        }

        $sqlite = self::str($args, 'sqlite-path');
        try {
            $result = Installer::install([
                'config_path' => $configPath,
                'storage_path' => $storage,
                'db' => [
                    'driver' => self::str($args, 'driver'),
                    'host' => self::str($args, 'db-host'),
                    'port' => self::str($args, 'db-port'),
                    'name' => self::str($args, 'db-name'),
                    'user' => self::str($args, 'db-user'),
                    'pass' => self::str($args, 'db-pass'),
                    'sqlite_path' => $sqlite !== '' ? self::absolute($sqlite) : '',
                ],
                'admin' => [
                    'name' => self::str($args, 'admin-name') ?: 'Admin',
                    'email' => self::str($args, 'admin-email'),
                    'password' => self::str($args, 'admin-password'),
                ],
                'cloud' => [
                    'base_url' => self::str($args, 'cloud-base-url'),
                    'api_key' => self::str($args, 'cloud-api-key'),
                    'model' => self::str($args, 'cloud-model'),
                ],
                'base_url' => self::str($args, 'base-url'),
                'worker_token' => self::str($args, 'worker-token'),
                'default_engine' => self::str($args, 'default-engine'),
                'allow_private_webhooks' => isset($args['allow-private-webhooks']),
                'allow_registration' => isset($args['allow-registration']),
            ]);
        } catch (\Throwable $e) {
            $field = $e instanceof ApiException && isset($e->extra['field']) ? ' (' . $e->extra['field'] . ')' : '';
            fwrite(STDERR, 'Install failed: ' . $e->getMessage() . $field . "\n");
            return 1;
        }
        if (!$result['config_written']) {
            fwrite(STDERR, 'Install failed: could not write ' . $result['config_path'] . "\n");
            return 1;
        }
        echo "Transcribe API installed.\n";
        echo 'Config:       ' . $result['config_path'] . "\n";
        echo 'Storage:      ' . $result['storage_path'] . "\n";
        echo 'Admin:        ' . Users::normalizeEmail(self::str($args, 'admin-email')) . "\n";
        echo 'Worker token: ' . $result['worker_token'] . "\n";
        return 0;
    }

    /** --key=value, --key value and bare --flag (true). */
    private static function parse(array $argv): array
    {
        $args = [];
        $count = count($argv);
        for ($i = 1; $i < $count; $i++) {
            $arg = (string) $argv[$i];
            if (!str_starts_with($arg, '--') || $arg === '--') {
                throw new \InvalidArgumentException("Unexpected argument: {$arg}");
            }
            $arg = substr($arg, 2);
            if (str_contains($arg, '=')) {
                [$key, $value] = explode('=', $arg, 2);
            } elseif (isset($argv[$i + 1]) && !str_starts_with((string) $argv[$i + 1], '--')) {
                $key = $arg;
                $value = (string) $argv[++$i];
            } else {
                $key = $arg;
                $value = true;
            }
            $args[strtolower($key)] = $value;
        }
        return $args;
    }

    private static function str(array $args, string $key): string
    {
        return isset($args[$key]) && is_string($args[$key]) ? $args[$key] : '';
    }

    private static function absolute(string $path): string
    {
        $path = str_replace('\\', '/', $path);
        $isAbsolute = str_starts_with($path, '/') || preg_match('#^[A-Za-z]:/#', $path) === 1;
        return $isAbsolute ? $path : str_replace('\\', '/', (string) getcwd()) . '/' . $path;
    }
}
