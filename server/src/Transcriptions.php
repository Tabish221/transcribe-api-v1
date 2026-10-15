<?php

declare(strict_types=1);

namespace Tapi;

/** Transcription jobs: creation from uploads, serialization, terminal state transitions, deletion. */
final class Transcriptions
{
    private const MAX_PROMPT = 1000;
    private const MAX_METADATA_BYTES = 4096;
    private const MAX_ERROR = 2000;

    public static function find(string $id): ?array
    {
        return self::hydrate(Db::one('SELECT * FROM transcriptions WHERE id = ?', [$id]));
    }

    public static function findInProject(string $id, string $projectId): array
    {
        $row = self::hydrate(Db::one('SELECT * FROM transcriptions WHERE id = ? AND project_id = ?', [$id, $projectId]));
        if ($row === null) {
            throw ApiException::notFound('Transcription not found');
        }
        return $row;
    }

    /** List shape shared by the public and dashboard APIs (newest first, without segments). */
    public static function list(string $projectId, Request $request): array
    {
        $status = Validate::status($request->query('status'));
        [$limit, $offset] = Validate::paging($request);
        $where = 'project_id = ?';
        $params = [$projectId];
        if ($status !== null) {
            $where .= ' AND status = ?';
            $params[] = $status;
        }
        $total = (int) Db::value("SELECT COUNT(*) FROM transcriptions WHERE {$where}", $params);
        $rows = Db::all("SELECT * FROM transcriptions WHERE {$where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
            array_merge($params, [$limit, $offset]));
        return [
            'object' => 'list',
            'data' => array_map(static fn (array $r): array => self::serialize(self::hydrate($r), false), $rows),
            'total' => $total,
            'limit' => $limit,
            'offset' => $offset,
        ];
    }

    /**
     * Creates a job from a multipart upload (public API and dashboard share this).
     * @return array{int, array} [HTTP status, transcription object]
     */
    public static function createFromUpload(array $project, ?string $apiKeyId, ?string $userId): array
    {
        $file = self::uploadedFile();
        $ext = strtolower((string) pathinfo((string) $file['name'], PATHINFO_EXTENSION));
        $allowed = Config::allowedExtensions();
        if (!in_array($ext, $allowed, true)) {
            throw new ApiException(415, 'unsupported_file_type', 'Unsupported file type. Allowed: ' . implode(', ', $allowed));
        }
        $size = (int) $file['size'];
        $maxMb = (int) Config::get('max_upload_mb', 100);
        if ($size > $maxMb * 1048576) {
            throw new ApiException(413, 'file_too_large', "File is larger than the {$maxMb} MB upload limit");
        }

        $post = $_POST;
        $engine = trim((string) self::field($post, 'engine'));
        if ($engine === '') {
            $engine = (string) ($project['default_engine'] ?: Config::get('default_engine', 'cloud'));
        }
        $engine = Validate::engine($engine);
        $task = Validate::task(self::field($post, 'task'));
        $language = array_key_exists('language', $post) && trim((string) self::field($post, 'language')) !== ''
            ? Validate::language(self::field($post, 'language'))
            : Validate::language($project['default_language'] ?? null);
        $prompt = self::field($post, 'prompt');
        $prompt = $prompt === null || trim($prompt) === '' ? null : trim($prompt);
        if ($prompt !== null && Util::length($prompt) > self::MAX_PROMPT) {
            throw ApiException::validation('prompt', 'prompt must be at most ' . self::MAX_PROMPT . ' characters');
        }
        $metadata = self::metadata(self::field($post, 'metadata'));
        $webhookUrl = Validate::webhookUrl(self::field($post, 'webhook_url')) ?? ($project['webhook_url'] ?: null);
        $wait = Validate::bool(self::field($post, 'wait') ?? false);

        self::assertEngineAvailable($engine);
        $cloudMax = (int) Config::get('cloud.max_mb', 25);
        if ($engine === 'cloud' && $size > $cloudMax * 1048576) {
            throw new ApiException(413, 'file_too_large',
                "The cloud engine accepts files up to {$cloudMax} MB. Use engine=worker for larger files.");
        }

        // Store the upload under a server-generated name (never trust the client filename for paths).
        $id = Util::id('tr_');
        $relative = 'uploads/' . $id . '.' . $ext;
        $dest = Config::storagePath($relative);
        $dir = dirname($dest);
        if (!is_dir($dir) && !@mkdir($dir, 0775, true) && !is_dir($dir)) {
            throw new \RuntimeException('Cannot create the uploads directory');
        }
        if (!@move_uploaded_file((string) $file['tmp_name'], $dest)) {
            throw new \RuntimeException('move_uploaded_file failed');
        }

        try {
            Db::insert('transcriptions', [
                'id' => $id,
                'project_id' => $project['id'],
                'api_key_id' => $apiKeyId,
                'created_by' => $userId,
                'status' => 'queued',
                'engine' => $engine,
                'language' => $language,
                'task' => $task,
                'prompt' => $prompt,
                'filename' => Util::sanitizeFilename((string) $file['name'], $ext),
                'file_path' => $relative,
                'file_size' => (int) (@filesize($dest) ?: $size),
                'mime' => self::detectMime($dest),
                'duration' => null,
                'text' => null,
                'segments' => null,
                'detected_language' => null,
                'error' => null,
                'metadata' => $metadata,
                'webhook_url' => $webhookUrl,
                'webhook_status' => null,
                'webhook_attempts' => 0,
                'worker_name' => null,
                'attempts' => 0,
                'locked_until' => null,
                'progress' => null,
                'created_at' => time(),
                'started_at' => null,
                'completed_at' => null,
            ]);
        } catch (\Throwable $e) {
            Util::unlinkQuietly($dest);
            throw $e;
        }

        if ($engine === 'cloud') {
            if ($wait) {
                Jobs::processCloud($id);
                $row = self::find($id) ?? throw ApiException::notFound('Transcription was deleted');
                $done = in_array($row['status'], ['completed', 'failed'], true);
                return [$done ? 200 : 202, self::serialize($row)];
            }
            if (App::canFinishRequest()) {
                // Answer 202 first, then transcribe in this same PHP process.
                App::defer(static function () use ($id): void {
                    Jobs::processCloud($id);
                });
            }
        }
        return [202, self::serialize(self::find($id) ?? throw ApiException::notFound('Transcription was deleted'))];
    }

    /** The transcription object (see SPEC section 7). */
    public static function serialize(array $row, bool $withSegments = true): array
    {
        $out = [
            'id' => $row['id'],
            'object' => 'transcription',
            'project_id' => $row['project_id'],
            'status' => $row['status'],
            'engine' => $row['engine'],
            'language' => $row['language'],
            'detected_language' => $row['detected_language'],
            'task' => $row['task'],
            'filename' => $row['filename'],
            'file_size' => (int) $row['file_size'],
            'duration' => $row['duration'] === null ? null : round((float) $row['duration'], 2),
            'progress' => Util::intOrNull($row['progress']),
            'text' => $row['text'],
            'segments' => null,
            'error' => $row['error'],
            'metadata' => null,
            'webhook_status' => $row['webhook_status'],
            'created_at' => Util::iso($row['created_at']),
            'started_at' => Util::iso($row['started_at']),
            'completed_at' => Util::iso($row['completed_at']),
        ];
        if ($row['segments'] !== null && $row['segments'] !== '') {
            $segments = json_decode((string) $row['segments'], true);
            $out['segments'] = is_array($segments) ? $segments : null;
        }
        if ($row['metadata'] !== null && $row['metadata'] !== '') {
            $out['metadata'] = json_decode((string) $row['metadata']); // object decode keeps {} as {}
        }
        if (!$withSegments) {
            unset($out['segments']);
        }
        return $out;
    }

    /** Marks a processing job completed. Returns false if the job is no longer processing. */
    public static function complete(string $id, array $result): bool
    {
        $text = trim((string) ($result['text'] ?? ''));
        $duration = Util::floatOrNull($result['duration'] ?? null);
        $segments = self::normalizeSegments((array) ($result['segments'] ?? []), $duration, $text);
        if ($text === '') {
            $text = implode(' ', array_column($segments, 'text'));
        }
        if ($duration === null && $segments !== []) {
            $duration = (float) end($segments)['end'];
        }
        return self::finish($id, [
            'status' => 'completed',
            'text' => $text,
            'segments' => Util::json($segments),
            'duration' => $duration === null ? null : round($duration, 2),
            'detected_language' => Languages::fromEngine($result['detected_language'] ?? null),
            'error' => null,
            'progress' => 100,
        ]);
    }

    /** Marks a job failed (only if it still matches $condition). */
    public static function fail(string $id, string $error, string $condition = "status = 'processing'", array $params = []): bool
    {
        $error = Util::cut(trim($error) === '' ? 'Transcription failed' : trim($error), self::MAX_ERROR);
        return self::finish($id, ['status' => 'failed', 'error' => $error], $condition, $params);
    }

    /**
     * Moves a job into a terminal state, then: webhook -> pending, audio cleanup (retention 0), webhook dispatch.
     */
    private static function finish(string $id, array $set, string $condition = "status = 'processing'", array $params = []): bool
    {
        $set += ['locked_until' => null, 'completed_at' => time()];
        if (Db::update('transcriptions', $set, 'id = ? AND ' . $condition, array_merge([$id], $params)) === 0) {
            return false;
        }
        Db::run("UPDATE transcriptions SET webhook_status = 'pending', webhook_attempts = 0
            WHERE id = ? AND webhook_url IS NOT NULL AND webhook_url <> ''", [$id]);
        if ((int) Config::get('audio_retention_days', 7) === 0) {
            $row = self::find($id);
            if ($row !== null) {
                self::deleteAudio($row);
            }
        }
        Webhooks::dispatch($id);
        return true;
    }

    /**
     * Normalises engine/worker segments to [{id, start, end, text}] (2-decimal seconds).
     * When there are no segments but there is text, a single segment covering the audio is created.
     */
    public static function normalizeSegments(array $segments, ?float $duration, string $text): array
    {
        $out = [];
        foreach ($segments as $segment) {
            if (!is_array($segment)) {
                continue;
            }
            $segText = trim((string) (is_scalar($segment['text'] ?? null) ? $segment['text'] : ''));
            if ($segText === '') {
                continue;
            }
            $start = is_numeric($segment['start'] ?? null) ? max(0.0, (float) $segment['start']) : 0.0;
            $end = is_numeric($segment['end'] ?? null) ? (float) $segment['end'] : $start;
            $out[] = [
                'id' => count($out),
                'start' => round($start, 2),
                'end' => round(max($start, $end), 2),
                'text' => $segText,
            ];
        }
        if ($out === [] && trim($text) !== '') {
            $out[] = ['id' => 0, 'start' => 0.0, 'end' => round(max(0.0, (float) $duration), 2), 'text' => trim($text)];
        }
        return $out;
    }

    /** Absolute path of the job's audio file, or null when it was deleted. */
    public static function audioPath(array $row): ?string
    {
        if (empty($row['file_path'])) {
            return null;
        }
        $path = Config::storagePath((string) $row['file_path']);
        return is_file($path) ? $path : null;
    }

    /**
     * Content-Type for serving the job's audio: the extension map, else the type sniffed at upload but
     * only when it is audio/* or video/*. Never a sniffed text/html or image/svg+xml (stored XSS).
     */
    public static function audioMime(array $row): string
    {
        $mime = Util::audioMime((string) pathinfo((string) $row['file_path'], PATHINFO_EXTENSION));
        $sniffed = strtolower(trim((string) ($row['mime'] ?? '')));
        if ($mime === 'application/octet-stream' && preg_match('#^(audio|video)/[a-z0-9.+-]+$#', $sniffed) === 1) {
            $mime = $sniffed;
        }
        return $mime;
    }

    /** Deletes the audio file and clears file_path. */
    public static function deleteAudio(array $row): void
    {
        if (!empty($row['file_path'])) {
            Util::unlinkQuietly(Config::storagePath((string) $row['file_path']));
            Db::run('UPDATE transcriptions SET file_path = NULL WHERE id = ?', [$row['id']]);
        }
    }

    public static function delete(array $row): void
    {
        self::deleteAudio($row);
        Db::run('DELETE FROM transcriptions WHERE id = ?', [$row['id']]);
    }

    public static function hydrate(?array $row): ?array
    {
        if ($row === null) {
            return null;
        }
        foreach (['file_size', 'webhook_attempts', 'attempts', 'created_at'] as $key) {
            $row[$key] = (int) $row[$key];
        }
        foreach (['locked_until', 'progress', 'started_at', 'completed_at'] as $key) {
            $row[$key] = Util::intOrNull($row[$key]);
        }
        $row['duration'] = Util::floatOrNull($row['duration']);
        return $row;
    }

    // ----- helpers -----

    /** The validated $_FILES['file'] entry. */
    private static function uploadedFile(): array
    {
        $file = $_FILES['file'] ?? null;
        if ($file === null) {
            $length = (int) ($_SERVER['CONTENT_LENGTH'] ?? 0);
            $postMax = Util::iniBytes((string) ini_get('post_max_size'));
            if ($postMax > 0 && $length > $postMax) {
                $maxMb = (int) Config::get('max_upload_mb', 100);
                throw new ApiException(413, 'file_too_large', "Request body exceeds the server limit (max {$maxMb} MB per file)");
            }
            throw ApiException::validation('file', 'Send the audio as multipart/form-data field "file"');
        }
        if (!is_array($file) || is_array($file['name'] ?? null)) {
            throw ApiException::validation('file', 'Send exactly one file in the "file" field');
        }
        switch ((int) ($file['error'] ?? UPLOAD_ERR_NO_FILE)) {
            case UPLOAD_ERR_OK:
                break;
            case UPLOAD_ERR_INI_SIZE:
            case UPLOAD_ERR_FORM_SIZE:
                throw new ApiException(413, 'file_too_large', 'File exceeds the server upload limit');
            case UPLOAD_ERR_NO_FILE:
                throw ApiException::validation('file', 'Send the audio as multipart/form-data field "file"');
            case UPLOAD_ERR_PARTIAL:
                throw ApiException::validation('file', 'The upload was interrupted; please retry');
            default:
                throw new \RuntimeException('Upload failed with PHP error code ' . (int) $file['error']);
        }
        if (!is_uploaded_file((string) $file['tmp_name'])) {
            throw ApiException::validation('file', 'Invalid upload');
        }
        return $file;
    }

    /** A multipart text field as string, or null when absent. */
    private static function field(array $post, string $name): ?string
    {
        if (!array_key_exists($name, $post)) {
            return null;
        }
        if (!is_string($post[$name])) {
            throw ApiException::validation($name, $name . ' must be a single value');
        }
        return $post[$name];
    }

    /** Optional JSON object string (<= 4 KB) -> normalised JSON or null. */
    private static function metadata(?string $raw): ?string
    {
        if ($raw === null || trim($raw) === '') {
            return null;
        }
        if (strlen($raw) > self::MAX_METADATA_BYTES) {
            throw ApiException::validation('metadata', 'metadata must be at most 4 KB');
        }
        $decoded = json_decode($raw);
        if (!$decoded instanceof \stdClass) {
            throw ApiException::validation('metadata', 'metadata must be a JSON object string, e.g. {"order_id":123}');
        }
        return Util::json($decoded);
    }

    public static function assertEngineAvailable(string $engine): void
    {
        if ($engine === 'cloud') {
            if (!Config::get('cloud.enabled')) {
                throw new ApiException(503, 'engine_unavailable', 'The cloud engine is disabled on this server');
            }
            if (!Config::cloudEnabled()) {
                throw new ApiException(503, 'engine_unavailable', 'The cloud engine is not configured (missing cloud.api_key)');
            }
            return;
        }
        if (!Config::workerEnabled()) {
            throw new ApiException(503, 'engine_unavailable', 'The worker engine is disabled on this server');
        }
    }

    private static function detectMime(string $path): ?string
    {
        if (!function_exists('finfo_open')) {
            return null;
        }
        $finfo = @finfo_open(FILEINFO_MIME_TYPE);
        if ($finfo === false) {
            return null;
        }
        $mime = @finfo_file($finfo, $path);
        finfo_close($finfo);
        return is_string($mime) ? substr($mime, 0, 100) : null;
    }
}
