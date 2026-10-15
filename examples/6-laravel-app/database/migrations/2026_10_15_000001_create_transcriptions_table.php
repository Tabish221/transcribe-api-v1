<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Local copy of the jobs this app sent to the Transcribe API.
 * remote_id is the API's id ("tr_..."). The webhook and the status refresh update these rows.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('transcriptions', function (Blueprint $table) {
            $table->id();
            $table->string('remote_id', 64)->unique();          // tr_... on the API
            $table->string('filename');                          // original file name
            $table->unsignedBigInteger('file_size')->nullable(); // bytes
            $table->string('audio_path')->nullable();            // local copy of the mp3 (storage/app/private/...)
            $table->string('engine', 16)->nullable();            // worker | cloud
            $table->string('language', 16)->nullable();          // asked or detected language
            $table->string('status', 16)->default('queued');     // queued | processing | completed | failed
            $table->unsignedTinyInteger('progress')->nullable(); // 0-100 while processing
            $table->longText('text')->nullable();
            $table->json('segments')->nullable();                // [{id, start, end, text}, ...]
            $table->float('duration')->nullable();               // seconds
            $table->text('error')->nullable();
            $table->timestamp('last_synced_at')->nullable();     // last refresh from GET /api/v1/transcriptions/{id}
            $table->timestamp('webhook_received_at')->nullable();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('transcriptions');
    }
};
