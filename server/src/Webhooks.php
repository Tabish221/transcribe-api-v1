<?php

declare(strict_types=1);

namespace Tapi;

/**
 * Outgoing webhooks: transcription.completed / transcription.failed, signed with the project's
 * webhook_secret (X-Transcribe-Signature: sha256=<hmac>). Failed deliveries are retried by cron.
 */
final class Webhooks
{
    /** Seconds after completed_at at which delivery attempt N (0-based) becomes due. */
    private const SCHEDULE = [60, 120, 600, 1800, 7200, 21600, 43200, 86400];

    /** Returns an error message when the URL is not an acceptable webhook target, else null. */
    public static function checkUrl(string $url): ?string
    {
        if (strlen($url) > 2048) {
            return 'webhook_url must be at most 2048 characters';
        }
        $parts = parse_url($url);
        if (!is_array($parts) || !in_array(strtolower((string) ($parts['scheme'] ?? '')), ['http', 'https'], true)
            || empty($parts['host'])) {
            return 'webhook_url must be an absolute http:// or https:// URL';
        }
        if (Config::get('webhooks.allow_private_hosts')) {
            return null;
        }
        $ips = NetGuard::resolve((string) $parts['host']);
        if ($ips === []) {
            return 'webhook_url host could not be resolved';
        }
        foreach ($ips as $ip) {
            if (!NetGuard::isPublic($ip)) {
                return 'webhook_url must point to a public host (private, loopback and reserved addresses are not allowed)';
            }
        }
        return null;
    }

    /** Delivers now (CLI/cron) or right after the HTTP response has been sent (web requests). */
    public static function dispatch(string $transcriptionId): void
    {
        if (PHP_SAPI === 'cli') {
            self::deliver($transcriptionId);
            return;
        }
        App::defer(static function () use ($transcriptionId): void {
            self::deliver($transcriptionId);
        });
    }

    /** One delivery attempt; updates webhook_status ("delivered" | "failed:<code|reason>") and the attempt count. */
    public static function deliver(string $transcriptionId): void
    {
        $row = Transcriptions::find($transcriptionId);
        if ($row === null || empty($row['webhook_url']) || $row['webhook_status'] === 'delivered'
            || !in_array($row['status'], ['completed', 'failed'], true)) {
            return;
        }
        $project = Projects::find((string) $row['project_id']);
        if ($project === null) {
            return;
        }
        $event = $row['status'] === 'completed' ? 'transcription.completed' : 'transcription.failed';
        $body = Util::json([
            'event' => $event,
            'created_at' => Util::iso(time()),
            'data' => Transcriptions::serialize($row),
        ]);
        $headers = [
            'Content-Type: application/json',
            'User-Agent: TranscribeAPI/1.0',
            'X-Transcribe-Event: ' . $event,
            'X-Transcribe-Delivery: ' . $row['id'],
            'X-Transcribe-Signature: sha256=' . hash_hmac('sha256', $body, (string) $project['webhook_secret']),
        ];
        $result = self::post((string) $row['webhook_url'], $body, $headers);
        Db::reconnectIfGone();
        Db::run('UPDATE transcriptions SET webhook_status = ?, webhook_attempts = webhook_attempts + 1 WHERE id = ?',
            [$result, $row['id']]);
        if ($result !== 'delivered') {
            Logger::warning('Webhook delivery failed', ['id' => $row['id'], 'result' => $result, 'attempt' => $row['webhook_attempts'] + 1]);
        }
    }

    /** Retries pending/failed deliveries that are due (cron). Returns the number of attempts made. */
    public static function retryDue(int $deadline): int
    {
        $max = max(1, (int) Config::get('webhooks.max_attempts', 5));
        $rows = Db::all("SELECT id, webhook_attempts, completed_at FROM transcriptions
            WHERE webhook_url IS NOT NULL AND webhook_url <> '' AND status IN ('completed', 'failed')
              AND (webhook_status = 'pending' OR webhook_status LIKE 'failed:%') AND webhook_attempts < ?
            ORDER BY completed_at ASC LIMIT 100", [$max]);
        $attempts = 0;
        foreach ($rows as $row) {
            if (time() >= $deadline) {
                break;
            }
            $n = (int) $row['webhook_attempts'];
            $due = (int) $row['completed_at'] + self::SCHEDULE[min($n, count(self::SCHEDULE) - 1)];
            if ($due <= time()) {
                self::deliver((string) $row['id']);
                $attempts++;
            }
        }
        return $attempts;
    }

    /** POSTs the payload. The SSRF check is repeated and the connection pinned to the vetted IP. */
    private static function post(string $url, string $body, array $headers): string
    {
        $parts = parse_url($url);
        if (!is_array($parts) || empty($parts['host'])) {
            return 'failed:invalid_url';
        }
        $scheme = strtolower((string) ($parts['scheme'] ?? ''));
        if (!in_array($scheme, ['http', 'https'], true)) {
            return 'failed:invalid_url';
        }
        $resolve = [];
        if (!Config::get('webhooks.allow_private_hosts')) {
            $host = trim((string) $parts['host'], '[]');
            $ips = NetGuard::resolve($host);
            if ($ips === []) {
                return 'failed:dns';
            }
            foreach ($ips as $ip) {
                if (!NetGuard::isPublic($ip)) {
                    return 'failed:blocked_host';
                }
            }
            if (filter_var($host, FILTER_VALIDATE_IP) === false) {
                $port = (int) ($parts['port'] ?? ($scheme === 'https' ? 443 : 80));
                $ip = $ips[0];
                $resolve[] = $host . ':' . $port . ':' . (str_contains($ip, ':') ? '[' . $ip . ']' : $ip);
            }
        }
        $timeout = max(1, (int) Config::get('webhooks.timeout', 10));
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => $body,
            CURLOPT_HTTPHEADER => array_merge($headers, ['Expect:']),
            CURLOPT_TIMEOUT => $timeout,
            CURLOPT_CONNECTTIMEOUT => min($timeout, 10),
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
            CURLOPT_RESOLVE => $resolve,
            CURLOPT_WRITEFUNCTION => static fn ($ch, string $chunk): int => strlen($chunk), // discard body
        ]);
        $ok = curl_exec($ch);
        $errno = curl_errno($ch);
        $code = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);
        if ($ok === false) {
            return $errno === CURLE_OPERATION_TIMEDOUT ? 'failed:timeout' : 'failed:connection';
        }
        return $code >= 200 && $code < 300 ? 'delivered' : 'failed:' . $code;
    }
}
