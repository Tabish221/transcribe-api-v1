<?php

declare(strict_types=1);

namespace Tapi;

/**
 * The current HTTP request: method, route path (request path minus the app's base path),
 * headers and body helpers.
 */
final class Request
{
    private ?array $jsonBody = null;

    private function __construct(
        public readonly string $method,
        public readonly string $path,      // decoded request path without query, e.g. /transcribe/api/v1/health
        public readonly string $basePath,  // app base path with trailing slash, e.g. /transcribe/
        public readonly string $route      // path relative to the base path, e.g. /api/v1/health
    ) {
    }

    public static function capture(): self
    {
        $method = strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET'));
        $uri = (string) ($_SERVER['REQUEST_URI'] ?? '/');
        $rawPath = (string) (parse_url($uri, PHP_URL_PATH) ?? '/');
        $path = rawurldecode($rawPath === '' ? '/' : $rawPath);
        $base = self::detectBasePath();

        $script = (string) ($_SERVER['SCRIPT_NAME'] ?? '');
        if (PHP_SAPI !== 'cli-server' && $script !== '' && str_starts_with($path, $script . '/')) {
            // index.php/api/v1/... (PATH_INFO fallback when mod_rewrite is unavailable)
            $route = (string) ($_SERVER['PATH_INFO'] ?? substr($path, strlen($script)));
        } elseif (str_starts_with($path, $base)) {
            $route = '/' . substr($path, strlen($base));
        } else {
            $route = $path;
        }
        if ($route === '' || $route[0] !== '/') {
            $route = '/' . $route;
        }
        if (str_starts_with($route, '/index.php/')) {
            $route = substr($route, strlen('/index.php')); // PATH_INFO style under any server
        }
        // ?route=/api/v1/... fallback
        if (($route === '/' || $route === '/index.php') && isset($_GET['route']) && is_string($_GET['route'])
            && str_starts_with($_GET['route'], '/')) {
            $route = $_GET['route'];
        }
        return new self($method, $path, $base, $route);
    }

    /** Directory of the executing index.php relative to the web root ("/" or "/transcribe/"). */
    private static function detectBasePath(): string
    {
        if (PHP_SAPI === 'cli-server') {
            return '/'; // php -S with index.php as router script always serves the app at the root
        }
        $script = str_replace('\\', '/', (string) ($_SERVER['SCRIPT_NAME'] ?? '/index.php'));
        $dir = rtrim(str_replace('\\', '/', dirname($script)), '/'); // dirname('/x') is "\" on Windows
        return $dir === '' || $dir === '.' ? '/' : $dir . '/';
    }

    public function header(string $name): ?string
    {
        $key = 'HTTP_' . strtoupper(str_replace('-', '_', $name));
        if (isset($_SERVER[$key]) && $_SERVER[$key] !== '') {
            return (string) $_SERVER[$key];
        }
        if (in_array($key, ['HTTP_CONTENT_TYPE', 'HTTP_CONTENT_LENGTH'], true)) {
            $plain = substr($key, 5);
            return isset($_SERVER[$plain]) ? (string) $_SERVER[$plain] : null;
        }
        return null;
    }

    /** Authorization header from any of the places CGI/FPM/LiteSpeed may put it. */
    public function authorization(): ?string
    {
        foreach (['HTTP_AUTHORIZATION', 'REDIRECT_HTTP_AUTHORIZATION'] as $key) {
            if (!empty($_SERVER[$key])) {
                return trim((string) $_SERVER[$key]);
            }
        }
        if (function_exists('getallheaders')) {
            foreach ((array) getallheaders() as $name => $value) {
                if (strcasecmp((string) $name, 'Authorization') === 0 && $value !== '') {
                    return trim((string) $value);
                }
            }
        }
        return null;
    }

    public function bearerToken(): ?string
    {
        $auth = $this->authorization();
        if ($auth !== null && preg_match('/^Bearer\s+(\S+)$/i', $auth, $m)) {
            return $m[1];
        }
        return null;
    }

    public function query(string $key, ?string $default = null): ?string
    {
        $value = $_GET[$key] ?? null;
        return is_string($value) ? $value : $default;
    }

    /**
     * Decoded JSON body. Form-encoded bodies are accepted as a fallback, and JSON sent without a
     * JSON Content-Type still works. Invalid bodies -> 422.
     */
    public function json(): array
    {
        if ($this->jsonBody !== null) {
            return $this->jsonBody;
        }
        if (str_contains(strtolower((string) $this->header('Content-Type')), 'multipart/form-data')) {
            return $this->jsonBody = $_POST;
        }
        $raw = (string) file_get_contents('php://input');
        $data = json_decode($raw, true);
        if (is_array($data)) {
            return $this->jsonBody = $data;
        }
        if ($_POST !== []) {
            return $this->jsonBody = $_POST;
        }
        if (trim($raw) === '') {
            return $this->jsonBody = [];
        }
        throw ApiException::validation('body', 'Request body must be a JSON object');
    }

    public function input(string $key, mixed $default = null): mixed
    {
        $body = $this->json();
        return array_key_exists($key, $body) ? $body[$key] : $default;
    }

    public function isHttps(): bool
    {
        return Util::isHttps();
    }

    /** Absolute base URL with trailing slash: config base_url, or detected from the request. */
    public function baseUrl(): string
    {
        $configured = trim((string) Config::get('base_url', ''));
        if ($configured !== '') {
            return rtrim($configured, '/') . '/';
        }
        $host = (string) ($_SERVER['HTTP_HOST'] ?? ($_SERVER['SERVER_NAME'] ?? 'localhost'));
        $host = preg_replace('/[^A-Za-z0-9.\-:\[\]]/', '', $host) ?: 'localhost';
        return ($this->isHttps() ? 'https' : 'http') . '://' . $host . $this->basePath;
    }

    public function origin(): ?string
    {
        return $this->header('Origin');
    }
}
