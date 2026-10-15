<?php

declare(strict_types=1);

namespace Tapi;

/**
 * "cloud" engine: an OpenAI-compatible speech-to-text API (Groq, OpenAI, ...) called with cURL.
 * POST {base_url}/audio/transcriptions  (or /audio/translations for task=translate)
 */
final class CloudEngine
{
    /**
     * @return array{text:string, segments:array, duration:?float, detected_language:?string}
     * @throws EngineException
     */
    public static function transcribe(string $path, string $filename, string $mime, string $task, ?string $language, ?string $prompt): array
    {
        $cloud = (array) Config::get('cloud');
        $translate = $task === 'translate';
        $url = rtrim((string) $cloud['base_url'], '/') . ($translate ? '/audio/translations' : '/audio/transcriptions');
        $model = (string) ($translate ? ($cloud['translate_model'] ?: $cloud['model']) : $cloud['model']);
        // Providers detect the audio format from the uploaded name's extension: it must match the stored file.
        $ext = strtolower((string) pathinfo($path, PATHINFO_EXTENSION));
        if ($ext !== '' && strtolower((string) pathinfo($filename, PATHINFO_EXTENSION)) !== $ext) {
            $filename = 'audio.' . $ext;
        }

        $fields = [
            'file' => new \CURLFile($path, $mime, $filename),
            'model' => $model,
            'response_format' => 'verbose_json',
            'temperature' => '0',
        ];
        if (!$translate) {
            // The translations endpoint always outputs English and does not take these parameters.
            $fields['timestamp_granularities[]'] = 'segment';
            if ($language !== null && $language !== '') {
                $fields['language'] = $language;
            }
        }
        if ($prompt !== null && $prompt !== '') {
            $fields['prompt'] = $prompt;
        }

        $timeout = max(30, (int) ($cloud['timeout'] ?? 600));
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => $fields,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER => [
                'Authorization: Bearer ' . (string) $cloud['api_key'],
                'Accept: application/json',
                'Expect:',
            ],
            CURLOPT_USERAGENT => 'TranscribeAPI/' . TAPI_VERSION,
            CURLOPT_CONNECTTIMEOUT => 30,
            CURLOPT_TIMEOUT => $timeout,
            CURLOPT_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
        ]);
        $body = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $curlError = curl_error($ch);
        curl_close($ch);

        if ($body === false || !is_string($body)) {
            throw new EngineException('Cloud engine request failed: ' . ($curlError !== '' ? $curlError : 'no response'), true);
        }
        $json = json_decode($body, true);
        if ($status < 200 || $status >= 300) {
            $message = is_array($json) ? ($json['error']['message'] ?? $json['message'] ?? null) : null;
            if (!is_string($message) || $message === '') {
                $message = Util::cut(trim(strip_tags($body)), 300);
            }
            $transient = $status === 408 || $status === 409 || $status === 429 || $status >= 500;
            throw new EngineException("Cloud engine error (HTTP {$status}): {$message}", $transient);
        }
        if (!is_array($json) || !isset($json['text'])) {
            throw new EngineException('Cloud engine returned an unexpected response (expected verbose_json)');
        }
        return self::parse($json, $translate ? 'en' : $language);
    }

    /** Maps a verbose_json response onto the engine result shape. */
    public static function parse(array $json, ?string $fallbackLanguage): array
    {
        $segments = [];
        foreach ((array) ($json['segments'] ?? []) as $segment) {
            if (is_array($segment)) {
                $segments[] = [
                    'start' => $segment['start'] ?? 0,
                    'end' => $segment['end'] ?? ($segment['start'] ?? 0),
                    'text' => (string) ($segment['text'] ?? ''),
                ];
            }
        }
        $text = trim((string) $json['text']);
        $duration = is_numeric($json['duration'] ?? null) ? (float) $json['duration'] : null;
        if ($duration === null && $segments !== []) {
            $last = end($segments);
            $duration = is_numeric($last['end']) ? (float) $last['end'] : null;
        }
        if ($segments === [] && $text !== '') {
            $segments[] = ['start' => 0.0, 'end' => $duration ?? 0.0, 'text' => $text];
        }
        return [
            'text' => $text,
            'segments' => $segments,
            'duration' => $duration,
            'detected_language' => Languages::fromEngine($json['language'] ?? null) ?? $fallbackLanguage,
        ];
    }
}
