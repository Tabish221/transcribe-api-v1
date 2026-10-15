<?php

namespace App\Services;

/**
 * The answer of one Transcribe API call. TranscribeClient never throws for HTTP errors:
 * it returns this object, so a page can show the full request and response.
 *
 *   $result->ok          true for 2xx
 *   $result->status      HTTP status (0 = no answer: network error, timeout, not configured)
 *   $result->data        decoded JSON (array) or null
 *   $result->body        raw body (text formats like srt) or null for JSON answers
 *   $result->error       ['code' => ..., 'message' => ..., 'field' => ...] or null
 *   $result->durationMs  time of the call in milliseconds
 *   $result->request     ['method', 'url', 'headers' (key masked), 'fields']
 *
 * In your app flow, call ->throw() to get an exception instead:
 *   $job = $client->get($id)->throw()->data;
 */
class TranscribeResult
{
    public function __construct(
        public readonly bool $ok,
        public readonly int $status,
        public readonly ?array $data,
        public readonly ?string $body,
        public readonly ?array $error,
        public readonly int $durationMs,
        public readonly array $request,
        public readonly array $headers = [],
    ) {}

    /** Throws TranscribeException when the call failed; returns $this otherwise. */
    public function throw(): static
    {
        if (! $this->ok) {
            throw new TranscribeException(
                (string) ($this->error['message'] ?? "HTTP {$this->status} from the Transcribe API"),
                $this->status,
                $this->error['code'] ?? null,
                $this->error['field'] ?? null,
            );
        }

        return $this;
    }

    /** The decoded JSON body, or an exception when the call failed. */
    public function json(): array
    {
        return $this->throw()->data ?? [];
    }

    /** One value from the error, e.g. errorCode() === 'not_found'. */
    public function errorCode(): ?string
    {
        return $this->error['code'] ?? null;
    }

    /** Plain array (for JSON responses and logs). Contains no secrets: the key is masked. */
    public function toArray(): array
    {
        return [
            'ok' => $this->ok,
            'status' => $this->status,
            'data' => $this->data,
            'body' => $this->body,
            'error' => $this->error,
            'duration_ms' => $this->durationMs,
            'request' => $this->request,
            'headers' => $this->headers,
        ];
    }
}
