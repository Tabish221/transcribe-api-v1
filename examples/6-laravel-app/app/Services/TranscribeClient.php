<?php

namespace App\Services;

use GuzzleHttp\Exception\TransferException;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\PendingRequest;
use Illuminate\Http\Client\Response;
use Illuminate\Support\Facades\Http;

/**
 * Small client for the self-hosted Transcribe API (public REST API under /api/v1).
 *
 * Settings: config/services.php -> 'transcribe' (TRANSCRIBE_API_URL, TRANSCRIBE_API_KEY ... in .env).
 *
 * Every method returns a TranscribeResult and never throws for HTTP errors, so a test page can show
 * them. In your app flow, add ->throw() to get a TranscribeException instead:
 *
 *   $client = app(TranscribeClient::class);
 *   $job = $client->upload($path, 'call.mp3', ['engine' => 'worker', 'language' => 'en'])->json();
 *   $job = $client->get($job['id'])->json();                // status, progress, text, segments
 *   $srt = $client->format($job['id'], 'srt')->throw()->body;  // txt | srt | vtt | json (when completed)
 *   $client->delete($job['id'])->throw();
 */
class TranscribeClient
{
    /** Final states. Keep asking for the status until it is one of these. */
    public const DONE = ['completed', 'failed'];

    /** Formats for GET /api/v1/transcriptions/{id}?format= */
    public const FORMATS = ['txt', 'srt', 'vtt', 'json'];

    /** Response headers worth showing on the tester page. */
    private const SHOWN_HEADERS = ['content-type', 'content-length', 'content-disposition', 'retry-after'];

    private string $baseUrl;
    private string $apiKey;
    private int $timeout;
    private int $readTimeout;

    /**
     * Laravel's container calls this with no arguments, so the values come from config.
     * Pass them yourself to talk to another installation.
     */
    public function __construct(?string $baseUrl = null, ?string $apiKey = null, ?int $timeout = null, ?int $readTimeout = null)
    {
        $this->baseUrl = rtrim($baseUrl ?? (string) config('services.transcribe.url'), '/');
        $this->apiKey = $apiKey ?? (string) config('services.transcribe.key');
        $this->timeout = max(1, $timeout ?? (int) config('services.transcribe.timeout', 120));
        $this->readTimeout = max(1, $readTimeout ?? (int) config('services.transcribe.read_timeout', 8));
    }

    /** "tk_1234abcd5678..." -> "tk_1234…". Use it whenever a key or secret could reach a page or a log. */
    public static function mask(?string $secret): string
    {
        $secret = (string) $secret;
        if ($secret === '') {
            return '(not set)';
        }

        return strlen($secret) <= 12 ? '…' : substr($secret, 0, 7) . '…';
    }

    public function baseUrl(): string
    {
        return $this->baseUrl;
    }

    public function maskedKey(): string
    {
        return self::mask($this->apiKey);
    }

    /** GET /api/v1/health (no key needed): {"ok":true,"version":"1.0.0","engines":{"cloud":bool,"worker":bool}} */
    public function health(): TranscribeResult
    {
        return $this->call('GET', 'api/v1/health', ['auth' => false]);
    }

    /**
     * Upload audio: POST /api/v1/transcriptions (multipart/form-data).
     *
     * @param  string  $path  the file on disk (it is streamed, not loaded into memory)
     * @param  string  $filename  the name the API sees. The API checks its extension (.mp3), so for a
     *                            browser upload pass $file->getClientOriginalName(), not the temp name.
     * @param  array  $opts  engine (cloud|worker), language ("en", "auto"; empty = project default),
     *                       task (transcribe|translate), prompt (cloud only), webhook_url,
     *                       metadata (array or JSON object string, max 4 KB), wait (bool, cloud only)
     * @return TranscribeResult data = the transcription object: status "queued" (HTTP 202),
     *                          or "completed"/"failed" (HTTP 200) when wait=true and engine=cloud
     */
    public function upload(string $path, string $filename, array $opts = []): TranscribeResult
    {
        $fields = $this->formFields($opts);
        $shown = ['file' => $filename . (is_file($path) ? ' (' . self::humanSize((int) filesize($path)) . ')' : '')] + $fields;

        if (! is_file($path) || ! is_readable($path)) {
            return $this->localError('POST', 'api/v1/transcriptions', $shown, 'file_not_found', "Audio file not found: {$filename}");
        }
        $stream = fopen($path, 'r');
        if ($stream === false) {
            return $this->localError('POST', 'api/v1/transcriptions', $shown, 'file_not_found', "Cannot read the audio file: {$filename}");
        }

        try {
            return $this->call('POST', 'api/v1/transcriptions', [
                'fields' => $shown,
                // wait=true (cloud) transcribes inside this request, so give it more time.
                'timeout' => empty($fields['wait']) ? $this->timeout : max($this->timeout, 660),
                'send' => fn (PendingRequest $http, string $url) => $http
                    ->attach('file', $stream, $filename)
                    ->post($url, $fields),
            ]);
        } finally {
            if (is_resource($stream)) {
                fclose($stream);
            }
        }
    }

    /** GET /api/v1/transcriptions/{id}: the transcription object (text/segments are null until completed). */
    public function get(string $id): TranscribeResult
    {
        return $this->call('GET', $this->path($id));
    }

    /**
     * GET /api/v1/transcriptions?status=&limit=&offset= (newest first, items without segments).
     * data = {"object":"list","data":[...],"total":N,"limit":20,"offset":0}
     */
    public function list(array $opts = []): TranscribeResult
    {
        $query = array_filter(
            array_intersect_key($opts, array_flip(['status', 'limit', 'offset'])),
            fn ($value) => $value !== null && $value !== ''
        );

        return $this->call('GET', 'api/v1/transcriptions', ['query' => $query]);
    }

    /**
     * The transcript in one format (txt, srt, vtt or json) in ->body.
     * Error code "not_ready" (HTTP 409) until the job is completed.
     */
    public function format(string $id, string $format = 'srt'): TranscribeResult
    {
        $format = strtolower(trim($format));
        if (! in_array($format, self::FORMATS, true)) {
            return $this->localError('GET', $this->path($id), [], 'validation_error', 'format must be one of: ' . implode(', ', self::FORMATS));
        }

        return $this->call('GET', $this->path($id), ['query' => ['format' => $format], 'accept' => '*/*', 'raw' => true]);
    }

    /** DELETE /api/v1/transcriptions/{id}: removes the job and its audio. data = {"id":"tr_...","deleted":true} */
    public function delete(string $id): TranscribeResult
    {
        return $this->call('DELETE', $this->path($id));
    }

    // ----- helpers ---------------------------------------------------------------------------

    private function path(string $id): string
    {
        return 'api/v1/transcriptions/' . rawurlencode($id);
    }

    /**
     * Sends one request and turns any answer (or no answer) into a TranscribeResult.
     *
     * $o: auth (bool), query (array), fields (array, only for display), accept, raw (keep the text body),
     *     timeout (seconds), send (fn (PendingRequest, string $url): Response)
     */
    private function call(string $method, string $path, array $o = []): TranscribeResult
    {
        $auth = $o['auth'] ?? true;
        $accept = $o['accept'] ?? 'application/json';
        $query = $o['query'] ?? [];
        $url = $this->baseUrl . '/' . $path . ($query ? '?' . http_build_query($query) : '');
        $timeout = $o['timeout'] ?? ($method === 'POST' ? $this->timeout : $this->readTimeout);

        // What we show about the request. The key is masked: "Bearer tk_1234…".
        $shownHeaders = ['Accept' => $accept];
        if ($auth) {
            $shownHeaders['Authorization'] = 'Bearer ' . $this->maskedKey();
        }
        $request = ['method' => $method, 'url' => $url, 'headers' => $shownHeaders, 'fields' => (object) ($o['fields'] ?? [])];

        if ($this->baseUrl === '' || ($auth && $this->apiKey === '')) {
            return $this->result(false, 0, null, null,
                ['code' => 'not_configured', 'message' => 'Set TRANSCRIBE_API_URL and TRANSCRIBE_API_KEY in .env'], 0, $request);
        }

        $started = hrtime(true);
        try {
            $http = Http::accept($accept)
                ->withUserAgent('LaravelTranscribeDemo/1.0')
                ->connectTimeout(min(5, $timeout))
                ->timeout($timeout);
            if ($auth) {
                $http = $http->withToken($this->apiKey);
            }
            $send = $o['send'] ?? fn (PendingRequest $http, string $url) => $http->send($method, $url);
            /** @var Response $response */
            $response = $send($http, $url);
        } catch (ConnectionException|TransferException $e) {
            return $this->result(false, 0, null, null, [
                'code' => 'network_error',
                'message' => "Cannot reach the Transcribe API at {$this->baseUrl}: " . $e->getMessage(),
            ], self::ms($started), $request);
        }

        return $this->fromResponse($response, $request, self::ms($started), (bool) ($o['raw'] ?? false));
    }

    private function fromResponse(Response $response, array $request, int $ms, bool $raw): TranscribeResult
    {
        $status = $response->status();
        $json = $response->json();
        $data = is_array($json) ? $json : null;
        $text = $response->body();
        // JSON answers live in ->data. Text answers (srt, vtt, txt) and unexpected pages live in ->body.
        $body = $raw ? $text : ($data === null ? mb_strimwidth($text, 0, 5000, '…') : null);

        $headers = [];
        foreach (self::SHOWN_HEADERS as $name) {
            if ($response->hasHeader($name)) {
                $headers[$name] = $response->header($name);
            }
        }

        $ok = $response->successful();
        $error = null;
        if (! $ok) {
            // Errors look like {"error":{"code":"invalid_api_key","message":"Invalid or revoked API key"}}
            $e = is_array($data['error'] ?? null) ? $data['error'] : [];
            $error = [
                'code' => (string) ($e['code'] ?? 'http_' . $status),
                'message' => (string) ($e['message'] ?? "HTTP {$status} from the Transcribe API"),
                'field' => isset($e['field']) ? (string) $e['field'] : null,
            ];
        } elseif (! $raw && $data === null) {
            $ok = false;
            $error = ['code' => 'bad_response', 'message' => "The API did not answer with JSON. Check TRANSCRIBE_API_URL ({$this->baseUrl}).", 'field' => null];
        }

        return $this->result($ok, $status, $data, $body, $error, $ms, $request, $headers);
    }

    private function localError(string $method, string $path, array $fields, string $code, string $message): TranscribeResult
    {
        $request = ['method' => $method, 'url' => $this->baseUrl . '/' . $path, 'headers' => (object) [], 'fields' => (object) $fields];

        return $this->result(false, 0, null, null, ['code' => $code, 'message' => $message, 'field' => null], 0, $request);
    }

    private function result(bool $ok, int $status, ?array $data, ?string $body, ?array $error, int $ms, array $request, array $headers = []): TranscribeResult
    {
        return new TranscribeResult($ok, $status, $data, $body, $error, $ms, $request, $headers);
    }

    /** Builds the text fields of the upload form. Empty values are left out (= server default). */
    private function formFields(array $opts): array
    {
        $fields = [];
        foreach (['engine', 'language', 'task', 'prompt', 'webhook_url'] as $name) {
            $value = trim((string) ($opts[$name] ?? ''));
            if ($value !== '') {
                $fields[$name] = $value;
            }
        }

        // metadata must be a JSON *object* string. (object) turns ['a' => 1] into {"a":1}, never [].
        $metadata = $opts['metadata'] ?? null;
        if (is_array($metadata) && $metadata !== []) {
            $fields['metadata'] = json_encode((object) $metadata, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        } elseif (is_string($metadata) && trim($metadata) !== '') {
            $fields['metadata'] = trim($metadata);
        }

        if (! empty($opts['wait']) && filter_var($opts['wait'], FILTER_VALIDATE_BOOLEAN)) {
            $fields['wait'] = 'true'; // cloud engine only; the server ignores it for worker
        }

        return $fields;
    }

    private static function ms(int $started): int
    {
        return (int) round((hrtime(true) - $started) / 1e6);
    }

    public static function humanSize(int $bytes): string
    {
        return $bytes >= 1048576 ? round($bytes / 1048576, 1) . ' MB' : max(1, (int) round($bytes / 1024)) . ' KB';
    }
}
