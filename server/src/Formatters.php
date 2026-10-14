<?php

declare(strict_types=1);

namespace Tapi;

/** Transcript download formats: txt, srt, vtt, json. */
final class Formatters
{
    public const MIME = [
        'txt' => 'text/plain; charset=utf-8',
        'srt' => 'application/x-subrip; charset=utf-8',
        'vtt' => 'text/vtt; charset=utf-8',
        'json' => 'application/json; charset=utf-8',
    ];

    public static function isFormat(string $format): bool
    {
        return isset(self::MIME[$format]);
    }

    /** Renders a serialized transcription object in the given format. */
    public static function render(array $transcription, string $format): string
    {
        $segments = self::segments($transcription);
        switch ($format) {
            case 'txt':
                return implode("\n", array_column($segments, 'text')) . "\n";
            case 'srt':
                $blocks = [];
                foreach ($segments as $i => $s) {
                    $blocks[] = ($i + 1) . "\n" . self::stamp($s['start'], ',') . ' --> ' . self::stamp($s['end'], ',') . "\n" . $s['text'] . "\n";
                }
                return implode("\n", $blocks);
            case 'vtt':
                $blocks = [];
                foreach ($segments as $s) {
                    $blocks[] = self::stamp($s['start'], '.') . ' --> ' . self::stamp($s['end'], '.') . "\n" . $s['text'] . "\n";
                }
                return "WEBVTT\n\n" . implode("\n", $blocks);
            case 'json':
                return Util::json($transcription, true) . "\n";
        }
        throw ApiException::validation('format', 'format must be one of: txt, srt, vtt, json');
    }

    /** Download filename: original name with the format's extension. */
    public static function filename(array $transcription, string $format): string
    {
        $base = pathinfo((string) $transcription['filename'], PATHINFO_FILENAME);
        return ($base === '' ? $transcription['id'] : $base) . '.' . $format;
    }

    /** HH:MM:SS,mmm (SRT) / HH:MM:SS.mmm (VTT). */
    public static function stamp(float|int $seconds, string $separator): string
    {
        $ms = (int) round(max(0, $seconds) * 1000);
        return sprintf('%02d:%02d:%02d%s%03d', intdiv($ms, 3600000), intdiv($ms, 60000) % 60, intdiv($ms, 1000) % 60, $separator, $ms % 1000);
    }

    /** Segments with text, falling back to one segment spanning the whole transcript. */
    private static function segments(array $transcription): array
    {
        $segments = [];
        foreach ((array) ($transcription['segments'] ?? []) as $s) {
            if (is_array($s) && trim((string) ($s['text'] ?? '')) !== '') {
                $segments[] = ['start' => (float) ($s['start'] ?? 0), 'end' => (float) ($s['end'] ?? 0), 'text' => trim((string) $s['text'])];
            }
        }
        $text = trim((string) ($transcription['text'] ?? ''));
        if ($segments === [] && $text !== '') {
            $segments[] = ['start' => 0.0, 'end' => (float) ($transcription['duration'] ?? 0), 'text' => $text];
        }
        return $segments;
    }
}
