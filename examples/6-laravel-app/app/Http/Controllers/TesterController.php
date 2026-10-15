<?php

namespace App\Http\Controllers;

use App\Models\WebhookLog;
use App\Services\TranscribeClient;
use App\Services\TranscribeResult;
use App\Services\UploadLimit;
use Closure;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Routing\Controllers\HasMiddleware;
use Illuminate\Support\Facades\Http;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;
use Illuminate\View\View;

/**
 * "Backend tester" page (/tester) and POST /tester-api/{action}.
 *
 * Each action calls the Transcribe API from the server and returns the same shape:
 *   {action, ok, request {method, url, headers (key masked), fields}, response {status, headers, body}, error, duration_ms}
 *
 * Turn the page off on a public server: TRANSCRIBE_TESTER=false.
 */
class TesterController extends Controller implements HasMiddleware
{
    public const ACTIONS = ['health', 'list', 'upload', 'get', 'format', 'delete', 'webhook-simulate'];

    public static function middleware(): array
    {
        return [
            function (Request $request, Closure $next) {
                abort_unless((bool) config('services.transcribe.tester'), 404);

                return $next($request);
            },
        ];
    }

    public function index(TranscribeClient $client): View
    {
        $secret = (string) config('services.transcribe.webhook_secret');

        return view('tester', [
            'baseUrl' => $client->baseUrl(),
            'maskedKey' => $client->maskedKey(),
            'maskedSecret' => TranscribeClient::mask($secret),
            'webhookUrl' => AppController::webhookUrl(),
            'engine' => config('services.transcribe.engine') === 'cloud' ? 'cloud' : 'worker',
            'language' => (string) config('services.transcribe.language'),
            'maxBytes' => UploadLimit::bytes(),
            'maxHuman' => UploadLimit::human(),
            'simulateVia' => self::simulateVia(),
        ]);
    }

    /** POST /tester-api/{action} */
    public function action(Request $request, string $action, TranscribeClient $client): JsonResponse
    {
        try {
            $out = match ($action) {
                'health' => $this->fromResult($action, $client->health()),
                'list' => $this->list($request, $client),
                'upload' => $this->upload($request, $client),
                'get' => $this->fromResult($action, $client->get($this->id($request))),
                'format' => $this->format($request, $client),
                'delete' => $this->fromResult($action, $client->delete($this->id($request))),
                'webhook-simulate' => $this->simulate($request),
                default => abort(404),
            };
        } catch (ValidationException $e) {
            $out = [
                'action' => $action,
                'ok' => false,
                'request' => ['method' => 'POST', 'url' => $request->path(), 'headers' => (object) [], 'fields' => (object) []],
                'response' => ['status' => 0, 'headers' => (object) [], 'body' => ['errors' => $e->errors()]],
                'error' => ['code' => 'validation_error', 'message' => $e->validator->errors()->first(), 'field' => null],
                'duration_ms' => 0,
            ];
        }

        return $this->safeJson($out);
    }

    /** GET /tester-api/webhook-logs — the newest calls to /webhooks/transcribe. */
    public function webhookLogs(): JsonResponse
    {
        $logs = WebhookLog::query()->latest('id')->limit(25)->get();

        return $this->safeJson(['data' => $logs->map(fn (WebhookLog $l) => $l->toClient())->all()]);
    }

    // ----- actions ---------------------------------------------------------------------------

    private function list(Request $request, TranscribeClient $client): array
    {
        $data = $request->validate([
            'status' => ['nullable', Rule::in(['queued', 'processing', 'completed', 'failed'])],
            'limit' => ['nullable', 'integer', 'min:1', 'max:100'],
        ]);

        return $this->fromResult('list', $client->list($data));
    }

    private function upload(Request $request, TranscribeClient $client): array
    {
        // No type check here on purpose: the tester may send a .wav to see the API's 415 answer.
        $data = $request->validate([
            'file' => ['required', 'file', 'max:' . UploadLimit::kilobytes()],
            'engine' => ['nullable', Rule::in(['worker', 'cloud'])],
            'language' => ['nullable', 'string', 'max:16'],
            'task' => ['nullable', Rule::in(['transcribe', 'translate'])],
            'prompt' => ['nullable', 'string', 'max:1000'],
            'metadata' => ['nullable', 'string', 'max:4096'],
            'wait' => ['nullable', 'boolean'],
            'webhook' => ['nullable', 'boolean'],
        ], ['file.max' => 'The file is too big. Max size: ' . UploadLimit::human() . '.']);

        $file = $request->file('file');
        $wait = $request->boolean('wait');
        @set_time_limit($wait ? 720 : max(60, (int) config('services.transcribe.timeout', 120) + 30));

        $result = $client->upload($file->getRealPath(), AppController::cleanFilename($file->getClientOriginalName()), [
            'engine' => $data['engine'] ?? '',
            'language' => $data['language'] ?? '',
            'task' => $data['task'] ?? '',
            'prompt' => $data['prompt'] ?? '',
            'metadata' => $data['metadata'] ?? '',
            'wait' => $wait,
            'webhook_url' => $request->boolean('webhook') ? AppController::webhookUrl() : '',
        ]);

        return $this->fromResult('upload', $result);
    }

    private function format(Request $request, TranscribeClient $client): array
    {
        $fmt = $request->validate(['format' => ['required', Rule::in(TranscribeClient::FORMATS)]])['format'];

        return $this->fromResult('format', $client->format($this->id($request), $fmt));
    }

    /**
     * Builds a fake "transcription.completed" webhook, signs it with the real secret (valid) or a wrong
     * one (forged), and sends it to this app's /webhooks/transcribe. The answer should be 200 / 401.
     */
    private function simulate(Request $request): array
    {
        $mode = $request->validate(['mode' => ['required', Rule::in(['valid', 'forged'])]])['mode'];
        $secret = (string) config('services.transcribe.webhook_secret');
        $id = 'tr_sim' . bin2hex(random_bytes(9)); // never a real job, so no local row is changed
        $now = gmdate('Y-m-d\TH:i:s\Z');
        $text = 'This is a simulated webhook from the tester page.';
        $payload = [
            'event' => 'transcription.completed',
            'created_at' => $now,
            'data' => [
                'id' => $id, 'object' => 'transcription', 'project_id' => 'prj_simulated', 'status' => 'completed',
                'engine' => 'worker', 'language' => 'en', 'detected_language' => 'en', 'task' => 'transcribe',
                'filename' => 'simulated.mp3', 'file_size' => 12345, 'duration' => 3.5, 'progress' => 100,
                'text' => $text, 'segments' => [['id' => 0, 'start' => 0.0, 'end' => 3.5, 'text' => $text]],
                'error' => null, 'metadata' => ['source' => 'tester'], 'webhook_status' => 'pending',
                'created_at' => $now, 'started_at' => $now, 'completed_at' => $now,
            ],
        ];
        $body = json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        $signingSecret = $mode === 'valid' ? $secret : 'whsec_wrong_' . bin2hex(random_bytes(8));
        $headers = [
            'Content-Type' => 'application/json',
            'User-Agent' => 'TranscribeDemoTester/1.0',
            'X-Transcribe-Event' => 'transcription.completed',
            'X-Transcribe-Delivery' => $id,
            'X-Transcribe-Signature' => TranscribeWebhookController::sign($body, $signingSecret),
        ];
        $url = route('webhooks.transcribe');
        $via = self::simulateVia();
        $shown = [
            'method' => 'POST',
            'url' => $url,
            'headers' => $headers,
            'fields' => [
                'signed_with' => $mode === 'valid'
                    ? 'TRANSCRIBE_WEBHOOK_SECRET (' . TranscribeClient::mask($secret) . ')'
                    : 'a wrong secret (forged)',
                'sent_via' => $via === 'direct'
                    ? 'direct call inside this app (php artisan serve handles one request at a time)'
                    : 'HTTP POST to this app',
            ],
            'body' => $payload,
        ];

        $started = hrtime(true);
        if ($via === 'direct') {
            $server = ['CONTENT_TYPE' => 'application/json', 'REMOTE_ADDR' => '127.0.0.1'];
            foreach ($headers as $name => $value) {
                $server['HTTP_' . strtoupper(str_replace('-', '_', $name))] = $value;
            }
            $sub = Request::create($url, 'POST', [], [], [], $server, $body);
            $response = app(TranscribeWebhookController::class)($sub);
            $status = $response->getStatusCode();
            $resBody = json_decode((string) $response->getContent(), true) ?? $response->getContent();
            $resHeaders = ['content-type' => $response->headers->get('Content-Type')];
            $error = null;
        } else {
            try {
                $response = Http::withHeaders($headers)->withBody($body, 'application/json')->timeout(10)->post($url);
                $status = $response->status();
                $resBody = $response->json() ?? mb_strimwidth($response->body(), 0, 3000, '…');
                $resHeaders = ['content-type' => $response->header('Content-Type')];
                $error = null;
            } catch (ConnectionException $e) {
                [$status, $resBody, $resHeaders] = [0, null, []];
                $error = ['code' => 'network_error', 'message' => 'Cannot reach ' . $url . ': ' . $e->getMessage(), 'field' => null];
            }
        }
        $ms = (int) round((hrtime(true) - $started) / 1e6);
        $expected = $mode === 'valid' ? 200 : 401;

        return [
            'action' => 'webhook-simulate',
            'ok' => $status === $expected,
            'request' => $shown,
            'response' => ['status' => $status, 'headers' => (object) $resHeaders, 'body' => $resBody],
            'error' => $error ?? ($status === $expected ? null : [
                'code' => 'unexpected_status',
                'message' => "Expected HTTP {$expected} for a {$mode} webhook, got {$status}.",
                'field' => null,
            ]),
            'duration_ms' => $ms,
        ];
    }

    // ----- helpers ---------------------------------------------------------------------------

    private function id(Request $request): string
    {
        return $request->validate([
            'id' => ['required', 'string', 'max:64', 'regex:/^[A-Za-z0-9_\-]+$/'],
        ], ['id.regex' => 'The id looks like tr_ followed by letters and numbers.'])['id'];
    }

    private function fromResult(string $action, TranscribeResult $result): array
    {
        return [
            'action' => $action,
            'ok' => $result->ok,
            'request' => $result->request,
            'response' => [
                'status' => $result->status,
                'headers' => (object) $result->headers,
                'body' => $result->data ?? $result->body,
            ],
            'error' => $result->error,
            'duration_ms' => $result->durationMs,
        ];
    }

    /** direct = call the webhook controller inside this request; http = real POST to this app. */
    public static function simulateVia(): string
    {
        $via = (string) config('services.transcribe.simulate_via', 'auto');
        if (in_array($via, ['direct', 'http'], true)) {
            return $via;
        }

        // php artisan serve (cli-server) answers one request at a time: a POST to itself would wait forever.
        return PHP_SAPI === 'cli-server' || app()->runningInConsole() ? 'direct' : 'http';
    }

    /** JSON answer with a last safety net: the full key or secret never leaves the server. */
    private function safeJson(array $out): JsonResponse
    {
        $response = response()->json($out, 200, [], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        $content = (string) $response->getContent();
        foreach (['key', 'webhook_secret'] as $name) {
            $secret = (string) config('services.transcribe.' . $name);
            if (strlen($secret) >= 8 && str_contains($content, $secret)) {
                $content = str_replace($secret, TranscribeClient::mask($secret), $content);
            }
        }

        return $response->setContent($content);
    }
}
