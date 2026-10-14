<?php

declare(strict_types=1);

namespace Tapi;

/** An error that maps directly to an HTTP status + {"error":{"code","message",...}} body. */
final class ApiException extends \RuntimeException
{
    public function __construct(
        public readonly int $status,
        public readonly string $errorCode,
        string $message,
        public readonly array $extra = []
    ) {
        parent::__construct($message);
    }

    public static function validation(string $field, string $message): self
    {
        return new self(422, 'validation_error', $message, ['field' => $field]);
    }

    public static function notFound(string $message = 'Not found'): self
    {
        return new self(404, 'not_found', $message);
    }

    public static function forbidden(string $message = 'You do not have access to this resource'): self
    {
        return new self(403, 'forbidden', $message);
    }

    public static function unauthorized(string $message = 'Authentication required'): self
    {
        return new self(401, 'unauthorized', $message);
    }
}
