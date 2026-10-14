<?php

declare(strict_types=1);

namespace Tapi;

/** A transcription engine error. Transient errors (timeouts, 429, 5xx) are retried; others fail the job. */
final class EngineException extends \RuntimeException
{
    public function __construct(string $message, public readonly bool $transient = false)
    {
        parent::__construct($message);
    }
}
