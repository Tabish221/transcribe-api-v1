<?php

declare(strict_types=1);

namespace Tapi;

/**
 * Dashboard authentication: PHP session cookie, CSRF token and login throttling.
 */
final class Auth
{
    private const THROTTLE_WINDOW = 900;   // 15 minutes
    private const THROTTLE_MAX_FAILS = 10; // failed attempts per IP per window
    private const SESSION_LIFETIME = 604800; // idle sessions expire after 7 days

    private static ?array $user = null;

    public static function startSession(Request $request): void
    {
        if (session_status() === PHP_SESSION_ACTIVE) {
            return;
        }
        $dir = Config::storagePath('sessions');
        if (is_dir($dir) || @mkdir($dir, 0700, true)) {
            session_save_path($dir);
            ini_set('session.gc_probability', '1');
            ini_set('session.gc_divisor', '100');
        }
        ini_set('session.use_strict_mode', '1');
        ini_set('session.use_only_cookies', '1');
        ini_set('session.use_trans_sid', '0');
        ini_set('session.gc_maxlifetime', (string) self::SESSION_LIFETIME);
        session_name((string) Config::get('session_name', 'tapi_session'));
        session_set_cookie_params([
            'lifetime' => 0,
            'path' => $request->basePath,
            'secure' => $request->isHttps(),
            'httponly' => true,
            'samesite' => 'Lax',
        ]);
        session_start();
    }

    /** Starts the session only when the browser sent a session cookie (anonymous requests create no session files). */
    public static function resumeSession(Request $request): void
    {
        $name = (string) Config::get('session_name', 'tapi_session');
        if (isset($_COOKIE[$name]) && is_string($_COOKIE[$name]) && $_COOKIE[$name] !== '') {
            self::startSession($request);
        }
    }

    /** Releases the session lock early (read-only requests); $_SESSION stays readable. */
    public static function closeSession(): void
    {
        if (session_status() === PHP_SESSION_ACTIVE) {
            session_write_close();
        }
    }

    /** The signed-in, enabled user or null. */
    public static function user(): ?array
    {
        if (self::$user !== null) {
            return self::$user;
        }
        if (session_status() !== PHP_SESSION_ACTIVE && !isset($_SESSION)) {
            return null;
        }
        $id = $_SESSION['uid'] ?? null;
        if (!is_string($id)) {
            return null;
        }
        $user = Users::find($id);
        if ($user === null || $user['disabled_at'] !== null
            || !hash_equals(self::passwordFingerprint($user), (string) ($_SESSION['pwf'] ?? ''))) {
            return null; // deleted, disabled, or password changed since this session logged in
        }
        return self::$user = $user;
    }

    public static function requireUser(): array
    {
        $user = self::user();
        if ($user === null) {
            throw ApiException::unauthorized('Please sign in');
        }
        return $user;
    }

    public static function requireAdmin(): array
    {
        $user = self::requireUser();
        if (!$user['is_admin']) {
            throw ApiException::forbidden('Administrator access required');
        }
        return $user;
    }

    public static function csrfToken(): string
    {
        if (empty($_SESSION['csrf']) || !is_string($_SESSION['csrf'])) {
            $_SESSION['csrf'] = bin2hex(random_bytes(32));
        }
        return $_SESSION['csrf'];
    }

    /** Validates X-CSRF-Token and, when present, that the Origin header is this host. */
    public static function checkCsrf(Request $request): void
    {
        self::checkOrigin($request);
        $sent = (string) $request->header('X-CSRF-Token');
        $expected = $_SESSION['csrf'] ?? '';
        if ($sent === '' || !is_string($expected) || $expected === '' || !hash_equals($expected, $sent)) {
            throw new ApiException(403, 'csrf_failed', 'Missing or invalid CSRF token');
        }
    }

    /** Rejects cross-origin dashboard writes (defence in depth on top of the CSRF token). */
    public static function checkOrigin(Request $request): void
    {
        $origin = $request->origin();
        if ($origin === null || $origin === '' || $origin === 'null') {
            return;
        }
        $originHost = strtolower((string) parse_url($origin, PHP_URL_HOST));
        $originPort = parse_url($origin, PHP_URL_PORT);
        $origin = $originHost . ($originPort ? ':' . $originPort : '');
        $host = strtolower((string) ($_SERVER['HTTP_HOST'] ?? ''));
        $host = preg_replace('/:(80|443)$/', '', $host) ?? $host;
        if ($origin !== $host) {
            throw new ApiException(403, 'csrf_failed', 'Cross-origin request rejected');
        }
    }

    /** Verifies credentials with throttling; on success starts an authenticated session. */
    public static function login(string $email, string $password): array
    {
        $ip = Util::clientIp();
        $since = time() - self::THROTTLE_WINDOW;
        $fails = (int) Db::value('SELECT COUNT(*) FROM login_attempts WHERE ip = ? AND created_at > ?', [$ip, $since]);
        if ($fails >= self::THROTTLE_MAX_FAILS) {
            throw new ApiException(429, 'rate_limited', 'Too many failed sign-in attempts. Try again in 15 minutes.');
        }

        $email = Users::normalizeEmail($email);
        $user = $email === '' ? null : Users::findByEmail($email);
        // Verify against a dummy hash for unknown users so timing does not reveal which emails exist.
        $hash = $user['password_hash'] ?? '$2y$10$YdBxU63oFaiSORnT7XBHZ.ZoFuip.FH2.r3FtpWyIxNvRD0nbJRby';
        if (!password_verify($password, $hash) || $user === null) {
            Db::insert('login_attempts', [
                'id' => Util::id('la_'),
                'ip' => $ip,
                'email' => Util::cut($email, 190),
                'created_at' => time(),
            ]);
            throw ApiException::unauthorized('Invalid email or password');
        }
        if ($user['disabled_at'] !== null) {
            throw ApiException::forbidden('This account is disabled');
        }
        if (password_needs_rehash($user['password_hash'], PASSWORD_DEFAULT)) {
            Users::setPassword($user['id'], $password);
            $user = Users::find($user['id']);
        }
        Db::update('users', ['last_login_at' => time()], 'id = ?', [$user['id']]);
        self::signIn($user);
        return $user;
    }

    /** Binds the session to a user (new session id, fresh CSRF token). */
    public static function signIn(array $user): void
    {
        session_regenerate_id(true);
        $_SESSION = [
            'uid' => $user['id'],
            'pwf' => self::passwordFingerprint($user),
            'csrf' => bin2hex(random_bytes(32)),
            'at' => time(),
        ];
        self::$user = $user;
    }

    /** Called after the signed-in user changes their password so this session stays valid. */
    public static function refresh(array $user): void
    {
        $_SESSION['pwf'] = self::passwordFingerprint($user);
        self::$user = $user;
    }

    public static function logout(): void
    {
        $_SESSION = [];
        if (session_status() === PHP_SESSION_ACTIVE) {
            $params = session_get_cookie_params();
            setcookie(session_name(), '', [
                'expires' => time() - 3600,
                'path' => $params['path'],
                'secure' => $params['secure'],
                'httponly' => true,
                'samesite' => 'Lax',
            ]);
            session_destroy();
        }
        self::$user = null;
    }

    private static function passwordFingerprint(array $user): string
    {
        return substr(hash('sha256', (string) $user['password_hash']), 0, 16);
    }
}
