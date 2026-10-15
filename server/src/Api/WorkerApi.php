<?php

declare(strict_types=1);

namespace Tapi\Api;

use Tapi\ApiException;
use Tapi\AudioStream;
use Tapi\Config;
use Tapi\Db;
use Tapi\Jobs;
use Tapi\Request;
use Tapi\Response;
use Tapi\Router;
use Tapi\Transcriptions;
use Tapi\Util;
use Tapi\Validate;

/** Worker API (/api/worker) used by the PC worker; authenticated with a token from config.worker.tokens. */
final class WorkerApi
{
    public static function register(Router $router): void
    {
        $router->post('/api/worker/claim', [self::class, 'claim']);
        $router->get('/api/worker/jobs/{id}/audio', [self::class, 'audio']);
        $router->post('/api/worker/jobs/{id}/heartbeat', [self::class, 'heartbeat']);
        $router->post('/api/worker/jobs/{id}/complete', [self::class, 'complete']);
        $router->post('/api/worker/jobs/{id}/fail', [self::class, 'fail']);
    }

    public static function claim(Request $request): void
    {
        self::authenticate($request);
        $name = $request->input('worker');
        $name = Util::cut(Util::cleanLine(is_string($name) ? $name : ''), 100);
        $job = Jobs::claimWorker($name === '' ? 'worker' : $name);
        if ($job === null) {
            Response::noContent();
            return;
        }
        Response::json(['job' => [
            'id' => $job['id'],
            'filename' => $job['filename'],
            'language' => $job['language'],
            'task' => $job['task'],
            'engine' => 'worker',
            'file_size' => $job['file_size'],
            // Base-relative (SPEC 8): the worker resolves it against its own API_BASE, so a base_url that
            // differs from API_BASE (www vs bare domain, http vs https) cannot break the download.
            'audio_url' => 'api/worker/jobs/' . $job['id'] . '/audio',
            'lease_seconds' => self::lease(),
        ]]);
    }

    public static function audio(Request $request, string $id): void
    {
        self::authenticate($request);
        $row = Jobs::claimedWorkerJob($id);
        $path = Transcriptions::audioPath($row);
        if ($path === null) {
            throw ApiException::notFound('The audio file is no longer available');
        }
        AudioStream::send($path, Transcriptions::audioMime($row), (string) $row['filename']);
    }

    public static function heartbeat(Request $request, string $id): void
    {
        self::authenticate($request);
        Jobs::claimedWorkerJob($id);
        $progress = $request->input('progress');
        if ($progress !== null && !is_numeric($progress)) {
            throw ApiException::validation('progress', 'progress must be a number between 0 and 100');
        }
        $progress = $progress === null ? null : max(0, min(100, (int) round((float) $progress)));
        Db::run("UPDATE transcriptions SET locked_until = ?, progress = COALESCE(?, progress)
            WHERE id = ? AND engine = 'worker' AND status = 'processing'", [time() + self::lease(), $progress, $id]);
        Response::json(['ok' => true]);
    }

    public static function complete(Request $request, string $id): void
    {
        self::authenticate($request);
        Jobs::claimedWorkerJob($id);
        $body = $request->json();
        if (isset($body['text']) && !is_string($body['text'])) {
            throw ApiException::validation('text', 'text must be a string');
        }
        if (isset($body['segments']) && !is_array($body['segments'])) {
            throw ApiException::validation('segments', 'segments must be an array of {start, end, text}');
        }
        if (isset($body['duration']) && !is_numeric($body['duration'])) {
            throw ApiException::validation('duration', 'duration must be a number');
        }
        if (isset($body['detected_language']) && !is_string($body['detected_language'])) {
            throw ApiException::validation('detected_language', 'detected_language must be a string');
        }
        if (!Transcriptions::complete($id, $body)) {
            throw ApiException::notFound('Job not found or not claimed');
        }
        Response::json(['ok' => true]);
    }

    public static function fail(Request $request, string $id): void
    {
        self::authenticate($request);
        $row = Jobs::claimedWorkerJob($id);
        $error = $request->input('error');
        $error = is_string($error) && trim($error) !== '' ? $error : 'The worker reported a failure';
        $retry = Validate::bool($request->input('retry', false));
        $max = max(1, (int) Config::get('worker.max_attempts', 3));
        if ($retry && Validate::bool($request->input('release', false))) {
            // Optional extension of SPEC 8: the worker gives the job back without having failed it
            // (graceful stop, broken local setup). The claim's attempt is returned, so stopping a worker
            // during a long job can never use up worker.max_attempts.
            Db::run("UPDATE transcriptions SET status = 'queued', locked_until = NULL, progress = NULL,
                    attempts = CASE WHEN attempts > 0 THEN attempts - 1 ELSE 0 END
                WHERE id = ? AND engine = 'worker' AND status = 'processing'", [$id]);
        } elseif ($retry && $row['attempts'] < $max) {
            Db::run("UPDATE transcriptions SET status = 'queued', locked_until = NULL, progress = NULL
                WHERE id = ? AND engine = 'worker' AND status = 'processing'", [$id]);
        } else {
            Transcriptions::fail($id, $error);
        }
        Response::json(['ok' => true]);
    }

    private static function authenticate(Request $request): void
    {
        if (!Config::get('worker.enabled')) {
            throw new ApiException(503, 'engine_unavailable', 'The worker engine is disabled on this server');
        }
        $token = $request->bearerToken();
        if ($token === null) {
            throw ApiException::unauthorized('Missing worker token (Authorization: Bearer <token>)');
        }
        foreach (Config::workerTokens() as $valid) {
            if (hash_equals($valid, $token)) {
                return;
            }
        }
        throw ApiException::unauthorized('Invalid worker token');
    }

    private static function lease(): int
    {
        return max(60, (int) Config::get('worker.lease_seconds', 900));
    }
}
