<?php

use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Http\Request;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        commands: __DIR__.'/../routes/console.php',
        health: '/up',
    )
    ->withMiddleware(function (Middleware $middleware): void {
        // The Transcribe API cannot send a CSRF token. The webhook checks X-Transcribe-Signature instead.
        $middleware->validateCsrfTokens(except: [
            'webhooks/transcribe',
        ]);
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        // JSON routes get JSON errors (for example 419 when the CSRF token expired).
        $exceptions->shouldRenderJsonWhen(
            fn ($request) => $request->is('app-api/*', 'tester-api/*', 'webhooks/*') || $request->expectsJson()
        );
        // Unknown local id on the App page: a short message instead of "No query results for model ...".
        $exceptions->render(function (NotFoundHttpException $e, Request $request) {
            if ($request->is('app-api/transcriptions/*')) {
                return response()->json(['error' => [
                    'code' => 'not_found',
                    'message' => 'This transcription was not found. Maybe it was deleted.',
                ]], 404);
            }
        });
    })->create();
