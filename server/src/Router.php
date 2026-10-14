<?php

declare(strict_types=1);

namespace Tapi;

/** Minimal method + path router. Patterns use {name} placeholders that match one path segment. */
final class Router
{
    /** @var array<int, array{string, string, callable}> */
    private array $routes = [];

    public function add(string $method, string $pattern, callable $handler): self
    {
        $regex = '#^' . preg_replace('#\\\\\{[a-zA-Z_]+\\\\\}#', '([^/]+)', preg_quote($pattern, '#')) . '$#';
        $this->routes[] = [strtoupper($method), $regex, $handler];
        return $this;
    }

    public function get(string $pattern, callable $handler): self
    {
        return $this->add('GET', $pattern, $handler);
    }

    public function post(string $pattern, callable $handler): self
    {
        return $this->add('POST', $pattern, $handler);
    }

    public function patch(string $pattern, callable $handler): self
    {
        return $this->add('PATCH', $pattern, $handler);
    }

    public function delete(string $pattern, callable $handler): self
    {
        return $this->add('DELETE', $pattern, $handler);
    }

    /** Runs the matching handler with (Request, ...placeholders). 404/405 when nothing matches. */
    public function dispatch(Request $request): void
    {
        $method = $request->method === 'HEAD' ? 'GET' : $request->method;
        $allowed = [];
        foreach ($this->routes as [$routeMethod, $regex, $handler]) {
            if (!preg_match($regex, $request->route, $m)) {
                continue;
            }
            if ($routeMethod !== $method) {
                $allowed[] = $routeMethod;
                continue;
            }
            $handler($request, ...array_slice($m, 1));
            return;
        }
        if ($allowed !== []) {
            throw new ApiException(405, 'method_not_allowed', 'Method not allowed (allowed: ' . implode(', ', array_unique($allowed)) . ')');
        }
        throw ApiException::notFound('No route for ' . $method . ' ' . $request->route);
    }
}
