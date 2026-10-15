<?php

declare(strict_types=1);

/**
 * Reads settings from a simple .env file (KEY=VALUE per line, # starts a comment).
 * A real environment variable with the same name wins over the file.
 *
 * @param string[] $required names that must have a value
 * @return array<string, string>
 */
function load_env(string $file, array $required = ['TRANSCRIBE_API_URL', 'TRANSCRIBE_API_KEY']): array
{
    $settings = [];
    if (is_file($file)) {
        foreach (file($file, FILE_IGNORE_NEW_LINES) ?: [] as $line) {
            $line = trim($line);
            if ($line === '' || $line[0] === '#' || !str_contains($line, '=')) {
                continue;
            }
            [$name, $value] = explode('=', $line, 2);
            $settings[trim($name)] = trim(trim($value), "\"'");
        }
    }

    foreach (array_unique(array_merge(array_keys($settings), $required)) as $name) {
        $fromEnvironment = getenv($name);
        if ($fromEnvironment !== false && $fromEnvironment !== '') {
            $settings[$name] = $fromEnvironment;
        }
    }

    foreach ($required as $name) {
        if (($settings[$name] ?? '') === '') {
            throw new RuntimeException("$name is missing. Add it to $file");
        }
    }
    return $settings;
}

/** "tk_1234..." - never show the full API key. */
function key_hint(string $key): string
{
    return substr($key, 0, 7) . '...';
}
