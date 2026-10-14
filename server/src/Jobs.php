<?php

declare(strict_types=1);

namespace Tapi;

/**
 * Job queue operations on the transcriptions table: atomic claims for the PC worker,
 * in-process cloud transcription and recovery of stale jobs.
 * Every state change is a conditional UPDATE checked via affected rows, so concurrent
 * requests/cron runs can never process the same job twice.
 */
final class Jobs
{
    /** Claims the oldest available worker job (or an expired lease). Returns the job row or null. */
    public static function claimWorker(string $workerName): ?array
    {
        $now = time();
        $max = max(1, (int) Config::get('worker.max_attempts', 3));
        $lease = max(60, (int) Config::get('worker.lease_seconds', 900));
        self::failExhaustedWorkerJobs();

        $available = "engine = 'worker' AND (status = 'queued' OR (status = 'processing' AND locked_until < ? AND attempts < ?))";
        $candidates = Db::all("SELECT id FROM transcriptions WHERE {$available} ORDER BY created_at ASC, id ASC LIMIT 5", [$now, $max]);
        foreach ($candidates as $candidate) {
            $claimed = Db::run("UPDATE transcriptions SET status = 'processing', started_at = COALESCE(started_at, ?),
                    attempts = attempts + 1, worker_name = ?, locked_until = ?, progress = 0, error = NULL
                WHERE id = ? AND {$available}",
                [$now, $workerName, $now + $lease, $candidate['id'], $now, $max])->rowCount();
            if ($claimed === 1) {
                return Transcriptions::find($candidate['id']);
            }
        }
        return null;
    }

    /** A worker job that is currently claimed (processing). 404 otherwise. */
    public static function claimedWorkerJob(string $id): array
    {
        $row = Transcriptions::find($id);
        if ($row === null || $row['engine'] !== 'worker' || $row['status'] !== 'processing') {
            throw ApiException::notFound('Job not found or not claimed');
        }
        return $row;
    }

    /** Fails worker jobs whose lease expired after the last allowed attempt. */
    public static function failExhaustedWorkerJobs(): int
    {
        $now = time();
        $max = max(1, (int) Config::get('worker.max_attempts', 3));
        $condition = "engine = 'worker' AND status = 'processing' AND locked_until < ? AND attempts >= ?";
        $count = 0;
        foreach (Db::all("SELECT id FROM transcriptions WHERE {$condition}", [$now, $max]) as $row) {
            $message = "The worker did not finish this job after {$max} attempts";
            if (Transcriptions::fail($row['id'], $message, "status = 'processing' AND locked_until < ?", [$now])) {
                $count++;
            }
        }
        return $count;
    }

    /**
     * Transcribes one queued cloud job inside this PHP process (wait=true, after the 202, or from cron).
     * Transient engine errors re-queue the job until cloud.max_attempts; other errors fail it.
     */
    public static function processCloud(string $id): void
    {
        $now = time();
        $timeout = max(30, (int) Config::get('cloud.timeout', 600));
        $claimed = Db::run("UPDATE transcriptions SET status = 'processing', started_at = COALESCE(started_at, ?),
                attempts = attempts + 1, locked_until = ?, progress = NULL
            WHERE id = ? AND engine = 'cloud' AND status = 'queued'", [$now, $now + $timeout + 120, $id])->rowCount();
        if ($claimed !== 1) {
            return; // already taken by another request or cron run
        }
        $row = Transcriptions::find($id);
        if ($row === null) {
            return;
        }
        $path = Transcriptions::audioPath($row);
        if ($path === null) {
            Transcriptions::fail($id, 'The audio file is missing');
            return;
        }

        ignore_user_abort(true);
        if ((int) ini_get('max_execution_time') !== 0) {
            @set_time_limit($timeout + 60);
        }
        try {
            try {
                $result = CloudEngine::transcribe($path, (string) $row['filename'], Transcriptions::audioMime($row),
                    (string) $row['task'], $row['language'], $row['prompt']);
            } finally {
                Db::reconnectIfGone(); // the API call may have outlived MySQL's wait_timeout
            }
            Transcriptions::complete($id, $result);
        } catch (EngineException $e) {
            $max = max(1, (int) Config::get('cloud.max_attempts', 3));
            Logger::warning('Cloud transcription error', ['id' => $id, 'attempt' => $row['attempts'], 'error' => $e->getMessage()]);
            if ($e->transient && $row['attempts'] < $max) {
                Db::run("UPDATE transcriptions SET status = 'queued', locked_until = NULL WHERE id = ? AND status = 'processing'", [$id]);
            } else {
                Transcriptions::fail($id, $e->getMessage());
            }
        } catch (\Throwable $e) {
            Logger::exception($e, 'Cloud transcription crashed');
            Transcriptions::fail($id, 'Internal error while transcribing');
        }
    }

    /** IDs of queued cloud jobs, oldest first. */
    public static function queuedCloudIds(int $limit): array
    {
        return array_column(Db::all("SELECT id FROM transcriptions WHERE engine = 'cloud' AND status = 'queued'
            ORDER BY created_at ASC, id ASC LIMIT ?", [$limit]), 'id');
    }

    /**
     * Cloud jobs left in "processing" after their lock expired (e.g. the PHP process was killed):
     * re-queue while attempts remain, otherwise fail. Also fails exhausted worker jobs.
     * @return array{requeued:int, failed:int}
     */
    public static function recoverStale(): array
    {
        $now = time();
        $max = max(1, (int) Config::get('cloud.max_attempts', 3));
        $requeued = 0;
        $failed = 0;
        $stale = Db::all("SELECT id, attempts FROM transcriptions
            WHERE engine = 'cloud' AND status = 'processing' AND locked_until < ?", [$now]);
        foreach ($stale as $row) {
            if ((int) $row['attempts'] < $max) {
                $requeued += Db::run("UPDATE transcriptions SET status = 'queued', locked_until = NULL
                    WHERE id = ? AND status = 'processing' AND locked_until < ?", [$row['id'], $now])->rowCount();
            } elseif (Transcriptions::fail($row['id'], 'Processing timed out', "status = 'processing' AND locked_until < ?", [$now])) {
                $failed++;
            }
        }
        $failed += self::failExhaustedWorkerJobs();
        return ['requeued' => $requeued, 'failed' => $failed];
    }
}
