<?php

declare(strict_types=1);

namespace Tapi;

/**
 * Periodic maintenance (cron/process.php, every minute):
 * recover stale jobs, transcribe queued cloud jobs within a time budget, retry webhooks,
 * delete expired audio and prune old login attempts / sessions.
 */
final class Cron
{
    public static function main(array $argv): int
    {
        $options = self::options($argv);
        if (isset($options['help'])) {
            echo "Usage: php cron/process.php [--budget=50] [--quiet] [--config=/path/to/config.php]\n";
            return 0;
        }
        if (isset($options['config']) && is_string($options['config'])) {
            putenv('TAPI_CONFIG=' . $options['config']);
        }
        $quiet = isset($options['quiet']);
        $budget = isset($options['budget']) && is_numeric($options['budget']) ? max(1, (int) $options['budget']) : 50;

        if (!Config::load()) {
            fwrite(STDERR, 'Not installed: ' . Config::path() . " not found\n");
            return 1;
        }
        $lockPath = Config::storagePath('cron.lock');
        $lock = @fopen($lockPath, 'c');
        if ($lock === false) {
            fwrite(STDERR, "Cannot open {$lockPath}\n");
            return 1;
        }
        if (!flock($lock, LOCK_EX | LOCK_NB)) {
            if (!$quiet) {
                echo "Another cron run is still in progress.\n";
            }
            fclose($lock);
            return 0;
        }

        try {
            $summary = self::run(time() + $budget);
        } catch (\Throwable $e) {
            Logger::exception($e, 'Cron run failed');
            fwrite(STDERR, 'Cron run failed: ' . $e->getMessage() . "\n");
            return 1;
        } finally {
            flock($lock, LOCK_UN);
            fclose($lock);
        }
        if (!$quiet) {
            echo '[' . gmdate('Y-m-d H:i:s') . '] ' . implode(', ', array_map(
                static fn (string $k, int $v): string => "{$k}={$v}", array_keys($summary), $summary)) . "\n";
        }
        return 0;
    }

    /** @return array<string, int> */
    private static function run(int $deadline): array
    {
        $stale = Jobs::recoverStale();

        $cloud = 0;
        if (Config::cloudEnabled()) {
            foreach (Jobs::queuedCloudIds(50) as $id) {
                if (time() >= $deadline) {
                    break;
                }
                Jobs::processCloud((string) $id);
                $cloud++;
            }
        }

        return [
            'requeued' => $stale['requeued'],
            'failed_stale' => $stale['failed'],
            'cloud_processed' => $cloud,
            'webhooks_sent' => Webhooks::retryDue($deadline),
            'audio_deleted' => self::deleteExpiredAudio() + self::deleteOrphanUploads(),
            'login_attempts_pruned' => Db::run('DELETE FROM login_attempts WHERE created_at < ?', [time() - 86400])->rowCount(),
            'sessions_pruned' => self::pruneSessions(),
        ];
    }

    /** Audio of finished jobs older than audio_retention_days (0 = all finished jobs). */
    private static function deleteExpiredAudio(): int
    {
        $days = (int) Config::get('audio_retention_days', 7);
        $cutoff = $days > 0 ? time() - $days * 86400 : time() + 1;
        $rows = Db::all("SELECT id, file_path FROM transcriptions
            WHERE file_path IS NOT NULL AND status IN ('completed', 'failed') AND completed_at < ?", [$cutoff]);
        foreach ($rows as $row) {
            Transcriptions::deleteAudio($row);
        }
        return count($rows);
    }

    /** Upload files without a database row (e.g. a request that crashed mid-insert), older than an hour. */
    private static function deleteOrphanUploads(): int
    {
        $dir = Config::storagePath('uploads');
        $deleted = 0;
        foreach (glob($dir . '/tr_*') ?: [] as $file) {
            $name = basename($file);
            if (!preg_match('/^tr_[a-f0-9]{24}\.[a-z0-9]{1,8}$/', $name) || (int) @filemtime($file) > time() - 3600) {
                continue;
            }
            $exists = Db::value('SELECT 1 FROM transcriptions WHERE file_path = ?', ['uploads/' . $name]);
            if ($exists === null) {
                Util::unlinkQuietly($file);
                $deleted++;
            }
        }
        return $deleted;
    }

    private static function pruneSessions(): int
    {
        $deleted = 0;
        foreach (glob(Config::storagePath('sessions') . '/sess_*') ?: [] as $file) {
            if ((int) @filemtime($file) < time() - 604800) {
                Util::unlinkQuietly($file);
                $deleted++;
            }
        }
        return $deleted;
    }

    private static function options(array $argv): array
    {
        $options = [];
        foreach (array_slice($argv, 1) as $arg) {
            if (str_starts_with((string) $arg, '--')) {
                $parts = explode('=', substr((string) $arg, 2), 2);
                $options[$parts[0]] = $parts[1] ?? true;
            }
        }
        return $options;
    }
}
