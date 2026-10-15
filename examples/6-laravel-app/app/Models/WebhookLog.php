<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/** One call to POST /webhooks/transcribe (valid or not). */
class WebhookLog extends Model
{
    public $timestamps = false;

    protected $fillable = [
        'event', 'remote_id', 'signature_valid', 'http_status_returned', 'payload', 'user_agent', 'note', 'received_at',
    ];

    protected function casts(): array
    {
        return [
            'signature_valid' => 'boolean',
            'http_status_returned' => 'integer',
            'payload' => 'array',
            'received_at' => 'datetime',
        ];
    }

    public function toClient(): array
    {
        return [
            'id' => $this->id,
            'received_at' => $this->received_at?->toIso8601String(),
            'event' => $this->event,
            'remote_id' => $this->remote_id,
            'signature_valid' => $this->signature_valid,
            'http_status_returned' => $this->http_status_returned,
            'user_agent' => $this->user_agent,
            'note' => $this->note,
        ];
    }
}
