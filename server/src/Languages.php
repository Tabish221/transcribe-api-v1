<?php

declare(strict_types=1);

namespace Tapi;

/**
 * Whisper language names <-> ISO-639-1 codes.
 * Engines report e.g. "english" (verbose_json); the API always stores and returns codes ("en").
 */
final class Languages
{
    private const NAMES = [
        'english' => 'en', 'chinese' => 'zh', 'german' => 'de', 'spanish' => 'es', 'russian' => 'ru',
        'korean' => 'ko', 'french' => 'fr', 'japanese' => 'ja', 'portuguese' => 'pt', 'turkish' => 'tr',
        'polish' => 'pl', 'catalan' => 'ca', 'dutch' => 'nl', 'arabic' => 'ar', 'swedish' => 'sv',
        'italian' => 'it', 'indonesian' => 'id', 'hindi' => 'hi', 'finnish' => 'fi', 'vietnamese' => 'vi',
        'hebrew' => 'he', 'ukrainian' => 'uk', 'greek' => 'el', 'malay' => 'ms', 'czech' => 'cs',
        'romanian' => 'ro', 'danish' => 'da', 'hungarian' => 'hu', 'tamil' => 'ta', 'norwegian' => 'no',
        'thai' => 'th', 'urdu' => 'ur', 'croatian' => 'hr', 'bulgarian' => 'bg', 'lithuanian' => 'lt',
        'latin' => 'la', 'maori' => 'mi', 'malayalam' => 'ml', 'welsh' => 'cy', 'slovak' => 'sk',
        'telugu' => 'te', 'persian' => 'fa', 'latvian' => 'lv', 'bengali' => 'bn', 'serbian' => 'sr',
        'azerbaijani' => 'az', 'slovenian' => 'sl', 'kannada' => 'kn', 'estonian' => 'et', 'macedonian' => 'mk',
        'breton' => 'br', 'basque' => 'eu', 'icelandic' => 'is', 'armenian' => 'hy', 'nepali' => 'ne',
        'mongolian' => 'mn', 'bosnian' => 'bs', 'kazakh' => 'kk', 'albanian' => 'sq', 'swahili' => 'sw',
        'galician' => 'gl', 'marathi' => 'mr', 'punjabi' => 'pa', 'sinhala' => 'si', 'khmer' => 'km',
        'shona' => 'sn', 'yoruba' => 'yo', 'somali' => 'so', 'afrikaans' => 'af', 'occitan' => 'oc',
        'georgian' => 'ka', 'belarusian' => 'be', 'tajik' => 'tg', 'sindhi' => 'sd', 'gujarati' => 'gu',
        'amharic' => 'am', 'yiddish' => 'yi', 'lao' => 'lo', 'uzbek' => 'uz', 'faroese' => 'fo',
        'haitian creole' => 'ht', 'pashto' => 'ps', 'turkmen' => 'tk', 'nynorsk' => 'nn', 'maltese' => 'mt',
        'sanskrit' => 'sa', 'luxembourgish' => 'lb', 'myanmar' => 'my', 'tibetan' => 'bo', 'tagalog' => 'tl',
        'malagasy' => 'mg', 'assamese' => 'as', 'tatar' => 'tt', 'hawaiian' => 'haw', 'lingala' => 'ln',
        'hausa' => 'ha', 'bashkir' => 'ba', 'javanese' => 'jv', 'sundanese' => 'su', 'cantonese' => 'yue',
        // Common aliases
        'burmese' => 'my', 'valencian' => 'ca', 'flemish' => 'nl', 'haitian' => 'ht', 'letzeburgesch' => 'lb',
        'pushto' => 'ps', 'panjabi' => 'pa', 'moldavian' => 'ro', 'moldovan' => 'ro', 'sinhalese' => 'si',
        'castilian' => 'es', 'mandarin' => 'zh', 'farsi' => 'fa', 'filipino' => 'tl',
    ];

    /**
     * Whisper's own codes that differ from ISO-639-1 (Javanese is "jw" in Whisper, "jv" in ISO).
     * The API always uses the ISO code; the PC worker maps it back for the model.
     */
    private const WHISPER_CODES = ['jw' => 'jv'];

    /**
     * Normalises a language code or name to a code.
     * Returns null for empty/"auto", false when the value is not a known language.
     */
    public static function normalize(mixed $value): string|false|null
    {
        if ($value === null) {
            return null;
        }
        $value = strtolower(trim((string) $value));
        if ($value === '' || $value === 'auto' || $value === 'null') {
            return null;
        }
        if (isset(self::NAMES[$value])) {
            return self::NAMES[$value];
        }
        $codes = array_flip(self::NAMES);
        // Accept "en", "EN", "en-US", "en_GB"
        $primary = preg_split('/[-_]/', $value)[0] ?? $value;
        $primary = self::WHISPER_CODES[$primary] ?? $primary;
        return isset($codes[$primary]) ? $primary : false;
    }

    /** Lenient variant for engine output: unknown values are kept (truncated) instead of rejected. */
    public static function fromEngine(mixed $value): ?string
    {
        $code = self::normalize($value);
        if ($code === false) {
            $code = substr(preg_replace('/[^a-z0-9-]/', '', strtolower((string) $value)) ?? '', 0, 16);
            return $code === '' ? null : $code;
        }
        return $code;
    }
}
