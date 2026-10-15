<?php

namespace Tests\Feature;

use App\Http\Controllers\TranscribeWebhookController;
use App\Models\Transcription;
use App\Models\WebhookLog;
use App\Services\TranscribeClient;
use App\Services\TranscribeException;
use Illuminate\Foundation\Http\Middleware\ValidateCsrfToken;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

/**
 * All API calls are faked (Http::fake). The key and secret come from phpunit.xml, not from .env.
 */
class TranscribeApiTest extends TestCase
{
    use RefreshDatabase;

    private const API = 'https://transcribe.test';

    private string $key;

    private string $secret;

    protected function setUp(): void
    {
        parent::setUp();
        Http::preventStrayRequests();
        Storage::fake('local');
        $this->key = (string) config('services.transcribe.key');
        $this->secret = (string) config('services.transcribe.webhook_secret');
        $this->assertStringStartsWith('tk_0123', $this->key, 'phpunit.xml must set a fake TRANSCRIBE_API_KEY');
    }

    // ----- TranscribeClient ----------------------------------------------------------------

    public function test_client_sends_bearer_key_and_multipart_fields(): void
    {
        Http::fake([self::API . '/api/v1/transcriptions' => Http::response($this->job('tr_aaa', 'queued'), 202)]);
        $path = tempnam(sys_get_temp_dir(), 'mp3');
        file_put_contents($path, str_repeat("\xFF\xFB", 2000));

        $result = app(TranscribeClient::class)->upload($path, 'call.mp3', [
            'engine' => 'worker',
            'language' => 'en',
            'task' => 'transcribe',
            'webhook_url' => 'https://example.com/hook',
            'metadata' => ['order_id' => 7],
            'wait' => false,
        ]);
        @unlink($path);

        $this->assertTrue($result->ok);
        $this->assertSame(202, $result->status);
        $this->assertSame('tr_aaa', $result->data['id']);
        $this->assertSame('Bearer tk_0123…', $result->request['headers']['Authorization']);

        Http::assertSent(function (Request $request) {
            $fields = collect($request->data())->filter(fn ($p) => is_array($p) && isset($p['name']))
                ->mapWithKeys(fn ($p) => [$p['name'] => $p['contents']]);

            return $request->method() === 'POST'
                && $request->url() === self::API . '/api/v1/transcriptions'
                && $request->hasHeader('Authorization', 'Bearer ' . $this->key)
                && $request->isMultipart()
                && $request->hasFile('file', null, 'call.mp3')
                && $fields['engine'] === 'worker'
                && $fields['language'] === 'en'
                && $fields['task'] === 'transcribe'
                && $fields['webhook_url'] === 'https://example.com/hook'
                && $fields['metadata'] === '{"order_id":7}'
                && ! $fields->has('wait');
        });
    }

    public function test_client_returns_http_errors_and_throw_helper_throws(): void
    {
        Http::fake([self::API . '/*' => Http::response(
            ['error' => ['code' => 'invalid_api_key', 'message' => 'Invalid or revoked API key']], 401)]);

        $result = app(TranscribeClient::class)->get('tr_x');

        $this->assertFalse($result->ok);
        $this->assertSame(401, $result->status);
        $this->assertSame('invalid_api_key', $result->errorCode());
        $this->assertArrayHasKey('duration_ms', $result->toArray());

        $this->expectException(TranscribeException::class);
        $this->expectExceptionMessage('Invalid or revoked API key');
        $result->throw();
    }

    public function test_health_needs_no_key_and_list_sends_query(): void
    {
        Http::fake([
            self::API . '/api/v1/health' => Http::response(['ok' => true, 'version' => '1.0.0', 'engines' => ['cloud' => false, 'worker' => true]]),
            self::API . '/api/v1/transcriptions?*' => Http::response(['object' => 'list', 'data' => [], 'total' => 0, 'limit' => 5, 'offset' => 0]),
        ]);
        $client = app(TranscribeClient::class);

        $this->assertTrue($client->health()->ok);
        $this->assertTrue($client->list(['status' => 'completed', 'limit' => 5])->ok);

        Http::assertSent(fn (Request $r) => str_ends_with($r->url(), '/api/v1/health') && ! $r->hasHeader('Authorization'));
        Http::assertSent(fn (Request $r) => $r->url() === self::API . '/api/v1/transcriptions?status=completed&limit=5'
            && $r->hasHeader('Authorization', 'Bearer ' . $this->key));
    }

    // ----- App routes ------------------------------------------------------------------------

    public function test_upload_creates_local_record_with_webhook_url(): void
    {
        Http::fake([self::API . '/api/v1/transcriptions' => Http::response($this->job('tr_upload1', 'queued'), 202)]);

        $response = $this->post('/app-api/transcriptions', [
            'file' => UploadedFile::fake()->create('My meeting.mp3', 300, 'audio/mpeg'),
            'engine' => 'worker',
            'language' => 'en',
        ], ['Accept' => 'application/json']);

        $response->assertCreated()
            ->assertJsonPath('remote_id', 'tr_upload1')
            ->assertJsonPath('filename', 'My meeting.mp3')
            ->assertJsonPath('status', 'queued');

        $row = Transcription::firstWhere('remote_id', 'tr_upload1');
        $this->assertNotNull($row);
        $this->assertSame('worker', $row->engine);
        $this->assertTrue($row->hasAudio(), 'a local copy of the mp3 is kept for the player');

        Http::assertSent(function (Request $request) {
            $fields = collect($request->data())->filter(fn ($p) => is_array($p) && isset($p['name']))
                ->mapWithKeys(fn ($p) => [$p['name'] => $p['contents']]);

            return $request->hasFile('file', null, 'My meeting.mp3')
                && $fields['webhook_url'] === url('/webhooks/transcribe')
                && $fields['engine'] === 'worker'
                && $fields['language'] === 'en';
        });
    }

    public function test_upload_rejects_a_file_that_is_not_mp3(): void
    {
        $this->post('/app-api/transcriptions', [
            'file' => UploadedFile::fake()->create('notes.txt', 5, 'text/plain'),
        ], ['Accept' => 'application/json'])->assertStatus(422)->assertJsonValidationErrors('file');

        Http::assertNothingSent();
        $this->assertSame(0, Transcription::count());
    }

    public function test_upload_passes_on_api_errors(): void
    {
        Http::fake([self::API . '/*' => Http::response(
            ['error' => ['code' => 'engine_unavailable', 'message' => 'The cloud engine is not configured']], 503)]);

        $this->post('/app-api/transcriptions', [
            'file' => UploadedFile::fake()->create('a.mp3', 10, 'audio/mpeg'),
            'engine' => 'cloud',
        ], ['Accept' => 'application/json'])
            ->assertStatus(502)
            ->assertJsonPath('error.code', 'engine_unavailable')
            ->assertJsonPath('api_status', 503);

        $this->assertSame(0, Transcription::count());
    }

    public function test_show_refreshes_from_the_api_until_the_job_is_final(): void
    {
        $row = Transcription::create(['remote_id' => 'tr_show1', 'filename' => 'a.mp3', 'status' => 'processing']);
        Http::fake([self::API . '/api/v1/transcriptions/tr_show1' => Http::response($this->job('tr_show1', 'completed'))]);

        $this->getJson("/app-api/transcriptions/{$row->id}")
            ->assertOk()
            ->assertJsonPath('status', 'completed')
            ->assertJsonPath('text', 'Hello there. Thanks for calling.')
            ->assertJsonCount(2, 'segments');

        // Final now: the next call is answered from the local copy.
        $this->getJson("/app-api/transcriptions/{$row->id}")->assertOk();
        Http::assertSentCount(1);
        $this->assertSame('completed', $row->fresh()->status);
    }

    public function test_srt_download_and_delete(): void
    {
        $srt = "1\n00:00:00,000 --> 00:00:02,000\nHello there.\n";
        Storage::disk('local')->put('audio/tr_del1.mp3', 'x');
        $row = Transcription::create(['remote_id' => 'tr_del1', 'filename' => 'call.mp3', 'status' => 'completed',
            'text' => 'Hello there.', 'audio_path' => 'audio/tr_del1.mp3']);
        Http::fake([
            self::API . '/api/v1/transcriptions/tr_del1?format=srt' => Http::response($srt, 200, ['Content-Type' => 'application/x-subrip']),
            self::API . '/api/v1/transcriptions/tr_del1' => Http::response(['id' => 'tr_del1', 'deleted' => true]),
        ]);

        $download = $this->get("/app-api/transcriptions/{$row->id}/srt");
        $download->assertOk()->assertHeader('Content-Disposition', 'attachment; filename=call.srt');
        $this->assertSame($srt, $download->streamedContent());

        $this->deleteJson("/app-api/transcriptions/{$row->id}")->assertOk()->assertJsonPath('deleted', true);
        $this->assertModelMissing($row);
        Storage::disk('local')->assertMissing('audio/tr_del1.mp3');
        Http::assertSent(fn (Request $r) => $r->method() === 'DELETE' && str_ends_with($r->url(), '/tr_del1'));
    }

    // ----- Webhook ---------------------------------------------------------------------------

    public function test_webhook_route_is_excluded_from_csrf(): void
    {
        $this->assertContains('webhooks/transcribe', app(ValidateCsrfToken::class)->getExcludedPaths());
    }

    public function test_webhook_with_valid_signature_updates_the_record(): void
    {
        $row = Transcription::create(['remote_id' => 'tr_hook1', 'filename' => 'a.mp3', 'status' => 'queued']);
        $body = json_encode(['event' => 'transcription.completed', 'created_at' => '2026-10-15T10:00:00Z',
            'data' => $this->job('tr_hook1', 'completed')]);

        $this->sendWebhook($body, TranscribeWebhookController::sign($body, $this->secret))
            ->assertOk()->assertExactJson(['ok' => true]);

        $row->refresh();
        $this->assertSame('completed', $row->status);
        $this->assertSame('Hello there. Thanks for calling.', $row->text);
        $this->assertCount(2, $row->segments);
        $this->assertNotNull($row->webhook_received_at);

        $log = WebhookLog::sole();
        $this->assertTrue($log->signature_valid);
        $this->assertSame(200, $log->http_status_returned);
        $this->assertSame('transcription.completed', $log->event);
        $this->assertSame('tr_hook1', $log->remote_id);
    }

    public function test_forged_or_unsigned_webhook_is_rejected_with_401(): void
    {
        $row = Transcription::create(['remote_id' => 'tr_hook2', 'filename' => 'a.mp3', 'status' => 'queued']);
        $body = json_encode(['event' => 'transcription.completed', 'data' => $this->job('tr_hook2', 'completed')]);

        $this->sendWebhook($body, TranscribeWebhookController::sign($body, 'whsec_wrong'))->assertStatus(401);
        $this->sendWebhook($body, null)->assertStatus(401);
        // Valid signature of a different body (tampered payload).
        $this->sendWebhook($body, TranscribeWebhookController::sign($body . ' ', $this->secret))->assertStatus(401);

        $this->assertSame('queued', $row->fresh()->status);
        $this->assertSame(3, WebhookLog::where('signature_valid', false)->where('http_status_returned', 401)->count());
        $this->assertSame(0, WebhookLog::whereNotNull('payload')->count(), 'bodies of forged webhooks are not stored');
    }

    public function test_unknown_local_id_gives_a_short_json_404(): void
    {
        $this->getJson('/app-api/transcriptions/999')
            ->assertNotFound()
            ->assertExactJson(['error' => ['code' => 'not_found', 'message' => 'This transcription was not found. Maybe it was deleted.']]);
        Http::assertNothingSent();
    }

    // ----- Tester ----------------------------------------------------------------------------

    public function test_tester_actions_mask_the_key(): void
    {
        Http::fake([
            self::API . '/api/v1/health' => Http::response(['ok' => true, 'version' => '1.0.0', 'engines' => ['cloud' => false, 'worker' => true]]),
            self::API . '/api/v1/transcriptions' => Http::response($this->job('tr_t1', 'queued'), 202),
            self::API . '/api/v1/transcriptions?*' => Http::response(['object' => 'list', 'data' => [$this->job('tr_t1', 'queued')], 'total' => 1, 'limit' => 10, 'offset' => 0]),
            self::API . '/api/v1/transcriptions/tr_t1?format=srt' => Http::response(['error' => ['code' => 'not_ready', 'message' => 'not completed']], 409),
            // A strange server that echoes the key back: the tester must still hide it.
            self::API . '/api/v1/transcriptions/tr_t1' => Http::response(['error' => ['code' => 'x', 'message' => 'bad key ' . $this->key]], 400),
        ]);
        $headers = ['Accept' => 'application/json'];

        $calls = [
            ['health', []],
            ['list', ['status' => 'queued', 'limit' => 10]],
            ['upload', ['file' => UploadedFile::fake()->create('t.mp3', 20, 'audio/mpeg'), 'engine' => 'worker', 'webhook' => '1']],
            ['get', ['id' => 'tr_t1']],
            ['format', ['id' => 'tr_t1', 'format' => 'srt']],
        ];
        foreach ($calls as [$action, $data]) {
            $response = $this->post("/tester-api/{$action}", $data, $headers);
            $response->assertOk()->assertJsonStructure(['action', 'ok', 'request' => ['method', 'url'], 'response' => ['status', 'headers', 'body'], 'duration_ms']);
            $this->assertStringNotContainsString($this->key, $response->getContent(), "{$action} leaked the key");
            $this->assertStringNotContainsString($this->secret, $response->getContent(), "{$action} leaked the secret");
            if ($action !== 'health') {
                $response->assertJsonPath('request.headers.Authorization', 'Bearer tk_0123…');
            }
        }

        $this->post('/tester-api/upload', [], $headers)->assertOk()->assertJsonPath('error.code', 'validation_error');
        $this->post('/tester-api/format', ['id' => 'tr_t1', 'format' => 'exe'], $headers)->assertJsonPath('ok', false);
    }

    public function test_tester_simulated_webhooks_give_200_and_401(): void
    {
        $headers = ['Accept' => 'application/json'];

        $this->post('/tester-api/webhook-simulate', ['mode' => 'valid'], $headers)
            ->assertOk()->assertJsonPath('ok', true)->assertJsonPath('response.status', 200);
        $this->post('/tester-api/webhook-simulate', ['mode' => 'forged'], $headers)
            ->assertOk()->assertJsonPath('ok', true)->assertJsonPath('response.status', 401);

        $logs = $this->getJson('/tester-api/webhook-logs')->assertOk()->json('data');
        $this->assertCount(2, $logs);
        $this->assertFalse($logs[0]['signature_valid']);
        $this->assertTrue($logs[1]['signature_valid']);
        Http::assertNothingSent();
    }

    public function test_pages_render_without_secrets(): void
    {
        foreach (['/', '/tester'] as $page) {
            $this->get($page)->assertOk()
                ->assertDontSee($this->key, false)
                ->assertDontSee($this->secret, false);
        }
        $this->get('/tester')->assertSee('tk_0123…');
    }

    public function test_tester_can_be_turned_off(): void
    {
        config(['services.transcribe.tester' => false]);

        $this->get('/tester')->assertNotFound();
        $this->post('/tester-api/health', [], ['Accept' => 'application/json'])->assertNotFound();
    }

    // ----- helpers ---------------------------------------------------------------------------

    private function sendWebhook(string $body, ?string $signature)
    {
        $server = ['CONTENT_TYPE' => 'application/json', 'HTTP_USER_AGENT' => 'TranscribeAPI/1.0'];
        if ($signature !== null) {
            $server['HTTP_X_TRANSCRIBE_SIGNATURE'] = $signature;
        }

        return $this->call('POST', '/webhooks/transcribe', [], [], [], $server, $body);
    }

    private function job(string $id, string $status): array
    {
        $done = $status === 'completed';

        return [
            'id' => $id, 'object' => 'transcription', 'project_id' => 'prj_1', 'status' => $status,
            'engine' => 'worker', 'language' => 'en', 'detected_language' => $done ? 'en' : null, 'task' => 'transcribe',
            'filename' => 'a.mp3', 'file_size' => 1000, 'duration' => $done ? 4.5 : null, 'progress' => $done ? 100 : null,
            'text' => $done ? 'Hello there. Thanks for calling.' : null,
            'segments' => $done ? [
                ['id' => 0, 'start' => 0.0, 'end' => 2.0, 'text' => 'Hello there.'],
                ['id' => 1, 'start' => 2.0, 'end' => 4.5, 'text' => 'Thanks for calling.'],
            ] : null,
            'error' => null, 'metadata' => null, 'webhook_status' => null,
            'created_at' => '2026-10-15T10:00:00Z', 'started_at' => null, 'completed_at' => null,
        ];
    }
}
