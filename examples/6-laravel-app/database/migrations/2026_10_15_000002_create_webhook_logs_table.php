<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/** Every call to POST /webhooks/transcribe, valid or not (shown on the tester page). */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('webhook_logs', function (Blueprint $table) {
            $table->id();
            $table->string('event', 64)->nullable();          // transcription.completed | transcription.failed
            $table->string('remote_id', 64)->nullable()->index();
            $table->boolean('signature_valid')->default(false);
            $table->unsignedSmallInteger('http_status_returned');
            $table->json('payload')->nullable();
            $table->string('user_agent')->nullable();          // "TranscribeAPI/1.0" = the real API
            $table->string('note')->nullable();                // e.g. "Updated local #3", "Bad signature"
            $table->timestamp('received_at')->index();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('webhook_logs');
    }
};
