<?php

namespace App\Services;

use RuntimeException;
use Throwable;

/**
 * Thrown by TranscribeResult::throw() when a call to the Transcribe API failed.
 *
 * getMessage() is the API's own message, e.g. "Unsupported file type. Allowed: mp3".
 * The API sends errors as {"error": {"code": "...", "message": "...", "field": "..."}}.
 */
class TranscribeException extends RuntimeException
{
    public function __construct(
        string $message,
        public readonly int $status = 0,            // HTTP status from the API (0 = no answer, e.g. network error)
        public readonly ?string $errorCode = null,  // e.g. invalid_api_key, validation_error, file_too_large, not_ready
        public readonly ?string $field = null,      // the form field, for validation_error (422)
        ?Throwable $previous = null,
    ) {
        parent::__construct($message, $status, $previous);
    }
}
