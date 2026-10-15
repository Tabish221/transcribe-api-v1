<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Facades\Storage;

/**
 * Local copy of one job on the Transcribe API (remote_id = "tr_...").
 */
class Transcription extends Model
{
    public const STATUSES = ['queued', 'processing', 'completed', 'failed'];

    public const FINAL = ['completed', 'failed'];

    protected $fillable = [
        'remote_id', 'filename', 'file_size', 'audio_path', 'engine', 'language', 'status', 'progress',
        'text', 'segments', 'duration', 'error', 'last_synced_at', 'webhook_received_at',
    ];

    protected function casts(): array
    {
        return [
            'segments' => 'array',
            'duration' => 'float',
            'progress' => 'integer',
            'file_size' => 'integer',
            'last_synced_at' => 'datetime',
            'webhook_received_at' => 'datetime',
        ];
    }

    public function isFinal(): bool
    {
        return in_array($this->status, self::FINAL, true);
    }

    /**
     * Copies the API's transcription object (SPEC section 7) into this row. Does not save.
     * Used by the status refresh and by the webhook.
     */
    public function applyRemote(array $data): static
    {
        if (in_array($data['status'] ?? null, self::STATUSES, true)) {
            $this->status = $data['status'];
        }
        if (! empty($data['engine']) && is_string($data['engine'])) {
            $this->engine = $data['engine'];
        }
        $language = $data['detected_language'] ?? $data['language'] ?? null;
        if (is_string($language) && $language !== '') {
            $this->language = $language;
        }
        $this->progress = isset($data['progress']) && is_numeric($data['progress'])
            ? max(0, min(100, (int) $data['progress'])) : null;
        if (isset($data['duration']) && is_numeric($data['duration'])) {
            $this->duration = (float) $data['duration'];
        }
        // text and segments are null until the job is completed (list items have no segments at all).
        if (isset($data['text']) && is_string($data['text'])) {
            $this->text = $data['text'];
        }
        if (isset($data['segments']) && is_array($data['segments'])) {
            $this->segments = array_values(array_map(fn (array $s) => [
                'id' => (int) ($s['id'] ?? 0),
                'start' => (float) ($s['start'] ?? 0),
                'end' => (float) ($s['end'] ?? 0),
                'text' => (string) ($s['text'] ?? ''),
            ], array_filter($data['segments'], 'is_array')));
        }
        $this->error = isset($data['error']) && is_scalar($data['error']) && $data['error'] !== ''
            ? (string) $data['error'] : null;
        if ($this->status === 'completed') {
            $this->progress = 100;
        }

        return $this;
    }

    public function hasAudio(): bool
    {
        return $this->audio_path !== null && Storage::disk('local')->exists($this->audio_path);
    }

    public function deleteAudio(): void
    {
        if ($this->audio_path !== null) {
            Storage::disk('local')->delete($this->audio_path);
        }
    }

    /** What the App page gets. $full adds text and segments. */
    public function toClient(bool $full = false): array
    {
        $out = [
            'id' => $this->id,
            'remote_id' => $this->remote_id,
            'filename' => $this->filename,
            'file_size' => $this->file_size,
            'engine' => $this->engine,
            'language' => $this->language,
            'status' => $this->status,
            'final' => $this->isFinal(),
            'progress' => $this->progress,
            'duration' => $this->duration,
            'error' => $this->error,
            'audio_url' => $this->hasAudio() ? route('app.audio', $this, false) : null,
            'created_at' => $this->created_at?->toIso8601String(),
            'last_synced_at' => $this->last_synced_at?->toIso8601String(),
            'webhook_received_at' => $this->webhook_received_at?->toIso8601String(),
        ];
        if ($full) {
            $out['text'] = $this->text;
            $out['segments'] = $this->segments ?? [];
        }

        return $out;
    }
}
