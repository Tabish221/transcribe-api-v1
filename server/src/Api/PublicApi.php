<?php

declare(strict_types=1);

namespace Tapi\Api;

use Tapi\ApiException;
use Tapi\ApiKeys;
use Tapi\Config;
use Tapi\Db;
use Tapi\Formatters;
use Tapi\Logger;
use Tapi\Request;
use Tapi\Response;
use Tapi\Router;
use Tapi\Transcriptions;

/** Public REST API (/api/v1), authenticated with a project API key. */
final class PublicApi
{
    public static function register(Router $router): void
    {
        $router->get('/api/v1/health', [self::class, 'health']);
        $router->post('/api/v1/transcriptions', [self::class, 'create']);
        $router->get('/api/v1/transcriptions', [self::class, 'list']);
        $router->get('/api/v1/transcriptions/{id}', [self::class, 'show']);
        $router->delete('/api/v1/transcriptions/{id}', [self::class, 'destroy']);
    }

    public static function health(Request $request): void
    {
        try {
            Db::value('SELECT 1');
        } catch (\Throwable $e) {
            Logger::exception($e, 'Health check: database unavailable');
            throw new ApiException(503, 'server_error', 'Database unavailable');
        }
        Response::json([
            'ok' => true,
            'version' => TAPI_VERSION,
            'engines' => ['cloud' => Config::cloudEnabled(), 'worker' => Config::workerEnabled()],
        ]);
    }

    public static function create(Request $request): void
    {
        [$key, $project] = ApiKeys::authenticate($request);
        [$status, $body] = Transcriptions::createFromUpload($project, (string) $key['id'], null);
        Response::json($body, $status);
    }

    public static function list(Request $request): void
    {
        [, $project] = ApiKeys::authenticate($request);
        Response::json(Transcriptions::list((string) $project['id'], $request));
    }

    public static function show(Request $request, string $id): void
    {
        [, $project] = ApiKeys::authenticate($request);
        self::sendTranscription(Transcriptions::findInProject($id, (string) $project['id']), $request->query('format'));
    }

    public static function destroy(Request $request, string $id): void
    {
        [, $project] = ApiKeys::authenticate($request);
        $row = Transcriptions::findInProject($id, (string) $project['id']);
        Transcriptions::delete($row);
        Response::json(['id' => $row['id'], 'deleted' => true]);
    }

    /** JSON object, or a txt/srt/vtt/json download when ?format= is given (409 until completed). */
    public static function sendTranscription(array $row, ?string $format): void
    {
        $object = Transcriptions::serialize($row);
        if ($format === null || $format === '') {
            Response::json($object);
            return;
        }
        $format = strtolower($format);
        if (!Formatters::isFormat($format)) {
            throw ApiException::validation('format', 'format must be one of: txt, srt, vtt, json');
        }
        if ($row['status'] !== 'completed') {
            throw new ApiException(409, 'not_ready', 'The transcription is not completed yet (status: ' . $row['status'] . ')');
        }
        Response::download(Formatters::render($object, $format), Formatters::MIME[$format], Formatters::filename($object, $format));
    }
}
