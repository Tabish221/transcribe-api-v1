<?php

declare(strict_types=1);

namespace Tapi;

use Tapi\Api\DashApi;
use Tapi\Api\PublicApi;
use Tapi\Api\WorkerApi;

/** Front controller: routing, error handling and post-response ("deferred") work. */
final class App
{
    /** @var callable[] */
    private static array $deferred = [];

    public static function run(): void
    {
        Response::securityHeaders();
        try {
            self::handle(Request::capture());
        } catch (ApiException $e) {
            Response::error($e->status, $e->errorCode, $e->getMessage(), $e->extra);
        } catch (\Throwable $e) {
            Logger::exception($e);
            if (!headers_sent()) {
                Response::error(500, 'server_error', 'Internal server error');
            }
        }
        self::runDeferred();
    }

    /** Queues work to run after the response has been sent (webhooks, cloud processing). */
    public static function defer(callable $task): void
    {
        self::$deferred[] = $task;
    }

    /** True when the SAPI can close the client connection and keep running (PHP-FPM, LiteSpeed). */
    public static function canFinishRequest(): bool
    {
        return function_exists('fastcgi_finish_request') || function_exists('litespeed_finish_request');
    }

    private static function handle(Request $request): void
    {
        // /transcribe -> /transcribe/ so relative dashboard URLs and the cookie path work.
        if ($request->basePath !== '/' && $request->path === rtrim($request->basePath, '/')) {
            $query = (string) ($_SERVER['QUERY_STRING'] ?? '');
            Response::redirect($request->basePath . ($query !== '' ? '?' . $query : ''), 301);
            return;
        }
        $route = $request->route;

        if (PHP_SAPI === 'cli-server') {
            if ($route === '/install.php') {
                require TAPI_SERVER_DIR . '/install.php';
                return;
            }
            if (StaticFiles::serve($route)) {
                return;
            }
        }

        $isDashboard = in_array($route, ['/', '/index.html', '/index.php'], true);
        if (!Config::load()) {
            if ($isDashboard) {
                Response::redirect($request->basePath . 'install.php');
                return;
            }
            if (str_starts_with($route, '/api/')) {
                throw new ApiException(503, 'not_installed', 'Transcribe API is not installed yet. Open install.php to set it up.');
            }
            throw ApiException::notFound();
        }

        if ($isDashboard) {
            StaticFiles::dashboard();
            return;
        }
        if (!str_starts_with($route, '/api/')) {
            throw ApiException::notFound('Not found');
        }

        if (str_starts_with($route, '/api/v1/')) {
            self::cors($request);
            if ($request->method === 'OPTIONS') {
                Response::noContent();
                return;
            }
        }
        $router = new Router();
        PublicApi::register($router);
        WorkerApi::register($router);
        DashApi::register($router);
        $router->dispatch($request);
    }

    /** CORS for the public API only (config cors_origins: exact origins or ["*"]). */
    private static function cors(Request $request): void
    {
        $origin = $request->origin();
        if ($origin === null || $origin === '') {
            return;
        }
        $allowed = array_map(static fn ($o): string => rtrim((string) $o, '/'), (array) Config::get('cors_origins', []));
        if (in_array('*', $allowed, true)) {
            Response::addHeader('Access-Control-Allow-Origin: *');
        } elseif (in_array(rtrim($origin, '/'), $allowed, true)) {
            Response::addHeader('Access-Control-Allow-Origin: ' . $origin);
            Response::addHeader('Vary: Origin');
        } else {
            return;
        }
        Response::addHeader('Access-Control-Allow-Headers: Authorization, X-API-Key, Content-Type');
        Response::addHeader('Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS');
        Response::addHeader('Access-Control-Max-Age: 600');
    }

    /** Closes the connection when possible, then runs queued tasks (tasks may queue more tasks). */
    private static function runDeferred(): void
    {
        if (self::$deferred === []) {
            return;
        }
        ignore_user_abort(true);
        @set_time_limit(0);
        Auth::closeSession();
        if (function_exists('fastcgi_finish_request')) {
            fastcgi_finish_request();
        } elseif (function_exists('litespeed_finish_request')) {
            litespeed_finish_request();
        }
        while (($task = array_shift(self::$deferred)) !== null) {
            try {
                $task();
            } catch (\Throwable $e) {
                Logger::exception($e, 'Deferred task failed');
            }
        }
    }
}
