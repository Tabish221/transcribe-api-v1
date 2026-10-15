<?php

use App\Http\Controllers\AppController;
use App\Http\Controllers\TesterController;
use App\Http\Controllers\TranscribeWebhookController;
use Illuminate\Support\Facades\Route;

// ----- App page (what your users would see) ---------------------------------------------------
Route::get('/', [AppController::class, 'index'])->name('app');

Route::prefix('app-api/transcriptions')->name('app.')->group(function () {
    Route::get('/', [AppController::class, 'list'])->name('list');
    Route::post('/', [AppController::class, 'store'])->name('store');
    Route::get('/{transcription}', [AppController::class, 'show'])->name('show');
    Route::get('/{transcription}/srt', [AppController::class, 'srt'])->name('srt');
    Route::get('/{transcription}/audio', [AppController::class, 'audio'])->name('audio');
    Route::delete('/{transcription}', [AppController::class, 'destroy'])->name('destroy');
});

// ----- Backend tester (turn off with TRANSCRIBE_TESTER=false) --------------------------------
Route::get('/tester', [TesterController::class, 'index'])->name('tester');
Route::get('/tester-api/webhook-logs', [TesterController::class, 'webhookLogs'])->name('tester.webhook-logs');
Route::post('/tester-api/{action}', [TesterController::class, 'action'])
    ->whereIn('action', TesterController::ACTIONS)
    ->name('tester.action');

// ----- Webhook from the Transcribe API (no CSRF: see bootstrap/app.php) -------------------------
Route::post('/webhooks/transcribe', TranscribeWebhookController::class)->name('webhooks.transcribe');
