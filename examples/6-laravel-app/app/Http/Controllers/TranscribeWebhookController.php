<?php

namespace App\Http\Controllers;

use App\Models\Transcription;
use App\Models\WebhookLog;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;

/**
 * POST /webhooks/transcribe — the Transcribe API calls this when a job is completed or failed.
 *
 * Body:    {"event":"transcription.completed"|"transcription.failed","created_at":"...","data":{transcription object}}
 * Header:  X-Transcribe-Signature: sha256=<hex HMAC-SHA256 of the raw body, key = project webhook secret>
 *
 * The route must skip CSRF: see validateCsrfTokens(except: ...) in bootstrap/app.php.
 * Answer 2xx quickly. Any other answer makes the API retry later.
 */
class TranscribeWebhookController extends Controller
{
    public const EVENTS = ['transcription.completed', 'transcription.failed'];

    /** The value of X-Transcribe-Signature for this raw body. */
    public static function sign(string $rawBody, string $secret): string
    {
        return 'sha256=' . hash_hmac('sha256', $rawBody, $secret);
    }

    /** True when the header matches the body. Uses hash_equals (constant time). */
    public static function signatureIsValid(string $rawBody, ?string $header, string $secret): bool
    {
        if ($secret === '' || $header === null || $header === '') {
            return false;
        }

        return hash_equals(self::sign($rawBody, $secret), trim($header));
    }

    public function __invoke(Request $request): JsonResponse
    {
        $raw = $request->getContent(); // the exact bytes that were signed. Do not re-encode the JSON.
        $secret = (string) config('services.transcribe.webhook_secret');
        $payload = json_decode($raw, true);
        $payload = is_array($payload) ? $payload : null;
        $event = is_string($payload['event'] ?? null) ? mb_substr($payload['event'], 0, 64) : null;
        $data = is_array($payload['data'] ?? null) ? $payload['data'] : [];
        $remoteId = is_string($data['id'] ?? null) ? mb_substr($data['id'], 0, 64) : null;

        if ($secret === '') {
            Log::error('Transcribe webhook: TRANSCRIBE_WEBHOOK_SECRET is empty, cannot check signatures');

            return $this->answer($request, 500, ['ok' => false, 'error' => 'webhook_secret_not_set'],
                $event, $remoteId, false, null, 'TRANSCRIBE_WEBHOOK_SECRET is not set');
        }

        if (! self::signatureIsValid($raw, $request->header('X-Transcribe-Signature'), $secret)) {
            Log::warning('Transcribe webhook: bad signature', ['ip' => $request->ip(), 'remote_id' => $remoteId]);

            // Do not trust anything in this body. Only the short fields are logged (for the tester page);
            // the body itself is not stored, so nobody can fill the database with fake webhooks.
            return $this->answer($request, 401, ['ok' => false, 'error' => 'invalid_signature'],
                $event, $remoteId, false, null, 'Bad or missing signature');
        }

        if ($payload === null) {
            return $this->answer($request, 400, ['ok' => false, 'error' => 'invalid_json'],
                null, null, true, null, 'Body is not JSON');
        }

        if (! in_array($event, self::EVENTS, true)) {
            // Unknown event: say OK so the API does not retry it forever.
            return $this->answer($request, 200, ['ok' => true, 'ignored' => true],
                $event, $remoteId, true, $payload, 'Unknown event, ignored');
        }

        $transcription = $remoteId === null ? null : Transcription::where('remote_id', $remoteId)->first();
        if ($transcription === null) {
            // Not started from this app (for example from the tester page). Still 200: nothing to retry.
            return $this->answer($request, 200, ['ok' => true],
                $event, $remoteId, true, $payload, 'No local transcription with this id');
        }

        $transcription->applyRemote($data);
        if ($event === 'transcription.failed' && $transcription->status !== 'failed') {
            $transcription->status = 'failed';
        }
        $transcription->webhook_received_at = now();
        $transcription->last_synced_at = now();
        $transcription->save();

        return $this->answer($request, 200, ['ok' => true],
            $event, $remoteId, true, $payload, "Updated local #{$transcription->id} ({$transcription->status})");
    }

    private function answer(Request $request, int $status, array $body, ?string $event, ?string $remoteId,
        bool $valid, ?array $payload, string $note): JsonResponse
    {
        try {
            WebhookLog::create([
                'event' => $event,
                'remote_id' => $remoteId,
                'signature_valid' => $valid,
                'http_status_returned' => $status,
                'payload' => $payload,
                'user_agent' => mb_substr((string) $request->userAgent(), 0, 250),
                'note' => mb_substr($note, 0, 250),
                'received_at' => now(),
            ]);
        } catch (\Throwable $e) {
            Log::error('Transcribe webhook: cannot write webhook_logs', ['error' => $e->getMessage()]);
        }

        return response()->json($body, $status);
    }
}
