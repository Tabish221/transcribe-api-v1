<?php

declare(strict_types=1);

/**
 * Tiny client for the Transcribe API. Plain PHP 8 + cURL, no Composer.
 * Copy this file into your project.
 *
 *   $api = new TranscribeApi('https://example.com/transcribe', 'tk_...');
 *   $job = $api->upload('/path/call.mp3', ['engine' => 'worker', 'language' => 'en']);
 *   // later (or in a loop): ask for the status until it is "completed" or "failed"
 *   $job = $api->get($job['id']);
 *   $srt = $api->download($job['id'], 'srt');   // txt | srt | vtt | json
 */
final class TranscribeApi
{
    private string $baseUrl;

    public function __construct(string $baseUrl, private string $apiKey, private int $timeout = 300)
    {
        // Base URL of the installation, without /api/v1.
        $this->baseUrl = rtrim($baseUrl, '/');
    }

    /**
     * POST /api/v1/transcriptions (multipart/form-data).
     *
     * @param array<string, string|int|bool|null> $fields engine, language, task, prompt, webhook_url, metadata, wait
     * @param string|null $filename name the API sees (needs the right extension, e.g. ".mp3").
     *                              Use it for PHP uploads, where the temp file has no extension.
     * @return array the transcription object (status "queued", or the result when wait=true on cloud)
     */
    public function upload(string $path, array $fields = [], ?string $filename = null): array
    {
        if (!is_file($path)) {
            throw new RuntimeException("File not found: $path");
        }
        $form = [];
        foreach ($fields as $name => $value) {
            if ($value === null || $value === '') {
                continue;
            }
            $form[$name] = is_bool($value) ? ($value ? 'true' : 'false') : (string) $value;
        }
        $form['file'] = new CURLFile($path, 'audio/mpeg', $filename ?? basename($path));
        return $this->json('POST', '/api/v1/transcriptions', $form);
    }

    /** GET /api/v1/transcriptions/{id} - status, progress and (when completed) text + segments. */
    public function get(string $id): array
    {
        return $this->json('GET', '/api/v1/transcriptions/' . rawurlencode($id));
    }

    /** Transcript as a file: txt, srt, vtt or json. The API answers 409 not_ready until the job is completed. */
    public function download(string $id, string $format = 'srt'): string
    {
        return $this->request('GET', '/api/v1/transcriptions/' . rawurlencode($id) . '?format=' . rawurlencode($format));
    }

    /** GET /api/v1/transcriptions?status=&limit=&offset= - newest first. */
    public function list(array $query = []): array
    {
        return $this->json('GET', '/api/v1/transcriptions' . ($query ? '?' . http_build_query($query) : ''));
    }

    /** DELETE /api/v1/transcriptions/{id} - removes the job and its audio file. */
    public function delete(string $id): array
    {
        return $this->json('DELETE', '/api/v1/transcriptions/' . rawurlencode($id));
    }

    private function json(string $method, string $path, ?array $form = null): array
    {
        $body = $this->request($method, $path, $form);
        $data = json_decode($body, true);
        if (!is_array($data)) {
            throw new TranscribeApiException('The API did not answer with JSON', 0, 'bad_response');
        }
        return $data;
    }

    /** Sends one request and returns the body. Throws TranscribeApiException for HTTP errors. */
    private function request(string $method, string $path, ?array $form = null): string
    {
        $ch = curl_init($this->baseUrl . $path);
        curl_setopt_array($ch, [
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT => 10,
            CURLOPT_TIMEOUT => $this->timeout,
            CURLOPT_HTTPHEADER => [
                'Authorization: Bearer ' . $this->apiKey,
                'Accept: application/json',
                'Expect:', // send big uploads at once (no "100-continue" wait)
            ],
        ]);
        if ($form !== null) {
            curl_setopt($ch, CURLOPT_POSTFIELDS, $form); // array + CURLFile = multipart/form-data
        }
        $body = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $curlError = curl_error($ch);
        curl_close($ch);

        if ($body === false) {
            throw new TranscribeApiException("Cannot reach the API at {$this->baseUrl}: $curlError", 0, 'network_error');
        }
        if ($status >= 400) {
            // Errors look like {"error":{"code":"invalid_api_key","message":"..."}}
            $error = json_decode((string) $body, true)['error'] ?? [];
            throw new TranscribeApiException(
                (string) ($error['message'] ?? "HTTP $status"),
                $status,
                (string) ($error['code'] ?? "http_$status")
            );
        }
        return (string) $body;
    }
}

/** An error answer from the API. $errorCode is the API code, e.g. "not_found" or "file_too_large". */
final class TranscribeApiException extends RuntimeException
{
    public function __construct(string $message, public readonly int $httpStatus = 0, public readonly string $errorCode = 'error')
    {
        parent::__construct($message, $httpStatus);
    }
}
