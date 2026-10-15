<?php

namespace App\Http\Controllers;

use App\Models\Transcription;
use App\Services\TranscribeClient;
use App\Services\TranscribeResult;
use App\Services\UploadLimit;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;
use Illuminate\View\View;
use Symfony\Component\HttpFoundation\Response;

/**
 * The "App" page (/) and its JSON routes (/app-api/...).
 *
 * Flow: the browser uploads an mp3 here -> this app sends it to the Transcribe API with
 * webhook_url = /webhooks/transcribe -> a local Transcription row keeps the API's id (remote_id).
 * The page polls GET /app-api/transcriptions/{id}; the webhook usually finishes the job first.
 */
class AppController extends Controller
{
    /** Languages offered on the App page. "auto" = let Whisper detect it. */
    public const LANGUAGES = [
        'auto' => 'Auto-detect', 'en' => 'English', 'ur' => 'Urdu', 'hi' => 'Hindi', 'ar' => 'Arabic',
        'bn' => 'Bengali', 'pa' => 'Punjabi', 'fa' => 'Persian', 'tr' => 'Turkish', 'es' => 'Spanish',
        'fr' => 'French', 'de' => 'German', 'it' => 'Italian', 'pt' => 'Portuguese', 'ru' => 'Russian',
        'zh' => 'Chinese', 'ja' => 'Japanese',
    ];

    public function index(): View
    {
        $language = strtolower((string) config('services.transcribe.language'));

        return view('app', [
            'engine' => config('services.transcribe.engine') === 'cloud' ? 'cloud' : 'worker',
            'language' => array_key_exists($language, self::LANGUAGES) ? $language : 'auto',
            'languages' => self::LANGUAGES,
            'maxBytes' => UploadLimit::bytes(),
            'maxHuman' => UploadLimit::human(),
        ]);
    }

    /** GET /app-api/transcriptions — local list, newest first. */
    public function list(): JsonResponse
    {
        $items = Transcription::query()->latest('id')->limit(100)->get();

        return response()->json(['data' => $items->map(fn (Transcription $t) => $t->toClient())->all()]);
    }

    /** POST /app-api/transcriptions — upload an mp3 and start a job on the API. */
    public function store(Request $request, TranscribeClient $client): JsonResponse
    {
        $request->validate([
            'file' => ['required', 'file', 'extensions:mp3', 'mimes:mp3,mpga', 'max:' . UploadLimit::kilobytes()],
            'engine' => ['nullable', Rule::in(['worker', 'cloud'])],
            'language' => ['nullable', Rule::in(array_keys(self::LANGUAGES))],
        ], [
            'file.max' => 'The file is too big. Max size: ' . UploadLimit::human() . '.',
            'file.extensions' => 'Please choose an MP3 file.',
            'file.mimes' => 'This file is not an MP3 audio file.',
        ]);

        $file = $request->file('file');
        $filename = self::cleanFilename($file->getClientOriginalName());
        @set_time_limit(max(60, (int) config('services.transcribe.timeout', 120) + 30));

        $result = $client->upload($file->getRealPath(), $filename, [
            'engine' => $request->input('engine') ?: config('services.transcribe.engine'),
            'language' => $request->input('language') ?: config('services.transcribe.language'),
            'webhook_url' => self::webhookUrl(),
            'metadata' => ['source' => 'laravel-demo'],
        ]);
        if (! $result->ok) {
            return self::apiError($result);
        }

        $data = $result->data ?? [];
        $remoteId = (string) ($data['id'] ?? '');
        if (! preg_match('/^tr_[A-Za-z0-9]{1,60}$/', $remoteId)) {
            return response()->json(['error' => ['code' => 'bad_response', 'message' => 'The API did not return a transcription id.']], 502);
        }

        // Keep a copy so the App page can play the audio later (storage/app/private/audio).
        $audioPath = config('services.transcribe.keep_audio') ? $file->storeAs('audio', $remoteId . '.mp3', 'local') : null;

        $transcription = new Transcription([
            'remote_id' => $remoteId,
            'filename' => $filename,
            'file_size' => $file->getSize(),
            'audio_path' => $audioPath ?: null,
            'status' => 'queued',
        ]);
        $transcription->applyRemote($data);
        $transcription->last_synced_at = now();
        $transcription->save();

        return response()->json($transcription->toClient(true), 201);
    }

    /** GET /app-api/transcriptions/{transcription} — refreshes from the API while the job is not done. */
    public function show(Transcription $transcription, TranscribeClient $client): JsonResponse
    {
        $syncError = null;
        $needsText = $transcription->status === 'completed' && $transcription->text === null;
        $stale = $transcription->last_synced_at === null || $transcription->last_synced_at->lt(now()->subSeconds(2));

        if ((! $transcription->isFinal() && $stale) || $needsText) {
            $result = $client->get($transcription->remote_id);
            if ($result->ok) {
                $transcription->applyRemote($result->data ?? []);
                $transcription->last_synced_at = now();
                $transcription->save();
            } elseif ($result->status === 404) {
                $transcription->status = 'failed';
                $transcription->error = 'This job is not on the API any more (deleted?).';
                $transcription->last_synced_at = now();
                $transcription->save();
            } else {
                $syncError = $result->error['message'] ?? 'Cannot reach the Transcribe API.';
            }
        }

        return response()->json($transcription->toClient(true) + ['sync_error' => $syncError]);
    }

    /** GET /app-api/transcriptions/{transcription}/srt — subtitle file from the API (?format=srt). */
    public function srt(Transcription $transcription, TranscribeClient $client): Response
    {
        if ($transcription->status !== 'completed') {
            return response()->json(['error' => ['code' => 'not_ready', 'message' => 'The transcript is not ready yet.']], 409);
        }
        $result = $client->format($transcription->remote_id, 'srt');
        if (! $result->ok) {
            return self::apiError($result);
        }
        $name = pathinfo($transcription->filename, PATHINFO_FILENAME) ?: $transcription->remote_id;
        $body = (string) $result->body;

        return response()->streamDownload(function () use ($body) {
            echo $body;
        }, $name . '.srt', ['Content-Type' => 'application/x-subrip; charset=utf-8']);
    }

    /** GET /app-api/transcriptions/{transcription}/audio — the local copy of the mp3. */
    public function audio(Transcription $transcription): Response
    {
        abort_unless($transcription->hasAudio(), 404);

        return response()->file(
            \Illuminate\Support\Facades\Storage::disk('local')->path($transcription->audio_path),
            ['Content-Type' => 'audio/mpeg', 'Cache-Control' => 'private, max-age=3600']
        );
    }

    /** DELETE /app-api/transcriptions/{transcription} — deletes on the API, then here. */
    public function destroy(Transcription $transcription, TranscribeClient $client): JsonResponse
    {
        $result = $client->delete($transcription->remote_id);
        if (! $result->ok && $result->status !== 404) { // 404 = already gone on the API
            return self::apiError($result);
        }
        $transcription->deleteAudio();
        $transcription->delete();

        return response()->json(['deleted' => true, 'remote_deleted' => $result->ok]);
    }

    /** Where the API sends the result. TRANSCRIBE_WEBHOOK_URL wins (for example a public tunnel URL). */
    public static function webhookUrl(): string
    {
        return (string) (config('services.transcribe.webhook_url') ?: route('webhooks.transcribe'));
    }

    /** Turns a failed API call into a JSON error for the browser (never with the key). */
    public static function apiError(TranscribeResult $result): JsonResponse
    {
        // 413/415/422/404/409 are about the request: pass them on. Anything else is a server problem (502).
        $status = in_array($result->status, [404, 409, 413, 415, 422, 429], true) ? $result->status : 502;
        $error = $result->error ?? ['code' => 'api_error', 'message' => 'Transcribe API error'];
        if ($result->status === 401) {
            $error['message'] = 'The API key was refused (401). Check TRANSCRIBE_API_KEY in .env.';
        }

        return response()->json(['error' => $error, 'api_status' => $result->status], $status);
    }

    /** "C:\fakepath\My call.mp3" -> "My call.mp3" (only for display; the API stores the file under its own id). */
    public static function cleanFilename(string $name): string
    {
        $name = basename(str_replace('\\', '/', $name));
        $name = preg_replace('/[\x00-\x1F\x7F]+/u', '', $name) ?? '';
        $name = trim(mb_substr($name, -200));

        return $name === '' || $name === '.mp3' ? 'audio.mp3' : $name;
    }
}
