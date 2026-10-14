<?php

declare(strict_types=1);

namespace Tapi;

/** Web installer wizard (install.php in a browser). No JavaScript; locked after a successful install. */
final class InstallerWeb
{
    private const COOKIE = 'tapi_install';

    public static function handle(): void
    {
        $configPath = Config::path();
        $storage = self::storagePath($configPath);
        if (Installer::isLocked($storage)) {
            self::page('Already installed', '<p>Transcribe API is already installed. For safety the installer is locked.</p>'
                . '<p class="muted">To run it again, delete <code>' . self::e(Installer::lockFile($storage)) . '</code>.</p>'
                . '<p><a class="button" href="./">Open the dashboard</a></p>', 403);
            return;
        }

        $values = self::defaults($storage);
        $error = null;
        if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST') {
            $values = array_merge($values, array_map(static fn ($v): string => is_string($v) ? $v : '', $_POST));
            $cookie = (string) ($_COOKIE[self::COOKIE] ?? '');
            if ($cookie === '' || !hash_equals($cookie, (string) ($_POST['csrf'] ?? ''))) {
                $error = 'Your form session expired. Please submit again.';
            } elseif (!Installer::requirementsMet($storage)) {
                $error = 'Fix the failed requirements first.';
            } else {
                try {
                    $result = self::install($values, $configPath, $storage);
                    self::success($result, $values);
                    return;
                } catch (\Throwable $e) {
                    $error = $e->getMessage();
                    if (!$e instanceof ApiException && !$e instanceof \RuntimeException) {
                        Logger::exception($e, 'Installer failed');
                        $error = 'Unexpected error: ' . $e->getMessage();
                    }
                }
            }
        }
        self::form($values, $storage, $configPath, $error);
    }

    private static function install(array $v, string $configPath, string $storage): array
    {
        if ($v['admin_password'] !== $v['admin_password2']) {
            throw new \RuntimeException('The two admin passwords do not match.');
        }
        return Installer::install([
            'config_path' => $configPath,
            'storage_path' => $storage,
            'db' => [
                'driver' => $v['driver'],
                'host' => $v['db_host'],
                'port' => $v['db_port'],
                'name' => $v['db_name'],
                'user' => $v['db_user'],
                'pass' => $v['db_pass'],
                'sqlite_path' => $v['sqlite_path'],
            ],
            'admin' => ['name' => $v['admin_name'], 'email' => $v['admin_email'], 'password' => $v['admin_password']],
            'cloud' => ['base_url' => $v['cloud_base_url'], 'api_key' => $v['cloud_api_key'], 'model' => $v['cloud_model']],
            'base_url' => $v['base_url'],
        ]);
    }

    /** Storage folder: from an existing config.php when present, else <config dir>/storage. */
    private static function storagePath(string $configPath): string
    {
        try {
            if (Config::load()) {
                return Config::storagePath();
            }
        } catch (\Throwable $e) {
            // unreadable config: fall back to the default location
        }
        return Installer::defaultStoragePath($configPath);
    }

    private static function defaults(string $storage): array
    {
        $drivers = \PDO::getAvailableDrivers();
        return [
            'driver' => in_array('mysql', $drivers, true) ? 'mysql' : 'sqlite',
            'db_host' => 'localhost', 'db_port' => '3306', 'db_name' => '', 'db_user' => '', 'db_pass' => '',
            'sqlite_path' => $storage . '/app.sqlite',
            'admin_name' => '', 'admin_email' => '', 'admin_password' => '', 'admin_password2' => '',
            'cloud_base_url' => 'https://api.groq.com/openai/v1', 'cloud_api_key' => '', 'cloud_model' => 'whisper-large-v3-turbo',
            'base_url' => '',
        ];
    }

    private static function form(array $v, string $storage, string $configPath, ?string $error): void
    {
        $csrf = bin2hex(random_bytes(16));
        setcookie(self::COOKIE, $csrf, [
            'expires' => 0, 'path' => self::cookiePath(), 'secure' => Util::isHttps(), 'httponly' => true, 'samesite' => 'Strict',
        ]);
        $checks = '';
        foreach (Installer::requirements($storage) as $c) {
            $checks .= '<li class="' . ($c['ok'] ? 'ok' : 'bad') . '"><span>' . ($c['ok'] ? '&#10003;' : '&#10007;') . '</span> '
                . self::e($c['label']) . ' <small>' . self::e($c['detail']) . '</small></li>';
        }
        $drivers = \PDO::getAvailableDrivers();
        $option = static function (string $value, string $label) use ($v, $drivers): string {
            $disabled = in_array($value, $drivers, true) ? '' : ' disabled';
            $selected = $v['driver'] === $value ? ' selected' : '';
            return "<option value=\"{$value}\"{$selected}{$disabled}>{$label}</option>";
        };
        $f = static fn (string $name, string $label, string $type = 'text', string $hint = '', string $extra = ''): string =>
            '<label>' . self::e($label) . '<input type="' . $type . '" name="' . $name . '" value="'
            . ($type === 'password' ? '' : self::e($v[$name] ?? '')) . '"' . $extra . '>'
            . ($hint !== '' ? '<small>' . $hint . '</small>' : '') . '</label>';

        $html = ($error !== null ? '<div class="alert">' . self::e($error) . '</div>' : '')
            . '<div class="card"><h2>1. Requirements</h2><ul class="checks">' . $checks . '</ul>'
            . '<p class="muted">Config file: <code>' . self::e($configPath) . '</code></p></div>'
            . '<form method="post" autocomplete="off">'
            . '<input type="hidden" name="csrf" value="' . $csrf . '">'
            . '<div class="card"><h2>2. Database</h2>'
            . '<label>Driver<select name="driver">' . $option('mysql', 'MySQL / MariaDB (recommended on cPanel)') . $option('sqlite', 'SQLite (small installs)') . '</select></label>'
            . '<div class="grid">' . $f('db_host', 'MySQL host') . $f('db_port', 'MySQL port') . $f('db_name', 'MySQL database name')
            . $f('db_user', 'MySQL user') . $f('db_pass', 'MySQL password', 'password', 'cPanel: create the database and user under "MySQL Databases".') . '</div>'
            . $f('sqlite_path', 'SQLite file (SQLite only)') . '</div>'
            . '<div class="card"><h2>3. Administrator</h2><div class="grid">'
            . $f('admin_name', 'Name') . $f('admin_email', 'Email', 'email', '', ' required')
            . $f('admin_password', 'Password (min. 8 characters)', 'password', '', ' required minlength="8"')
            . $f('admin_password2', 'Repeat password', 'password', '', ' required minlength="8"') . '</div></div>'
            . '<div class="card"><h2>4. Cloud engine <span class="muted">(optional)</span></h2>'
            . '<p class="muted">Any OpenAI-compatible speech-to-text API, e.g. Groq (<code>https://api.groq.com/openai/v1</code>, model <code>whisper-large-v3-turbo</code>) '
            . 'or OpenAI (<code>https://api.openai.com/v1</code>, model <code>whisper-1</code>). Leave the key empty to use only the PC worker.</p>'
            . $f('cloud_base_url', 'API base URL') . '<div class="grid">' . $f('cloud_api_key', 'API key', 'password') . $f('cloud_model', 'Model') . '</div>'
            . $f('base_url', 'Public URL of this app (optional)', 'url', 'Auto-detected when empty, e.g. https://example.com/transcribe')
            . '</div><button class="primary" type="submit">Install</button></form>';
        self::page('Install', $html);
    }

    private static function success(array $result, array $v): void
    {
        $cron = '/usr/local/bin/php ' . TAPI_SERVER_DIR . '/cron/process.php'; // cPanel's PHP CLI path
        $html = '<div class="card"><h2>Installed</h2>'
            . '<p>Sign in to the dashboard as <strong>' . self::e(Users::normalizeEmail($v['admin_email'])) . '</strong>.</p>'
            . '<p>Worker token for the PC worker (<code>WORKER_TOKEN</code> in <code>worker/.env</code>). It is also stored in config.php:</p>'
            . '<pre>' . self::e($result['worker_token']) . '</pre>'
            . '<p>Add this cron job in cPanel (every minute) to process cloud jobs, retry webhooks and delete old audio:</p>'
            . '<pre>* * * * * ' . self::e($cron) . ' &gt;/dev/null 2&gt;&amp;1</pre>';
        if (!$result['config_written']) {
            $html .= '<div class="alert">Could not write <code>' . self::e($result['config_path']) . '</code>. Create it with this content, '
                . 'then reload the dashboard:</div><textarea readonly rows="16">' . self::e($result['config_php']) . '</textarea>';
        }
        $html .= '<p><a class="button primary" href="./">Open the dashboard</a></p></div>';
        self::page('Installed', $html);
    }

    private static function page(string $title, string $body, int $status = 200): void
    {
        $html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
            . '<meta name="robots" content="noindex"><title>' . self::e($title) . ' - Transcribe API</title><style>' . self::CSS . '</style></head>'
            . '<body><main><div class="eyebrow">Transcribe API</div><h1>' . self::e($title) . '</h1>' . $body . '</main></body></html>';
        Response::html($html, $status, [
            "Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
            'Cache-Control: no-store',
        ]);
    }

    private static function cookiePath(): string
    {
        $dir = rtrim(str_replace('\\', '/', dirname((string) ($_SERVER['SCRIPT_NAME'] ?? '/install.php'))), '/');
        return PHP_SAPI === 'cli-server' || $dir === '' || $dir === '.' ? '/' : $dir . '/';
    }

    private static function e(string $value): string
    {
        return htmlspecialchars($value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    }

    private const CSS = <<<'CSS'
:root{--bg:#f6f6f8;--card:#fff;--text:#1b1b1f;--muted:#6b6b76;--border:#e3e3ea;--accent:#6d28d9;--accent-soft:#ede9fe;--accent-text:#fff;--bad:#b91c1c;--ok:#15803d}
@media (prefers-color-scheme:dark){:root{--bg:#111115;--card:#1b1b21;--text:#ececf1;--muted:#9a9aa6;--border:#2d2d36;--accent:#a78bfa;--accent-soft:#2a2340;--accent-text:#0d0b14;--bad:#f87171;--ok:#4ade80}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:760px;margin:0 auto;padding:32px 16px 80px}.eyebrow{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--accent);font-weight:600}
h1{font-size:26px;margin:4px 0 20px}h2{font-size:17px;margin:0 0 12px}.card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:20px;margin-bottom:16px}
label{display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--muted);margin-bottom:12px}label small{font-size:12px}
input,select,textarea{font:inherit;color:var(--text);background:var(--card);border:1px solid var(--border);border-radius:8px;padding:8px 10px;width:100%}
textarea{font:12px/1.5 ui-monospace,Consolas,monospace}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:0 12px}
.checks{list-style:none;padding:0;margin:0 0 8px}.checks li{padding:3px 0}.checks small{color:var(--muted)}.ok span{color:var(--ok)}.bad span,.bad{color:var(--bad)}
.muted{color:var(--muted);font-size:13px;font-weight:400}code,pre{font:13px ui-monospace,Consolas,monospace}pre{background:var(--accent-soft);padding:10px 12px;border-radius:8px;overflow-x:auto;white-space:pre-wrap;word-break:break-all}
.alert{border:1px solid var(--bad);color:var(--bad);border-radius:10px;padding:10px 14px;margin-bottom:16px}
button,.button{font:inherit;display:inline-block;text-decoration:none;cursor:pointer;border-radius:8px;padding:10px 18px;border:1px solid var(--border);background:var(--card);color:var(--text)}
.primary{background:var(--accent);color:var(--accent-text);border:none;font-weight:600}
CSS;
}
